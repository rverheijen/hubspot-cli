const GROUP_FIELDS = ['label', 'displayOrder'];
// dataSensitivity was excluded here for a while because schemas get used to
// never include it in a property's payload (confirmed live at the time).
// Re-confirmed live (2026-10-24) that this is no longer true - every
// property on both a production and a sandbox portal now includes a real
// dataSensitivity value, not just the ones explicitly set to something
// non-default. Re-included now that it can be read back reliably; still
// can't be changed post-creation though (see push.js).
const PROPERTY_FIELDS = [
  'label', 'type', 'fieldType', 'description', 'groupName',
  'options', 'hasUniqueValue', 'hidden', 'formField', 'displayOrder',
  'dataSensitivity',
];

// Plain JSON.stringify is sensitive to object key insertion order, which
// HubSpot's API and our own locally-authored JSON don't agree on (e.g. an
// `options` entry might come back as {hidden,displayOrder,description,
// label,value} from the API but {label,value,description,displayOrder,
// hidden} in a hand-authored file) - confirmed live, this was flagging
// every options-array field as "changed" even when every value matched,
// across every object checked. Comparisons use this instead, which sorts
// object keys recursively so two semantically-equal values always compare
// equal regardless of key order. Display output (formatObjectDiff) still
// uses plain JSON.stringify, which is fine there - key order doesn't
// matter for a human reading the printed diff.
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function diffScalar(field, local, remote) {
  if (stableStringify(local ?? null) === stableStringify(remote ?? null)) return null;
  return { field, from: remote, to: local };
}

function diffSet(localArr = [], remoteArr = []) {
  const localSet = new Set(localArr);
  const remoteSet = new Set(remoteArr);
  return {
    added: localArr.filter((v) => !remoteSet.has(v)),
    removed: remoteArr.filter((v) => !localSet.has(v)),
  };
}

function diffByName(localList = [], remoteList = [], fields) {
  const localMap = new Map(localList.map((item) => [item.name, item]));
  const remoteMap = new Map(remoteList.map((item) => [item.name, item]));

  const added = localList.filter((item) => !remoteMap.has(item.name));
  const removed = remoteList.filter((item) => !localMap.has(item.name));
  const changed = [];

  for (const [name, local] of localMap) {
    if (!remoteMap.has(name)) continue;
    const remote = remoteMap.get(name);
    const changes = [];
    for (const field of fields) {
      // A field missing entirely from the local file means "no opinion,
      // leave it alone" (same as push's own semantics), not "explicitly
      // unset" - comparing it against remote's default would otherwise
      // flag every optional field a minimal hand-authored file omits.
      if (!(field in local)) continue;
      const localVal = stableStringify(local[field] ?? null);
      const remoteVal = stableStringify(remote[field] ?? null);
      if (localVal !== remoteVal) changes.push({ field, from: remote[field], to: local[field] });
    }
    if (changes.length > 0) changed.push({ name, changes });
  }

  return { added, removed, changed };
}

export function diffObjectBundles(local, remote) {
  // Same "absent = no opinion" rule as diffByName: a bundle that omits
  // labels/primaryDisplayProperty/requiredProperties entirely (valid for
  // push against an object that already exists) shouldn't diff as if it
  // explicitly wanted them cleared.
  const scalarChanges = [
    local.labels && diffScalar('labels.singular', local.labels.singular, remote.labels?.singular),
    local.labels && diffScalar('labels.plural', local.labels.plural, remote.labels?.plural),
    'primaryDisplayProperty' in local &&
      diffScalar('primaryDisplayProperty', local.primaryDisplayProperty, remote.primaryDisplayProperty),
  ].filter(Boolean);

  return {
    scalarChanges,
    requiredProperties: 'requiredProperties' in local
      ? diffSet(local.requiredProperties, remote.requiredProperties)
      : { added: [], removed: [] },
    groups: diffByName(local.groups, remote.groups, GROUP_FIELDS),
    properties: diffByName(local.properties, remote.properties, PROPERTY_FIELDS),
  };
}

export function hasDifferences(diff) {
  return (
    diff.scalarChanges.length > 0 ||
    diff.requiredProperties.added.length > 0 ||
    diff.requiredProperties.removed.length > 0 ||
    diff.groups.added.length > 0 ||
    diff.groups.removed.length > 0 ||
    diff.groups.changed.length > 0 ||
    diff.properties.added.length > 0 ||
    diff.properties.removed.length > 0 ||
    diff.properties.changed.length > 0
  );
}

export function formatObjectDiff(diff, label) {
  const lines = [label, ''];

  for (const { field, from, to } of diff.scalarChanges) {
    lines.push(`  ${field}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  }

  for (const name of diff.requiredProperties.added) lines.push(`  + requiredProperty: ${name}`);
  for (const name of diff.requiredProperties.removed) lines.push(`  - requiredProperty: ${name}`);

  for (const group of diff.groups.added) lines.push(`  + group: ${group.name}`);
  for (const group of diff.groups.removed) lines.push(`  - group: ${group.name}`);
  for (const { name, changes } of diff.groups.changed) {
    for (const c of changes) lines.push(`  ~ group "${name}": ${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  }

  for (const prop of diff.properties.added) lines.push(`  + ${prop.name} (${prop.type})`);
  for (const prop of diff.properties.removed) lines.push(`  - ${prop.name} (${prop.type})`);
  for (const { name, changes } of diff.properties.changed) {
    for (const c of changes) lines.push(`  ~ ${name}: ${c.field} ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`);
  }

  return lines.join('\n');
}
