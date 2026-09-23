# hubspot-cli

A custom wrapper around the official [`hubspot`](https://developers.hubspot.com/docs/guides/other/agent-integrations/agent-cli) Agent CLI that adds config-as-code commands — pull/push/diff to local files, multi-environment sync, and a deployment manifest — on top of it, the same way [`n8n-cli`](https://github.com/rverheijen/n8n-cli) wraps the official n8n CLI.

All official `hubspot` commands and flags pass through unchanged. This wrapper only adds new verbs on top of a handful of them. Live CRM data (`objects`, `owners`, `segments`, `imports`, ...) is untouched passthrough — this tool manages portal **configuration**, not records. (Bulk record import/export/diff is a separate, planned concern — see [issue #2](https://github.com/rverheijen/hubspot-cli/issues/2).)

## Install

The official `hubspot` binary is **not** an npm package — it's a separate Rust binary, typically already on your machine if you're using it as a Claude Code skill (`npx skills add hubspot/agent-cli-skills`), or installable directly:

```bash
curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
```

Then install this wrapper:

```bash
npm install -g github:rverheijen/hubspot-cli
```

`hubspot-cli` looks for `hubspot` on your `PATH` at runtime and errors with install instructions if it's missing. It is deliberately **not** bundled as a dependency here — see the "why not wrap `@hubspot/cli`/bundle the Agent CLI" discussion in project history if you're wondering.

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
| `schemas pull <type>` / `--all` | Save a custom object type's schema to `hubspot/schemas/<type>.json`. `--all` covers every custom type (discovered via `objects types`) |
| `schemas push <file>` | Create a new custom object type, or update an existing one's metadata |
| `schemas diff <file>` / `--all` | Compare local schema against remote |
| `properties pull --type <type>` / `--all` | Save an object type's properties to `hubspot/properties/<type>.json` (standard objects: custom properties only, use `--full` for everything) |
| `properties push <file>` | Create/update properties for an object type |
| `properties diff <file>` / `--all` | Compare local properties against remote |
| `properties groups pull --type <type>` / `--all` | Save property groups to `hubspot/property-groups/<type>.json` (via `@hubspot/api-client`, `hubspot` has no CLI surface for groups) |
| `properties groups push <file>` | Create/update/delete property groups |
| `properties groups diff <file>` / `--all` | Compare local groups against remote |
| `pipelines pull --type <type>` / `--all` | Save pipelines + stages to `hubspot/pipelines/<type>/<slug>.json` |
| `pipelines push <file>` | Create/update a pipeline and its stages |
| `pipelines diff <file>` / `--all` | Compare local pipeline+stages against remote |
| `associations pull [--from <type> --to <type>]` / `--all` | Save custom labels + limits to `hubspot/associations/<from>_<to>.json` |
| `associations push <file>` | Create/update labels and limits |
| `associations diff <file>` / `--all` | Compare local associations against remote |
| `views pull --type <type>` / `--all` | Save saved CRM views to `hubspot/views/<type>/<slug>.json` |
| `views push <file>` | Create/update a view's columns |
| `views diff <file>` / `--all` | Compare local view against remote |
| `workflows pull <id>` / `--all` | Save a v4 flow to `hubspot/workflows/<slug>.json` |
| `workflows push <file>` | Create a workflow, or update (full replace) an existing one |
| `workflows diff <file>` / `--all` | Compare local workflow against remote |
| `workflows activate <file\|id>` / `deactivate` | Sugar over `workflows update` flipping `isEnabled` |

Everything else — `hubspot-cli objects list`, `hubspot-cli whoami`, `hubspot-cli segments create`, `hubspot-cli imports start`, etc. — passes straight through to the real `hubspot` binary untouched.

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
hubspot-cli schemas pull --all --env-file .env.staging
hubspot-cli schemas pull --all --env production        # loads .env.production if present
```

In CI, set `HUBSPOT_ACCESS_TOKEN` directly as a secret; no `.env` file needed.

---

## Global flags

| Flag | Description |
|---|---|
| `--env <name>` | Environment name (manifest key, loads `.env.<name>` if present) |
| `--env-file <path>` | Load a specific `.env` file |
| `--dir <path>` | Override the default source/target directory |
| `--all` | Operate on all items of that resource type |
| `--full` | On `properties pull` for a standard object, include HubSpot-defined properties too (default: custom-only) |

---

## Two kinds of resource: schema vs. properties vs. objects

Worth being explicit about this, since it drives what each command does:

- **`schemas`** = the object *type* definition (like `CREATE TABLE`): its name, labels, primary display property, required properties, associated object types. Only meaningful for **custom** object types — standard ones (`contacts`, `companies`, `deals`, ...) already exist and can't be created/deleted, only their metadata can be updated (destructively — see below), which `schemas push` refuses by default (see "Standard vs. custom objects").
- **`properties`** = the object type's fields (like columns). Applies to **any** object type, standard or custom, and evolves independently of the schema over time.
- **`objects`** = the actual data records (rows). Live CRM data, not configuration — pure passthrough, never pulled/pushed/diffed by this wrapper.

## Standard vs. custom objects

`hubspot schemas list` only enumerates **custom** schemas. To discover everything (standard + custom), `schemas pull --all` uses `hubspot objects types` first, then `hubspot schemas get --type <name>` per type — this works for both (`metaType: HUBSPOT` for standard, `PORTAL_SPECIFIC` for custom).

`schemas push` **refuses to touch a `metaType: HUBSPOT` schema by default** (pass `--force` to override, with a warning). Standard schema metadata updates are marked `mutation_kind: "MetadataDestroy"` and `reversible: false` by the underlying API — pushing a locally-diverged file over it is exactly the kind of accident that's worth guarding against, not just gating behind the same confirm prompt as everything else.

`properties push` works normally against standard objects — adding/updating your own custom fields on `contacts` is the common case and isn't destructive to HubSpot's own fields.

---

## Push safety: the dry-run / digest / confirm handshake

Nearly every mutating `hubspot` command (`schemas update/delete`, `properties update/delete`, `pipelines update/delete`, `pipelines stages-update`, `associations labels-update/delete`, `views delete`) gates real execution behind a two-step confirm: run with `--dry-run` to get a `digest`, then re-run with `--digest <hash> --confirm <exact-name>`. That's a deliberate brake for a human typing commands by hand.

`hubspot-cli`'s `push` commands do this handshake **automatically and transparently** — one `hubspot-cli schemas push equipment.json` call does the dry-run, extracts the digest, and re-issues with confirm internally. This is worth knowing explicitly: `push` is authorizing a destructive confirm on your behalf. Read the diff output first if you're unsure.

---

## Deployment manifest

`.hubspot_cli/manifest.json` maps local filename → remote ID/objectTypeId, per environment, so `push` knows create-vs-update instead of duplicating on every run:

```json
{
  "sandbox": {
    "schemas": { "equipment.json": "2-12345678" },
    "pipelines": { "deals/sales_pipeline.json": "default" }
  },
  "production": {
    "schemas": { "equipment.json": "2-98765432" },
    "pipelines": { "deals/sales_pipeline.json": "55f2a1b0" }
  }
}
```

**Commit this file to git.** Association `typeId`s in particular are assigned per-portal, not stable across environments — confirmed by rotating a token mid-session and seeing the exact same conceptual label get a different `typeId` (see [issue #1](https://github.com/rverheijen/hubspot-cli/issues/1)) — so the manifest (and `associations push` resolving `typeId` live rather than trusting a value baked into the file) is what makes sandbox → production promotion actually portable.

---

## Working directory layout

```text
hubspot/
  schemas/
    equipment.json
  properties/
    contacts.json
    equipment.json
  property-groups/
    contacts.json
    equipment.json
  pipelines/
    deals/
      sales_pipeline.json
  associations/
    contacts_companies.json
  views/
    deals/
      all_open_deals.json
  workflows/
    lead_routing.json
```

---

## Roadmap / known gaps

See [open issues](https://github.com/rverheijen/hubspot-cli/issues) for the working backlog. Notably:

- [#1](https://github.com/rverheijen/hubspot-cli/issues/1) — `associations push` needs to drive both `labels-create` and `limits-create` from one config, resolving `typeId` itself.
- [#2](https://github.com/rverheijen/hubspot-cli/issues/2) — bulk record import/export/diff (JSON/CSV), deliberately separate from the config-as-code resources above.

## License

See [LICENSE.md](./LICENSE.md).
