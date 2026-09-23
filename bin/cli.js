#!/usr/bin/env node

import { runHubspot } from '../lib/run.js';
import { parseGlobalFlags, loadEnvFile, buildEnv, deriveEnvName } from '../lib/env.js';
import { pullObject, pullAllObjects, fetchObjectBundle, readObjectBundle, listLocalObjectFiles } from '../lib/objects.js';
import { diffObjectBundles, hasDifferences, formatObjectDiff } from '../lib/diff.js';
import { pushObject } from '../lib/push.js';

const { remaining: args, envFile, envName, dir, all, full, force } = parseGlobalFlags(process.argv.slice(2));

loadEnvFile(envFile, envName);
const env = buildEnv();
const currentEnvName = deriveEnvName(envFile, envName);

// Populated as config-as-code resource commands (objects, pipelines,
// associations, views, workflows) are added on top of the official
// hubspot CLI.
const ADDED_COMMANDS = [
  'objects pull <type> / --all   Save an object\'s schema + property groups + properties to hubspot/objects/',
  'objects diff <file> / --all   Compare a local object bundle against remote',
  'objects push <file> / --all   Create/update an object\'s schema, property groups, and properties',
];

// top-level --help / -h / no args
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  let banner =
    'This is a custom wrapper around the official hubspot Agent CLI.\n' +
    'All standard hubspot commands pass through unchanged.\n';

  if (ADDED_COMMANDS.length > 0) {
    banner += '\nADDED COMMANDS\n' + ADDED_COMMANDS.map((line) => `  ${line}\n`).join('');
  }

  process.stdout.write(banner + '\n');

  const result = runHubspot(args.length === 0 ? ['--help'] : args, { env, stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// objects pull <type> / --all
if (args[0] === 'objects' && args[1] === 'pull') {
  const type = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!type && !all) {
    console.error('Usage: hubspot-cli objects pull <type>');
    console.error('       hubspot-cli objects pull --all');
    process.exit(1);
  }

  if (all) {
    const results = await pullAllObjects({ full, dir, env, envName: currentEnvName });
    let failed = false;
    for (const r of results) {
      if (r.ok) {
        console.log(`Pulled ${r.type} -> ${r.filePath}`);
      } else {
        failed = true;
        console.error(`Failed ${r.type}: ${r.error}`);
      }
    }
    process.exit(failed ? 1 : 0);
  } else {
    const filePath = await pullObject(type, { full, dir, env, envName: currentEnvName });
    console.log(`Pulled ${type} -> ${filePath}`);
    process.exit(0);
  }
}

// objects diff <file> / --all
if (args[0] === 'objects' && args[1] === 'diff') {
  const file = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!file && !all) {
    console.error('Usage: hubspot-cli objects diff <file>');
    console.error('       hubspot-cli objects diff --all');
    process.exit(1);
  }

  async function diffOne(filePath) {
    const local = readObjectBundle(filePath);
    const remote = await fetchObjectBundle(local.name, { full: local.full, env });
    const diff = diffObjectBundles(local, remote);
    const differs = hasDifferences(diff);
    console.log(formatObjectDiff(diff, `${filePath} vs remote (env: ${currentEnvName})`));
    console.log();
    return differs;
  }

  const files = all ? listLocalObjectFiles(dir) : [file];
  let anyDiffer = false;
  for (const f of files) {
    if (await diffOne(f)) anyDiffer = true;
  }
  process.exit(anyDiffer ? 1 : 0);
}

// objects push <file> / --all
if (args[0] === 'objects' && args[1] === 'push') {
  const file = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!file && !all) {
    console.error('Usage: hubspot-cli objects push <file>');
    console.error('       hubspot-cli objects push --all');
    process.exit(1);
  }

  async function pushOne(filePath) {
    try {
      const { objectTypeId, messages } = await pushObject(filePath, { env, envName: currentEnvName, force });
      console.log(`${filePath} -> ${objectTypeId}`);
      for (const m of messages) console.log(`  ${m}`);
      return true;
    } catch (err) {
      console.error(`${filePath}: ${err.message}`);
      return false;
    }
  }

  const files = all ? listLocalObjectFiles(dir) : [file];
  let anyFailed = false;
  for (const f of files) {
    if (!(await pushOne(f))) anyFailed = true;
  }
  process.exit(anyFailed ? 1 : 0);
}

// Everything else passes straight through to the real hubspot binary.
const result = runHubspot(args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
