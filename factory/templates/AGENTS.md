# {{PROJECT_NAME}} Development Operating Guide

This repository is developed by the **Vivicy development factory** from the canonical spec under `docs/canonical/**`. This file is the lean entrypoint for any development agent working in this repo. Read it first; it is not a product specification.

Vivicy is the method machinery (the deterministic orchestrator, the documentation baseline lock, the traceability checks, the progress ledger, and the architecture-map viewer). It runs OUTSIDE this repository and points at it. The product you build lives in `docs/canonical/**/*.md`, written by the project owner.

## How development works here

Vivicy drives this repo through a deterministic loop. The agents do only four actions; Vivicy does everything else (freeze, extract, schedule, re-run the gate, commit, move issues to done) mechanically:

1. **Extract** — read the frozen canonical spec and author the executable plan (requirement catalog, traceability matrix, line exclusions, vertical issues, issue index, architecture map).
2. **Verify** — independently check that extraction against the spec.
3. **Implement** — make one issue's verification gate pass with the smallest correct vertical slice (TDD; gate-first).
4. **Review** — an independent agent reviews and fixes that issue's diff.

The full per-action discipline (what to read, what to produce, the quality bar, the frozen read-only corpus, the public-API rules) travels in the **Vivicy-bundled agent prompts**, not in this repo. You do NOT need any method docs checked into this project: when Vivicy invokes you, it hands you the prompt that governs your action. Your job is to follow that prompt and leave the gate green.

## Product and architecture truth

- Product and architecture truth lives **only** in the active frozen canonical baseline under `docs/canonical/**/*.md`. These docs are written by the project owner; until at least one exists and is frozen into a baseline, there is nothing to extract. Never implement product behavior, the component model, data ownership and isolation rules, protocol boundaries, the identity/auth model, secret handling, or runtime/cloud decisions from this file or from memory.
- Read the relevant canonical document before coding a slice, and verify each product assumption against its canonical home. On any conflict, the canonical doc wins.
- The EXTRACTION CORPUS is FROZEN and READ-ONLY during implementation: never modify `docs/canonical/**`, `docs/baselines/**`, `spec/requirements/**`, `spec/development/issue-index.json`, the issue files, or `docs/architecture-map/architecture-map.yml`.

## Build, test, and validate

- The per-issue **verification gate** is the command in `vivicy.json` (`gateCommand`). Vivicy re-runs it itself as the authoritative verdict on every issue — it is the arbiter of done. Set `gateCommand` to this project's real test runner (for example `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, or `npm test`). An issue may override it per issue via its own `gate_command`.
- Install whatever you need (CLIs, runtimes, package managers) and capture repeatable dependencies in the project's own manifests, scripts, infrastructure, or docs.
- Do not hardcode machine-specific absolute paths such as `/Users/...` in repo code, tests, scripts, or docs.

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

## Language

All development artifacts are English: code, comments, docs, generated specs, issue prompts, test names, commit messages, and default source/translation strings. Any product i18n behavior — locales, fallback language, internal working language — is product truth defined in the canonical baseline.
