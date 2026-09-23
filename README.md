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

```bash
hubspot-cli skill install          # install to the current project
hubspot-cli skill install --global # install globally to ~/.claude/skills/
```

Installs the official `hubspot/agent-cli-skills` and extends them with this wrapper's own commands, so your coding agent knows about both layers.

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
| `--full` | On `objects pull` for a standard object, include HubSpot-defined properties too (default: custom-only) |

---

## Two things named `objects`

Worth being explicit about this, since the same command name covers two very different concerns:

- **`hubspot-cli objects pull/push/diff`** (this wrapper's added verbs) = the object *type's* config bundle: its schema (name, labels, primary display property, required properties, associated object types — only meaningful for **custom** types), its property groups, and its properties. This is the shape of the type, like a database's `CREATE TABLE` plus its columns. Rare, deliberate changes. Config-as-code.
- **`hubspot-cli objects list/get/create/update/upsert/merge/delete/...`** (native `hubspot` passthrough, everything except pull/push/diff) = the actual data records — rows, not columns. Live CRM data, changes constantly, never git-tracked by this wrapper. (Bulk record import/export/diff is planned separately — [issue #2](https://github.com/rverheijen/hubspot-cli/issues/2).)

Same top-level command name, disambiguated entirely by verb — same pattern as every other resource in this wrapper, just applied to a command name that happens to also carry live-data meaning natively.

## Standard vs. custom objects

`hubspot schemas list` only enumerates **custom** schemas. To discover everything (standard + custom), `objects pull --all` uses `hubspot objects types` first, then `hubspot schemas get --type <name>` per type (which returns properties embedded, for both kinds — `metaType: HUBSPOT` for standard, `PORTAL_SPECIFIC` for custom).

`objects push` **never touches schema-level fields (labels, primary display property, required properties, associated objects) on a `metaType: HUBSPOT` target** — those are skipped silently, regardless of what's in the local file (pass `--force` to override, with a warning). Standard schema metadata updates are marked `mutation_kind: "MetadataDestroy"` and `reversible: false` by the underlying API, so this is a deliberate guard, not an oversight. Property groups and properties are still fully created/updated for standard objects either way — adding/updating your own custom fields on `contacts` is the common case and isn't destructive to HubSpot's own fields.

For a **custom** object type, `objects push` creates the schema (with its initial properties) if it doesn't exist yet in the manifest, otherwise reconciles schema metadata, groups, and properties all in the same call.

---

## Push safety: the dry-run / digest / confirm handshake

Nearly every mutating `hubspot` command (`schemas update/delete`, `properties update/delete`, `pipelines update/delete`, `pipelines stages-update`, `associations labels-update/delete`, `views delete`) gates real execution behind a two-step confirm: run with `--dry-run` to get a `digest`, then re-run with `--digest <hash> --confirm <exact-name>`. That's a deliberate brake for a human typing commands by hand.

`hubspot-cli`'s `push` commands do this handshake **automatically and transparently** — one `hubspot-cli objects push equipment.json` call does the dry-run, extracts the digest, and re-issues with confirm internally, for each underlying mutation it needs to make. This is worth knowing explicitly: `push` is authorizing a destructive confirm on your behalf. Read the diff output first if you're unsure.

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

### `objects pull <type>`

```bash
hubspot-cli objects pull equipment                # sparse by default, same as any object type
hubspot-cli objects pull contacts                  # sparse (custom properties only)
hubspot-cli objects pull contacts --full           # + every HubSpot-defined property, for reference
hubspot-cli objects pull equipment --env sandbox
```

### `objects pull --all`

Discovers every object type via `objects types`, fetches each with `schemas get --type <name>` plus its property groups, and writes one bundle per type.

```bash
hubspot-cli objects pull --all
hubspot-cli objects pull --all --full --env sandbox
```

### `objects push <file>`

```bash
hubspot-cli objects push hubspot/objects/equipment.json
hubspot-cli objects push hubspot/objects/equipment.json --env production
hubspot-cli objects push hubspot/objects/contacts.json   # standard: only groups/properties are applied
```

Creates the schema (custom types only, with its initial properties) if missing from the manifest for this environment. Otherwise reconciles, in order: schema metadata (custom types only) → property groups (create/update; delete only if empty — HubSpot refuses to delete a non-empty group) → properties (create missing, update changed; HubSpot-defined properties are never touched even if present in a `--full`-pulled file).

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

### `associations pull --from <type> --to <type>` / `--all`

```bash
hubspot-cli associations pull --from contacts --to companies
hubspot-cli associations pull --all --env sandbox   # every discoverable pair with custom labels or limits
```

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
  "labels": [{ "label": "Decision Maker" }],
  "limits": { "category": "USER_DEFINED", "maxToObjectIds": 1 }
}
```

`cardinality` is a descriptive, human-readable summary (`1:1`, `1:M`, `M:1`, `M:M`) derived from `limits` on pull — it isn't itself a HubSpot API field, and `push` doesn't read it; it's there so the relationship's shape is obvious at a glance without mentally decoding `maxToObjectIds`.

### `associations diff <file>` / `--all`

```bash
hubspot-cli associations diff hubspot/associations/contacts-companies.json
```

Example output:

```text
contacts-companies.json vs remote (env: production)

  + label: Gatekeeper
  ~ limit: maxToObjectIds 1 -> 2
```

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
