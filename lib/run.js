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

// Returns the full parsed JSON response, unwrapped. Some commands (get,
// list, create, dry-run/confirm) put everything at the top level alongside
// `ok` - others (get, list) nest the payload under `data`. Callers that
// need dry-run/digest/confirm fields (which only exist at the top level)
// should use this directly rather than tryRunHubspotJson's data-unwrapping.
export function tryRunHubspotJsonRaw(args, opts = {}) {
  // Not every command accepts --format (confirmed: schemas/properties/etc
  // update commands don't, they emit JSON unconditionally, and reject the
  // flag outright with "unexpected argument '--format' found"). Callers
  // that know their command supports it can still rely on the default.
  const { noFormat, ...spawnOpts } = opts;
  const finalArgs = noFormat ? args : [...args, '--format', 'json'];
  const result = runHubspot(finalArgs, { encoding: 'utf8', ...spawnOpts });

  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // fall through - status/stderr handling below covers this
  }

  if (result.status !== 0 || (parsed && parsed.ok === false)) {
    const error = parsed?.error ?? {
      message: result.stderr || result.stdout || `hubspot exited with status ${result.status}`,
    };
    return { ok: false, error, status: result.status, raw: parsed };
  }

  return { ok: true, status: result.status, ...parsed };
}

// Same, but unwraps `data` for commands that nest their payload under it
// (get, list). Falls back to the raw object for commands that don't.
export function tryRunHubspotJson(args, opts = {}) {
  const result = tryRunHubspotJsonRaw(args, opts);
  if (!result.ok) return result;
  return { ok: true, data: 'data' in result ? result.data : result };
}

export function runHubspotJson(args, opts = {}) {
  const result = tryRunHubspotJson(args, opts);
  if (!result.ok) {
    console.error(`Error: ${result.error?.message ?? 'unknown error'}`);
    process.exit(result.status && result.status !== 0 ? result.status : 1);
  }
  return result.data;
}

// Runs the dry-run -> digest -> confirm handshake most mutating hubspot
// commands require, transparently. baseArgs should NOT include --dry-run/
// --digest/--confirm. confirmValue must equal whatever the command expects
// (varies: schema name, property name, pipeline label, ...) - if omitted,
// falls back to the dry-run response's own target.name (e.g. for a schema
// looked up by objectTypeId, where the confirm value is still the type's
// name/fullyQualifiedName, not the ID that was passed in as --type).
export function applyWithConfirm(baseArgs, { input, confirmValue, env } = {}) {
  const dryRun = tryRunHubspotJsonRaw([...baseArgs, '--dry-run'], { env, input, noFormat: true });
  if (!dryRun.ok) return dryRun;

  // Some commands' dry-run reports no digest when there's nothing to change.
  if (!dryRun.digest) return dryRun;

  const confirm = confirmValue ?? dryRun.target?.name;

  // The confirm step needs the body piped again too - the CLI's own
  // apply_command_hint text omits --file/stdin, which is misleading;
  // confirmed live it fails with "No schema body provided" without it.
  return tryRunHubspotJsonRaw(
    [...baseArgs, '--digest', dryRun.digest, '--confirm', confirm],
    { env, input, noFormat: true },
  );
}
