#!/usr/bin/env node

import { runHubspot } from '../lib/run.js';

const args = process.argv.slice(2);

// Populated as config-as-code resource commands (schemas, properties,
// pipelines, associations, views, workflows) are added on top of the
// official hubspot CLI.
const ADDED_COMMANDS = [];

// top-level --help / -h / no args
if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  let banner =
    'This is a custom wrapper around the official hubspot Agent CLI.\n' +
    'All standard hubspot commands pass through unchanged.\n';

  if (ADDED_COMMANDS.length > 0) {
    banner += '\nADDED COMMANDS\n' + ADDED_COMMANDS.map((line) => `  ${line}\n`).join('');
  }

  process.stdout.write(banner + '\n');

  const result = runHubspot(args.length === 0 ? ['--help'] : args, { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// Everything else passes straight through to the real hubspot binary.
const result = runHubspot(args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
