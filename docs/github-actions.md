# GitHub Actions CI/CD Guide

This guide explains how to use `hubspot-cli` with GitHub Actions to validate, deploy and promote HubSpot portal configuration (schemas, properties, property groups, pipelines, associations, views, workflows) across one or more portals.

---

## How it works

```text
Developer pushes code
                 │
                 ▼
     ┌─────────────────────────────┐    PR opened       ┌────────────────────────────┐
     │  Git repo                   │───────────────────►│  CI: validate              │
     │  ├── hubspot/                │                    │  └─ Changed config files   │
     │  │   ├── schemas/            │                    └────────────────────────────┘
     │  │   ├── properties/         │   Merge to main    ┌────────────────────────────┐
     │  │   ├── property-groups/    │───────────────────►│  CD: sandbox               │
     │  │   ├── pipelines/          │                    │  1. schemas push           │
     │  │   ├── associations/       │                    │  2. property-groups push   │
     │  │   ├── views/              │                    │  3. properties push        │
     │  │   └── workflows/          │                    │  4. pipelines push         │
     │  └── .hubspot_cli/           │                    │  5. associations push      │
     │      └── manifest.json       │                    │  6. views push             │
     └─────────────────────────────┘                    │  7. workflows push          │
                 ▲                                       └──────────────┬─────────────┘
                 │                                                     │ passes
                 │                                                     ▼
                 │                                      ┌────────────────────────────┐
                 │                                      │  CD: quality_assurance     │
                 │                                      │  (same 7 steps)             │
                 │                                      └──────────────┬─────────────┘
                 │                                                     │ approved
                 │                                                     ▼
                 │                                      ┌────────────────────────────┐
                 │                                      │  CD: production            │
                 │                                      │  (same 7 steps)             │
                 │                                      └──────────────┬─────────────┘
                 │                                                     │
                 └─────────────────────────────────────────────────────┘
                              manifest committed back
```

Deployment order matters: a schema must exist before properties can be added to it, groups should exist before properties are assigned into them, and pipelines/associations/views/workflows can all reference object types and properties defined earlier in the sequence.

---

## Recommended repo structure

```text
your-project/
├── .github/
│   └── workflows/
│       ├── ci.yml                  validate on pull request
│       ├── cd.yml                  deploy to single portal on merge
│       └── cd-promote.yml          promote sandbox -> quality_assurance -> production
├── .hubspot_cli/
│   └── manifest.json               tracks schema/pipeline/view/workflow IDs per portal
├── hubspot/
│   ├── schemas/
│   │   └── equipment.json
│   ├── properties/
│   │   ├── contacts.json           custom properties only, unless pulled with --full
│   │   └── equipment.json
│   ├── property-groups/
│   │   └── contacts.json
│   ├── pipelines/
│   │   └── deals/
│   │       └── sales_pipeline.json
│   ├── associations/
│   │   └── contacts_companies.json
│   ├── views/
│   │   └── deals/
│   │       └── all_open_deals.json
│   └── workflows/
│       └── lead_routing.json
├── .env                             local dev (gitignored)
├── .env.sandbox                     local targeting of sandbox (gitignored)
└── .gitignore
```

**Commit to git:**
- Everything under `hubspot/` and `.hubspot_cli/`
- `.hubspot_cli/manifest.json`: tracks remote IDs so subsequent deployments update instead of duplicate

**Never commit:**
- `.env`, `.env.*`: contain the portal access token

---

## Prerequisites

### 1. Install `hubspot` and `hubspot-cli` in CI

The official `hubspot` binary isn't an npm package, so CI needs to install both it and this wrapper:

```bash
curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
npm install -g github:rverheijen/hubspot-cli
```

### 2. Enable write permissions for the manifest commit

The CD workflows commit the updated `.hubspot_cli/manifest.json` back to the repo after each deployment. To allow this, go to:

**Settings → Actions → General → Workflow permissions**

Set to **Read and write permissions**.

---

## Setting up GitHub Secrets

### Single portal

Go to **Settings → Secrets and variables → Actions** and add:

| Secret | Value |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Your portal's Private App / service key token |

### Multiple portals

Use [GitHub Environments](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment), one per portal (**Settings → Environments**), each with its own `HUBSPOT_ACCESS_TOKEN` secret. You get deployment protection rules and approval gates per portal — this is how production approval gating works below.

---

## Workflow files

### CI: Validate on pull request

**`.github/workflows/ci.yml`**

Runs on every pull request that touches config files. Diffs each changed file against the remote portal so reviewers can see drift before merge.

```yaml
name: CI

on:
  pull_request:
    paths:
      - 'hubspot/**.json'

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install hubspot and hubspot-cli
        run: |
          curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
          echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
          npm install -g github:rverheijen/hubspot-cli

      - name: Diff changed config against remote
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: |
          git fetch origin ${{ github.base_ref }}
          for resource in schemas properties property-groups pipelines associations views workflows; do
            git diff --name-only origin/${{ github.base_ref }}...HEAD -- "hubspot/$resource/**.json" | \
            while read file; do
              [ -f "$file" ] || continue
              echo "Diffing $file..."
              hubspot-cli "$resource" diff "$file" || true
            done
          done
```

The diff step uses `|| true` so it never blocks the PR. It prints the diff for review without failing the build. Remove `|| true` if you want to block merges when local and remote are out of sync.

---

### CD: Deploy to a single portal

**`.github/workflows/cd.yml`**

Deploys everything, in dependency order, on every merge to `main`.

```yaml
name: Deploy

on:
  push:
    branches:
      - main
    paths:
      - 'hubspot/**.json'

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install hubspot and hubspot-cli
        run: |
          curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
          echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
          npm install -g github:rverheijen/hubspot-cli

      - name: Push schemas
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli schemas push --all

      - name: Push property groups
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli properties groups push --all

      - name: Push properties
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli properties push --all

      - name: Push pipelines
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli pipelines push --all

      - name: Push associations
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli associations push --all

      - name: Push views
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli views push --all

      - name: Push workflows
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: hubspot-cli workflows push --all

      - name: Commit updated manifest
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .hubspot_cli/manifest.json
          git diff --staged --quiet || git commit -m "chore: update deployment manifest [skip ci]"
          git push
```

---

### CD: Promote through sandbox, quality_assurance, and production

**`.github/workflows/cd-promote.yml`**

Deploys sequentially through three portals on merge to `main`. Each portal is gated by the previous one. Production requires manual approval via a GitHub Environment protection rule.

**Setup:**
1. Create three GitHub Environments: `sandbox`, `quality_assurance`, `production` (**Settings → Environments**)
2. Add `HUBSPOT_ACCESS_TOKEN` as a secret to each
3. On the `production` environment, enable **Required reviewers** to add a manual approval gate

```yaml
name: Promote to production

on:
  push:
    branches:
      - main
    paths:
      - 'hubspot/**.json'
  workflow_dispatch:

jobs:
  deploy-sandbox:
    name: Deploy to sandbox
    environment: sandbox
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install hubspot and hubspot-cli
        run: |
          curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
          echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
          npm install -g github:rverheijen/hubspot-cli

      - name: Push all config
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: |
          hubspot-cli schemas push --all --env sandbox
          hubspot-cli properties groups push --all --env sandbox
          hubspot-cli properties push --all --env sandbox
          hubspot-cli pipelines push --all --env sandbox
          hubspot-cli associations push --all --env sandbox
          hubspot-cli views push --all --env sandbox
          hubspot-cli workflows push --all --env sandbox

      - name: Commit updated manifest
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .hubspot_cli/manifest.json
          git diff --staged --quiet || git commit -m "chore: update manifest [sandbox] [skip ci]"
          git push

  deploy-quality_assurance:
    name: Deploy to quality_assurance
    needs: deploy-sandbox
    environment: quality_assurance
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.ref }}

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install hubspot and hubspot-cli
        run: |
          curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
          echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
          npm install -g github:rverheijen/hubspot-cli

      - name: Push all config
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: |
          hubspot-cli schemas push --all --env quality_assurance
          hubspot-cli properties groups push --all --env quality_assurance
          hubspot-cli properties push --all --env quality_assurance
          hubspot-cli pipelines push --all --env quality_assurance
          hubspot-cli associations push --all --env quality_assurance
          hubspot-cli views push --all --env quality_assurance
          hubspot-cli workflows push --all --env quality_assurance

      - name: Commit updated manifest
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .hubspot_cli/manifest.json
          git diff --staged --quiet || git commit -m "chore: update manifest [quality_assurance] [skip ci]"
          git push

  deploy-production:
    name: Deploy to production
    needs: deploy-quality_assurance
    environment: production
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.ref }}

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install hubspot and hubspot-cli
        run: |
          curl -fsSL https://api.hubapi.com/hub/cli/backend/hub-cli/latest/install.sh | sh
          echo "$HOME/.hubspot/bin" >> "$GITHUB_PATH"
          npm install -g github:rverheijen/hubspot-cli

      - name: Push all config
        env:
          HUBSPOT_ACCESS_TOKEN: ${{ secrets.HUBSPOT_ACCESS_TOKEN }}
        run: |
          hubspot-cli schemas push --all --env production
          hubspot-cli properties groups push --all --env production
          hubspot-cli properties push --all --env production
          hubspot-cli pipelines push --all --env production
          hubspot-cli associations push --all --env production
          hubspot-cli views push --all --env production
          hubspot-cli workflows push --all --env production

      - name: Commit updated manifest
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add .hubspot_cli/manifest.json
          git diff --staged --quiet || git commit -m "chore: update manifest [production] [skip ci]"
          git push
```

The `needs:` keyword enforces the promotion order: sandbox must pass before quality_assurance runs, and quality_assurance must pass before production is attempted. With **Required reviewers** set on the `production` environment, GitHub pauses the pipeline and waits for manual approval before the production job starts.

The manifest grows one section per portal:

```json
{
  "sandbox":           { "schemas": { "equipment.json": "2-11111111" } },
  "quality_assurance": { "schemas": { "equipment.json": "2-22222222" } },
  "production":        { "schemas": { "equipment.json": "2-33333333" } }
}
```

---

## Local development workflow

```bash
# Initial setup: pull everything from your portal
hubspot-cli schemas pull --all
hubspot-cli properties groups pull --all
hubspot-cli properties pull --all
hubspot-cli pipelines pull --all
hubspot-cli associations pull --all
hubspot-cli views pull --all
hubspot-cli workflows pull --all

# Check for portal changes before editing locally
hubspot-cli schemas diff hubspot/schemas/equipment.json

# Edit files under hubspot/

# Push to sandbox to test
hubspot-cli schemas push hubspot/schemas/equipment.json --env sandbox
hubspot-cli properties push hubspot/properties/equipment.json --env sandbox

# Commit and push; GitHub Actions handles the rest
git add hubspot/
git commit -m "feat: add warranty_expiry to equipment"
git push
```

For multiple portals locally, use `.env` files:

```bash
hubspot-cli schemas push --all --env-path .env.sandbox
hubspot-cli properties push --all --env-path .env.sandbox
```

---

## Adding a new portal

1. Create a new GitHub Environment named e.g. `client-b-prod` and add its `HUBSPOT_ACCESS_TOKEN` secret.
2. Add a deploy job for it (copy the `deploy-sandbox` job shape above, or add it to a matrix if you have several similar portals).
3. Create `.env.client-b-prod` locally (gitignored) for local access.
4. Run the initial deployment locally to populate the manifest:
   ```bash
   hubspot-cli schemas push --all --env client-b-prod
   hubspot-cli properties groups push --all --env client-b-prod
   hubspot-cli properties push --all --env client-b-prod
   hubspot-cli pipelines push --all --env client-b-prod
   hubspot-cli associations push --all --env client-b-prod
   hubspot-cli views push --all --env client-b-prod
   hubspot-cli workflows push --all --env client-b-prod
   ```
5. Commit the updated `.hubspot_cli/manifest.json`.

From this point on, GitHub Actions handles deployments on every push to main.

---

## Troubleshooting

**A schema/property/pipeline was edited directly in the HubSpot UI and is out of sync with git**
Run the resource's `diff` command to see what changed, then either pull the remote version or push the git version back.

**Config is being created as duplicates instead of updated**
The manifest (`.hubspot_cli/manifest.json`) is either missing or doesn't have an entry for that environment. Run `push` once locally with the correct `--env` flag to populate the manifest, then commit it.

**`schemas push` / `workflows push` refuses to run**
`schemas push` refuses `metaType: HUBSPOT` (standard object) targets by default — pass `--force` if you deliberately want to update a standard object's metadata, and be sure you mean it (it's a destructive full metadata replace). `workflows push` requires `HUBSPOT_ACCESS_TOKEN`; OAuth-based auth isn't accepted by the v4 flows API at all.

**Association `typeId` looks different between portals for what should be the same label**
Expected — `typeId` is assigned per portal, not stable across environments (see [issue #1](https://github.com/rverheijen/hubspot-cli/issues/1)). Never hand-edit a `typeId` into an associations file; `associations push` resolves it live every time.

**`Error: env file not found`**
You used `--env-path .env.client-b-prod` but the file doesn't exist. Either create the file or use `--env client-b-prod` (which only requires the file if it exists, and falls back to shell env vars).

**Manifest commit is failing in CI**
Check that **Workflow permissions** is set to **Read and write** in repository settings (Settings → Actions → General).

**`Error: could not resolve hubspot binary`**
The `hubspot` CLI isn't on `PATH`. Make sure the install step ran before any `hubspot-cli` command, and that `$HOME/.hubspot/bin` was added to `$GITHUB_PATH` in the same job.
