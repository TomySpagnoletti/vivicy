# {{PROJECT_NAME}} Development Operating Guide

This repository is built by the **Vivicy** development factory from the canonical spec under `.vivicy/canonical/**`. This file is the technical entrypoint for any agent working in this repo — read it first. It is not a product specification; the product truth lives in the frozen canonical baseline.

Vivicy — the deterministic orchestrator, the documentation-baseline lock, the traceability gates, the progress ledger, and the architecture-map viewer — runs OUTSIDE this repository and points at it, the way `git` operates on a working tree. It is never vendored in. Your job as an agent is to leave the verification gate green on the slice you were handed and touch nothing outside your mandate.

## The `.vivicy/` layout

Everything Vivicy owns lives under one directory at the repo root:

- `.vivicy/canonical/**/*.md` — **product truth**, authored by the owner: the only source of what to build. Frozen into a baseline before extraction.
- `.vivicy/baselines/**` — frozen baseline manifests (the hash of the canonical corpus at freeze time).
- `.vivicy/requirements/**` — the extracted requirement catalog and traceability data.
- `.vivicy/architecture-map/architecture-map.yml` — the extracted architecture map (nodes, edges, coverage); the `architecture-data.json` and viewer data beside it are generated and committed.
- `.vivicy/development/issues/` — the extracted vertical issues; `done/` holds the retired ones.
- `.vivicy/development/issue-index.json` — the issue dependency graph and scheduling index.
- `.vivicy/development/spikes/` — spike experiments that prove risky assumptions before the freeze.
- `.vivicy/development/reports/` — orchestrator reports (extraction status, skills, CR application, map review, quotas).
- `.vivicy/development/progress-ledger.json` — the single source of truth for build progress, written mechanically by the orchestrator.
- `.vivicy/development/transcripts/` — raw agent session logs; produced on disk, **never committed**.
- `.vivicy/change-requests/` — change requests (see below).
- `.vivicy/uploads/**` — source documents imported as raw spec material, one folder per import batch.

## How the loop drives this repo

Vivicy runs a deterministic loop. Agents perform only four actions; the orchestrator does everything else (freeze, extract, schedule, re-run the gate, commit, move issues to `done/`) mechanically:

1. **Extract** — read the frozen canonical spec and author the executable plan (requirement catalog, traceability matrix, line exclusions, vertical issues, issue index, architecture map).
2. **Verify** — independently check that extraction against the spec.
3. **Implement** — make one issue's verification gate pass with the smallest correct vertical slice (gate-first, TDD).
4. **Review** — an independent agent reviews and fixes that issue's diff.

The full per-action discipline (what to read, what to produce, the quality bar, the frozen read-only corpus, the public-API rules) travels in the **Vivicy-bundled agent prompt** that governs your invocation — no method docs are checked into this repo. When Vivicy invokes you it hands you the prompt for your action; follow it and leave the gate green.

## Product and architecture truth

- Product and architecture truth lives **only** in the active frozen canonical baseline under `.vivicy/canonical/**/*.md`, written by the owner. Never implement product behavior, the component model, data ownership and isolation rules, protocol boundaries, the identity/auth model, secret handling, or runtime/cloud decisions from this file or from memory.
- Read the relevant canonical document before coding a slice, and verify each product assumption against its canonical home. On any conflict, the canonical doc wins.

## The verification gate — `vivicy.json`

`vivicy.json` at the repo root is the project's gate contract:

- `gateCommand` — the command Vivicy runs as the per-issue verification gate and re-runs itself as the authoritative verdict on every issue (for example `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, or `npm test`). Vivicy establishes it mechanically, never a human: the scaffold writes the sentinel `null` (not yet established); the pipeline fills the real command from the frozen canonical when the spec states one, otherwise the stack-setup issue's implementer sets it as part of completing that issue. Once it is a real command, leave it in place — an issue may still override it for itself via its own `gate_command`. A field explicitly present in `vivicy.json`, even an empty array, always wins over the `package.json#vivicy` fallback for that field.
- `requiredSkills` — the agent skills installed for this project, as `owner/repo@skill` ids. Maintained by Vivicy's skills stage together with the managed *Project skills* section it keeps at the end of this file; both the implementer and the reviewer MUST consult and apply any installed skill whose domain their work touches.

Install whatever tooling you need (CLIs, runtimes, package managers) and capture repeatable dependencies in the project's own manifests, scripts, infrastructure, or docs. Do not hardcode machine-specific absolute paths such as `/Users/...` in repo code, tests, scripts, or docs.

## What you must never touch

During implementation the **extraction corpus is frozen and read-only**: never modify `.vivicy/canonical/**`, `.vivicy/baselines/**`, `.vivicy/requirements/**`, `.vivicy/development/issue-index.json`, the issue files, or `.vivicy/architecture-map/architecture-map.yml`. The orchestrator alone performs governance — git commits, the progress ledger, map edits, and moving issues to `done/`: never commit, never write the ledger, never edit the map yourself. Transcripts under `.vivicy/development/transcripts/` stay on disk and never enter git history.

## Change requests

The frozen canonical spec is the intention, and it is not edited directly once frozen. When implementation reveals that the intention itself is wrong, or a discovered constraint changes what must be built, that is a **change request** under `.vivicy/change-requests/` — never a silent code workaround and never a spec edit. An accepted CR folds back into the canonical, forcing a re-freeze and re-extraction. Approving or rejecting a CR is the single human decision the loop waits for; agents never decide a CR. If an issue is non-implementable because of already-produced code, fix the issue's plan; if it is non-implementable because the intention is wrong, route to a CR. Never reconcile a contract conflict with a side-channel hack — stop and route it to change control.

## Engineering principles

These are build-discipline invariants you enforce while writing the system. The product boundaries they protect are product truth — read them in their canonical home, do not restate them.

- One source of truth per decision; one protocol per boundary; one owner per state transition.
- Prefer typed contracts to generic `payload`/`metadata`/untyped blobs for core protocols when a typed contract can exist.
- No shadow state store, and no schema duplicated across prose and code once an executable schema exists.
- No fallback path unless the active frozen canonical baseline explicitly requires it.
- Enforce — do not re-document — the product's architecture boundaries: each protocol boundary, isolation rule, secret boundary, and scope limit the canonical baseline defines. The canonical doc owns the rule; your code enforces it.

## Quality

- Never reach green by lowering standards or hiding reality. Do not weaken assertions, narrow covered paths, skip or pend tests, relax performance budgets, add permissive retries, or replace real behavior with synthetic proof.
- Code coverage must include the real executable logic — product behavior, security, isolation, protocol, orchestration, persistence, integration, i18n, and error handling. Mock-only proof is insufficient for stateful mutations, provider integrations, lifecycle behavior, secrets, or isolation boundaries.
- **Only the intent is sacred, not the code.** Preserve intent, invariants, and the reason a feature exists — not a weak implementation for its own sake. If the implementation is structurally poor, redesign it aggressively while keeping the product truth and user-visible intent.
- **Refactor, do not accrete.** Do not stack workaround-on-workaround patches. When an area becomes hard to reason about, collapse it to the smallest explicit design that still satisfies correctness, security, and performance.
- **Diagnose before rewriting.** Reproduce, measure, localize, identify the actual cause, and apply the smallest evidence-backed fix.

## Code hygiene

- **Zero comments by default.** Code here is written and read mostly by AI agents: comments cost tokens on every read and rot into lies; the code, its names, and its tests are the documentation. The only comment allowed is a structural invariant, constraint, or danger genuinely not derivable from the code itself — one dense line, no story. Never write narration or paraphrase, JSDoc/docstrings that restate names and types, module-header essays, TODO musings, or decorative banners. Tool directives (`eslint-disable`, `@ts-expect-error`, `"use client"`, shebangs) are not comments — keep them. Never match the comment density of a heavily-commented codebase: that density is a defect, not a style to imitate.
- **Never encode a moment in time.** Code is a flow — it states what the system IS now, never when or in which batch it was written: no version markers, plan/phase/sprint/batch codes, "new/old/legacy/added in vX" wording, or session references in identifiers, strings, comments, or docs. Version data a machine reads (dependency manifests, protocol/schema version fields) and requirement IDs from the traceability corpus are functional, not markers — those stay.
- These two rules are the Vivicy factory default; the project owner owns this file and may amend this section for this repository.

## Language

All development artifacts are English: code, comments, docs, generated specs, issue prompts, test names, commit messages, and default source/translation strings. Any product i18n behavior — locales, fallback language, internal working language — is product truth defined in the canonical baseline.
