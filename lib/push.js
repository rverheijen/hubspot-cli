import { tryRunHubspotJson, tryRunHubspotJsonRaw } from './run.js';
import { createClient } from './client.js';
import { readManifest, writeManifest, getSection } from './manifest.js';
import { readObjectBundle } from './objects.js';
import { stableStringify } from './diff.js';
import path from 'path';

// A brand-new object must be created with its initial properties (and
// primaryDisplayProperty, which must reference one of them) in the SAME
// schemas create call - confirmed live, primaryDisplayProperty is both
// required at creation and rejected if it references a property that
// doesn't exist yet, so a two-step "create empty schema, then add
// properties" never works. groupName on an inline property can reference a
// group that doesn't exist yet either - HubSpot auto-creates it (with a
// default, unstyled label), which reconcileGroups then fixes up.
async function createSchemaIfMissing(local, env, log) {
  const existing = tryRunHubspotJson(['schemas', 'get', '--type', local.name], { env });
  if (existing.ok) return { schema: existing.data[0], created: false };

  if (!local.labels?.singular || !local.labels?.plural) {
    throw new Error(
      `"${local.name}" doesn't exist yet and can't be created: labels.singular and labels.plural are required.`,
    );
  }
  if (!local.primaryDisplayProperty) {
    throw new Error(`"${local.name}" doesn't exist yet and can't be created: primaryDisplayProperty is required.`);
  }

  const body = {
    name: local.name,
    labels: local.labels,
    primaryDisplayProperty: local.primaryDisplayProperty,
  };
  if (local.requiredProperties?.length) body.requiredProperties = local.requiredProperties;
  if (local.associatedObjects?.length) body.associatedObjects = local.associatedObjects;
  if (local.properties?.length) body.properties = local.properties;

  const result = tryRunHubspotJsonRaw(['schemas', 'create'], { env, input: JSON.stringify(body), noFormat: true });
  if (!result.ok) throw new Error(`Failed to create schema: ${result.error?.message}`);

  const created = result.data ?? result;
  log(`+ created schema (${created.objectTypeId}) with ${local.properties?.length || 0} initial properties`);
  return { schema: created, created: true };
}

function buildSchemaPatch(local, remote) {
  const patch = {};

  const singular = local.labels?.singular ?? remote.labels?.singular;
  const plural = local.labels?.plural ?? remote.labels?.plural;
  if (singular !== remote.labels?.singular || plural !== remote.labels?.plural) {
    patch.labels = { singular, plural };
  }

  if (local.primaryDisplayProperty !== undefined && local.primaryDisplayProperty !== remote.primaryDisplayProperty) {
    patch.primaryDisplayProperty = local.primaryDisplayProperty;
  }

  if (local.requiredProperties && JSON.stringify(local.requiredProperties) !== JSON.stringify(remote.requiredProperties || [])) {
    patch.requiredProperties = local.requiredProperties;
  }

  return patch;
}

// hubspot schemas update's confirm step is confirmed broken upstream - it
// returns ok:true with what looks like the updated schema, but never
// actually persists the change (see rverheijen/hubspot-cli#4 /
// HubSpot/agent-cli#7). Rather than call it and claim a success that
// isn't real, this detects and reports the drift without attempting it.
// Only affects an object that already exists - createSchemaIfMissing's
// schemas create path is unaffected, that's a different command that
// works correctly.
function reportSchemaMetadataDrift(local, remoteSchema, log, force) {
  if (remoteSchema.metaType === 'HUBSPOT' && !force) return;

  const patch = buildSchemaPatch(local, remoteSchema);
  if (Object.keys(patch).length === 0) return;

  log(
    `! schema metadata differs (${Object.keys(patch).join(', ')}) but can't be applied: ` +
      'hubspot schemas update\'s confirm step is broken upstream and silently does not persist ' +
      '(see rverheijen/hubspot-cli#4). Change this manually in the HubSpot UI for now.',
  );
}

async function reconcileGroups(objectTypeId, localGroups, remoteGroups, env, log) {
  const client = createClient(env);
  const remoteByName = new Map(remoteGroups.map((g) => [g.name, g]));

  for (const group of localGroups) {
    const remote = remoteByName.get(group.name);

    if (!remote) {
      await client.crm.properties.groupsApi.create(objectTypeId, {
        name: group.name,
        label: group.label,
        displayOrder: group.displayOrder,
      });
      log(`+ group: ${group.name}`);
      continue;
    }

    const changed = group.label !== remote.label || group.displayOrder !== remote.displayOrder;
    if (changed) {
      await client.crm.properties.groupsApi.update(objectTypeId, group.name, {
        label: group.label,
        displayOrder: group.displayOrder,
      });
      log(`~ group: ${group.name}`);
    }
  }
}

// hubspot properties update only accepts --label/--group (confirmed live -
// no CLI path exists to change an existing property's type, fieldType,
// options, hasUniqueValue, hidden, or formField via the official CLI
// subcommand). For a property whose modificationMetadata.readOnlyDefinition
// is false, the raw API allows changing some of these directly though -
// confirmed live converting a native `gender` property from string/text to
// enumeration/select with real options, and `date_of_birth` from
// string/text to type: date, both on a real portal. Applied via a direct
// PATCH call below for exactly the fields confirmed to work this way, not
// a blanket "anything readOnlyDefinition allows."
const RAW_API_UPDATABLE_FIELDS = new Set(['type', 'fieldType', 'options']);

// readOnlyDefinition: false is necessary but not sufficient - these two are
// confirmed NOT changeable via the raw API either, even when it's false.
//
// dataSensitivity is a create-time-only field, per HubSpot's own docs
// ("Ensure the dataSensitivity field is set to indicate sensitivity during
// the property creation process") and confirmed live: attempting to set it
// on an already-existing property (even one that was archived and
// recreated under the same name) is rejected outright with an explicit
// error. It's included in a local property's create payload the same as
// any other field - no special-casing needed there - but changing it later
// requires archiving the property and creating a differently-named
// replacement, a real migration, not something this update path attempts.
//
// hasUniqueValue is worse: a raw PATCH returns 200 OK but silently leaves
// the value unchanged, confirmed live on a real property that already had
// data - no error at all, just a no-op. Same real-migration requirement as
// dataSensitivity applies.
const CONFIRMED_UNCHANGEABLE_FIELDS = new Set(['dataSensitivity', 'hasUniqueValue']);

async function applyPropertyRaw(objectTypeId, propertyName, changes, env) {
  const res = await fetch(`https://api.hubapi.com/crm/v3/properties/${objectTypeId}/${propertyName}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}

async function reconcileProperties(objectTypeId, localProperties, remoteProperties, env, log) {
  const remoteByName = new Map(remoteProperties.map((p) => [p.name, p]));
  const toCreate = localProperties.filter((p) => !remoteByName.has(p.name));

  // One batch-create call per property, not one call for the whole
  // toCreate array. batch-create is confirmed all-or-nothing live: one
  // invalid property (missing scope, a rejected field value, etc.) failed
  // the entire call, blocking every other unrelated property in the same
  // push with no way to tell which one was actually the problem. The
  // single-property `properties create` subcommand isn't a substitute -
  // it only supports a handful of flags (name/label/prop-type/field-type/
  // group/has-unique-value/form-field), no options/description/
  // dataSensitivity/hidden - so batch-create (which takes the full JSON
  // property object) is still what's needed, just called N times instead
  // of once, trading some API-call efficiency for one failure not taking
  // down everything else in the same push.
  // Failures from both creating and updating are collected and thrown once
  // at the very end, rather than immediately, for the same reason:
  // confirmed live, one property's failure shouldn't stop every other
  // property - including ones this same loop hasn't gotten to yet - from
  // being attempted. An immediate throw on an update failure has the exact
  // same atomicity problem as batch-create bundling every property into
  // one all-or-nothing call, just at update time instead of create time.
  const failures = [];

  for (const p of toCreate) {
    const result = tryRunHubspotJsonRaw(['properties', 'batch-create', '--type', objectTypeId], {
      env, input: JSON.stringify(p), noFormat: true,
    });
    if (!result.ok) {
      failures.push(`create "${p.name}": ${result.error?.message}`);
      log(`! ${p.name}: failed to create (${result.error?.message})`);
      continue;
    }
    log(`+ ${p.name} (${p.type})`);
  }

  for (const local of localProperties) {
    const remote = remoteByName.get(local.name);
    if (!remote) continue;

    const updateArgs = [];
    const applied = [];
    const skippedReadOnly = [];
    const skippedConfirmedUnchangeable = [];
    const skippedUnconfirmed = [];
    const rawChanges = {};
    const canUseRawApi = remote.modificationMetadata?.readOnlyDefinition === false;

    for (const field of Object.keys(local)) {
      if (field === 'name') continue;
      const localVal = stableStringify(local[field] ?? null);
      const remoteVal = stableStringify(remote[field] ?? null);
      if (localVal === remoteVal) continue;

      if (field === 'label') {
        updateArgs.push('--label', local.label);
        applied.push('label');
      } else if (field === 'groupName') {
        updateArgs.push('--group', local.groupName);
        applied.push('group');
      } else if (!canUseRawApi) {
        skippedReadOnly.push(field);
      } else if (CONFIRMED_UNCHANGEABLE_FIELDS.has(field)) {
        skippedConfirmedUnchangeable.push(field);
      } else if (RAW_API_UPDATABLE_FIELDS.has(field)) {
        rawChanges[field] = local[field];
      } else {
        skippedUnconfirmed.push(field);
      }
    }

    if (updateArgs.length > 0) {
      const result = tryRunHubspotJsonRaw(
        ['properties', 'update', '--type', objectTypeId, local.name, ...updateArgs],
        { env, noFormat: true },
      );
      if (!result.ok) {
        failures.push(`update "${local.name}" (${applied.join(', ')}): ${result.error?.message}`);
        log(`! ${local.name}: failed to update ${applied.join(', ')} (${result.error?.message})`);
      } else {
        log(`~ ${local.name} (${applied.join(', ')})`);
      }
    }

    if (Object.keys(rawChanges).length > 0) {
      try {
        await applyPropertyRaw(objectTypeId, local.name, rawChanges, env);
        log(`~ ${local.name} (${Object.keys(rawChanges).join(', ')}, via raw API)`);
      } catch (err) {
        failures.push(`update "${local.name}" (${Object.keys(rawChanges).join(', ')}, via raw API): ${err.message}`);
        log(`! ${local.name}: failed to update ${Object.keys(rawChanges).join(', ')} via raw API (${err.message})`);
      }
    }

    if (skippedReadOnly.length > 0) {
      log(`! ${local.name}: can't push changes to ${skippedReadOnly.join(', ')} (this property's definition is read-only, modificationMetadata.readOnlyDefinition is true)`);
    }
    if (skippedConfirmedUnchangeable.length > 0) {
      log(`! ${local.name}: can't push changes to ${skippedConfirmedUnchangeable.join(', ')} (confirmed unchangeable post-creation even via the raw API - a real migration, not something this update path attempts)`);
    }
    if (skippedUnconfirmed.length > 0) {
      log(`! ${local.name}: can't push changes to ${skippedUnconfirmed.join(', ')} (hubspot properties update only supports --label/--group; raw-API support for this field hasn't been confirmed)`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`${failures.length} propert${failures.length === 1 ? 'y' : 'ies'} failed (see individual errors above):\n  ${failures.join('\n  ')}`);
  }
}

export async function pushObject(filePath, { env, envName, force } = {}) {
  const local = readObjectBundle(filePath);
  if (!local.name) throw new Error(`${filePath}: bundle has no "name" field`);

  const messages = [];
  const log = (m) => messages.push(m);

  const { schema: created } = await createSchemaIfMissing(local, env, log);

  // Groups must exist before properties that reference them via groupName,
  // so groups are reconciled first, using a fresh fetch (a schema that was
  // just created has no groups yet at all).
  const client = createClient(env);
  const remoteGroups = (await client.crm.properties.groupsApi.getAll(created.objectTypeId)).results || [];
  await reconcileGroups(created.objectTypeId, local.groups || [], remoteGroups, env, log);

  // reconcileProperties attempts every property before throwing (see its
  // own comment) - caught here so the manifest still gets written (the
  // schema/objectTypeId itself is valid regardless of a property-level
  // failure) and so the caller still sees every message logged so far,
  // not just the final error. Without this, a partial failure would hide
  // everything that actually succeeded - confirmed, `messages` is only
  // returned on a clean return, lost entirely if this throws uncaught.
  const remoteProperties = created.properties || [];
  let propertiesError = null;
  try {
    await reconcileProperties(created.objectTypeId, local.properties || [], remoteProperties, env, log);
  } catch (err) {
    propertiesError = err;
  }

  // Only reports drift now (see reportSchemaMetadataDrift) - schemas
  // update's confirm step doesn't actually apply anything.
  reportSchemaMetadataDrift(local, created, log, force);

  const manifest = readManifest();
  getSection(manifest, envName, 'objects')[path.basename(filePath)] = created.objectTypeId;
  writeManifest(manifest);

  if (propertiesError) {
    propertiesError.messages = messages;
    propertiesError.objectTypeId = created.objectTypeId;
    throw propertiesError;
  }

  return { objectTypeId: created.objectTypeId, messages };
}
