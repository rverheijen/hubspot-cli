import { tryRunHubspotJson, tryRunHubspotJsonRaw } from './run.js';
import { createClient } from './client.js';
import { readManifest, writeManifest, getSection } from './manifest.js';
import { readObjectBundle } from './objects.js';
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
// options, hasUniqueValue, hidden, or formField). Other field changes are
// reported but not applied.
async function reconcileProperties(objectTypeId, localProperties, remoteProperties, env, log) {
  const remoteByName = new Map(remoteProperties.map((p) => [p.name, p]));
  const toCreate = localProperties.filter((p) => !remoteByName.has(p.name));

  if (toCreate.length > 0) {
    const input = toCreate.map((p) => JSON.stringify(p)).join('\n');
    const result = tryRunHubspotJsonRaw(['properties', 'batch-create', '--type', objectTypeId], { env, input, noFormat: true });
    if (!result.ok) throw new Error(`Failed to create properties: ${result.error?.message}`);
    for (const p of toCreate) log(`+ ${p.name} (${p.type})`);
  }

  for (const local of localProperties) {
    const remote = remoteByName.get(local.name);
    if (!remote) continue;

    const updateArgs = [];
    const applied = [];
    const skipped = [];

    for (const field of Object.keys(local)) {
      if (field === 'name') continue;
      const localVal = JSON.stringify(local[field] ?? null);
      const remoteVal = JSON.stringify(remote[field] ?? null);
      if (localVal === remoteVal) continue;

      if (field === 'label') {
        updateArgs.push('--label', local.label);
        applied.push('label');
      } else if (field === 'groupName') {
        updateArgs.push('--group', local.groupName);
        applied.push('group');
      } else {
        skipped.push(field);
      }
    }

    if (updateArgs.length > 0) {
      const result = tryRunHubspotJsonRaw(
        ['properties', 'update', '--type', objectTypeId, local.name, ...updateArgs],
        { env, noFormat: true },
      );
      if (!result.ok) throw new Error(`Failed to update property "${local.name}": ${result.error?.message}`);
      log(`~ ${local.name} (${applied.join(', ')})`);
    }

    if (skipped.length > 0) {
      log(`! ${local.name}: can't push changes to ${skipped.join(', ')} (hubspot properties update only supports --label/--group)`);
    }
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

  const remoteProperties = created.properties || [];
  await reconcileProperties(created.objectTypeId, local.properties || [], remoteProperties, env, log);

  // Only reports drift now (see reportSchemaMetadataDrift) - schemas
  // update's confirm step doesn't actually apply anything.
  reportSchemaMetadataDrift(local, created, log, force);

  const manifest = readManifest();
  getSection(manifest, envName, 'objects')[path.basename(filePath)] = created.objectTypeId;
  writeManifest(manifest);

  return { objectTypeId: created.objectTypeId, messages };
}
