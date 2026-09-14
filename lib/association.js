import fs from 'fs';
import path from 'path';
import { ensureDir, slugify } from './util.js';
import { getSection } from './manifest.js';

const DEFAULT_ASSOCIATIONS_DIR = 'associations';

function associationsDir(baseDir) {
  return path.join(baseDir, DEFAULT_ASSOCIATIONS_DIR);
}

export async function listAssociations(client) {
  const response = await client.crm.associations.v4.schema.definitionsApi.getAll(false);
  return (response.results || []).map(def => ({
    fromObjectType: def.fromObjectType,
    toObjectType: def.toObjectType,
    name: def.name,
    typeId: def.typeId,
    category: def.category,
    label: def.label,
    pluralLabel: def.pluralLabel,
    inverseLabel: def.inverseLabel,
    inversePluralLabel: def.inversePluralLabel,
    updatedAt: def.updatedAt,
    createdAt: def.createdAt,
  }));
}

export async function pullAssociations(fromType, toType, baseDir, envName, manifest, client) {
  const dir = associationsDir(baseDir);
  ensureDir(dir);

  if (!fromType) {
    // Pull all association definitions into one file per from-to pair.
    const all = await client.crm.associations.v4.schema.definitionsApi.getAll(false);
    const byPair = new Map();
    for (const def of all.results || []) {
      const key = `${def.fromObjectType}_${def.toObjectType}`;
      if (!byPair.has(key)) byPair.set(key, []);
      byPair.get(key).push(def);
    }

    console.log(`Pulling ${byPair.size} association pair(s) to ${dir}`);
    let ok = 0;
    for (const [key, definitions] of byPair) {
      const filename = `${slugify(key)}.json`;
      const filepath = path.join(dir, filename);
      const bundle = {
        fromObjectType: definitions[0].fromObjectType,
        toObjectType: definitions[0].toObjectType,
        associations: definitions.map(definitionToSummary),
      };
      fs.writeFileSync(filepath, JSON.stringify(bundle, null, 2) + '\n');
      getSection(manifest, envName, 'associations')[filename] = key;
      console.log(`Saved to ${filepath}`);
      ok++;
    }
    return true;
  }

  // Pull single pair.
  const response = await client.crm.associations.v4.schema.definitionsApi.getAll(false);
  const definitions = (response.results || []).filter(d =>
    d.fromObjectType === fromType && d.toObjectType === toType,
  );

  if (definitions.length === 0) {
    console.error(`No association definitions found for ${fromType} -> ${toType}`);
    return false;
  }

  const key = `${fromType}_${toType}`;
  const filename = `${slugify(key)}.json`;
  const filepath = path.join(dir, filename);
  const bundle = {
    fromObjectType,
    toObjectType,
    associations: definitions.map(definitionToSummary),
  };
  fs.writeFileSync(filepath, JSON.stringify(bundle, null, 2) + '\n');
  getSection(manifest, envName, 'associations')[filename] = key;
  console.log(`Saved to ${filepath}`);
  return true;
}

function definitionToSummary(def) {
  return {
    name: def.name,
    typeId: def.typeId,
    category: def.category,
    label: def.label,
    pluralLabel: def.pluralLabel,
    inverseLabel: def.inverseLabel,
    inversePluralLabel: def.inversePluralLabel,
  };
}

export async function pushAssociations(target, baseDir, envName, manifest, client) {
  const dir = associationsDir(baseDir);

  if (target === '--all') {
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => f.endsWith('.json'))
      : [];
    if (files.length === 0) {
      console.log(`No .json files found in ${dir}`);
      return true;
    }
    console.log(`Pushing ${files.length} association bundle(s) to env: ${envName}\n`);
    let created = 0, skipped = 0, failed = 0;
    for (const filename of files) {
      const result = await pushAssociationFile(path.join(dir, filename), manifest, client);
      if (result === 'created') created++;
      else if (result === 'skipped') skipped++;
      else failed++;
    }
    console.log(`\n${created} created, ${skipped} skipped${failed > 0 ? `, ${failed} failed` : ''}`);
    return failed === 0;
  }

  const filepath = target.endsWith('.json') ? target : path.join(dir, `${slugify(target)}.json`);
  if (!fs.existsSync(filepath)) {
    console.error(`Association bundle not found: ${filepath}`);
    return false;
  }
  const result = await pushAssociationFile(filepath, manifest, client);
  return result !== 'failed';
}

async function pushAssociationFile(filepath, manifest, client) {
  const filename = path.basename(filepath);
  let bundle;
  try {
    bundle = JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch (e) {
    console.error(`✗ ${filename}: ${e.message}`);
    return 'failed';
  }

  const { fromObjectType, toObjectType, associations } = bundle;
  if (!fromObjectType || !toObjectType || !Array.isArray(associations)) {
    console.error(`✗ ${filename}: invalid bundle (missing fromObjectType, toObjectType, or associations)`);
    return 'failed';
  }

  try {
    const existingResp = await client.crm.associations.v4.schema.definitionsApi.getAll(false);
    const existing = (existingResp.results || []).filter(d =>
      d.fromObjectType === fromObjectType && d.toObjectType === toObjectType,
    );
    const existingNames = new Set(existing.map(e => e.name));

    let createdCount = 0;
    for (const assoc of associations) {
      if (existingNames.has(assoc.name)) continue;

      await client.crm.associations.v4.schema.definitionsApi.create(
        fromObjectType,
        toObjectType,
        {
          name: assoc.name,
          label: assoc.label,
          inverseLabel: assoc.inverseLabel,
        },
      );
      createdCount++;
      console.log(`  + ${assoc.name}`);
    }

    if (createdCount === 0) {
      console.log(`Skipped  ${filename} (all associations exist)`);
      return 'skipped';
    }
    console.log(`Created  ${filename} (${createdCount} association type(s))`);
    return 'created';
  } catch (e) {
    console.error(`✗ ${filename}: ${e.body?.message || e.message}`);
    return 'failed';
  }
}
