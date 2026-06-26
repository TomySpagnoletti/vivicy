# Pocket Ledger - development-method rehearsal fixture

This directory is an **isolated, self-contained fake project** used to rehearse the Naight OS development method end-to-end. It is **not** part of the Naight OS product and describes a different product: Pocket Ledger, a tiny dependency-free TypeScript/JavaScript personal-expense-tracker library.

It exists so the method tooling and the autonomous dev-loop can be exercised against a small, real, buildable codebase without touching the real Naight OS canonical baseline.

## Why it works

The method tools are root-aware via the `VIVICY_TARGET_ROOT` environment variable (the legacy `NAIGHT_DEV_ROOT` is still accepted). Pointing that variable at this directory makes the tools treat it as if it were the repository root: they read `docs/canonical/**`, `docs/baselines/`, `docs/architecture-map/`, and `spec/development/` from here instead of the host project.

## Layout

Committed inputs/artifacts (the fixture proper):

```
pocket-ledger/
  README.md                                  this file
  .gitignore                                 ignores the regenerable tool outputs below
  package.json                               npm scaffold; `npm test` runs node --test
  src/index.js                               placeholder module (agents fill src/ in)
  test/scaffold.test.js                      trivial green test so the gate exists
  docs/
    canonical/                               6 frozen canonical docs (the product spec)
      01-architecture.md … 06-cli.md
    baselines/
      baseline-v1.0.0.json                   frozen doc baseline manifest (regenerable)
    architecture-map/
      architecture-map.yml                   minimal valid map (6 nodes, 7 edges, 2 lanes)
  spec/
    development/
      issue-index.json                       extracted index: 8 issues, topologically ordered
      issues/ISS-0001.md … ISS-0008.md       8 vertical issues (the extraction write step)
      progress-ledger.json                   progress ledger (orchestrator-written)
    requirements/
      catalog.json                           Requirement Catalog (21 requirements)
      traceability-matrix.json               Traceability Matrix (21 rows)
      exclusions.json                        governed line-exclusion records (36)
```

Regenerated at run time by the deterministic tooling, and COMMITTED by the orchestrator (these are real evidence the user gets in git; only transcripts are never committed):

```
  docs/architecture-map/viewer/src/architecture-data.json   generate-viewer-data.ts output
  spec/requirements/source-map.json                         semantic-extraction-check output
  spec/requirements/coverage-report.json / .md              semantic-extraction-check output
```

## Baseline pins

The architecture map, issue index, and progress ledger all pin the same frozen documentation baseline:

- `baseline_id`: `baseline-v1.0.0`
- `baseline_version`: `1.0.0`
- `manifest_path`: `docs/baselines/baseline-v1.0.0.json`
- `manifest_hash` and `document_set_hash`: the hashes recorded in that manifest, which are deterministic from the canonical docs.

## How to validate it

A frozen baseline requires a clean git working tree, so validate from a throwaway git copy rather than the real repo:

```sh
RV=$(mktemp -d)
cp -R . "$RV"
cd "$RV"
git init -q && git add -A && git commit -qm fixture

# 1. Verify the frozen documentation baseline.
VIVICY_TARGET_ROOT="$RV" node <vivicy>/factory/doc-baseline.mjs \
  verify --manifest docs/baselines/baseline-v1.0.0.json \
  --require-status frozen --require-baseline-id baseline-v1.0.0

# 2. Run the semantic extraction gate (placeholder => "nothing to check yet").
VIVICY_TARGET_ROOT="$RV" node <vivicy>/factory/semantic-extraction-check.mjs

# 3. Generate the architecture viewer data.
VIVICY_TARGET_ROOT="$RV" node <vivicy>/factory/generate-viewer-data.ts

# 4. Run the project gate.
npm test
```

To regenerate the frozen manifest (the hashes are deterministic from the docs), run `doc-baseline.mjs generate --version 1.0.0 --status frozen` against a clean git copy with `--approved-by` and `--approval-ref`, then re-pin the printed `manifest_hash` and `document_set_hash` into `architecture-map.yml`, `issue-index.json`, and `progress-ledger.json`.

## What it is not

This fixture is test scaffolding only. It must never be committed as live Naight OS progress, and the dev-loop agents working it must not mutate the real repo's canonical baseline or architecture map.
