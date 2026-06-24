# Canonical Documentation — Write Your Product Here

Document status: placeholder.

This directory is where **you, the project owner, write the product and architecture truth for {{PROJECT_NAME}}**. Nothing in `factory/` decides what your product is — these documents do.

## What goes here

- One Markdown file per coherent product or architecture decision area (`docs/canonical/01-<area>.md`, `docs/canonical/02-<area>.md`, ...).
- One source of truth per fact. State each decision in exactly one canonical document and link to it from anywhere else; never duplicate it.
- When an executable contract exists (a schema, a migration, code), the doc summarizes and links to it instead of copying it.

## How the factory uses these docs

1. You write canonical docs and give each a maturity tier (see [Source Of Truth](../governance/01-source-of-truth.md)).
2. You **freeze and hash** the doc set into a Doc Baseline Lock manifest with `factory/doc-baseline.mjs` (see [Documentation Baseline Lock](../governance/08-doc-baseline-lock.md)).
3. The semantic issue extraction pipeline reads **only** `docs/canonical/**/*.md` from that frozen baseline to produce the Requirement Catalog, Source Map, Traceability Matrix, vertical issues, and the architecture-map issue index (see [Development Traceability Method](../governance/05-development-traceability-method.md)).
4. After freeze, every product change enters through [Product Change Control](../governance/06-product-change-control.md) and produces a new frozen baseline — never a silent edit.

## Until you write at least one canonical doc

There is nothing to extract: the Requirement Catalog is empty, no issues are generated, and the architecture map is empty. The factory cannot invent your product. Write your first canonical document, freeze a baseline, and run extraction.
