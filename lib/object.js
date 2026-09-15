import fs from 'fs';
import path from 'path';
import { slugify, ensureDir } from './util.js';
import { getSection } from './manifest.js';

const DEFAULT_OBJECTS_DIR = 'objects';

const STANDARD_OBJECTS = [
  'contacts',
  'companies',
  'deals',
  'tickets',
  'products',
  'quotes',
  'calls',
  'emails',
  'meetings',
  'notes',
  'tasks',
  'postal_mail',
  'communications',
  'feedback_submissions',
  'goals',
  'users',
  'user_pii',
  'invoices',
  'payments',
  'orders',
  'cart',
  'line_items',
  'subscriptions',
  'contracts',
  'companies_prospects',
];

function objectsDir(baseDir) {
  return path.join(baseDir, DEFAULT_OBJECTS_DIR);
}

function standardSchemaStub(name) {
  return {
    objectTypeId: name,
    name,
    fullyQualifiedName: name,
    labels: { singular: name, plural: name },
    primaryDisplayProperty: null,
    requiredProperties: [],
    searchableProperties: [],
    propertiesToSend: [],
    conditionalProperties: [],
    metaType: 'HUBSPOT',
    archived: false,
    isStandardStub: true,
  };
}

export async function listObjects(client) {
  const [customResponse, ...standardChecks] = await Promise.all([
    client.crm.schemas.coreApi.getAll(),
    ...STANDARD_OBJECTS.map(name =>
      client.crm.properties.groupsApi.getAll(name)
        .then(() => ({ name, available: true }))
        .catch(() => ({ name, available: false })),
    ),
  ]);

  const results = [];

  for (const name of STANDARD_OBJECTS) {
    const check = standardChecks.find(c => c.name === name);
    if (check?.available) {
      results.push({ objectTypeId: name, name, fullyQualifiedName: name, metaType: 'HUBSPOT' });
    }
  }

  for (const schema of customResponse.results || []) {
    results.push(schemaToSummary(schema));
  }

  return results;
}

function schemaToSummary(schema) {
  return {
    objectTypeId: schema.objectTypeId,
    name: schema.name,
    fullyQualifiedName: schema.fullyQualifiedName,
    labels: schema.labels,
    primaryDisplayProperty: schema.primaryDisplayProperty,
    requiredProperties: schema.requiredProperties,
    searchableProperties: schema.searchableProperties,
    metaType: schema.metaType,
  };
}

export async function pullObject(target, baseDir, envName, manifest, client, options = {}) {
  const dir = objectsDir(baseDir);
  ensureDir(dir);

  if (target === '--all') {
    const allNames = [...STANDARD_OBJECTS, ...((await client.crm.schemas.coreApi.getAll()).results || []).map(s => s.fullyQualifiedName ?? s.name)];
    console.log(`Pulling ${allNames.length} object(s) to ${dir}`);
    let ok = 0, failed = 0, skipped = 0;
    for (const name of allNames) {
      try {
        const pulled = await pullSingleObject(name, baseDir, envName, manifest, client, options);
        if (pulled) ok++;
        else failed++;
      } catch (e) {
        console.error(`  ✗ ${name}: ${e.message}`);
        failed++;
      }
    }
    console.log(`\n${ok} pulled${failed > 0 ? `, ${failed} failed` : ''}`);
    return failed === 0;
  }

  return await pullSingleObject(target, baseDir, envName, manifest, client, options);
}

async function pullSingleObject(target, baseDir, envName, manifest, client, options = {}) {
  const dir = objectsDir(baseDir);

  // Try to find a custom object schema first.
  const schemas = await client.crm.schemas.coreApi.getAll();
  let schema = schemas.results.find(s =>
    s.objectTypeId === target ||
    s.name === target ||
    s.fullyQualifiedName === target,
  );

  if (!schema) {
    const standardName = STANDARD_OBJECTS.find(n => n === target.toLowerCase());
    if (!standardName) {
      console.error(`Object type "${target}" not found`);
      return false;
    }
    // Verify the standard object is accessible with the current key.
    try {
      await client.crm.properties.groupsApi.getAll(standardName);
      schema = standardSchemaStub(standardName);
    } catch (e) {
      console.error(`Object type "${target}" is not accessible with the current API key: ${e.body?.message || e.message}`);
      return false;
    }
  }

  await saveObject(schema, dir, envName, manifest, client, options);
  return true;
}

function isCustomObject(schema) {
  return schema.metaType === 'PORTAL_SPECIFIC' ||
    schema.metaType === 'CUSTOM' ||
    (schema.fullyQualifiedName ?? schema.name).startsWith('p_') ||
    schema.isStandardStub !== true;
}

function isCustomProperty(property) {
  return property.hubspotDefined !== true && property.createdUserId != null;
}

async function saveObject(schema, dir, envName, manifest, client, options = {}) {
  const objectTypeId = schema.objectTypeId;
  const fullyQualifiedName = schema.fullyQualifiedName ?? schema.name;
  const custom = isCustomObject(schema);

  const [groups, properties] = await Promise.all([
    client.crm.properties.groupsApi.getAll(objectTypeId),
    client.crm.properties.coreApi.getAll(objectTypeId),
  ]);

  let rawProperties = properties.results || [];
  let keptGroups = (groups.results || []).map(g => ({
    name: g.name,
    label: g.label,
    displayOrder: g.displayOrder,
    target: g.target,
    archived: g.archived ?? false,
  }));

  if (!custom && !options.full) {
    rawProperties = rawProperties.filter(isCustomProperty);
    const referencedGroupNames = new Set(rawProperties.map(p => p.groupName).filter(Boolean));
    keptGroups = keptGroups.filter(g => referencedGroupNames.has(g.name));
  }

  const keptProperties = rawProperties.map(p => cleanProperty(p));

  const pullMode = custom || options.allProps ? 'full' : 'sparse';

  const bundle = {
    objectTypeId,
    fullyQualifiedName,
    name: schema.name,
    labels: schema.labels,
    primaryDisplayProperty: schema.primaryDisplayProperty,
    requiredProperties: schema.requiredProperties,
    searchableProperties: schema.searchableProperties,
    propertiesToSend: schema.propertiesToSend,
    conditionalProperties: schema.conditionalProperties,
    metaType: schema.metaType,
    archived: schema.archived ?? false,
    pullMode,
    propertyGroups: keptGroups,
    properties: keptProperties,
  };

  const filename = `${slugify(fullyQualifiedName)}.json`;
  const filepath = path.join(dir, filename);

  const section = getSection(manifest, envName, 'objects');
  const existing = Object.keys(section).find(f => section[f] === fullyQualifiedName);
  if (existing && existing !== filename) {
    const oldPath = path.join(dir, existing);
    if (fs.existsSync(oldPath)) {
      fs.renameSync(oldPath, filepath);
      console.log(`Renamed  ${existing} -> ${filename}`);
    }
    delete section[existing];
  }

  fs.writeFileSync(filepath, JSON.stringify(bundle, null, 2) + '\n');
  section[filename] = fullyQualifiedName;

  console.log(`Saved to ${filepath}`);
}

function cleanProperty(property) {
  const p = { ...property };
  // Remove HubSpot-managed read-only / version fields that change on every push.
  delete p.createdAt;
  delete p.updatedAt;
  delete p.modifiedAt;
  delete p.metaData;
  delete p.createdUserId;
  delete p.updatedUserId;
  delete p.optionSortStrategy;
  if (p.options) {
    p.options = p.options.map(o => {
      const opt = { ...o };
      delete opt.createdAt;
      delete opt.updatedAt;
      delete opt.optionSetId;
      return opt;
    });
  }
  return p;
}

export async function pushObject(target, baseDir, envName, manifest, client) {
  const dir = objectsDir(baseDir);

  if (target === '--all') {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      : [];
    if (files.length === 0) {
      console.log(`No .json files found in ${dir}`);
      return true;
    }
    console.log(`Pushing ${files.length} object bundle(s) to env: ${envName}\n`);
    let created = 0, updated = 0, failed = 0;
    for (const filename of files) {
      const result = await pushObjectFile(path.join(dir, filename), envName, manifest, client);
      if (result === 'created') created++;
      else if (result === 'updated') updated++;
      else failed++;
    }
    console.log(`\n${created} created, ${updated} updated${failed > 0 ? `, ${failed} failed` : ''}`);
    return failed === 0;
  }

  if (target.endsWith('.json')) {
    console.log(`Pushing to env: ${envName}`);
    const result = await pushObjectFile(target, envName, manifest, client);
    return result !== 'failed';
  }

  // target is a file path without extension or object name
  const filepath = path.join(dir, `${slugify(target)}.json`);
  if (!fs.existsSync(filepath)) {
    console.error(`Object bundle not found: ${filepath}`);
    return false;
  }
  console.log(`Pushing to env: ${envName}`);
  const result = await pushObjectFile(filepath, envName, manifest, client);
  return result !== 'failed';
}

async function pushObjectFile(filepath, envName, manifest, client) {
  const filename = path.basename(filepath);
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`✗ ${filename}: ${e.message}`);
    return 'failed';
  }

  const section = getSection(manifest, envName, 'objects');
  const existingFqn = section[filename];

  try {
    let schema;
    if (existingFqn) {
      // Try to fetch existing schema to decide create vs update.
      const all = await client.crm.schemas.coreApi.getAll();
      schema = all.results.find(s => s.fullyQualifiedName === existingFqn || s.objectTypeId === existingFqn);
    }

    if (schema) {
      // Update existing custom object: HubSpot only allows updating labels and a few fields.
      // We do not recreate the object; instead we push properties and groups.
      await pushPropertiesAndGroups(schema.objectTypeId, bundle, client);
      console.log(`Updated  ${bundle.fullyQualifiedName} (id: ${schema.objectTypeId})`);
      return 'updated';
    }

    // Create new custom object.
    const createPayload = {
      name: bundle.name,
      labels: bundle.labels,
      primaryDisplayProperty: bundle.primaryDisplayProperty,
      requiredProperties: bundle.requiredProperties ?? [],
      searchableProperties: bundle.searchableProperties ?? [],
      properties: (bundle.properties || []).map(p => stripPropertyForCreate(p)),
      associatedObjects: bundle.associatedObjects ?? [],
    };

    const created = await client.crm.schemas.coreApi.create(createPayload);
    section[filename] = created.fullyQualifiedName ?? created.objectTypeId;
    console.log(`Created  ${created.fullyQualifiedName} (id: ${created.objectTypeId})`);
    return 'created';
  } catch (e) {
    console.error(`✗ ${filename}: ${e.body?.message || e.message}`);
    return 'failed';
  }
}

function stripPropertyForCreate(property) {
  // HubSpot create object endpoint accepts a subset of property fields.
  const {
    name, label, type, fieldType, description, groupName, options,
    displayOrder, formField, readOnlyValue, readOnlyDefinition,
    hidden, searchable, hubspotDefined, hasUniqueValue,
    externalOptions, isCustomizedDefault, showCurrencySymbol,
    calculationFormula, numberDisplayHint,
  } = property;
  const payload = {
    name, label, type, fieldType, description, groupName, options,
    displayOrder, formField, readOnlyValue, readOnlyDefinition,
    hidden, searchable, hubspotDefined, hasUniqueValue,
    externalOptions, isCustomizedDefault, showCurrencySymbol,
    calculationFormula, numberDisplayHint,
  };
  // Remove undefined values.
  return Object.fromEntries(Object.entries(payload).filter(([, v]) => v !== undefined));
}

async function pushPropertiesAndGroups(objectTypeId, bundle, client) {
  // Push missing property groups.
  const existingGroups = await client.crm.properties.groupsApi.getAll(objectTypeId);
  const existingGroupNames = new Set((existingGroups.results || []).map(g => g.name));
  for (const group of bundle.propertyGroups || []) {
    if (!existingGroupNames.has(group.name)) {
      try {
        await client.crm.properties.groupsApi.create(objectTypeId, {
          name: group.name,
          label: group.label,
          displayOrder: group.displayOrder,
        });
        console.log(`  + group ${group.name}`);
      } catch (e) {
        console.error(`  ✗ group ${group.name}: ${e.body?.message || e.message}`);
      }
    }
  }

  // Push missing or changed properties.
  const existingProperties = await client.crm.properties.coreApi.getAll(objectTypeId);
  const existingByName = new Map((existingProperties.results || []).map(p => [p.name, p]));

  for (const property of bundle.properties || []) {
    const existing = existingByName.get(property.name);
    if (!existing) {
      try {
        await client.crm.properties.coreApi.create(objectTypeId, stripPropertyForCreate(property));
        console.log(`  + property ${property.name}`);
      } catch (e) {
        console.error(`  ✗ property ${property.name}: ${e.body?.message || e.message}`);
      }
    } else if (propertyChanged(existing, property)) {
      try {
        await client.crm.properties.coreApi.update(objectTypeId, property.name, stripPropertyForUpdate(property));
        console.log(`  ~ property ${property.name}`);
      } catch (e) {
        console.error(`  ✗ property ${property.name}: ${e.body?.message || e.message}`);
      }
    }
  }
}

function stripPropertyForUpdate(property) {
  // Update accepts an even smaller subset.
  const {
    label, description, groupName, options, displayOrder,
    formField, readOnlyValue, readOnlyDefinition, hidden,
    searchable, hasUniqueValue,
  } = property;
  return Object.fromEntries(Object.entries({
    label, description, groupName, options, displayOrder,
    formField, readOnlyValue, readOnlyDefinition, hidden,
    searchable, hasUniqueValue,
  }).filter(([, v]) => v !== undefined));
}

function propertyChanged(remote, local) {
  const fields = ['label', 'description', 'groupName', 'displayOrder', 'hidden', 'searchable', 'options'];
  for (const f of fields) {
    if (JSON.stringify(remote[f]) !== JSON.stringify(local[f])) return true;
  }
  return false;
}

export async function diffObject(target, baseDir, envName, manifest, client) {
  const dir = objectsDir(baseDir);

  if (target === '--all') {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      : [];
    if (files.length === 0) {
      console.log(`No .json files found in ${dir}`);
      return 0;
    }
    let hasChanges = false;
    for (const filename of files) {
      const changed = await diffObjectFile(path.join(dir, filename), envName, manifest, client);
      if (changed) hasChanges = true;
    }
    return hasChanges ? 1 : 0;
  }

  const filepath = target.endsWith('.json') ? target : path.join(dir, `${slugify(target)}.json`);
  if (!fs.existsSync(filepath)) {
    console.error(`Object bundle not found: ${filepath}`);
    return 1;
  }
  return await diffObjectFile(filepath, envName, manifest, client) ? 1 : 0;
}

async function diffObjectFile(filepath, envName, manifest, client) {
  const filename = path.basename(filepath);
  const label = `${filename} vs remote (env: ${envName})`;

  let local;
  try {
    local = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`Error reading ${filepath}: ${e.message}`);
    return false;
  }

  const section = getSection(manifest, envName, 'objects');
  const fqn = section[filename] ?? local.fullyQualifiedName;

  let remoteSchema;
  try {
    const all = await client.crm.schemas.coreApi.getAll();
    remoteSchema = all.results.find(s => s.fullyQualifiedName === fqn || s.objectTypeId === fqn);
  } catch (e) {
    console.error(`${label}: failed to fetch remote schemas`);
    return false;
  }

  if (!remoteSchema) {
    console.log(`${label}: not found on remote (not yet pushed)`);
    return false;
  }

  const [remoteGroupsResponse, remotePropertiesResponse] = await Promise.all([
    client.crm.properties.groupsApi.getAll(remoteSchema.objectTypeId),
    client.crm.properties.coreApi.getAll(remoteSchema.objectTypeId),
  ]);

  const remote = {
    labels: remoteSchema.labels,
    primaryDisplayProperty: remoteSchema.primaryDisplayProperty,
    requiredProperties: remoteSchema.requiredProperties,
    searchableProperties: remoteSchema.searchableProperties,
    propertyGroups: (remoteGroupsResponse.results || []).map(g => ({
      name: g.name, label: g.label, displayOrder: g.displayOrder, target: g.target,
    })),
    properties: (remotePropertiesResponse.results || []).map(p => cleanProperty(p)),
  };

  const sparse = local.pullMode === 'sparse';
  const changes = [];

  if (JSON.stringify(local.labels) !== JSON.stringify(remote.labels)) {
    changes.push(`labels: ${JSON.stringify(remote.labels)} -> ${JSON.stringify(local.labels)}`);
  }

  const localGroups = new Map((local.propertyGroups || []).map(g => [g.name, g]));
  const remoteGroups = new Map((remote.propertyGroups || []).map(g => [g.name, g]));
  for (const [name, g] of localGroups) {
    if (!remoteGroups.has(name)) changes.push(`+ property group ${name}`);
    else if (JSON.stringify(g) !== JSON.stringify(remoteGroups.get(name))) changes.push(`~ property group ${name}`);
  }
  if (!sparse) {
    for (const name of remoteGroups.keys()) {
      if (!localGroups.has(name)) changes.push(`- property group ${name}`);
    }
  }

  const localProps = new Map((local.properties || []).map(p => [p.name, p]));
  const remoteProps = new Map((remote.properties || []).map(p => [p.name, p]));
  for (const [name, p] of localProps) {
    if (!remoteProps.has(name)) changes.push(`+ property ${name}`);
    else if (propertyChanged(remoteProps.get(name), p)) changes.push(`~ property ${name}`);
  }
  if (!sparse) {
    for (const name of remoteProps.keys()) {
      if (!localProps.has(name)) changes.push(`- property ${name}`);
    }
  }

  if (changes.length === 0) {
    console.log(`${label}: up to date`);
    return false;
  }

  console.log(`${label}\n`);
  for (const c of changes) console.log(`  ${c}`);
  return true;
}
