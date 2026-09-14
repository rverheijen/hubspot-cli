import fs from 'fs';
import path from 'path';
import { ensureDir, slugify } from './util.js';
import { getSection } from './manifest.js';

const DEFAULT_PIPELINES_DIR = 'pipelines';

function pipelinesDir(baseDir) {
  return path.join(baseDir, DEFAULT_PIPELINES_DIR);
}

export async function listPipelines(client, objectType) {
  const response = await client.crm.pipelines.pipelinesApi.getAll(objectType);
  return (response.results || []).map(p => ({
    id: p.id,
    label: p.label,
    displayOrder: p.displayOrder,
    active: p.active,
    stages: (p.stages || []).map(s => ({
      id: s.id,
      label: s.label,
      displayOrder: s.displayOrder,
      metadata: s.metadata,
      active: s.active,
    })),
  }));
}

export async function pullPipelines(objectType, baseDir, envName, manifest, client) {
  const dir = path.join(pipelinesDir(baseDir), slugify(objectType));
  ensureDir(dir);

  const response = await client.crm.pipelines.pipelinesApi.getAll(objectType);
  const pipelines = response.results || [];

  console.log(`Pulling ${pipelines.length} pipeline(s) for ${objectType} to ${dir}`);

  const section = getSection(manifest, envName, 'pipelines');
  if (!section[objectType]) section[objectType] = {};

  let ok = 0, failed = 0;
  for (const pipeline of pipelines) {
    try {
      const filename = `${slugify(pipeline.label)}.json`;
      const filepath = path.join(dir, filename);
      const bundle = {
        objectType,
        id: pipeline.id,
        label: pipeline.label,
        displayOrder: pipeline.displayOrder,
        active: pipeline.active,
        stages: (pipeline.stages || []).map(s => ({
          id: s.id,
          label: s.label,
          displayOrder: s.displayOrder,
          metadata: s.metadata,
          active: s.active,
        })),
      };
      fs.writeFileSync(filepath, JSON.stringify(bundle, null, 2) + '\n');
      section[objectType][filename] = pipeline.id;
      console.log(`Saved to ${filepath}`);
      ok++;
    } catch (e) {
      console.error(`  ✗ ${pipeline.label}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${ok} pulled${failed > 0 ? `, ${failed} failed` : ''}`);
  return failed === 0;
}

export async function pushPipelines(objectType, baseDir, envName, manifest, client) {
  const dir = path.join(pipelinesDir(baseDir), slugify(objectType));
  if (!fs.existsSync(dir)) {
    console.log(`No pipelines directory for ${objectType}: ${dir}`);
    return true;
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log(`No .json files found in ${dir}`);
    return true;
  }

  console.log(`Pushing ${files.length} pipeline(s) for ${objectType} to env: ${envName}\n`);

  const existingResp = await client.crm.pipelines.pipelinesApi.getAll(objectType);
  const existingByLabel = new Map((existingResp.results || []).map(p => [p.label, p]));

  const section = getSection(manifest, envName, 'pipelines');
  if (!section[objectType]) section[objectType] = {};

  let created = 0, updated = 0, failed = 0;
  for (const filename of files) {
    const filepath = path.join(dir, filename);
    let bundle;
    try {
      bundle = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    } catch (e) {
      console.error(`✗ ${filename}: ${e.message}`);
      failed++;
      continue;
    }

    try {
      const existing = existingByLabel.get(bundle.label);
      if (existing) {
        // Update pipeline label / stages.
        await client.crm.pipelines.pipelinesApi.update(objectType, existing.id, {
          label: bundle.label,
          displayOrder: bundle.displayOrder,
          active: bundle.active,
        });

        const existingStageLabels = new Map((existing.stages || []).map(s => [s.label, s]));
        for (const stage of bundle.stages || []) {
          const existingStage = existingStageLabels.get(stage.label);
          if (existingStage) {
            await client.crm.pipelines.stagesApi.update(objectType, existing.id, existingStage.id, {
              label: stage.label,
              displayOrder: stage.displayOrder,
              metadata: stage.metadata,
              active: stage.active,
            });
          } else {
            await client.crm.pipelines.stagesApi.create(objectType, existing.id, {
              label: stage.label,
              displayOrder: stage.displayOrder,
              metadata: stage.metadata,
              active: stage.active,
            });
          }
        }
        section[objectType][filename] = existing.id;
        console.log(`Updated  ${bundle.label}`);
        updated++;
      } else {
        const createdPipeline = await client.crm.pipelines.pipelinesApi.create(objectType, {
          label: bundle.label,
          displayOrder: bundle.displayOrder,
          active: bundle.active,
          stages: (bundle.stages || []).map(s => ({
            label: s.label,
            displayOrder: s.displayOrder,
            metadata: s.metadata,
            active: s.active,
          })),
        });
        section[objectType][filename] = createdPipeline.id;
        console.log(`Created  ${bundle.label}`);
        created++;
      }
    } catch (e) {
      console.error(`✗ ${filename}: ${e.body?.message || e.message}`);
      failed++;
    }
  }

  console.log(`\n${created} created, ${updated} updated${failed > 0 ? `, ${failed} failed` : ''}`);
  return failed === 0;
}
