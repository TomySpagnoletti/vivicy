# 01 - Source Of Truth

Document status: stable governance.

## Purpose

This document prevents the {{PROJECT_NAME}} documentation from becoming a speculative implementation dump.

The documentation must remain useful to a human architect and to a coding agent without pretending that every runtime detail is knowable before implementation. It separates canonical product documents from governance/support documents, evidence records, and future options.

## Owner Roles

The word "owner" can name two distinct roles that must never be conflated:

- Product actor (if your product has end users who own data, direct the system, or hold accounts): this is the "owner" in canonical product docs, schemas, prompts, and protocols. Define it in your canonical baseline.
- Governance owner (repository/documentation owner): the human who approves documentation freezes, decides Change Requests (`accepted_current_build`, `accepted_future`, `rejected`), reopens stable decisions, and resolves source-of-truth contradictions.

In `docs/governance/**` and `AGENTS.md`, bare "owner" means the governance owner unless product behavior is being described. Freeze-approval and CR-decision authority belong only to the governance owner; a product actor can never mutate the frozen spec. The roles carry different powers and are not interchangeable in documentation, schemas, or tooling, even when the same human holds both today.

## Documentation Operating Hierarchy

Use this order when documents appear to overlap. Product and architecture extraction reads only the active frozen canonical documentation baseline over `docs/canonical/**/*.md`; the other files below are operating guides, governance rules, evidence records, or derived artifacts.

1. `docs/canonical/**/*.md` defines product and architecture truth before executable implementation exists. **These documents are authored by the project owner.**
2. `AGENTS.md` is the development agent entrypoint and execution rule wrapper. It must stay aligned with this hierarchy and must not override product or architecture truth.
3. `README.md` summarizes product identity, operating model, and reading order.
4. `docs/governance/01-source-of-truth.md` defines documentation governance and maturity rules.
5. `docs/governance/08-doc-baseline-lock.md` governs the versioned and hashed canonical documentation baseline lock used before extraction and implementation.
6. `docs/governance/06-product-change-control.md` governs post-freeze ideas and controlled canonical-baseline evolution.
7. `docs/architecture-map/architecture-map.yml` is a derived machine-readable architecture and development-progress index. It indexes the canonical product docs with `source_refs`; if it conflicts with a cited canonical document or executable artifact, the cited source wins and the map must be corrected.
8. Evidence/spike documents are records, not truth. They resolve doubts only after the accepted decision is written back into the affected canonical product document.
9. Once implementation starts, generated schemas, database migrations, infrastructure modules, and tested commands become the executable source of truth for their layer.

When an executable contract exists, documentation must summarize it and link to it rather than duplicate large schemas in several places.

## Canonical Product Decision Index

This section is an index of decisions that must live in `docs/canonical/**/*.md`. It helps humans and coding agents navigate the product, but implementation issue extraction must cite the canonical document that owns the decision, not this index. If this index conflicts with the active frozen canonical documentation baseline, the canonical baseline wins and this index must be corrected.

**The project owner authors this index as they author the canonical docs.** It is a navigation aid into product decisions, not a place to invent them. Each entry names a decision and points at the canonical document that owns the full rule. Until the owner writes canonical docs, this index is empty.

Method-level decisions that are true for every project built with this factory:

- The product brand/name constant is fixed in the codebase, not configurable runtime state. Anything an end user can change is never hardcoded.
- After a documentation freeze, owner ideas and product changes enter through Product Change Requests. Raw ideas must not directly change active implementation scope.
- Documentation freeze is locked by a Doc Baseline Lock manifest generated and verified by `factory/doc-baseline.mjs`. Implementation must not run from a draft manifest or from docs whose hashes do not match the active frozen manifest.
- Development uses the traceability method defined in `docs/governance/05-development-traceability-method.md`: frozen baseline, Requirement Catalog, Source Map, Traceability Matrix, vertical issues, gate-first TDD, adaptive local and pre-production/integration verification gates, traceability coverage report, and coherent green commit checkpoints.
- Code coverage policy is defined in `docs/governance/05-development-traceability-method.md`, including required counters, thresholds, exclusions, and anti-cheating rules.
- Implementation must not create a parallel `spec.md -> plan.md -> tasks.md` pipeline or any second source-of-truth authority alongside the canonical baseline and the traceability artifacts.
- The development agent must manage its own branch or worktree, commits, pushes, validation evidence, and traceability updates autonomously when credentials and remote configuration allow it.
- Release-quality proof requires pre-production / integration gates for changes that touch deployable runtime behavior, infrastructure, external provider integrations, isolation boundaries, secrets, or persistent state. Local validation alone is not release-quality proof for those areas.
- Performance budgets are first-class verification contracts. Exact thresholds must come from this project's requirements, evidence, or measured baselines, not another project's numbers.
- The first development launch prompt lives in `docs/governance/07-development-launch-prompt.md`. It is a prompt wrapper around the traceability method, not a second source of truth.

## Canonical Decision Homes

When a decision appears in several places, keep the full rule in one canonical home and let other documents apply or link to it. Governance/support rows below identify process homes and are not product extraction sources. The project owner adds product-decision rows pointing at their canonical docs.

| Decision | Canonical home |
|---|---|
| Machine-readable architecture and progress graph artifact | `docs/architecture-map/architecture-map.yml` |
| Development agent operating guide | `AGENTS.md` |
| Documentation-to-code traceability and development method | `docs/governance/05-development-traceability-method.md` |
| Documentation baseline versioning and hash lock | `docs/governance/08-doc-baseline-lock.md` |
| Code coverage gates | `docs/governance/05-development-traceability-method.md` |
| Development launch prompt | `docs/governance/07-development-launch-prompt.md` |
| Post-freeze product ideas and Change Requests | `docs/governance/06-product-change-control.md` |
| <product decision> | `docs/canonical/<file>.md` |

## Document Maturity Vocabulary

Canonical documents use exactly four maturity tiers:

| Tier | Meaning |
|---|---|
| `conceptual` | Intent and ownership only; never coded against directly. |
| `stable-architecture` | Frozen architectural/product decision; constrains implementation but is not itself converted into executable artifacts. |
| `pre-implementation-contract` | Precise enough to code against; converted into executable artifacts during implementation. |
| `future-option` | Not in current scope; must not leak requirements into current contracts. |

Every `Document status:` line and every README maturity label is a description of one of these tiers, never a fifth tier. Status-line wording may add nuance — which evidence/spike still gates the doc, which subsystem the contract covers — but the authoritative tier signal for `pre-implementation-contract` is membership in the Pre-Implementation Contracts list below: when a status phrase and the list disagree, the list wins. "Conceptual model only" marks `conceptual`, "future option" marks `future-option`, and everything else not in the list is `stable-architecture`.

## Pre-Implementation Contracts

The project owner lists here the canonical documents that are precise enough to code against in the first implementation. They must be precise enough to guide coding, but not expanded with guessed details. During implementation, their examples must be converted into executable sources:

- schemas in the contracts package;
- database migrations in the database package;
- infrastructure modules;
- verified install scripts and image recipes where applicable;
- integration tests and smoke tests;
- requirement catalog, traceability matrix, vertical issues, and verification gates.

After those executable sources exist, this documentation must link to them and keep only the architectural intent, constraints, and acceptance criteria.

## Evidence Boundary

Some external-provider and runtime details must not be locked by prose before real verification. They are deliberate evidence spikes, not documentation gaps. The project owner records the authoritative list of those spikes (scope, gating, and decisions to lock); each spike file owns its own evidence contract. A spike is complete only when it records commands, observed output, decision, documentation updates, and unresolved risks.

## Future Options

Future options must not leak into current contracts as requirements. The project owner lists them in their canonical home and references them only where a current abstraction must leave room for them.

## Anti-Garbage Rules

1. Do not duplicate a core model in every document. Keep it in one canonical home and link to it.
2. Do not add a schema in prose if it can only be validated during implementation.
3. Do not turn evidence-needed unknowns into fake certainty.
4. Do not create backlog items for every imagined feature.
5. Do not create artifacts, registries, approvals, or workflows that contradict the product model.
6. Do not hardcode example names into schemas, prompts, protocols, or product copy.
7. Do not keep two conflicting descriptions. Pick one source document and link to it.
8. Do not treat a sub-agent audit finding as a request for more prose when the real answer is an evidence spike or an implementation test.
9. Do not implement, backlog, or patch active scope from a post-freeze idea until a Product Change Request has been accepted.

Illustrative examples throughout documentation should use stable placeholder names that are clearly examples, never real entities, and (per rule 6) must never be hardcoded into schemas, prompts, protocols, or product copy.

## Update Policy

When implementation starts:

1. Run the relevant evidence spike when one gates the slice.
2. Record evidence in the spike file.
3. For post-freeze product ideas, create or update a Change Request before changing active scope.
4. Update only the affected contract document.
5. Put executable schemas, migrations, infrastructure modules, and scripts in code.
6. Update `README.md` only if the high-level summary or reading order changes.

If a coding agent needs to proceed without this conversation, it must first read:

1. `AGENTS.md`
2. `README.md`
3. `docs/governance/01-source-of-truth.md`
4. the canonical implementation-contract document(s) the owner designates as the primary stack/architecture entrypoint
5. `docs/governance/05-development-traceability-method.md`
6. `docs/governance/08-doc-baseline-lock.md`
7. `docs/governance/06-product-change-control.md`
8. `docs/governance/07-development-launch-prompt.md`

This boot list is the single authoritative pre-development reading order. It is a minimal boot subset of the Documentation Operating Hierarchy above, which remains the full precedence order; `AGENTS.md` and `README.md` must point here instead of maintaining competing ordered lists.
