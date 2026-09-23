import { spawnSync } from 'child_process';

export function runHubspot(args, opts = {}) {
  const result = spawnSync('hubspot', args, { maxBuffer: 50 * 1024 * 1024, ...opts });

  if (result.error && result.error.code === 'ENOENT') {
    console.error('Error: could not find the "hubspot" binary on PATH.');
    console.error('Install it with:');
    console.error('  curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh');
    process.exit(1);
  }

  return result;
}

export function runHubspotJson(args, opts = {}) {
  const result = runHubspot([...args, '--format', 'json'], { encoding: 'utf8', ...opts });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `hubspot exited with status ${result.status}\n`);
    process.exit(result.status ?? 1);
  }

  const parsed = JSON.parse(result.stdout);
  if (parsed && typeof parsed === 'object' && 'ok' in parsed) {
    if (parsed.ok === false) {
      console.error(`Error: ${parsed.error?.message ?? 'unknown error'}`);
      process.exit(1);
    }
    return parsed.data;
  }
  return parsed;
}
