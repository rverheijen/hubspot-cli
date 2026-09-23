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
