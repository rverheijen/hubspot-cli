# hubspot-cli

A custom wrapper around the official [`hubspot`](https://developers.hubspot.com/docs/guides/other/agent-integrations/agent-cli) Agent CLI that adds config-as-code commands — pull/push/diff to local files, multi-environment sync, and a deployment manifest — on top of it, the same way [`n8n-cli`](https://github.com/rverheijen/n8n-cli) wraps the official n8n CLI.

All official `hubspot` commands and flags pass through unchanged. This wrapper only adds new verbs on top of a handful of them. (Bulk record import/export/diff is a separate, planned concern — see [issue #2](https://github.com/rverheijen/hubspot-cli/issues/2).)

## Install

```bash
npm install -g github:rverheijen/hubspot-cli
```

The official `hubspot` binary is **not** an npm package, so it can't be declared as a normal `dependency` — instead, a `postinstall` script handles it automatically: if `hubspot` is already on your `PATH` (e.g. installed via the Claude Code skill, `npx skills add hubspot/agent-cli-skills`), it runs `hubspot upgrade` to make sure you're current; otherwise it installs it fresh via the official installer. Either way never fails the wrapper's own install — if it can't reach the network, `hubspot-cli` still gives a clear error at runtime pointing at the manual install command:

```bash
curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
```

`hubspot-cli` looks for `hubspot` on your `PATH` at runtime.

## Uninstall

```bash
npm uninstall -g hubspot-cli
```

## Use as skill with your coding agent

> **Planned, not implemented yet.** Tracked in [#7](https://github.com/rverheijen/hubspot-cli/issues/7).

```bash
hubspot-cli skill install          # install to the current project (.claude/skills/hubspot-cli/)
hubspot-cli skill install --global # install globally to ~/.claude/skills/hubspot-cli/
```

This will install a standalone `hubspot-cli` skill that sits next to HubSpot's own `hubspot/agent-cli-skills` rather than extending them, because the official `hubspot` binary has no `skill install` command of its own to hook into. It will teach your coding agent this wrapper's config-as-code commands, the manifest, `.env` handling and the known push caveats. Until then, install HubSpot's official skills with `npx skills add hubspot/agent-cli-skills`.

---

## Command overview

| Command | Description |
|---|---|
| `objects pull <type>` / `--all` | Save an object type's schema + property groups + properties as one bundle to `hubspot/objects/<type>.json`. `--all` covers every discoverable type (via `objects types`) |
| `objects push <file>` | Create the schema if custom and missing, then create/update groups and properties. Standard objects: schema fields are never touched, only groups/properties |
| `objects diff <file>` / `--all` | Compare local bundle against remote |
| `pipelines pull --type <type>` / `--all` | Save pipelines + stages to `hubspot/pipelines/<type>/<slug>.json` |
| `pipelines push <file>` | Create/update a pipeline and its stages |
| `pipelines diff <file>` / `--all` | Compare local pipeline+stages against remote |
| `associations pull [--from <type> --to <type>]` / `--all` | Save custom labels + limits to `hubspot/associations/<from>-<to>.json` |
| `associations push <file>` | Create/update labels and limits |
| `associations diff <file>` / `--all` | Compare local associations against remote |
| `views pull --type <type>` / `--all` | Save saved CRM views to `hubspot/views/<type>/<slug>.json` |
| `views push <file>` | Create/update a view's columns |
| `views diff <file>` / `--all` | Compare local view against remote |
| `workflows pull <id>` / `--all` | Save a v4 flow to `hubspot/workflows/<slug>.json` |
| `workflows push <file>` | Create a workflow, or update (full replace) an existing one |
| `workflows diff <file>` / `--all` | Compare local workflow against remote |
| `workflows activate <file\|id>` / `deactivate` | Sugar over `workflows update` flipping `isEnabled` |

Everything else under these same command names — `hubspot-cli objects list`, `hubspot-cli objects create`, `hubspot-cli objects get`, and every other resource's native subcommands (`hubspot-cli whoami`, `hubspot-cli segments create`, `hubspot-cli imports start`, etc.) — passes straight through to the real `hubspot` binary untouched. Only `pull`/`push`/`diff` (plus `activate`/`deactivate` on workflows) are new verbs this wrapper adds; everything else, including live CRM record commands under `objects`, is native `hubspot` behavior. See "Two things named `objects`" below.

---

## Configuration

### Authentication

Because `hubspot-cli` wraps the official `hubspot` binary directly, it inherits that binary's own login flow for free. For interactive use, run `hubspot auth login` once (a normal browser-based OAuth login) and no private app or API key ever needs to be created at all. For CI or any scripted use, set `HUBSPOT_ACCESS_TOKEN` instead, as described below.

### Environment variables

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private App / service key access token. Same variable name the official `hubspot` binary itself reads — this wrapper does not rename or translate it. |

### .env files

```bash
# .env
HUBSPOT_ACCESS_TOKEN=pat-na1-...
```

```bash
hubspot-cli objects pull --all --env-path .env.staging
hubspot-cli objects pull --all --env production        # loads .env.production if present
```

In CI, set `HUBSPOT_ACCESS_TOKEN` directly as a secret; no `.env` file needed.

---

## Global flags

| Flag | Description |
|---|---|
| `--env <name>` | Environment name (manifest key, loads `.env.<name>` if present) |
| `--env-path <path>` | Load a specific `.env` file |
| `--dir <path>` | Override the default source/target directory |
| `--all` | Operate on all items of that resource type |
| `--full` | On `objects pull`, include HubSpot-defined properties too (default: custom-only) |
| `--both` | On `objects pull`, write both the tailored sparse bundle and a `<type>.full.json` full reference in one run |

---

## Two things named `objects`

Worth being explicit about this, since the same command name covers two very different concerns:

- **`hubspot-cli objects pull/push/diff`** (this wrapper's added verbs) = the object *type's* config bundle: its schema (name, labels, primary display property, required properties, associated object types — only meaningful for **custom** types), its property groups, and its properties. This is the shape of the type, like a database's `CREATE TABLE` plus its columns. Rare, deliberate changes. Config-as-code.
- **`hubspot-cli objects list/get/create/update/upsert/merge/delete/...`** (native `hubspot` passthrough, everything except pull/push/diff) = the actual data records — rows, not columns. Live CRM data, changes constantly, never git-tracked by this wrapper. (Bulk record import/export/diff is planned separately — [issue #2](https://github.com/rverheijen/hubspot-cli/issues/2).)

Same top-level command name, disambiguated entirely by verb — same pattern as every other resource in this wrapper, just applied to a command name that happens to also carry live-data meaning natively.

## Standard vs. custom objects

`hubspot schemas list` only enumerates **custom** schemas. To discover everything (standard + custom), `objects pull --all` uses `hubspot objects types` first, then `hubspot schemas get --type <name>` per type (which returns properties embedded, for both kinds — `metaType: HUBSPOT` for standard, `PORTAL_SPECIFIC` for custom).

`objects push` **never applies schema-level fields (labels, primary display property, required properties) on a `metaType: HUBSPOT` target** by default — those are skipped silently unless `--force` is passed, in which case they're at least *reported* (see below; nothing can actually be applied there either way, for a separate reason). Property groups and properties are still fully created/updated for standard objects regardless — adding/updating your own custom fields on `contacts` is the common case and isn't destructive to HubSpot's own fields.

For a **custom** object type, `objects push` creates the schema (with only its primary display property, every other property added individually right after — see below) if it doesn't exist yet, otherwise reconciles groups and properties, and *reports* (does not apply) any schema-metadata drift — see below.

---

## Push safety, and a real limitation: schema metadata can't currently be pushed to an existing object

Several mutating `hubspot` commands (`schemas update/delete`, `properties update/delete`, `pipelines update/delete`, `associations labels-update/delete`, `views delete`, ...) are *documented* as gating real execution behind a two-step confirm: run with `--dry-run` to get a `digest`, then re-run with `--digest <hash> --confirm <exact-name>`. In practice this varies a lot by command, confirmed by testing directly:

- **`properties update`** isn't actually gated at all, despite its own `--help` text implying it is — it executes immediately, no dry-run/digest/confirm needed. `objects push` calls it directly.
- **`schemas create`** isn't gated either, and separately its `--dry-run` doesn't validate anything (always reports success, even for an empty body) — `objects push` never relies on it for validation, just lets the real call fail and surfaces the error.
- **`schemas update`**'s confirm step is gated for real (a genuine API round-trip, real digest) — but the confirm call itself is **broken**: it returns `ok: true` with what looks like the updated schema, but the change is never actually persisted. Confirmed by testing directly and waiting well past any plausible propagation delay. See [rverheijen/hubspot-cli#4](https://github.com/rverheijen/hubspot-cli/issues/4) (filed upstream: [HubSpot/agent-cli#7](https://github.com/HubSpot/agent-cli/issues/7)).

Because of that last one, **`objects push` does not attempt `schemas update` at all** for an existing custom object — attempting a call known to silently no-op while reporting success would be worse than not attempting it. Instead, if a local bundle's `labels`/`primaryDisplayProperty`/`requiredProperties` differ from what's live, `push` prints a `!` line naming exactly which fields differ and why it can't apply them, and leaves the manifest/exit code unaffected (this alone doesn't count as a failure). Use the HubSpot UI to make that kind of change until the upstream bug is fixed. `objects diff` is unaffected by any of this and will always correctly show the drift either way.

---

## Object commands

`hubspot/objects/<type>.json` bundles everything about one object type's shape:

```json
{
  "name": "equipment",
  "objectTypeId": "2-12345678",
  "metaType": "PORTAL_SPECIFIC",
  "labels": { "singular": "Equipment", "plural": "Equipment" },
  "primaryDisplayProperty": "equipment_name",
  "requiredProperties": ["equipment_name"],
  "full": false,
  "groups": [
    { "name": "warranty", "label": "Warranty", "displayOrder": 0 }
  ],
  "properties": [
    { "name": "equipment_name", "label": "Name", "type": "string", "fieldType": "text", "groupName": "equipment_information" },
    { "name": "serial_number", "label": "Serial Number", "type": "string", "fieldType": "text", "groupName": "equipment_information" }
  ]
}
```

`objectTypeId` and `full` are bookkeeping `pull` writes for itself — `full` records which mode a bundle was pulled in, so `diff` compares against a remote fetch in the same mode (otherwise a sparse local file would show hundreds of false "removed" entries for HubSpot's own boilerplate properties). Neither is meant to be hand-edited.

Standard objects (`contacts`, `companies`, ...) use the same shape with `metaType: "HUBSPOT"` — the schema-level fields (`labels`, `primaryDisplayProperty`, `requiredProperties`) are included for reference but `push` never acts on them (see "Standard vs. custom objects" above).

`associatedObjects` (the list of object types a *new* custom schema should be associable with) is a write-only field for `schemas create` — `pull` doesn't populate it, since what `schemas get` actually returns is the full, portal-specific list of every association *type* already set up for that object (hundreds of entries even for a small custom object), not the simple list `associatedObjects` expects as input. Add it by hand to a bundle you're authoring for a brand-new custom object; there's nothing to round-trip for an object that already exists.

**Authoring a bundle for a brand-new custom object** (one `objects push` needs to create from scratch): only `name` and `labels` are actually required — confirmed directly against the API (an empty body is rejected with `required fields were not set: [name, labels]`; `name` alone still fails on `[labels]`). Everything else (`primaryDisplayProperty`, `requiredProperties`, `associatedObjects`, initial `properties`) is optional at creation time. For an object that already exists, none of the schema-level fields are required in the file at all — omit `labels` (or anything else) to mean "leave it alone," `objects push` only acts on what's present.

By default, `properties` is **sparse** — only non-`hubspotDefined` properties and the groups that contain them. This applies to every object type, not just standard ones: even a freshly created custom object carries ~30 HubSpot-managed boilerplate properties (`hs_object_id`, `hs_createdate`, `hubspot_owner_id`, ...), all marked `hubspotDefined: true` — confirmed by pulling one live. Pass `--full` to also pull those, for reference — they're never pushed either way.

A group kept in a sparse pull isn't necessarily something the portal created — it's just wherever a surviving custom property happens to live, which can be an existing HubSpot default group (`contactinformation`, say) that a custom field was later dropped into. HubSpot's groups API has no equivalent of `hubspotDefined` for groups themselves to tell the two apart directly (confirmed live, a raw `groupsApi.getAll()` response only has `name`/`label`/`displayOrder`/`archived`). The closest available signal: a kept group gets an informational `"sharedWithStandard": true` field (sparse mode only, never pushed) when it also contains at least one `hubspotDefined` property, found by cross-referencing against the full property list fetched either way before the sparse filter is applied.

`--full` and the tailored sparse output are otherwise mutually exclusive per run, both written to the same path — getting both meant running `pull` twice and juggling `--dir` by hand to avoid the second run clobbering the first (issue #8). `--both` writes both from a single schema/groups fetch instead: the tailored bundle at the normal path (`hubspot/objects/<type>.json`, what `diff`/`push`/`--all` actually track) and the full reference alongside it at `hubspot/objects/<type>.full.json`. The `.full.json` file is deliberately excluded from `listLocalObjectFiles` (so `objects diff --all`/`objects push --all` never pick it up) — it's a point-in-time reference, not a bundle meant to be pushed. `--full` and `--both` are mutually exclusive (`--both` already covers what `--full` would give you).

### `objects pull <type>`

```bash
hubspot-cli objects pull equipment                # sparse by default, same as any object type
hubspot-cli objects pull contacts                  # sparse (custom properties only)
hubspot-cli objects pull contacts --full           # + every HubSpot-defined property, for reference
hubspot-cli objects pull contacts --both           # writes contacts.json (sparse) + contacts.full.json (full), one fetch
hubspot-cli objects pull equipment --env sandbox
```

### `objects pull --all`

Discovers every object type via `objects types`, fetches each with `schemas get --type <name>` plus its property groups, and writes one bundle per type.

```bash
hubspot-cli objects pull --all
hubspot-cli objects pull --all --full --env sandbox
hubspot-cli objects pull --all --both --env sandbox
```

### `objects push <file>`

```bash
hubspot-cli objects push hubspot/objects/equipment.json
hubspot-cli objects push hubspot/objects/equipment.json --env production
hubspot-cli objects push hubspot/objects/contacts.json   # standard: only groups/properties are applied
```

Creates the schema (custom types only) if it doesn't exist yet, with only the primary display property's own definition in that call — not every property in the bundle. Confirmed live: every property bundled into the initial `schemas create` call gets an automatic, immediate `OBJECT_REQUIREMENT` lock, blocking any later archive/delete attempt (a fresh, random lock id each time the object is recreated, not specific to a property type or a deliberately-configured rule). A property added individually via its own `properties batch-create` call doesn't get this lock, so every other property in the bundle is created that way instead, right after schema creation, via the same per-property path described below. Otherwise (the schema already exists) reconciles, in order: property groups (create missing; update label/order changes — no deletion yet) → properties (create missing via `properties batch-create`; update changed `label`/`groupName` via the official `hubspot properties update` subcommand, the only two fields it supports) → schema metadata drift is *reported*, not applied (see "Push safety" above).

`properties batch-create` is confirmed all-or-nothing on the real API: one invalid property in a single call fails the entire call, with no way to tell which one was the problem versus just caught in the blast radius. So each new property gets its own individual `batch-create` call rather than bundling the whole batch into one, trading some API-call efficiency for one failure not blocking every other unrelated property in the same push. Same reasoning applies to updates: a property update failure is collected and reported rather than stopping the whole push immediately, so every property that *can* be created or updated in a run still is, even when one specific property fails. All failures are thrown together at the end (after everything that could be attempted was), with the full list of what succeeded still printed first — even on a partial failure, nothing that did succeed is hidden behind the final error.

For every other changed field, `objects push` checks the remote property's `modificationMetadata.readOnlyDefinition`. If it's `false`, `type`/`fieldType`/`options` changes are applied directly via a raw `PATCH` to the Properties API, bypassing the official CLI subcommand entirely (confirmed live converting a native `gender` property from `string`/`text` to `enumeration`/`select` with real options, and `date_of_birth` from `string`/`text` to `type: date`, both on a real portal). If `readOnlyDefinition` is `true`, or the field isn't one of those three, it's reported but not applied, the same as before.

`dataSensitivity` and `hasUniqueValue` are always reported, never applied, even when `readOnlyDefinition` is `false` — confirmed unchangeable post-creation regardless. `dataSensitivity` is **create-time-only**, matching HubSpot's own docs ("Ensure the dataSensitivity field is set to indicate sensitivity during the property creation process") — HubSpot rejects any attempt to change it on an existing property outright, even archiving and recreating one under the same name. `hasUniqueValue` is worse: a raw `PATCH` returns `200 OK` but silently leaves the value unchanged, confirmed live on a property that already had data, no error at all. Changing either on an existing property for real means archiving it and creating a differently-named replacement, a real migration, not something this update path attempts.

(Earlier versions of this README claimed `schemas get` never returns `dataSensitivity`, excluding it entirely from `diff`/`push`'s drift reporting to avoid permanent false noise. Re-confirmed live, 2026-10-24: that's no longer true, every property on both a production and a sandbox portal now includes a real `dataSensitivity` value. Drift on it is tracked normally again.)

### `objects diff <file>` / `--all`

```bash
hubspot-cli objects diff hubspot/objects/equipment.json
hubspot-cli objects diff --all --env production
```

Exits `1` if differences are found, `0` if up to date. Shows differences across the whole bundle (schema, groups, properties) regardless of standard/custom — `diff` is purely informational; `push` decides what it actually acts on.

Example output:

```text
equipment.json vs remote (env: production)

  labels.singular: "Equipment" -> "Asset"
  + requiredProperty: warranty_expiry
  + group: warranty
  + acd_form_tag (enumeration)
  ~ serial_number: label "Serial Number" -> "Serial #"
```

---

## Pipeline commands

`hubspot/pipelines/<type>/<slug>.json` holds one pipeline and its full stage list together (pushing a pipeline without its stages isn't meaningful).

### `pipelines pull --type <type>` / `--all`

```bash
hubspot-cli pipelines pull --type deals
hubspot-cli pipelines pull --all --env sandbox   # every pipeline-supporting object type
```

### `pipelines push <file>`

```bash
hubspot-cli pipelines push hubspot/pipelines/deals/sales_pipeline.json
hubspot-cli pipelines push hubspot/pipelines/deals/sales_pipeline.json --env production
```

Creates the pipeline (with initial stages) if missing from the manifest, otherwise updates the pipeline label and diffs/reconciles stages individually (add/update/reorder) via the confirm handshake.

### `pipelines diff <file>` / `--all`

```bash
hubspot-cli pipelines diff hubspot/pipelines/deals/sales_pipeline.json
```

Example output:

```text
sales_pipeline.json vs remote (env: production)

  label: "Sales Pipeline" -> "Enterprise Sales Pipeline"
  + stage: Waiting on legal (order: 3)
  ~ stage "Qualified": label "Qualified" -> "SQL"
```

---

## Association commands

`hubspot/associations/<from>-<to>.json` holds custom labels and limit configs for one object-type pair. `push` resolves each label's `typeId` **live** rather than trusting a value in the file — `typeId` is assigned per portal, not stable across environments (see [issue #1](https://github.com/rverheijen/hubspot-cli/issues/1) for the concrete case that surfaced this).

These commands are implemented directly against the raw API in `lib/associations.js`, not by shelling out to the official `hubspot associations labels-create`/`limits-create`/`limits-update` subcommands for every step. Confirmed live: `limits-create`/`limits-update`'s own local input validator only accepts the shape their `--help` text documents (`{associationTypeId, maxToObjectCount}`), but the real API only accepts a different shape (`{category, typeId, maxToObjectIds}`) - the CLI only accepts the shape the API rejects, and rejects the shape the API accepts, so no input makes those two subcommands work at all (see [issue #17](https://github.com/rverheijen/hubspot-cli/issues/17)). Limits are applied via the real endpoint directly instead (`POST /crm/associations/v4/definitions/configurations/{from}/{to}/batch/create` or `.../batch/update`, found in the official SDK's own compiled request code since the SDK's `Client` class doesn't expose this API group through its usual `crm.associations.v4.*` path). `labels-list`/`labels-create`/`labels-delete` work fine through the CLI and are used as-is.

### `associations pull --from <type> --to <type>` / `--all`

```bash
hubspot-cli associations pull --from contacts --to companies
hubspot-cli associations pull --all   # re-pulls every pair already present in hubspot/associations/, by its own from/to
```

`--all` doesn't discover new pairs on its own (there's no endpoint to enumerate "every object-type pair with custom associations" on a portal) - it just refreshes every file already in the directory using that file's own `from`/`to`. Pull a new pair for the first time with `--from`/`--to` directly.

### `associations push <file>`

```bash
hubspot-cli associations push hubspot/associations/contacts-companies.json --env production
```

Config shape:

```json
{
  "from": "contacts",
  "to": "companies",
  "cardinality": "M:M",
  "labels": [{ "label": "Decision Maker", "name": "DECISION_MAKER" }],
  "limits": { "label": "Decision Maker", "category": "USER_DEFINED", "maxToObjectIds": 1 }
}
```

`cardinality` is a descriptive, human-readable summary (`M:1` or `M:M`, derived from whether `limits.maxToObjectIds` is `1`) - it isn't itself a HubSpot API field, and `push` doesn't read it; it's there so the relationship's shape is obvious at a glance without mentally decoding `maxToObjectIds`. `limits` carries one object per pair, not one per label, so a bundle with more than one custom label and a meaningful per-label cap isn't representable yet.

`limits.label` names which association type the limit applies to, and falls back to the bundle's first `labels[]` entry if omitted (the common case, one label and one limit together). It's also how to cap an existing `HUBSPOT_DEFINED` association type with `labels: []` and no custom labels at all - e.g. the default association type HubSpot already creates via `schemas create`'s `associatedObjects` for a brand-new custom object:

```json
{ "from": "equipment", "to": "contacts", "cardinality": "M:1", "labels": [], "limits": { "label": "Equipment to Contact", "category": "HUBSPOT_DEFINED", "maxToObjectIds": 1 } }
```

`name` on a label is derived (upper-cased, non-alphanumeric runs collapsed to `_`) rather than something the API returns - confirmed live, `labels-list` only returns `{typeId, label, category, fromObjectTypeId, toObjectTypeId}`, no `name` field at all; `name` only exists because `labels-create` auto-derives it from `label` the same way, confirmed in issue #1.

### `associations diff <file>` / `--all`

```bash
hubspot-cli associations diff hubspot/associations/contacts-companies.json
```

Example output:

```text
contacts-companies.json vs remote (env: production)

  + label: Gatekeeper
  ~ limits: {"category":"USER_DEFINED","maxToObjectIds":1} -> {"category":"USER_DEFINED","maxToObjectIds":2}
```

---

## Property validation commands

Property-level validation rules (regex/format/length constraints enforced on data entry) live in a separate, newer API entirely (`/crm/property-validations/2026-03/...`), not the standard property-read endpoints — confirmed live, `GET /crm/v3/properties/{type}/{name}` and the legacy `/properties/v2/.../named/{name}` both omit validation rules completely, and the official hubspot CLI has no flag or subcommand for them at all (see issue #15). These commands wrap that API directly with raw `fetch` calls, same pattern as `objects push`'s raw-API property updates and `associations push`'s limits handling.

`--type` accepts a standard object's plain name directly (confirmed live, e.g. `companies`) — a custom object needs its numeric `objectTypeId` instead (confirmed live, a custom object's plain name is rejected outright with `"Unable to infer object type from: <name>"`); either form is resolved automatically from `objects types` if you pass a name, numeric IDs are passed through unchanged.

There's no delete — confirmed live, `DELETE` on a rule's URL returns `405 Method Not Allowed`. Removing a rule for real isn't something this API supports.

A validation rule on an archived property isn't cleared by archiving it — confirmed live, `properties validations list` continued showing a rule for a property that had already been archived via `properties delete`. Worth knowing if a property gets archived and recreated under the same name later.

### `properties validations list --type <object> [--name <property>]`

Without `--name`, lists every property on the object that has at least one rule. With `--name`, lists just that property's rules (an empty array if it has none — confirmed live this is a normal `200`, not a `404`).

```bash
hubspot-cli properties validations list --type companies
hubspot-cli properties validations list --type companies --name vat_number
```

### `properties validations get --type <object> --name <property> --rule-type <TYPE>`

Shows one rule. Exits non-zero with a plain message (not a stack trace) if that rule type isn't set on the property — confirmed live this case is a `404` with an HTML body, not JSON, so it's treated as "not set" rather than surfaced as a raw fetch error.

```bash
hubspot-cli properties validations get --type companies --name vat_number --rule-type REGEX
```

### `properties validations set --type <object> --name <property> --rule-type <TYPE> --args <v> [--args <v> ...]`

Creates or replaces one rule (confirmed live: `204 No Content` on success, same call either way — there's no separate create vs. update). For `REGEX`, the real response shape is `[pattern, short error message, longer multi-line guidance text]` — confirmed live this is 3 arguments, not the 2 (pattern + one message) HubSpot's own docs example shows.

```bash
hubspot-cli properties validations set --type companies --name vat_number --rule-type REGEX \
  --args '^(?:AE|AT|...)(?:[0-9A-Z]{2,20})$' \
  --args 'Starts with a country code followed by 2-20 alphanumeric characters.'
```

Not yet folded into `objects pull`/`diff`/`push` bundles — a bundle can still silently drift from what's actually enforced on the portal with no way for `objects diff` to catch it. Worth a follow-up if validation rules turn out to matter for more than one or two properties at a time.

---

## View commands

`hubspot/views/<type>/<slug>.json` holds one saved CRM view's columns, filters, and sort.

### `views pull --type <type>` / `--all`

```bash
hubspot-cli views pull --type deals
hubspot-cli views pull --all --env sandbox
```

### `views push <file>`

```bash
hubspot-cli views push hubspot/views/deals/all_open_deals.json
```

`views update` only touches columns (add/remove/reorder) — filters and sort are preserved from whatever currently exists remotely, matching the underlying `hubspot views update` behavior. There's no confirm handshake for view updates (not gated the same way as the destructive resources above), but `views delete` is.

### `views diff <file>` / `--all`

```bash
hubspot-cli views diff hubspot/views/deals/all_open_deals.json
```

---

## Workflow commands

`hubspot/workflows/<slug>.json` holds one v4 flow. `hubspot workflows list` only returns v4 flows — classic v3 contact-based workflows aren't covered by `hubspot` and aren't pulled by this wrapper either.

### `workflows pull <id>` / `--all`

```bash
hubspot-cli workflows pull 12345678
hubspot-cli workflows pull --all --env sandbox
```

### `workflows push <file>`

```bash
hubspot-cli workflows push hubspot/workflows/lead_routing.json --env production
```

`workflows update` is a **full replace** requiring the latest `revisionId` — `push` fetches the current remote state first to get it, strips the read-only fields (`createdAt`, `updatedAt`, `dataSources`) the API rejects on write, then runs the confirm handshake. Requires `HUBSPOT_ACCESS_TOKEN`; OAuth user tokens aren't accepted by this endpoint at all.

### `workflows diff <file>` / `--all`

```bash
hubspot-cli workflows diff hubspot/workflows/lead_routing.json
```

### `workflows activate <file|id>` / `workflows deactivate <file|id>`

Sugar over `workflows update` flipping `isEnabled`, resolving a local filename to its remote flow ID via the manifest first (or accepting a raw ID directly).

```bash
hubspot-cli workflows activate hubspot/workflows/lead_routing.json
hubspot-cli workflows deactivate hubspot/workflows/lead_routing.json --env sandbox
hubspot-cli workflows activate 12345678   # raw ID
```

---

## Deployment manifest

`.hubspot_cli/manifest.json` maps local filename → remote ID/objectTypeId, per environment, so `push` knows create-vs-update instead of duplicating on every run:

```json
{
  "sandbox": {
    "objects": { "equipment.json": "2-12345678" },
    "pipelines": { "deals/sales_pipeline.json": "default" }
  },
  "production": {
    "objects": { "equipment.json": "2-98765432" },
    "pipelines": { "deals/sales_pipeline.json": "55f2a1b0" }
  }
}
```

**Commit this file to git.** Association `typeId`s in particular are assigned per-portal, not stable across environments — confirmed by rotating a token mid-session and seeing the exact same conceptual label get a different `typeId` (see [issue #1](https://github.com/rverheijen/hubspot-cli/issues/1)) — so the manifest (and `associations push` resolving `typeId` live rather than trusting a value baked into the file) is what makes sandbox → production promotion actually portable.

---

## Working directory layout

```text
hubspot/
  objects/
    contacts.json
    equipment.json
  pipelines/
    deals/
      sales_pipeline.json
  associations/
    contacts-companies.json
  views/
    deals/
      all_open_deals.json
  workflows/
    lead_routing.json
```

`--dir` can nest these however you prefer (e.g. grouping object bundles by business domain) — the flat layout above is just the default.

---

## CI/CD with GitHub Actions

See [docs/github-actions.md](./docs/github-actions.md) for a full guide including:
- Recommended repo structure
- Setting up GitHub Secrets
- CI workflow (validate + diff on pull request)
- CD workflow (deploy on merge to main)
- Multi-portal deployment with GitHub Environments
- Promotion pipeline (sandbox → quality_assurance → production)
- Troubleshooting

---

## License

See [LICENSE.md](./LICENSE.md).
