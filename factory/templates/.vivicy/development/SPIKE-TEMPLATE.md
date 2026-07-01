# S<NN> - <Title>

Document status: Phase 0 spike.

A spike is the evidence gate for an assumption that cannot be known reliably from the spec alone — a provider API, a runtime capability, an external behaviour. It is authored before the slices that depend on it, runs once to capture evidence, and ends in a recorded decision. `spike-check` validates this shape; an issue that depends on a spike does not start until the spike's `status` is `verified`.

## Traceability

```text
requirement_ids: pending-extraction (Requirement Catalog join key: S<NN>)
gate_id: gate:phase0:s<nn>-<slug>
status: pending | verified | deferred | blocked | failed
gated_by: <optional — gate_ids of spikes that must verify BEFORE this one>
blocks: <optional — gate_ids of spikes this one gates; the inverse of their gated_by>
gated_by_external: <optional — a slow human/external grant this spike waits on, e.g. a provider production-access review>
```

Inter-spike gating: `gated_by` lists the spikes this one depends on. The graph is validated acyclic, and a spike cannot reach `verified` until its whole `gated_by` chain is verified — so the dev-loop's spike-status readiness honours the chain for free. `blocks` is the inverse and must be mirrored by the target's `gated_by`. `gated_by_external` documents a slow external grant (there is no machine gate for it; the spike simply stays un-`verified` until its evidence is recorded). Omit any field that does not apply.

## Question

What exact assumption is being verified? One falsifiable question.

## Must Verify

One bullet per check. Tag each by evidence source: `[Resolved from official docs: ...]` for behaviour already confirmed from authoritative documentation (the live spike only re-confirms it, it does not re-discover it) and `[Live test required: ...]` for behaviour that must be proven by a live observation. Flag a tie-breaking live test as decisive.

## Evidence Required

What a complete run must capture and record under these fields when the spike is executed (the Completion Rule — a spike is `verified` only once all are recorded):

```text
environment: date, machine/runtime, tool versions
commands or API calls: exact, never secret values
observed output: relevant results only
decision: the decision the spike locks, including any decision boundary
documentation updates: canonical docs to change if an assumption moves
unresolved risks: remaining uncertainty or follow-up
```

A spike never silently re-decides product truth: if its evidence contradicts a canonical doc, it records the documentation update (which re-freezes the baseline) rather than working around it locally; if the assumption proves false, the outcome is a Change Request, not a local patch.

## References

Optional. External reference implementations or provider docs consulted. For each, record the exact URL, the commit hash or documentation version inspected, and the reason for consultation; an unverified pointer must not be treated as a given. Remove this section when there are none.
