
## hubspot-cli wrapper commands

This skill also manages the custom `hubspot-cli` wrapper that ships with this package.
Use it for HubSpot data-engineering tasks (CRM objects, properties, associations, pipelines, users, teams).

### Authentication

The wrapper reads `HUBSPOT_API_KEY` from `.env` or `.env.<env>` files. Create a Private App (or service key) in the target HubSpot portal with the scopes required for the resources you plan to manage.

### Global flags

- `--env <name>` – use environment name and load `.env.<name>` if present
- `--env-file <path>` – load a specific env file
- `--dir <path>` – override the default `./hubspot` working directory
- `--all` – operate on all items in the target directory

### Commands

**CRM objects**
- `hubspot-cli object list`
- `hubspot-cli object pull <objectType>`
- `hubspot-cli object pull --all`
- `hubspot-cli object push <file>`
- `hubspot-cli object push --all`
- `hubspot-cli object diff <file>`
- `hubspot-cli object diff --all`

Object bundles are saved as `hubspot/objects/<object>.json` and contain the schema, property groups, and properties for that object.

**Associations**
- `hubspot-cli association list`
- `hubspot-cli association pull [fromObjectType] [toObjectType]`
- `hubspot-cli association push <file>`
- `hubspot-cli association push --all`

Association bundles are saved as `hubspot/associations/<fromObject>_<toObject>.json` and contain association types/labels.

**Pipelines**
- `hubspot-cli pipeline list <objectType>`
- `hubspot-cli pipeline pull <objectType>`
- `hubspot-cli pipeline push <objectType>`

Pipelines are saved under `hubspot/pipelines/<objectType>/`.

**Users and teams (read-only)**
- `hubspot-cli user list`
- `hubspot-cli team list`
