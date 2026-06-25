# 06 - Product Change Control

Document status: stable governance.

## Purpose

{{PROJECT_NAME}} documentation can be frozen for implementation while the product remains alive.

This document defines how new owner ideas, product changes, and architecture changes enter the system after a frozen baseline exists. It prevents moving-target development while still letting the owner keep improving the product through conversation with the development agent.

## Stable Decision

After a documentation freeze, new ideas must not directly modify the active implementation scope.

Every post-freeze idea that could change product behavior, architecture, data model, UX, cost, security, component behavior, external interfaces, protocols, or implementation order must pass through a Product Change Request.

```text
owner idea
  -> development-agent guided intake
  -> Change Request draft
  -> owner decision
  -> accepted current build, accepted future, rejected, or implemented
```

The frozen documentation baseline is immutable. It is identified by a `baseline_id`, `version`, `manifest_path`, `document_set_hash`, and `manifest_hash` from the Doc Baseline Lock process.

An accepted current-build Change Request is a controlled patch plan for the canonical docs. It does not become a parallel execution spec. The current controlled spec is always a frozen canonical documentation baseline:

```text
previous frozen_doc_baseline
  -> accepted current-build Change Request
  -> canonical docs patched
  -> new frozen_doc_baseline
```

The original baseline must remain auditable. The current controlled spec becomes the execution truth only after the accepted CR updates:

- affected canonical product documents;
- the Doc Baseline Lock manifest;
- requirement catalog entries;
- source-map entries;
- affected implementation issues;
- traceability matrix rows;
- verification gates;
- traceability coverage report;
- and, when needed, architecture decisions or evidence spikes.

## Registry

Change Requests live in the repository:

```text
docs/change-requests/
  README.md
  CR-TEMPLATE.md
  CR-####-short-title.md
```

The next CR ID is the highest existing `CR-####` plus one.

The Change Request registry is not the implementation backlog. A CR becomes implementation work only after it reaches `accepted_current_build` and its affected issues and gates are updated.

## Registry Validation

CR registry validation is a named step inside `semantic-extraction:check` ([Development Traceability Method](02-development-traceability-method.md)), not a separate validator tool. When the check runs, it must fail on any CR file with:

- a filename/frontmatter ID mismatch or a non-sequential `CR-####` ID;
- a status or classification outside the allowed enums;
- a decided status (`accepted_current_build`, `docs_applied`, `accepted_future`, `rejected`, `implemented`) without populated `owner_decision_by`, `owner_decision_at`, and `owner_decision_evidence`;
- `accepted_current_build` or later without populated `previous_baseline_*` fields;
- `docs_applied` or `implemented` without populated `resulting_*` fields, or a `resulting_manifest_hash` that does not match an existing manifest in `docs/baselines/`;
- an inconsistent `supersedes`/`superseded_by` graph;
- an active current-build requirement sourced only from a CR file.

Until the semantic extraction pipeline exists, these rules are applied by review against this list; they become mechanical when that pipeline's check command is implemented.

## Statuses

Allowed statuses:

```text
idea
under_review
accepted_current_build
docs_applied
accepted_future
rejected
implemented
superseded
```

Status meanings:

- `idea`: captured but not analyzed.
- `under_review`: the development agent is interviewing, checking docs, and assessing impact.
- `accepted_current_build`: owner has explicitly approved the change for the active build; canonical docs are not patched yet.
- `docs_applied`: canonical docs are patched, the resulting frozen baseline is generated and verified, and the resulting baseline fields are recorded in the CR. Execution truth has already moved to the new baseline; code work is still pending.
- `accepted_future`: valid product direction, but not allowed to affect the active build.
- `rejected`: intentionally not part of {{PROJECT_NAME}}.
- `implemented`: accepted change has been reflected in docs, issues, traceability, gates, and code when applicable.
- `superseded`: replaced by another CR or architecture decision.

Only the owner — the governance owner defined in [Source Of Truth](01-source-of-truth.md), not a product end user — can move a CR to `accepted_current_build`, `accepted_future`, or `rejected`. The development agent can recommend a status, but must not decide it alone.

Every owner decision must leave durable evidence in the CR frontmatter: `owner_decision_by`, `owner_decision_at`, and `owner_decision_evidence` (a reference to where and how the owner approved — for example the recorded approval text, message reference, or committed decision note). A CR in `accepted_current_build`, `docs_applied`, `accepted_future`, `rejected`, or `implemented` without populated decision-evidence fields is invalid: the repository must be able to distinguish a real owner approval from an agent assertion.

## Intake Trigger

The development agent must route the conversation through Change Request intake when, during frozen or active implementation work, the owner says something equivalent to:

- "I have an idea";
- "What if we added...";
- "We should change...";
- "Maybe later...";
- "This should work differently";
- "Can we also...";
- "I want the product to...";

The development agent must also route through Change Request intake when, during implementation, it discovers that the frozen canonical baseline itself is wrong — a factual error, an internal contradiction, or a requirement proven infeasible by an evidence spike result or an executable contract. A documentation defect is owner-decided product truth like any other canonical change: the agent surfaces it, proposes the correction with its classification, and recommends a status, but must not silently edit the frozen canonical docs and keep implementing against the change.

The development agent must first check whether the idea is already covered by existing documentation, backlog, future options, or an existing CR.

If the idea is already covered, the development agent must point to the existing source instead of creating duplicate documentation.

If the owner is only brainstorming and has not asked to preserve or change scope, the development agent must summarize the idea and ask whether to create a CR. A CR is created or updated only when the idea is not already covered and should be preserved, reviewed, accepted, deferred, or rejected.

## Guided Intake Protocol

The development agent must not patch the product docs immediately from a raw idea.

The development agent must:

1. Restate the idea in one paragraph.
2. Search the relevant docs before asking questions that the docs already answer.
3. Classify the idea.
4. Ask only the missing questions required to classify and decide the CR.
5. Ask questions one at a time.
6. Give a recommended answer with each question.
7. Record the owner's answers in the CR.
8. Identify affected docs, issues, source-of-truth rows, risks, and verification gates.
9. Recommend a status.
10. Wait for explicit owner approval before changing active scope.

Question style:

```text
Question: Is this current build, or future?
Recommendation: future, because it adds a new surface and should not interrupt the current implementation loop.
```

The development agent must avoid long interrogations when the answer can be discovered by reading the docs.

Stop asking questions as soon as the development agent has enough information to state:

- classification;
- affected scope;
- likely status recommendation;
- required decision owner;
- and the minimum verification consequence.

At that point, the development agent must stop interviewing and present the recommended CR state for owner approval.

## Intake Decision Tree

Use the smallest branch that fits the idea:

- `future_option`: capture the idea, why it matters, relevant canonical doc, non-goals, and proof needed before activation. Do not ask for implementation details.
- `clarification`: verify no behavior changes, then patch only the relevant canonical doc after owner approval.
- `minor_product_change`: identify affected canonical docs, affected issue or backlog area, and one verification gate.
- `major_product_change`: identify affected canonical docs, requirements, issues, traceability rows, verification gates, and implementation-order impact.
- `architecture_change`: identify canonical decisions touched, required architecture decision or governance update, evidence needs, requirements, issues, and gates.
- `implementation_order_change`: require a CR only when the owner changes active scope, active priority, or mandated order. Mechanical reordering of already covered work does not require a CR.
- `rejection_candidate`: ask only whether the owner wants to explicitly reopen the conflicting stable decision; otherwise recommend `rejected`.
- `documentation_defect`: a factual error, internal contradiction, or proven-infeasible requirement found in the frozen baseline during implementation. Capture the evidence (the spike result, the executable contract, or the contradicting canonical references), then classify by the impact of the correction — `clarification` if it changes no behavior, otherwise `minor_product_change`, `major_product_change`, or `architecture_change` — and identify the affected canonical docs, requirements, issues, traceability rows, and gates.

## Classification

Every reviewed CR must be classified as exactly one primary type. `pending` is allowed only before review is complete.

```text
pending
clarification
minor_product_change
major_product_change
architecture_change
implementation_order_change
future_option
rejection_candidate
```

Classification rules:

- `pending`: captured but not analyzed.
- `clarification`: no behavior or scope change; wording only.
- `minor_product_change`: behavior changes but does not alter architecture, source of truth, protocols, security, or implementation order.
- `major_product_change`: changes user-visible product behavior, scope, or first-implementation requirements.
- `architecture_change`: changes a core component, protocol, provider, data ownership rule, isolation rule, security boundary, or source of truth.
- `implementation_order_change`: changes what must be built now versus later.
- `future_option`: preserves an idea without affecting the active build.
- `rejection_candidate`: conflicts with {{PROJECT_NAME}} principles, no-fallback rules, security, isolation, or current product direction.

A documentation defect discovered during implementation is not a separate primary type: classify it by the impact of its correction (`clarification`, `minor_product_change`, `major_product_change`, or `architecture_change`) and record in the CR that its origin is an agent-discovered defect, with the supporting evidence.

## Required Fields

Each CR file must contain this frontmatter:

```yaml
id: CR-0000
title: Short title
status: idea
classification: pending
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
source: owner
owner_decision: pending
owner_decision_by: null
owner_decision_at: null
owner_decision_evidence: null
previous_baseline_id: null
previous_baseline_version: null
previous_baseline_manifest_path: null
previous_document_set_hash: null
previous_manifest_hash: null
target_baseline_bump: null
resulting_baseline_id: null
resulting_baseline_version: null
resulting_baseline_manifest_path: null
resulting_document_set_hash: null
resulting_manifest_hash: null
affected_docs: []
affected_backlog_items: []
affected_issues: []
affected_requirements: []
affected_verification_gates: []
issue_generation_required: false
catalog_delta_required: false
matrix_rows_pending: false
supersedes: []
superseded_by: null
```

Baseline-field vocabulary and scope: `previous_baseline_*` is the baseline that was active when the CR became a patch plan; `resulting_*` is the baseline produced by applying it. The same names are used in the frontmatter, the CR body Baseline Impact block, and the Doc Baseline Lock CR rules — do not introduce an alternate "active baseline" vocabulary. Baseline fields are required only from `accepted_current_build` onward (`previous_baseline_*`) and from `docs_applied` onward (`resulting_*`); for `idea`, `under_review`, `accepted_future`, and `rejected` CRs they stay `null` or `N/A - no baseline change`.

Each CR must also contain:

- idea;
- why it matters;
- protected product truth;
- current documentation coverage;
- open questions and owner answers;
- development agent recommendation;
- impact assessment;
- decision;
- required documentation changes;
- required issue and traceability changes;
- required verification gates;
- non-goals;
- audit trail.

## Decision Rules

`accepted_current_build` is allowed only when:

- the owner explicitly approves it and the decision-evidence fields (`owner_decision_by`, `owner_decision_at`, `owner_decision_evidence`) are populated;
- the active (pre-change) baseline identity is recorded in the `previous_baseline_*` frontmatter fields;
- affected docs are known;
- affected backlog items and issues are known, or `issue_generation_required=true` explains why issue IDs do not exist yet;
- affected requirements are known, or `catalog_delta_required=true` explains the expected catalog delta;
- affected traceability rows are known, or `matrix_rows_pending=true` explains why they wait for the semantic issue extraction pipeline;
- affected verification gates are known with enough detail to create executable gates;
- the change does not introduce duplicate protocols, duplicate stores, fallback paths, or hidden interfaces;
- the change does not bypass isolation or secret boundaries;
- the change can be tested.

An `architecture_change` that touches a stable decision can reach `accepted_current_build` only when the owner explicitly approves reopening that decision and the required source-of-truth or architecture decision update is identified.

`accepted_future` is the default for useful ideas that should not affect the active build.

`rejected` is required when an idea conflicts with a stable decision and the owner does not explicitly reopen that decision.

## Applying An Accepted CR

When a CR is accepted for the current build, the development agent must apply changes in this order:

1. Record the active baseline identity in the `previous_baseline_*` frontmatter fields (`previous_baseline_id`, `previous_baseline_version`, `previous_baseline_manifest_path`, `previous_document_set_hash`, `previous_manifest_hash`) and the CR ID.
2. Patch the canonical source document first.
3. Patch dependent docs only where they apply the canonical decision.
4. Generate and verify the new Doc Baseline Lock manifest with the correct SemVer bump. The tool stamps the prior frozen manifest `superseded`.
5. Record `resulting_baseline_id`, `resulting_baseline_version`, `resulting_baseline_manifest_path`, `resulting_document_set_hash`, and `resulting_manifest_hash` in the CR.
6. Mark the CR `docs_applied`. From this point the new frozen baseline is the active implementation target, even though code work is pending.
7. Re-run the semantic issue extraction pipeline.
8. Detect changed source hashes.
9. Mark each impacted requirement as `unchanged`, `amended`, `split`, `merged`, `removed`, or `new`.
10. Update the Requirement Catalog.
11. Update `source-map.json` and `source-map.md`.
12. Update the traceability matrix.
13. Update affected issues or mark `issue_generation_required=true` until issue generation runs.
14. Update verification gates.
15. Regenerate the traceability coverage report.
16. Add or update evidence spike requirements when evidence is needed.
17. Run documentation consistency checks.
18. Mark the CR `implemented` only after docs, baseline manifest, traceability artifacts, and implementation artifacts reflect the decision.

No code should be changed from a CR before the source documentation and issue gates are updated.

## Forbidden Behavior

The development agent must not:

- silently implement an idea mentioned casually by the owner;
- add a future idea to the active backlog before acceptance;
- patch several docs with duplicated speculative prose;
- create a fallback path "just in case";
- create a second protocol, second source of truth, or shadow interface;
- ask questions whose answers are already in the docs;
- declare a CR accepted without explicit owner approval;
- mark a CR implemented while affected tests or gates are missing;
- silently edit the frozen canonical docs to fix a perceived documentation error and keep implementing against the change, instead of raising a Change Request and producing a new frozen baseline.

## Minimal Intake Questions

The development agent should start with these questions only when the docs do not already answer them:

1. Is this for the current build or future?
2. Is it a clarification, product change, architecture change, or implementation-order change?
3. Which user or actor benefits?
4. What problem does it solve?
5. What must remain forbidden?
6. Which current decision might it conflict with?
7. What should prove that it works?

The development agent must ask one question at a time and include a recommended answer.

For fields that do not apply, the development agent must write `N/A - no impact found` rather than inventing content.

## Relationship To Traceability

Change Requests connect product evolution to implementation traceability.

Accepted CRs must create or update:

- requirement catalog entries;
- source file and section mappings;
- implementation issues;
- verification gates;
- and, when relevant, evidence spike records.

The implementation method remains defined in [Development Traceability Method](02-development-traceability-method.md). This document only defines how new product ideas enter that method after the baseline is frozen.
