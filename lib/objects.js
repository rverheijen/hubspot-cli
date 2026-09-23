import fs from 'fs';
import path from 'path';

import { runHubspotJson } from './run.js';
import { createClient } from './client.js';
import { readManifest, writeManifest, getSection } from './manifest.js';

const DEFAULT_OBJECTS_DIR = 'hubspot/objects';

// Fields the underlying schemas/properties/groups APIs return that are
// read-only audit metadata, not part of what you'd hand-write or push.
const READONLY_PROPERTY_FIELDS = new Set([
  'createdAt', 'updatedAt', 'createdUserId', 'updatedUserId',
  'hubspotDefined', 'calculated', 'externalOptions', 'archived',
  'modificationMetadata', 'dataSensitivity',
]);

function cleanProperty(prop) {
  const out = {};
  for (const [key, value] of Object.entries(prop)) {
    if (!READONLY_PROPERTY_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

function cleanGroup({ name, label, displayOrder }) {
  return { name, label, displayOrder };
}

export function discoverObjectTypes(env) {
  const types = runHubspotJson(['objects', 'types'], { env });
  return types.map((t) => t.name);
}

async function fetchPropertyGroups(env, objectTypeId) {
  // The plain type name (e.g. "auth0_audit_event") only works for standard
  // objects here - custom objects require objectTypeId (e.g. "2-12345678"),
  // confirmed by testing both against a live portal. objectTypeId works
  // universally, so it's used for both cases.
  const client = createClient(env);
  const groups = await client.crm.properties.groupsApi.getAll(objectTypeId);
  return (groups.results || []).map(cleanGroup);
}

export async function fetchObjectBundle(type, { full = false, env } = {}) {
  // schemas get --format json wraps its single match in a one-element array.
  const [schema] = runHubspotJson(['schemas', 'get', '--type', type], { env });

  // Every object type - standard or custom - carries ~30 HubSpot-managed
  // boilerplate properties (hs_object_id, hs_createdate, hubspot_owner_id,
  // ...), all marked hubspotDefined: true. Confirmed live against a fresh
  // custom object, not just standard ones. Sparse mode filters these out
  // regardless of metaType; --full keeps them for reference.
  let properties = schema.properties || [];
  let keepGroupNames = null;

  if (!full) {
    // createdUserId isn't populated on this endpoint's embedded property
    // list (unlike the separate properties.coreApi), so hubspotDefined
    // alone is the filter - confirmed live it correctly distinguishes
    // HubSpot-managed boilerplate (true) from everything else (absent).
    properties = properties.filter((p) => p.hubspotDefined !== true);
    keepGroupNames = new Set(properties.map((p) => p.groupName));
  }

  const allGroups = await fetchPropertyGroups(env, schema.objectTypeId);
  const groups = keepGroupNames ? allGroups.filter((g) => keepGroupNames.has(g.name)) : allGroups;

  return {
    name: schema.name,
    objectTypeId: schema.objectTypeId,
    metaType: schema.metaType,
    labels: schema.labels,
    primaryDisplayProperty: schema.primaryDisplayProperty,
    requiredProperties: schema.requiredProperties || [],
    groups,
    properties: properties.map(cleanProperty),
  };
}

export function objectBundlePath(type, dir) {
  return path.join(dir ?? DEFAULT_OBJECTS_DIR, `${type}.json`);
}

export function writeObjectBundle(type, bundle, dir) {
  const filePath = objectBundlePath(type, dir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2) + '\n');
  return filePath;
}

export async function pullObject(type, { full, dir, env, envName } = {}) {
  const bundle = await fetchObjectBundle(type, { full, env });
  const filePath = writeObjectBundle(type, bundle, dir);

  const manifest = readManifest();
  getSection(manifest, envName, 'objects')[path.basename(filePath)] = bundle.objectTypeId;
  writeManifest(manifest);

  return filePath;
}

export async function pullAllObjects({ full, dir, env, envName } = {}) {
  const types = discoverObjectTypes(env);
  const results = [];

  for (const type of types) {
    try {
      const filePath = await pullObject(type, { full, dir, env, envName });
      results.push({ type, filePath, ok: true });
    } catch (err) {
      results.push({ type, ok: false, error: err.message });
    }
  }

  return results;
}
