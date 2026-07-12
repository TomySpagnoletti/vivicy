# {{PROJECT_NAME}} Development Operating Guide

This file is the technical entrypoint for any agent working in this repo — read it first. It is not a product specification; the product truth lives in the frozen canonical baseline. The sections below the essential contract expand each rule in detail.

<!-- vivicy:method:begin -->
## Working under Vivicy

This repository is governed by the **Vivicy** development factory. The product truth is the frozen canonical spec under `.vivicy/canonical/**`, never this file or memory; Vivicy runs OUTSIDE the repository (the way `git` operates on a working tree) and is never vendored in.

- During implementation the `.vivicy/**` extraction corpus is frozen and read-only: never modify `.vivicy/canonical/**`, `.vivicy/baselines/**`, `.vivicy/requirements/**`, `.vivicy/development/issue-index.json`, the issue files, or `.vivicy/architecture-map/**`.
- The orchestrator alone performs governance — git commits, the progress ledger, map edits, and moving issues to `done/`. Never commit, never write the ledger, never edit the map yourself. Transcripts under `.vivicy/development/transcripts/` stay on disk and never enter git history.
- The verification gate is `vivicy.json`'s `gateCommand`; leave it green on the slice you were handed and touch nothing outside your mandate. Never hardcode machine-specific absolute paths.
- When the intention itself is wrong, or a discovered constraint changes what must be built, raise a change request under `.vivicy/change-requests/` — never a silent code workaround and never a spec edit. Approving or rejecting a change request is the one human decision the loop waits for.
- Consult and apply any project skill Vivicy has installed (listed in the *Project skills* section Vivicy maintains at the end of this file) whose domain your work touches.
- Write spec and documentation artifacts in the project's established language — the language of its own docs and imported sources, never assumed to be English; code identifiers follow the existing codebase's convention.
<!-- vivicy:method:end -->

## The `.vivicy/` layout

Everything Vivicy owns lives under one directory at the repo root:

- `.vivicy/canonical/**/*.md` — **product truth**: the only source of what to build, co-authored with Vivi (her grill, the owner's answers, and imported documents prepared into canonical form). Frozen into a baseline before extraction.
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

Vivicy runs a deterministic loop. At each decision point it spawns an agent **leg** that PROPOSES — a plan, a verdict, or a diff; the orchestrator ENFORCES everything around it (freeze, extract, schedule, run the gate, commit, move issues to `done/`, write the progress ledger) mechanically. Enforcement is never a leg's job, and no leg reports its own progress.

The action your leg performs is defined by the **Vivicy-bundled prompt** handed to you at invocation — no method docs are checked into this repo. The roster of legs grows as the factory does (preparing imported documents, extraction and its independent verification, implementing an issue against its gate, independent review, spike proving); treat the prompt you were handed as the authority, not any list here. Follow it and leave the gate green.

## Product and architecture truth

- Product and architecture truth lives **only** in the active frozen canonical baseline under `.vivicy/canonical/**/*.md` — the co-authored spec the owner froze. Never implement product behavior, the component model, data ownership and isolation rules, protocol boundaries, the identity/auth model, secret handling, or runtime/cloud decisions from this file or from memory.
- Read the relevant canonical document before coding a slice, and verify each product assumption against its canonical home. On any conflict, the canonical doc wins.

## The verification gate — `vivicy.json`

`vivicy.json` at the repo root is the project's gate contract:

- `gateCommand` — the command Vivicy runs as the per-issue verification gate and re-runs itself as the authoritative verdict on every issue (for example `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, or `npm test`). Vivicy establishes it mechanically, never a human: the scaffold writes the sentinel `null` (not yet established); the pipeline fills the real command from the frozen canonical when the spec states one, otherwise the stack-setup issue's implementer sets it as part of completing that issue. Once it is a real command, leave it in place — an issue may still override it for itself via its own `gate_command`. A field explicitly present in `vivicy.json`, even an empty array, always wins over the `package.json#vivicy` fallback for that field.
- `requiredSkills` — the agent skills installed for this project, as `owner/repo@skill` ids. Maintained by Vivicy's skills stage together with the managed *Project skills* section it keeps at the end of this file; both the implementer and the reviewer MUST consult and apply any installed skill whose domain their work touches.

Install whatever tooling you need (CLIs, runtimes, package managers) and capture repeatable dependencies in the project's own manifests, scripts, infrastructure, or docs. Do not hardcode machine-specific absolute paths such as `/Users/...` in repo code, tests, scripts, or docs.

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
- **A test must discriminate.** Each test has to fail on the specific defect it guards: if inverting the behavior under test leaves it green, it proves nothing and must be rewritten. Assert on the real observable outcome, never on a restatement of the implementation.
- **Only the intent is sacred, not the code.** Preserve intent, invariants, and the reason a feature exists — not a weak implementation for its own sake. If the implementation is structurally poor, redesign it aggressively while keeping the product truth and user-visible intent.
- **Refactor, do not accrete.** Do not stack workaround-on-workaround patches. When an area becomes hard to reason about, collapse it to the smallest explicit design that still satisfies correctness, security, and performance.
- **Diagnose before rewriting.** Reproduce, measure, localize, identify the actual cause, and apply the smallest evidence-backed fix.

## Code hygiene

- **Minimalism in service of utility.** Every line you add — code, comment, doc, or spec prose — must change what a reader DOES; content whose only effect is to reassure a human or an agent rots into a stale lie, so leave it out. This never deletes a contract: a quality bar, a boundary, or an invariant not derivable from the code changes behavior and stays.
- **Zero comments by default.** Code here is written and read mostly by AI agents: comments cost tokens on every read and rot into lies; the code, its names, and its tests are the documentation. The only comment allowed is a structural invariant, constraint, or danger genuinely not derivable from the code itself — one dense line, no story. Never write narration or paraphrase, JSDoc/docstrings that restate names and types, module-header essays, TODO musings, or decorative banners. Tool directives (`eslint-disable`, `@ts-expect-error`, `"use client"`, shebangs) are not comments — keep them. Never match the comment density of a heavily-commented codebase: that density is a defect, not a style to imitate.
- **Never encode a moment in time.** Code is a flow — it states what the system IS now, never when or in which batch it was written: no version markers, plan/phase/sprint/batch codes, "new/old/legacy/added in vX" wording, or session references in identifiers, strings, comments, or docs. Version data a machine reads (dependency manifests, protocol/schema version fields) and requirement IDs from the traceability corpus are functional, not markers — those stay.
- These rules are the Vivicy factory default; the project owner owns this file and may amend this section for this repository.

## Language

The project's established language governs its spec and documentation. Vivicy fixes that language mechanically from the imported source documents — the dominant language of the batch that seeds the corpus — and writes every canonical doc, generated spec, issue prompt, and prepared document in it; a document imported in another language is translated toward it during preparation, and the raw uploads are never modified. A French-source project lives in French, not English — match the established language whenever you write or update prose in this repo. Code identifiers and keywords follow the stack and the existing codebase's own convention, independent of the spec language. Any product i18n behavior — locales, fallback language, internal working language — is product truth defined in the canonical baseline, not this rule.
