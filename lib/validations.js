import { resolveObjectTypeId } from './objects.js';

// Not covered by the official hubspot CLI at all (confirmed: no flag on
// properties create/update, no dedicated subcommand), and not visible on
// either of the standard property-read endpoints either (GET
// /crm/v3/properties/{type}/{name} and the legacy /properties/v2/.../named/
// both omit it entirely) - the data lives only under this separate,
// newer API (see issue #15). All raw fetch, same pattern as push.js's
// applyPropertyRaw and associations.js's applyLimitRaw.
const BASE = 'https://api.hubapi.com/crm/property-validations/2026-03';

function authHeaders(env) {
  return { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` };
}

// A rule-type/property combo with no rule set returns a plain-text/HTML 404
// body, not JSON (confirmed live) - res.json() would throw and mask the
// real "no rule set" case as a parse error, so errors are read as text and
// only parsed as JSON on a best-effort basis for the message.
async function parseErrorBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text).message ?? text;
  } catch {
    return text || `HTTP ${res.status}`;
  }
}

// All properties on an object that have at least one validation rule.
// Returns [{propertyName, propertyValidationRules: [{ruleType,
// ruleArguments, shouldApplyNormalization}]}], confirmed live - a property
// with no rules simply doesn't appear in the list.
export async function fetchObjectValidations(type, env) {
  const objectTypeId = resolveObjectTypeId(type, env);
  const res = await fetch(`${BASE}/${objectTypeId}`, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(await parseErrorBody(res));
  const body = await res.json();
  return body.results ?? [];
}

// Every rule on one property. Confirmed live this returns {results: []}
// (200, not 404) for a property with no rules at all.
export async function fetchPropertyValidations(type, propertyName, env) {
  const objectTypeId = resolveObjectTypeId(type, env);
  const res = await fetch(`${BASE}/${objectTypeId}/${propertyName}`, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(await parseErrorBody(res));
  const body = await res.json();
  return body.results ?? [];
}

// One specific rule. Confirmed live the response here is a flat object
// ({ruleType, ruleArguments, shouldApplyNormalization}), NOT wrapped in
// {results: [...]} like the two list endpoints above - the Property
// Validations API docs' own example for this endpoint is misleading on
// this point. Returns null (not a throw) for the confirmed-live 404 case
// of a valid ruleType with no rule set on this property, so callers can
// treat "not set" as a normal outcome rather than an error.
export async function fetchValidationRule(type, propertyName, ruleType, env) {
  const objectTypeId = resolveObjectTypeId(type, env);
  const res = await fetch(`${BASE}/${objectTypeId}/${propertyName}/rule-type/${ruleType}`, {
    headers: authHeaders(env),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(await parseErrorBody(res));
  return res.json();
}

// Creates or replaces one rule. Confirmed live: 204 No Content on success,
// body is just {ruleArguments: [...]} (ruleType is only ever in the URL,
// never repeated in the body). No delete endpoint exists - confirmed live,
// DELETE on this same URL returns 405 Method Not Allowed; removing a rule
// for real isn't something this API supports, not something this project
// just hasn't wired up yet.
export async function setValidationRule(type, propertyName, ruleType, ruleArguments, env) {
  const objectTypeId = resolveObjectTypeId(type, env);
  const res = await fetch(`${BASE}/${objectTypeId}/${propertyName}/rule-type/${ruleType}`, {
    method: 'PUT',
    headers: { ...authHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ ruleArguments }),
  });
  if (!res.ok) throw new Error(await parseErrorBody(res));
}
