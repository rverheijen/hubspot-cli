export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'unnamed';
}

export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // ignore
  }
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, data) {
  const dir = path.dirname(file);
  ensureDir(dir);
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

// Re-export fs/path helpers so modules can import everything from util.js
import fs from 'fs';
import path from 'path';
export { fs, path };
