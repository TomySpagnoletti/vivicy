# Change Requests

After the documentation baseline is frozen, no idea touches active scope directly: every post-freeze product/architecture change passes through a **Product Change Request** captured here.

```text
.vivicy/change-requests/
  README.md
  CR-TEMPLATE.md
  CR-####-short-title.md
```

The next CR id is the highest existing `CR-####` plus one. The registry is not the implementation backlog — a CR becomes work only after it reaches `accepted_current_build` and its affected issues and gates are updated.

An accepted current-build CR patches the canonical docs, regenerates a new frozen baseline (the prior one stamped `superseded`), and re-runs extraction; the original baseline stays auditable. The mechanical well-formedness of this registry — sequential ids, valid statuses/classifications, owner-decision evidence on decided CRs, the baseline-identity fields, a consistent supersedes graph, and no requirement sourced only from a CR — is enforced by `change-control:check`. The intake, classification, and apply discipline live in Vivicy's change-request agent prompt.
