#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

import { parseGlobalFlags, loadEnvFile, buildEnv, deriveEnvName } from '../lib/env.js';
import { readManifest, writeManifest } from '../lib/manifest.js';
import { createClient } from '../lib/client.js';
import { slugify } from '../lib/util.js';
import { listObjects, pullObject, pushObject, diffObject } from '../lib/object.js';
import { listAssociations, pullAssociations, pushAssociations } from '../lib/association.js';
import { listPipelines, pullPipelines, pushPipelines } from '../lib/pipeline.js';
import { listUsers } from '../lib/user.js';
import { listTeams } from '../lib/team.js';

const { remaining: args, envFile, envName, dir, all, allProps } = parseGlobalFlags(process.argv.slice(2));

loadEnvFile(envFile, envName);

const env = buildEnv();
const currentEnvName = deriveEnvName(envFile, envName);
const baseDir = dir ?? 'hubspot';

function usage() {
  console.log(`hubspot-cli – data-engineering wrapper for HubSpot

USAGE
  $ hubspot-cli <resource> <action> [args] [flags]

RESOURCES
  object        CRM object schemas, property groups, and properties
  association   Association types and labels between objects
  pipeline      Pipelines and stages for objects that support them
  user          Read users from the portal
  team          Read teams from the portal

ACTIONS
  list          List remote items
  pull          Fetch remote item(s) and save to disk
  push          Push local item(s) to the remote portal
  diff          Compare local item(s) against remote

GLOBAL FLAGS
  --env <name>       Environment name (loads .env.<name> if present)
  --env-file <path>  Load a specific .env file
  --dir <path>       Override the default source/target directory (default: ./${baseDir})
  --all              Operate on all items in the target directory
  --all-props        On pull, include all standard properties (default: only custom/modified)

ENVIRONMENT
  HUBSPOT_ACCESS_TOKEN    Private App access token for the target portal
  HUBSPOT_ENV             Optional default environment label
`);
}

function commandHelp() {
  console.log(`Object commands
  $ hubspot-cli object list
  $ hubspot-cli object pull <object>        # e.g. contacts, companies, deals, p_customobject
  $ hubspot-cli object pull --all
  $ hubspot-cli object pull <object> --all-props    # include all standard properties
  $ hubspot-cli object push <file>
  $ hubspot-cli object push --all
  $ hubspot-cli object diff <file>
  $ hubspot-cli object diff --all

Association commands
  $ hubspot-cli association list
  $ hubspot-cli association pull <fromObjectType> <toObjectType>
  $ hubspot-cli association push <file>
  $ hubspot-cli association push --all

Pipeline commands
  $ hubspot-cli pipeline list <objectType>
  $ hubspot-cli pipeline pull <objectType> [--dir <path>]
  $ hubspot-cli pipeline push <objectType> [--dir <path>]

User / team commands
  $ hubspot-cli user list
  $ hubspot-cli team list
`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  usage();
  process.exit(0);
}

if (args[0] === 'help') {
  usage();
  commandHelp();
  process.exit(0);
}

const client = createClient(env);
const manifest = readManifest();

const resource = args[0];
const action = args[1];

async function run() {
  try {
    if (resource === 'object') {
      if (action === 'list') {
        const objects = await listObjects(client);
        console.log(JSON.stringify(objects, null, 2));
        return 0;
      }

      if (action === 'pull' && all) {
        const ok = await pullObject('--all', baseDir, currentEnvName, manifest, client, { allProps });
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'pull') {
        const objectType = args[2];
        if (!objectType) { console.error('Usage: hubspot-cli object pull <objectType>'); return 1; }
        const ok = await pullObject(objectType, baseDir, currentEnvName, manifest, client, { allProps });
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'push' && all) {
        const ok = await pushObject('--all', baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'push') {
        const file = args.slice(2).find(a => !a.startsWith('-'));
        if (!file) { console.error('Usage: hubspot-cli object push <file>'); return 1; }
        const ok = await pushObject(file, baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'diff' && all) {
        return await diffObject('--all', baseDir, currentEnvName, manifest, client);
      }

      if (action === 'diff') {
        const file = args.slice(2).find(a => !a.startsWith('-'));
        if (!file) { console.error('Usage: hubspot-cli object diff <file>'); return 1; }
        return await diffObject(file, baseDir, currentEnvName, manifest, client);
      }
    }

    if (resource === 'association') {
      if (action === 'list') {
        const associations = await listAssociations(client);
        console.log(JSON.stringify(associations, null, 2));
        return 0;
      }

      if (action === 'pull') {
        const fromType = args[2];
        const toType = args[3];
        const ok = await pullAssociations(fromType, toType, baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'push' && all) {
        const ok = await pushAssociations('--all', baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'push') {
        const file = args.slice(2).find(a => !a.startsWith('-'));
        if (!file) { console.error('Usage: hubspot-cli association push <file>'); return 1; }
        const ok = await pushAssociations(file, baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }
    }

    if (resource === 'pipeline') {
      if (action === 'list') {
        const objectType = args[2];
        if (!objectType) { console.error('Usage: hubspot-cli pipeline list <objectType>'); return 1; }
        const pipelines = await listPipelines(client, objectType);
        console.log(JSON.stringify(pipelines, null, 2));
        return 0;
      }

      if (action === 'pull') {
        const objectType = args[2];
        if (!objectType) { console.error('Usage: hubspot-cli pipeline pull <objectType>'); return 1; }
        const ok = await pullPipelines(objectType, baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }

      if (action === 'push') {
        const objectType = args[2];
        if (!objectType) { console.error('Usage: hubspot-cli pipeline push <objectType>'); return 1; }
        const ok = await pushPipelines(objectType, baseDir, currentEnvName, manifest, client);
        writeManifest(manifest);
        return ok ? 0 : 1;
      }
    }

    if (resource === 'user' && action === 'list') {
      const users = await listUsers(client);
      console.log(JSON.stringify(users, null, 2));
      return 0;
    }

    if (resource === 'team' && action === 'list') {
      const teams = await listTeams(client);
      console.log(JSON.stringify(teams, null, 2));
      return 0;
    }

    console.error(`Unknown command: ${resource} ${action}`);
    console.error('Run `hubspot-cli help` for usage.');
    return 1;
  } catch (err) {
    if (err.body?.message) {
      console.error(`HubSpot API error: ${err.body.message}`);
    } else if (err.message) {
      console.error(`Error: ${err.message}`);
    } else {
      console.error(err);
    }
    return 1;
  }
}

process.exit(await run());
