---
name: hubspot-cli
description: Use hubspot-cli to pull/diff/push HubSpot object schemas (types, property groups, properties), association labels/limits, and property validation rules as config-as-code JSON, across multiple portals (sandbox/production/etc via .env.<name>). Use when asked to pull a HubSpot object's config, diff config between two portals, push a schema/property/group change, manage association labels or limits, or check/set a property's validation rule.
allowed-tools: Bash(hubspot-cli:*), Bash(hubspot:*), Read, Write
author: Remco Verheijen
---

# hubspot-cli

`hubspot-cli` wraps HubSpot's official `hubspot` Agent CLI. Every native `hubspot` command and flag passes through unchanged (`hubspot-cli objects list`, `hubspot-cli whoami`, `hubspot-cli imports start`, etc. all work exactly as documented upstream). This wrapper only adds config-as-code verbs (`pull`/`diff`/`push`) on top of a few resources, plus one standalone validation-rules command group the official CLI has no equivalent for at all.

**Implemented today: `objects`, `associations`, `properties validations`.** Nothing else is implemented, regardless of what any other documentation in this repo's history may have implied — don't attempt `pipelines`/`views`/`workflows` pull/push/diff, there is no code behind those verbs.

## Setup

Because this wraps the official `hubspot` binary directly, it inherits that binary's own auth for free:

```bash
hubspot auth login                        # interactive, browser-based OAuth - no key to manage
export HUBSPOT_ACCESS_TOKEN=pat-na1-...   # or: for CI / scripted use
```

`.env`/`.env.<name>` files are loaded automatically (shell env always wins over a loaded file):

```bash
hubspot-cli objects pull --all --env production         # loads .env.production if present
hubspot-cli objects pull --all --env-path .env.staging   # load a specific file
```

## Global flags

| Flag | Applies to | Description |
|---|---|---|
| `--env <name>` | all | Manifest key; loads `.env.<name>` if present |
| `--env-path <path>` | all | Load a specific `.env` file |
| `--dir <path>` | all | Override the default `hubspot/objects` / `hubspot/associations` directory |
| `--all` | pull/diff/push | Operate on every local or discoverable item |
| `--full` | `objects pull` | Include HubSpot-defined (`hubspotDefined: true`) properties too — sparse (custom-only) is the default |
| `--both` | `objects pull` | Write both the sparse bundle and a `<type>.full.json` reference in one run (mutually exclusive with `--full`) |
| `--force` | `objects push` | Report schema-metadata drift (labels/primaryDisplayProperty/requiredProperties) even for a standard (`metaType: HUBSPOT`) object — nothing can actually be applied there either way |

## Objects: schema + property groups + properties

`hubspot/objects/<type>.json` is one object type's shape — its schema (name, labels, primary display property, required properties — only meaningful for **custom** types), property groups, and properties. This is distinct from `hubspot-cli objects list/get/create/...`, which is native `hubspot` passthrough for live CRM *records* (rows, not the type's columns) — same command name, disambiguated entirely by verb.

```bash
hubspot-cli objects pull contacts                  # sparse: custom properties only
hubspot-cli objects pull contacts --full           # + every HubSpot-defined property, for reference
hubspot-cli objects pull contacts --both           # writes both, one fetch
hubspot-cli objects pull --all --env sandbox

hubspot-cli objects diff hubspot/objects/contacts.json
hubspot-cli objects diff --all

hubspot-cli objects push hubspot/objects/contacts.json
hubspot-cli objects push --all
```

Sparse mode filters out ~30 HubSpot-managed boilerplate properties every object type carries (`hs_object_id`, `hs_createdate`, ...). A sparse-kept group isn't necessarily portal-created — it may be an existing HubSpot default group a custom property was later dropped into; such a group gets `"sharedWithStandard": true` as an informational (never-pushed) flag.

**Authoring a brand-new custom object**: only `name` and `labels` are required. `primaryDisplayProperty` is required too if any properties are being created alongside it (HubSpot rejects creating a schema with properties but no valid primary display property). For an object that already exists, omit any schema-level field entirely to mean "leave it alone" — push only acts on what's present in the file.

**Known limitation — schema metadata can't be pushed to an existing custom object.** `hubspot schemas update`'s confirm step returns `ok: true` with what looks like the updated schema but never actually persists the change (upstream bug, [rverheijen/hubspot-cli#4](https://github.com/rverheijen/hubspot-cli/issues/4)). `objects push` does not attempt it at all for this reason — if local `labels`/`primaryDisplayProperty`/`requiredProperties` differ from remote on an existing object, push prints a `!` line naming the drift instead of a doomed, falsely-successful-looking update. Groups and properties are unaffected and still fully create/update correctly. `objects diff` always shows this kind of drift correctly regardless.

**Property field support on update**: `hubspot properties update` only supports `--label`/`--group`. For a property whose `modificationMetadata.readOnlyDefinition` is `false`, `type`/`fieldType`/`options` can additionally be changed via a raw API call this wrapper makes directly — anything else (`dataSensitivity`, `hasUniqueValue`) is confirmed unchangeable post-creation even then; push reports exactly which fields it skipped and why.

**Subscription-type opt-out properties** (`hs_email_optout_<id>` on `contacts`, `--full`/`--both` only) are represented portably as `hs_email_optout:<Subscription Type Name>` instead of the portal-specific numeric id, resolved live against the portal's real Email Subscription Types. These properties are read-only even for `label` — this is read/diff visibility, not something you can successfully push a change through.

## Associations: custom labels + limits

`hubspot/associations/<from>-<to>.json` holds one object-pair's custom (`USER_DEFINED`) association labels and its cardinality limit.

```bash
hubspot-cli associations pull --from contacts --to companies
hubspot-cli associations pull --all

hubspot-cli associations diff hubspot/associations/contacts-companies.json
hubspot-cli associations diff --all

hubspot-cli associations push hubspot/associations/contacts-companies.json
```

A limit targets one association type by label text: an explicit `limits.label`, or the bundle's first entry in `labels[]` if omitted. `limits.label` also covers capping an existing `HUBSPOT_DEFINED` type with no custom labels at all — set `labels: []` and `limits.label` to that type's own label. Example bundle:

```json
{
  "from": "contacts",
  "to": "companies",
  "cardinality": "M:1",
  "labels": [{ "label": "Gatekeeper", "name": "GATEKEEPER" }],
  "limits": { "label": "Gatekeeper", "category": "USER_DEFINED", "maxToObjectIds": 1 }
}
```

There's no `associations push --all` — push one pair's file at a time.

## Property validation rules

Not covered by the official `hubspot` CLI at all, and invisible on the standard property-read endpoints — validation rules live under a separate API (`/crm/property-validations/...`), wrapped here directly:

```bash
hubspot-cli properties validations list --type companies
hubspot-cli properties validations list --type companies --name vat_number
hubspot-cli properties validations get --type companies --name vat_number --rule-type REGEX
hubspot-cli properties validations set --type companies --name vat_number --rule-type REGEX \
  --args '^[A-Z]{2}[0-9A-Z]{2,20}$' --args 'Must start with a 2-letter country code.'
```

`--type` accepts a standard object's plain name directly; a custom object needs its numeric `objectTypeId` instead. There's no delete — removing a rule isn't supported by this API at all. Not folded into `objects` bundles yet.

## Deployment manifest

`.hubspot_cli/manifest.json` tracks remote object-type IDs per environment (keyed by env name from `--env`/`--env-path`), written automatically by every `push`. Commit it to git — it's an ID-mapping file, never secrets.

## Multi-portal workflows

A coding agent's two most common asks against this wrapper:

```bash
# Does sandbox config match production for a given type?
hubspot-cli objects diff hubspot/objects/contacts.json --env production
hubspot-cli objects diff hubspot/objects/contacts.json --env quality_assurance

# Promote a reviewed local change to another portal
hubspot-cli objects push hubspot/objects/contacts.json --env quality_assurance
```

`objects diff`/`push --all` only ever touch the tailored sparse bundle files in `hubspot/objects/` (a `--both` pull's `<type>.full.json` reference copies are deliberately excluded from both).
