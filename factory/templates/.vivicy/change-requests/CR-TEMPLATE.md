---
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
affected_issues: []
affected_requirements: []
affected_verification_gates: []
issue_generation_required: false
catalog_delta_required: false
matrix_rows_pending: false
supersedes: []
superseded_by: null
---

# CR-0000 - Short Title

## Idea

State the idea in the owner's words, then restate it as a product change.

## Why It Matters

Explain the product, business, UX, technical, security, or cost reason.

## Protected Product Truth

State what must remain true even if this change is accepted.

## Current Documentation Coverage

List existing canonical docs that already cover, constrain, conflict with, or leave room for this idea.

## Open Questions And Owner Answers

The development agent asks one question at a time and records the answer here.

```text
Question:
Development agent recommendation:
Owner answer:
```

## Development Agent Recommendation

Recommended status and rationale. Statuses: `idea`, `under_review`, `accepted_current_build`, `docs_applied`, `accepted_future`, `rejected`, `implemented`, `superseded`. Classifications: `clarification`, `minor_product_change`, `major_product_change`, `architecture_change`, `implementation_order_change`, `future_option`, `rejection_candidate`.

## Impact Assessment

Cover: product behavior; architecture; data model; protocols; security and isolation; cost; implementation order; UX; tests and verification gates. Use `N/A - no impact found` for any area that does not apply.

## Decision

Record the owner decision, date, and reason, and populate the frontmatter decision-evidence fields: `owner_decision_by`, `owner_decision_at`, and `owner_decision_evidence` (a reference to where and how the owner approved). A decided CR without this evidence is invalid.

## Baseline Impact

Record:

```text
previous_baseline_id:
previous_baseline_version:
previous_baseline_manifest_path:
previous_document_set_hash:
previous_manifest_hash:
target_baseline_bump:
resulting_baseline_id:
resulting_baseline_version:
resulting_baseline_manifest_path:
resulting_document_set_hash:
resulting_manifest_hash:
```

If this CR does not change active documentation, state `N/A - no baseline change`.

## Required Documentation Changes

List exact canonical docs and sections to update if accepted.

## Required Issue And Traceability Changes

List affected implementation issues, requirement IDs, source mappings, and traceability rows. If issues, catalog rows, or matrix rows do not exist yet, set `issue_generation_required` / `catalog_delta_required` / `matrix_rows_pending` and explain why.

## Required Verification Gates

List what must prove the change works. Each gate: `gate_id`, `requirement_ids_verified`, `level`, `environment`, `command_or_check`, `expected_result`, `allowed_fakes`, `real_components_required`, `failure_handling`.

## Non-Goals

List what this CR explicitly does not introduce.

## Audit Trail

```text
YYYY-MM-DD - CR created.
```
