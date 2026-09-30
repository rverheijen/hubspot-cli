import fs from 'fs';
import path from 'path';

import { runHubspotJson, tryRunHubspotJson } from './run.js';
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

// Resolving a brand-new custom object by name can fail for a while after
// creation even though `objects types` already lists it - confirmed live,
// a real gap between hubspot's own internal caches, not a propagation
// delay that resolves with a short wait (still failed after 45s). Falls
// back to objectTypeId, which works immediately.
//
// Deliberately uses `schemas get`, not the properties list/get endpoints
// (GET /crm/v3/properties/{type}[/{name}]), to fetch a type's properties.
// Those endpoints filter by data sensitivity tier and default to
// non-sensitive only - a property with dataSensitivity "sensitive" or
// "highly_sensitive" is completely invisible unless you pass a matching
// ?dataSensitivity=<level> query param, and each level is an exact match,
// not cumulative (confirmed live: ?dataSensitivity=sensitive returns only
// sensitive properties, not sensitive+non-sensitive or all three tiers
// together). Getting every property that way needs three separate calls
// (no param, ?dataSensitivity=sensitive, ?dataSensitivity=highly_sensitive)
// merged together. `schemas get` has no such filtering - confirmed live,
// it returns every property regardless of sensitivity tier in one call -
// which is why pull/diff/push never need to think about this at all. The
// one thing `schemas get` doesn't return is the dataSensitivity value
// itself (see diff.js/push.js).
async function fetchSchema(type, env) {
  const byName = tryRunHubspotJson(['schemas', 'get', '--type', type], { env });
  if (byName.ok) return byName.data[0];

  const types = runHubspotJson(['objects', 'types'], { env });
  const match = types.find((t) => t.name === type || t.objectTypeId === type);
  if (!match) throw new Error(byName.error?.message ?? `Unable to resolve object type: ${type}`);

  const byId = runHubspotJson(['schemas', 'get', '--type', match.objectTypeId], { env });
  return byId[0];
}

export async function fetchObjectBundle(type, { full = false, env } = {}) {
  const schema = await fetchSchema(type, env);

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
    // Recorded so `diff` knows whether to compare against a sparse or full
    // remote fetch - otherwise a sparse local file would show hundreds of
    // false "removed" entries for HubSpot's own boilerplate properties.
    full: Boolean(full),
    groups,
    properties: properties.map(cleanProperty),
  };
}

export function objectBundlePath(type, dir) {
  return path.join(dir ?? DEFAULT_OBJECTS_DIR, `${type}.json`);
}

export function readObjectBundle(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function listLocalObjectFiles(dir) {
  const target = dir ?? DEFAULT_OBJECTS_DIR;
  if (!fs.existsSync(target)) return [];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(target, f))
    .sort();
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
