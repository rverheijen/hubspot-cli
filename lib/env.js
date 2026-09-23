import fs from 'fs';
import { parse as parseDotenv } from 'dotenv';

export function parseGlobalFlags(args) {
  const remaining = [];
  let envFile = null;
  let envName = null;
  let dir = null;
  let all = false;
  let full = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--env-path') {
      envFile = args[++i];
    } else if (args[i].startsWith('--env-path=')) {
      envFile = args[i].slice('--env-path='.length);
    } else if (args[i] === '--env') {
      envName = args[++i];
    } else if (args[i].startsWith('--env=')) {
      envName = args[i].slice('--env='.length);
    } else if (args[i] === '--dir') {
      dir = args[++i];
    } else if (args[i].startsWith('--dir=')) {
      dir = args[i].slice('--dir='.length);
    } else if (args[i] === '--all') {
      all = true;
    } else if (args[i] === '--full') {
      full = true;
    } else {
      remaining.push(args[i]);
    }
  }

  return { remaining, envFile, envName, dir, all, full };
}

export function loadEnvFile(envFile, envName) {
  const envFilePath = envFile ?? (envName ? `.env.${envName}` : '.env');
  if (fs.existsSync(envFilePath)) {
    const parsed = parseDotenv(fs.readFileSync(envFilePath, 'utf8'));
    for (const [key, value] of Object.entries(parsed)) {
      if (!(key in process.env)) process.env[key] = value;
    }
  } else if (envFile) {
    console.error(`Error: env file not found: ${envFilePath}`);
    process.exit(1);
  }
}

export function buildEnv() {
  const env = { ...process.env };
  if (!env.HUBSPOT_ACCESS_TOKEN && env.HUBSPOT_API_TOKEN) {
    console.warn('Warning: HUBSPOT_API_TOKEN is deprecated, use HUBSPOT_ACCESS_TOKEN instead.');
    env.HUBSPOT_ACCESS_TOKEN = env.HUBSPOT_API_TOKEN;
  }
  return env;
}
