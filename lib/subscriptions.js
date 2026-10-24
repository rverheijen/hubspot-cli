// Email Subscription Types (Settings -> Marketing -> Email -> Types) each
// automatically create their own hs_email_optout_<numeric id> checkbox
// property on contacts the moment the subscription type is created - the
// <id> is assigned by that subsystem, not chosen by the user, and isn't
// portable across portals (confirmed on a real migration: the same six
// subscription types, matched by name, existed under completely different
// numeric ids between two portals - see issue #10). This resolves those
// properties by the subscription type's own name instead, the same pattern
// associations.js already uses for typeId.
const BASE = 'https://api.hubapi.com/communication-preferences/v3/definitions';

const OPT_OUT_PROPERTY_RE = /^hs_email_optout_(\d+)$/;
const PORTABLE_PREFIX = 'hs_email_optout:';

function authHeaders(env) {
  return { Authorization: `Bearer ${env.HUBSPOT_ACCESS_TOKEN}` };
}

// communication-preferences.read_write was noted as "currently not granted
// to our service key" when issue #10 was filed - re-confirmed live
// (2026-10-24) that it is granted (or always was), this call succeeds and
// returns real subscription type definitions.
export async function fetchSubscriptionDefinitions(env) {
  const res = await fetch(BASE, { headers: authHeaders(env) });
  if (!res.ok) throw new Error(`Failed to fetch subscription definitions: HTTP ${res.status}`);
  const body = await res.json();
  return body.subscriptionDefinitions ?? [];
}

export function isPortableOptOutName(name) {
  return name.startsWith(PORTABLE_PREFIX);
}

export function portableOptOutName(subscriptionName) {
  return `${PORTABLE_PREFIX}${subscriptionName}`;
}

export function subscriptionNameFromPortable(name) {
  return name.slice(PORTABLE_PREFIX.length);
}

// Converts any hs_email_optout_<id> entries in a property list to their
// portable hs_email_optout:<Subscription Name> form, resolved against this
// portal's real Communication Preferences definitions. A no-op (no extra
// API call) when nothing in the list matches. Falls back to the raw name
// for an id that doesn't match any known definition - a property outliving
// its subscription type (deleted in Settings but not yet cleaned up here)
// isn't ruled out, and it's better to show the raw name than to drop the
// property from the bundle entirely.
export async function toPortableOptOutNames(properties, env) {
  if (!properties.some((p) => OPT_OUT_PROPERTY_RE.test(p.name))) return properties;

  const defs = await fetchSubscriptionDefinitions(env);
  const byId = new Map(defs.map((d) => [d.id, d.name]));

  return properties.map((p) => {
    const match = p.name.match(OPT_OUT_PROPERTY_RE);
    if (!match) return p;
    const name = byId.get(match[1]);
    return name ? { ...p, name: portableOptOutName(name) } : p;
  });
}

// Resolves a portable hs_email_optout:<Subscription Name> reference back to
// this portal's real hs_email_optout_<id> property name. Throws (rather
// than returning null/undefined) when the named subscription type doesn't
// exist here - there's no property to create or update in that case, and
// it's always a real problem worth stopping a push over (a typo, or the
// subscription type genuinely hasn't been set up on this portal yet). These
// properties are a side effect of creating a subscription type in Settings,
// never something `properties create` can produce directly (confirmed live
// in issue #10's own investigation).
export async function resolveOptOutPropertyName(subscriptionName, env) {
  const defs = await fetchSubscriptionDefinitions(env);
  const match = defs.find((d) => d.name === subscriptionName);
  if (!match) {
    throw new Error(
      `no subscription type named "${subscriptionName}" exists on this portal - create it under ` +
      'Settings -> Marketing -> Email -> Types first (its opt-out property is a side effect of that, not something push can create)',
    );
  }
  return `hs_email_optout_${match.id}`;
}
