<!--
  Canonical issue template for the semantic issue extraction pipeline.

  Issues are LLM-authored from the frozen canonical docs baseline pinned in spec/development/issue-index.json. The prose sections are semantic and owned by review; the refs in the Traceability block are the deterministic contract and are validated by factory/semantic-extraction-check.mjs (grammar, manifest membership, line ranges, dependency acyclicity, full-line coverage).

  Replace every <placeholder>. Keep the section headings exactly as written; the checker locates the Traceability block by its heading.
-->

# <issue_id> - <Title>

## Summary

<2-4 plain sentences describing the outcome this issue delivers. This text is map-visible: it is shown on the architecture map viewer, so write it for a reader who has not opened the canonical docs.>

## Task Type

<One of: implementation | diagnosis | cleanup | rewrite | review_fix. See "Task Type And Writing Discipline" in `docs/governance/05-development-traceability-method.md` for the per-type behavior. For cleanup/rewrite, state the target simplification pattern — the single authority that must remain and the named complexity to remove — plus the exact user-visible behavior and contracts preserved.>

## Traceability

```text
issue_id: <issue_id>
graph_refs:
  - <node:architecture_map_item>
requirement_ids:
  - <REQ-AREA-NNN>
source_line_refs:
  - docs/canonical/<file>.md:<start>-<end>
depends_on:
  - <issue_id of a prerequisite issue; leave the list empty when none>
spike_gates:
  - <evidence spike gate id; leave the list empty when none>
verification_gate_ids:
  - <gate id, e.g. gate:test:<issue-slug>>
```

## Scope

<Faithful specification of what to build: behavior, interfaces, data, and
constraints restated from the referenced canonical lines. Do not invent requirements that the referenced lines do not state. Use deterministic wording: no "if needed", "if possible", "simplify where appropriate", "clean up this area", or "refactor this flow" — state the exact target state, owners, behavior to preserve, and gates.>

## Out Of Scope

<What this issue deliberately does not cover, especially adjacent behavior a
reader might assume is included.>

## Verification

<Define the tests and gates that PROVE the Scope is fully implemented and
correct before this issue may be reported complete. The bar is owned by `docs/governance/05-development-traceability-method.md`; restate the specifics for this issue and never lower it:

- Unit tests covering this issue's governed code to the Code Coverage Gate (100% lines, statements, branches, functions), asserting real behavior, boundaries, authorization, errors, and state transitions — happy paths AND negative, edge, and failure cases, including unusual inputs. Lines executed without behavioral assertions do not count.
- Integration tests using the real components the Anti-Cheating Rules forbid faking (stateful mutations, provider integrations, lifecycle behavior, secrets, persistent state, isolation boundaries), at the highest Adaptive E2E Ladder level available for this area (L2+ DB-backed, contract).
- A pre-production (L6) gate when the Scope touches deployable runtime behavior, infrastructure, provider integrations, isolation boundaries, secrets, or persistent state; it must be green before release readiness.
- The deterministic gate(s) in `verification_gate_ids` above, each resolving to a real green gate-run record (status: pass, exit_code: 0), not a free-text label.

No later code or issue may build on this slice until it is proven fully functional and fully tested here, and completion is claimed only from fresh green evidence on the current tree.>
