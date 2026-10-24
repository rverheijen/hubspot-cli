import { tryRunHubspotJson } from './run.js';
import fs from 'fs';
import path from 'path';

const DEFAULT_ASSOCIATIONS_DIR = 'hubspot/associations';

export function associationFilePath(from, to, dir) {
  return path.join(dir ?? DEFAULT_ASSOCIATIONS_DIR, `${from}-${to}.json`);
}

export function listLocalAssociationFiles(dir) {
  const target = dir ?? DEFAULT_ASSOCIATIONS_DIR;
  if (!fs.existsSync(target)) return [];
  return fs
    .readdirSync(target)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(target, f))
    .sort();
}

// `hubspot associations limits-create/update/delete`'s own --help text
// documents the wrong body shape ({associationTypeId, maxToObjectCount}),
// confirmed live and already tracked in issue #1 - the real required
// fields, confirmed against both the live create call and labels-list's/
// limits-list's own real response shape, are {category, typeId,
// maxToObjectIds}. Always use this shape, never the --help example.
function toRealLimitPayload(typeId, limit) {
  return { category: limit.category, typeId, maxToObjectIds: limit.maxToObjectIds };
}

// hubspot associations limits-create/limits-update go through the CLI's
// own local JSONL validator before ever reaching the API, confirmed live:
// it only accepts the --help example's shape ({associationTypeId,
// maxToObjectCount}), rejecting the real shape ({category, typeId,
// maxToObjectIds}) outright as "invalid JSON line" without even making a
// request. But the real API only accepts {category, typeId,
// maxToObjectIds} (confirmed live too - the --help shape reaches the API
// and gets rejected with "Some required fields were not set: [category,
// typeId, maxToObjectIds]"). The CLI only accepts the shape the API
// rejects, and rejects the shape the API accepts - no input makes
// `limits-create`/`limits-update` work through the CLI at all. Calling the
// real endpoint directly instead, found via the official SDK's own
// compiled request path (lib/codegen/crm/associations/v4/schema/apis/
// LimitsApi.js), since the SDK's main Client class doesn't expose this API
// group through its usual crm.associations.v4.* convenience path either.
// `batch/create` is not an upsert - confirmed live, calling it again on a
// typeId that already has a configuration fails with "A configuration
// already exists." `batch/update` is the separate endpoint for an existing
// one. Caller must know which applies (see `existingLimit` check below).
async function applyLimitRaw(from, to, typeId, limit, env, verb) {
  const res = await fetch(
    `https://api.hubapi.com/crm/associations/v4/definitions/configurations/${from}/${to}/batch/${verb}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ inputs: [toRealLimitPayload(typeId, limit)] }),
    },
  );
  const body = await res.json();
  if (!res.ok) throw new Error(body.message ?? `HTTP ${res.status}`);
  return body;
}

// A from->to pair's custom (USER_DEFINED) labels, each with its directional
// typeId. labels-list doesn't return a `name` field at all - confirmed
// live, only {typeId, label, category, fromObjectTypeId, toObjectTypeId} -
// `name` only exists because `labels-create` auto-derives it from `label`
// (upper-cased, spaces to underscores, confirmed in issue #1). Derived the
// same way here so a pulled file's `name` matches what push would create.
function deriveName(label) {
  return label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

async function fetchLabels(from, to, env) {
  const result = tryRunHubspotJson(['associations', 'labels-list', '--from', from, '--to', to], { env });
  if (!result.ok) throw new Error(`Failed to list labels for ${from}->${to}: ${result.error?.message}`);
  return result.data;
}

// Global, not scoped by from/to - confirmed live, limits-list's real
// response also doesn't include fromObjectTypeId/toObjectTypeId despite
// its own --help example showing them. Matching a limit back to a specific
// from->to pair means cross-referencing its typeId against that pair's
// labels-list results instead.
async function fetchAllLimits(env) {
  const result = tryRunHubspotJson(['associations', 'limits-list'], { env });
  if (!result.ok) throw new Error(`Failed to list limits: ${result.error?.message}`);
  return result.data;
}

function deriveCardinality(limit) {
  if (!limit) return 'M:M';
  return limit.maxToObjectIds === 1 ? 'M:1' : 'M:M';
}

export async function fetchAssociationBundle(from, to, env) {
  const labels = await fetchLabels(from, to, env);
  // A USER_DEFINED label can have label: null - confirmed live on a real
  // portal - presumably an orphaned/legacy entry. Skipped since there's no
  // text to match it to a local bundle entry by.
  const customLabels = labels.filter((l) => l.category === 'USER_DEFINED' && l.label != null);
  const allLimits = await fetchAllLimits(env);
  const pairTypeIds = new Set(labels.map((l) => l.typeId));
  const matchingLimit = allLimits.find((lim) => pairTypeIds.has(lim.typeId)) ?? null;
  // Included explicitly (not just relying on push's labels[0] fallback) so
  // a limit on a type other than the first custom label - including a
  // HUBSPOT_DEFINED one with no custom labels at all - round-trips
  // correctly through a pull -> push cycle.
  const limitLabelText = matchingLimit ? labels.find((l) => l.typeId === matchingLimit.typeId)?.label ?? null : null;

  return {
    from,
    to,
    cardinality: deriveCardinality(matchingLimit),
    labels: customLabels.map((l) => ({ label: l.label, name: deriveName(l.label) })),
    limits: matchingLimit
      ? { label: limitLabelText, category: matchingLimit.category, maxToObjectIds: matchingLimit.maxToObjectIds }
      : null,
  };
}

export function readAssociationBundle(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeAssociationBundle(filePath, bundle) {
  fs.writeFileSync(filePath, JSON.stringify(bundle, null, 2) + '\n');
}

export function diffAssociationBundle(local, remote) {
  const localByLabel = new Map((local.labels || []).map((l) => [l.label, l]));
  const remoteByLabel = new Map((remote.labels || []).map((l) => [l.label, l]));

  const labelsAdded = (local.labels || []).filter((l) => !remoteByLabel.has(l.label));
  const labelsRemoved = (remote.labels || []).filter((l) => !localByLabel.has(l.label));

  // "absent = no opinion" convention, matching objects' own diff semantics
  // (lib/diff.js) - a local bundle that omits `limits` entirely shouldn't
  // diff as if it explicitly wants limits cleared.
  let limitsChange = null;
  if ('limits' in local) {
    const localVal = JSON.stringify(local.limits ?? null);
    const remoteVal = JSON.stringify(remote.limits ?? null);
    if (localVal !== remoteVal) limitsChange = { from: remote.limits ?? null, to: local.limits ?? null };
  }

  return { labelsAdded, labelsRemoved, limitsChange };
}

export function hasAssociationDifferences(diff) {
  return diff.labelsAdded.length > 0 || diff.labelsRemoved.length > 0 || diff.limitsChange !== null;
}

export function formatAssociationDiff(diff, label) {
  const lines = [label, ''];
  for (const l of diff.labelsAdded) lines.push(`  + label: ${l.label}`);
  for (const l of diff.labelsRemoved) lines.push(`  - label: ${l.label}`);
  if (diff.limitsChange) {
    lines.push(`  ~ limits: ${JSON.stringify(diff.limitsChange.from)} -> ${JSON.stringify(diff.limitsChange.to)}`);
  }
  return lines.join('\n');
}

export async function pushAssociationBundle(filePath, { env } = {}) {
  const local = readAssociationBundle(filePath);
  const messages = [];
  const log = (m) => messages.push(m);

  const remoteLabels = await fetchLabels(local.from, local.to, env);
  const remoteByLabel = new Map(remoteLabels.map((l) => [l.label, l]));

  // Created typeIds for this push, keyed by label text, so a limit
  // targeting a label created in this same run doesn't need a second
  // labels-list round-trip to resolve its typeId.
  const typeIdByLabel = new Map(remoteLabels.map((l) => [l.label, l.typeId]));

  for (const local_label of local.labels || []) {
    if (remoteByLabel.has(local_label.label)) continue;
    const result = tryRunHubspotJson(
      ['associations', 'labels-create', '--from', local.from, '--to', local.to, '--label', local_label.label],
      { env, noFormat: true },
    );
    if (!result.ok) throw new Error(`Failed to create label "${local_label.label}": ${result.error?.message}`);
    log(`+ label: ${local_label.label}`);
    // labels-create's response nests under `data`, confirmed live - plain
    // JSON.stringify of the raw result would show {ok, data: {typeId,
    // label, results: [...]}}, not a top-level typeId/results.
    typeIdByLabel.set(local_label.label, result.data.typeId);
  }

  // Limits target one association type, resolved by label text: an
  // explicit `limits.label` if given, otherwise the bundle's first custom
  // label (matching the README's documented shape, where a bundle with one
  // label and one limit is the common case). `limits.label` also covers
  // issue #1's standalone case, a limit on an existing HUBSPOT_DEFINED
  // type with no custom labels at all (e.g. capping HubSpot's own default
  // association HubSpot already created via `schemas create`'s
  // `associatedObjects`) - resolved via the labels-list lookup already
  // done above (`typeIdByLabel` includes every category, not just
  // USER_DEFINED), not something that needs creating.
  if (local.limits) {
    const targetLabel = local.limits.label ?? local.labels?.[0]?.label;
    const typeId = targetLabel ? typeIdByLabel.get(targetLabel) : null;
    if (!targetLabel) {
      log(`! limits: no label to target (set limits.label, or add at least one entry to labels[]), skipping`);
    } else if (typeId == null) {
      log(`! limits: can't resolve a typeId for "${targetLabel}", skipping`);
    } else {
      const allLimits = await fetchAllLimits(env);
      const existing = allLimits.find((lim) => lim.typeId === typeId);
      const verb = existing ? 'update' : 'create';
      try {
        await applyLimitRaw(local.from, local.to, typeId, local.limits, env, verb);
        log(`~ limits (${verb}): ${JSON.stringify(local.limits)}`);
      } catch (err) {
        throw new Error(`Failed to ${verb} limit for "${targetLabel}": ${err.message}`);
      }
    }
  }

  return { messages };
}
