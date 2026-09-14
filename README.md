# hubspot-cli

A data-engineering CLI for HubSpot. Built on top of the official `@hubspot/api-client`, it lets you manage CRM object schemas, properties, associations, pipelines, users, and teams across environments — ideal for RevOps implementations, data migrations, and portal-to-portal configuration syncs.

This package also installs the official `@hubspot/cli` (`hs`) for local development work, but does not wrap it yet.

## Install

```bash
npm install -g github:rverheijen/hubspot-cli
```

Both this wrapper and the official `hs` CLI become available.

## Authentication

Create a Private App in each HubSpot portal and grant the scopes you need:

- `crm.objects.contacts.read`, `crm.objects.contacts.write`
- `crm.schemas.contacts.read`, `crm.schemas.contacts.write`
- `crm.objects.deals.read`, `crm.objects.deals.write`
- etc. (mirror for companies, tickets, custom objects, and associations)

Copy the Private App access token and put it in `.env`:

```bash
HUBSPOT_ACCESS_TOKEN=pat-na1-...
HUBSPOT_ENV=default
```

For multiple environments, create `.env.client-a-prod`, `.env.client-a-sandbox`, etc. and run with `--env client-a-prod`.

## Quick start

```bash
# List object types in the portal
hubspot-cli object list

# Pull one object bundle (schema + property groups + properties)
hubspot-cli object pull contacts

# Pull everything
hubspot-cli object pull --all

# Push a local object bundle to the current portal
hubspot-cli object push hubspot/objects/contacts.json

# See what would change before pushing
hubspot-cli object diff hubspot/objects/contacts.json
hubspot-cli object diff --all
```

## Commands

### `object`

| Command | Description |
|---|---|
| `object list` | List all CRM object types |
| `object pull <objectType>` | Pull schema, groups, and properties for one object |
| `object pull --all` | Pull all objects |
| `object pull <objectType> --all-props` | Pull one object including every standard property |
| `object push <file>` | Push one object bundle (create or update properties/groups) |
| `object push --all` | Push all local object bundles |
| `object diff <file>` | Compare local bundle against remote |
| `object diff --all` | Diff all local bundles |

By default, standard objects (e.g. `contacts`, `companies`, `deals`) are pulled in **sparse mode**: only custom properties and the property groups that contain them are written to disk. Custom objects are always pulled in **full mode**. Bundles store a `pullMode` field so `diff` knows whether to report remote-only removals. Use `--all-props` to override.

### `association`

| Command | Description |
|---|---|
| `association list` | List association type definitions |
| `association pull [fromType] [toType]` | Pull association definitions for a pair, or all pairs if no arguments |
| `association push <file>` | Create missing association types/labels |
| `association push --all` | Push all local association bundles |

### `pipeline`

| Command | Description |
|---|---|
| `pipeline list <objectType>` | List pipelines for an object type (`deals`, `tickets`, custom objects) |
| `pipeline pull <objectType>` | Pull pipelines and stages for an object type |
| `pipeline push <objectType>` | Push pipelines and stages for an object type |

### `user` / `team`

| Command | Description |
|---|---|
| `user list` | List portal users (read-only) |
| `team list` | List portal teams (read-only) |

## Global flags

| Flag | Description |
|---|---|
| `--env <name>` | Environment name; loads `.env.<name>` |
| `--env-file <path>` | Load a specific `.env` file |
| `--dir <path>` | Override default working directory (`./hubspot`) |
| `--all` | Operate on all items in the target directory |

## Working directory layout

```text
hubspot/
  objects/
    contacts.json
    companies.json
    deals.json
    p_my_custom_object.json
  associations/
    contacts_companies.json
    companies_deals.json
  pipelines/
    deals/
      sales_pipeline.json
```

## Manifest

`.hubspot_cli/manifest.json` maps local filenames to remote IDs per environment so pushes are idempotent:

```json
{
  "client-a-sandbox": {
    "objects": {
      "p_my_custom_object.json": "p_my_custom_object"
    },
    "pipelines": {
      "deals": {
        "sales_pipeline.json": "12345678"
      }
    }
  }
}
```

## Limitations and roadmap

- Object update: HubSpot only allows limited schema mutation after creation. We therefore update labels and push new/changed property groups and properties. We do not delete properties or groups yet.
- Associations: only creates missing association types; does not update or delete labels yet.
- Users/teams: read-only for now.
- Future: full `diff` for associations and pipelines, prune flags, owners, lists, workflows.

## License

Sustainable Use License
