#!/usr/bin/env node

import { runHubspot } from '../lib/run.js';
import { parseGlobalFlags, loadEnvFile, buildEnv, deriveEnvName } from '../lib/env.js';
import { pullObject, pullAllObjects } from '../lib/objects.js';

const { remaining: args, envFile, envName, dir, all, full } = parseGlobalFlags(process.argv.slice(2));

loadEnvFile(envFile, envName);
const env = buildEnv();
const currentEnvName = deriveEnvName(envFile, envName);

// Populated as config-as-code resource commands (objects, pipelines,
// associations, views, workflows) are added on top of the official
// hubspot CLI.
const ADDED_COMMANDS = [
  'objects pull <type> / --all   Save an object\'s schema + property groups + properties to hubspot/objects/',
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

// Everything else passes straight through to the real hubspot binary.
const result = runHubspot(args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
