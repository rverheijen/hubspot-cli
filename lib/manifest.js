import fs from 'fs';

const MANIFEST_DIR = '.hubspot_cli';
const MANIFEST_PATH = path.join(MANIFEST_DIR, 'manifest.json');

import path from 'path';

export function readManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export function writeManifest(manifest) {
  fs.mkdirSync(MANIFEST_DIR, { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

export function getSection(manifest, envName, section) {
  if (!manifest[envName]) manifest[envName] = {};
  if (!manifest[envName][section]) manifest[envName][section] = {};
  return manifest[envName][section];
}
