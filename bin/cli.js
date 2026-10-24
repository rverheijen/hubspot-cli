#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { runHubspot } from '../lib/run.js';
import { parseGlobalFlags, loadEnvFile, buildEnv, deriveEnvName } from '../lib/env.js';
import { pullObject, pullAllObjects, fetchObjectBundle, readObjectBundle, listLocalObjectFiles, objectFullBundlePath } from '../lib/objects.js';
import { diffObjectBundles, hasDifferences, formatObjectDiff } from '../lib/diff.js';
import { pushObject } from '../lib/push.js';
import {
  fetchAssociationBundle, readAssociationBundle, writeAssociationBundle,
  diffAssociationBundle, hasAssociationDifferences, formatAssociationDiff,
  pushAssociationBundle, listLocalAssociationFiles, associationFilePath,
} from '../lib/associations.js';
import { fetchObjectValidations, fetchPropertyValidations, fetchValidationRule, setValidationRule } from '../lib/validations.js';

const { remaining: args, envFile, envName, dir, all, full, both, force } = parseGlobalFlags(process.argv.slice(2));

loadEnvFile(envFile, envName);
const env = buildEnv();
const currentEnvName = deriveEnvName(envFile, envName);

// Populated as config-as-code resource commands (objects, pipelines,
// associations, views, workflows) are added on top of the official
// hubspot CLI.
const ADDED_COMMANDS = [
  'objects pull <type> / --all   Save an object\'s schema + property groups + properties to hubspot/objects/',
  'objects pull --both           Alongside --all or <type>: also write a full-reference <type>.full.json',
  'objects diff <file> / --all   Compare a local object bundle against remote',
  'objects push <file> / --all   Create/update an object\'s schema, property groups, and properties',
  'associations pull --from <type> --to <type> / --all   Save custom labels + limits to hubspot/associations/',
  'associations diff <file> / --all   Compare a local association bundle against remote',
  'associations push <file>   Create missing labels and apply limits for one from->to pair',
  'properties validations list --type <object> [--name <property>]   List validation rules (object-wide or one property)',
  'properties validations get --type <object> --name <property> --rule-type <TYPE>   Show one validation rule',
  'properties validations set --type <object> --name <property> --rule-type <TYPE> --args <v> [--args <v> ...]   Create/replace one validation rule',
  'skill install [--global]   Write the hubspot-cli reference skill to .claude/skills/ (or ~/.claude/skills/ with --global)',
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

// skill install [--global]
if (args[0] === 'skill' && args[1] === 'install') {
  const global = args.includes('--global');
  const targetDir = global
    ? path.join(os.homedir(), '.claude', 'skills', 'hubspot-cli')
    : path.join('.claude', 'skills', 'hubspot-cli');
  const targetPath = path.join(targetDir, 'SKILL.md');

  // The official hubspot binary has no skill install command of its own to
  // extend (unlike n8n-cli, which passes through to @n8n/cli's own skill
  // install then appends a wrapper-extension file onto the same generated
  // SKILL.md) - this is a fully standalone skill instead, written directly,
  // same pattern as the existing hubspot-naming-conventions skill (issue #7).
  const contentPath = fileURLToPath(new URL('../lib/skill-content.md', import.meta.url));
  const content = fs.readFileSync(contentPath, 'utf8');

  fs.mkdirSync(targetDir, { recursive: true });
  fs.writeFileSync(targetPath, content);
  console.log(`Installed to ${targetPath}`);
  process.exit(0);
}

// objects pull <type> / --all
if (args[0] === 'objects' && args[1] === 'pull') {
  const type = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!type && !all) {
    console.error('Usage: hubspot-cli objects pull <type>');
    console.error('       hubspot-cli objects pull --all');
    process.exit(1);
  }

  if (full && both) {
    console.error('--full and --both are mutually exclusive: --both already writes both forms.');
    process.exit(1);
  }

  if (all) {
    const results = await pullAllObjects({ full, both, dir, env, envName: currentEnvName });
    let failed = false;
    for (const r of results) {
      if (r.ok) {
        console.log(`Pulled ${r.type} -> ${r.filePath}`);
        if (both) console.log(`  (full reference -> ${objectFullBundlePath(r.type, dir)})`);
      } else {
        failed = true;
        console.error(`Failed ${r.type}: ${r.error}`);
      }
    }
    process.exit(failed ? 1 : 0);
  } else {
    const filePath = await pullObject(type, { full, both, dir, env, envName: currentEnvName });
    console.log(`Pulled ${type} -> ${filePath}`);
    if (both) console.log(`  (full reference -> ${objectFullBundlePath(type, dir)})`);
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
      // err.messages/.objectTypeId are attached by pushObject on a partial
      // property-level failure, so progress that did succeed is still
      // visible here instead of being silently lost behind the error.
      if (err.objectTypeId) console.log(`${filePath} -> ${err.objectTypeId}`);
      if (err.messages) for (const m of err.messages) console.log(`  ${m}`);
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

// associations pull --from <type> --to <type> / --all
if (args[0] === 'associations' && args[1] === 'pull') {
  let from = null;
  let to = null;
  for (let i = 2; i < args.length; i++) {
    if (args[i] === '--from') from = args[++i];
    else if (args[i] === '--to') to = args[++i];
  }

  if (all) {
    const files = listLocalAssociationFiles(dir);
    let anyFailed = false;
    for (const f of files) {
      const existing = readAssociationBundle(f);
      try {
        const bundle = await fetchAssociationBundle(existing.from, existing.to, env);
        writeAssociationBundle(f, bundle);
        console.log(`Pulled ${existing.from}-${existing.to} -> ${f}`);
      } catch (err) {
        anyFailed = true;
        console.error(`Failed ${existing.from}-${existing.to}: ${err.message}`);
      }
    }
    process.exit(anyFailed ? 1 : 0);
  }

  if (!from || !to) {
    console.error('Usage: hubspot-cli associations pull --from <type> --to <type>');
    console.error('       hubspot-cli associations pull --all');
    process.exit(1);
  }

  const bundle = await fetchAssociationBundle(from, to, env);
  const filePath = associationFilePath(from, to, dir);
  writeAssociationBundle(filePath, bundle);
  console.log(`Pulled ${from}-${to} -> ${filePath}`);
  process.exit(0);
}

// associations diff <file> / --all
if (args[0] === 'associations' && args[1] === 'diff') {
  const file = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!file && !all) {
    console.error('Usage: hubspot-cli associations diff <file>');
    console.error('       hubspot-cli associations diff --all');
    process.exit(1);
  }

  async function diffAssociationOne(filePath) {
    const local = readAssociationBundle(filePath);
    const remote = await fetchAssociationBundle(local.from, local.to, env);
    const diff = diffAssociationBundle(local, remote);
    const differs = hasAssociationDifferences(diff);
    console.log(formatAssociationDiff(diff, `${filePath} vs remote (env: ${currentEnvName})`));
    console.log();
    return differs;
  }

  const files = all ? listLocalAssociationFiles(dir) : [file];
  let anyAssociationDiffers = false;
  for (const f of files) {
    try {
      if (await diffAssociationOne(f)) anyAssociationDiffers = true;
    } catch (err) {
      anyAssociationDiffers = true;
      console.error(`${f}: ${err.message}`);
    }
  }
  process.exit(anyAssociationDiffers ? 1 : 0);
}

// associations push <file>
if (args[0] === 'associations' && args[1] === 'push') {
  const file = args[2] && !args[2].startsWith('--') ? args[2] : null;

  if (!file) {
    console.error('Usage: hubspot-cli associations push <file>');
    process.exit(1);
  }

  try {
    const { messages } = await pushAssociationBundle(file, { env });
    console.log(file);
    for (const m of messages) console.log(`  ${m}`);
    process.exit(0);
  } catch (err) {
    console.error(`${file}: ${err.message}`);
    process.exit(1);
  }
}

// properties validations list / get / set
if (args[0] === 'properties' && args[1] === 'validations') {
  const subcommand = args[2];
  let type = null;
  let name = null;
  let ruleType = null;
  const ruleArguments = [];
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--type') type = args[++i];
    else if (args[i] === '--name') name = args[++i];
    else if (args[i] === '--rule-type') ruleType = args[++i];
    else if (args[i] === '--args') ruleArguments.push(args[++i]);
  }

  if (subcommand === 'list') {
    if (!type) {
      console.error('Usage: hubspot-cli properties validations list --type <object> [--name <property>]');
      process.exit(1);
    }
    try {
      if (name) {
        const rules = await fetchPropertyValidations(type, name, env);
        console.log(JSON.stringify(rules, null, 2));
      } else {
        const results = await fetchObjectValidations(type, env);
        console.log(JSON.stringify(results, null, 2));
      }
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (subcommand === 'get') {
    if (!type || !name || !ruleType) {
      console.error('Usage: hubspot-cli properties validations get --type <object> --name <property> --rule-type <TYPE>');
      process.exit(1);
    }
    try {
      const rule = await fetchValidationRule(type, name, ruleType, env);
      if (!rule) {
        console.error(`No ${ruleType} rule set on ${type}.${name}`);
        process.exit(1);
      }
      console.log(JSON.stringify(rule, null, 2));
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  if (subcommand === 'set') {
    if (!type || !name || !ruleType || ruleArguments.length === 0) {
      console.error('Usage: hubspot-cli properties validations set --type <object> --name <property> --rule-type <TYPE> --args <v> [--args <v> ...]');
      process.exit(1);
    }
    try {
      await setValidationRule(type, name, ruleType, ruleArguments, env);
      console.log(`~ ${type}.${name}: ${ruleType} rule set`);
      process.exit(0);
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  console.error('Usage: hubspot-cli properties validations <list|get|set> ...');
  process.exit(1);
}

// Everything else passes straight through to the real hubspot binary.
const result = runHubspot(args, { env, stdio: 'inherit' });
process.exit(result.status ?? 1);
