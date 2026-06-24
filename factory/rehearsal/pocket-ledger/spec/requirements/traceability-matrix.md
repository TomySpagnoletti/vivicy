# Pocket Ledger Traceability Matrix

Human-readable rendering of `spec/requirements/traceability-matrix.json`. Connects each requirement to its issues, verification gates, and status against frozen baseline `baseline-v1.0.0` (version 1.0.0). Nothing is implemented yet, so every row is `issue_planned`.

- Baseline manifest: `docs/baselines/baseline-v1.0.0.json`
- Manifest hash: `420ce29efdd4fb98e4c28618f65a33f9f06e1bc6d887a7d6b04285d88d701e1f`
- Document set hash: `bc9560ce4e0d91ea0782b1890ac48c0a4c3fe95673f5497862f8d0d7d0e642cf`

| Requirement ID | Title | Source file | Source section | Maturity | Disposition | Issue IDs | Verification gate IDs | Verification stage | Test files or commands | Status | Open questions |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-ARCH-001 | Ledger is the single source of truth for stored expenses | docs/canonical/01-architecture.md | Boundaries | mvp | must_implement | ISS-0001 | gate:test:ledger-add-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-ARCH-002 | Money is represented as integer minor units | docs/canonical/01-architecture.md | Money representation | mvp | must_implement | ISS-0003 | gate:test:ledger-total | unit | npm test (node --test) | issue_planned | - |
| REQ-ARCH-003 | CLI is the sole process-argument and stdout owner that drives the flow | docs/canonical/01-architecture.md | Boundaries / Data flow | mvp | must_implement | ISS-0008 | gate:test:cli-dispatch | unit | npm test (node --test) | issue_planned | - |
| REQ-LEDGER-001 | Expense record has exactly five typed fields | docs/canonical/02-ledger-model.md | Expense record | mvp | must_implement | ISS-0001 | gate:test:ledger-add-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-LEDGER-002 | Ledger stores in insertion order and rejects invalid or duplicate records | docs/canonical/02-ledger-model.md | Storage rules | mvp | must_implement | ISS-0001 | gate:test:ledger-add-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-LEDGER-003 | Ledger reads return defensive copies and tolerate unknown ids | docs/canonical/02-ledger-model.md | Retrieval rules | mvp | must_implement | ISS-0002 | gate:test:ledger-retrieval | unit | npm test (node --test) | issue_planned | - |
| REQ-LEDGER-004 | Ledger total sums amountCents with empty total zero | docs/canonical/02-ledger-model.md | Totals | mvp | must_implement | ISS-0003 | gate:test:ledger-total | unit | npm test (node --test) | issue_planned | - |
| REQ-CATEGORY-001 | Categorizer matches a rule by lowercase keyword substring | docs/canonical/03-category-rules.md | Purpose / Rule shape | mvp | must_implement | ISS-0004 | gate:test:categorize-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-CATEGORY-002 | Rules are evaluated in order, first match wins, case-insensitively | docs/canonical/03-category-rules.md | Evaluation order | mvp | must_implement | ISS-0004 | gate:test:categorize-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-CATEGORY-003 | Unmatched expenses get the fixed uncategorized label | docs/canonical/03-category-rules.md | Default category | mvp | must_implement | ISS-0004 | gate:test:categorize-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-CATEGORY-004 | Categorization is a pure, stateless function | docs/canonical/03-category-rules.md | Determinism | mvp | must_implement | ISS-0004 | gate:test:categorize-expense | unit | npm test (node --test) | issue_planned | - |
| REQ-REPORT-001 | Monthly totals group by YYYY-MM and order ascending | docs/canonical/04-reporting.md | Purpose / Monthly totals | mvp | must_implement | ISS-0005 | gate:test:monthly-report | unit | npm test (node --test) | issue_planned | - |
| REQ-REPORT-002 | Category breakdown within a month is ordered by label ascending | docs/canonical/04-reporting.md | Category totals within a month | mvp | must_implement | ISS-0005 | gate:test:monthly-report | unit | npm test (node --test) | issue_planned | - |
| REQ-REPORT-003 | Budget evaluation classifies the month and reports the signed difference | docs/canonical/04-reporting.md | Budget evaluation | mvp | must_implement | ISS-0006 | gate:test:budget-evaluation | unit | npm test (node --test) | issue_planned | - |
| REQ-EXPORT-001 | CSV export has a fixed header and column order | docs/canonical/05-csv-export.md | Purpose / Column order | mvp | must_implement | ISS-0007 | gate:test:csv-export | unit | npm test (node --test) | issue_planned | - |
| REQ-EXPORT-002 | CSV rows follow Ledger insertion order | docs/canonical/05-csv-export.md | Row order | mvp | must_implement | ISS-0007 | gate:test:csv-export | unit | npm test (node --test) | issue_planned | - |
| REQ-EXPORT-003 | CSV quotes special characters and escapes inner quotes | docs/canonical/05-csv-export.md | Quoting rules | mvp | must_implement | ISS-0007 | gate:test:csv-export | unit | npm test (node --test) | issue_planned | - |
| REQ-EXPORT-004 | CSV uses LF separators, plain-integer amounts, header-only when empty | docs/canonical/05-csv-export.md | Line endings and amount format | mvp | must_implement | ISS-0007 | gate:test:csv-export | unit | npm test (node --test) | issue_planned | - |
| REQ-CLI-001 | CLI dispatches add, list, report, and export commands | docs/canonical/06-cli.md | Purpose / Commands | mvp | must_implement | ISS-0008 | gate:test:cli-dispatch | unit | npm test (node --test) | issue_planned | - |
| REQ-CLI-002 | CLI reads only process arguments and fails non-zero on bad invocation | docs/canonical/06-cli.md | Argument handling | mvp | must_implement | ISS-0008 | gate:test:cli-dispatch | unit | npm test (node --test) | issue_planned | - |
| REQ-CLI-003 | CLI separates stdout and stderr and emits no partial output on error | docs/canonical/06-cli.md | Output discipline | mvp | must_implement | ISS-0008 | gate:test:cli-dispatch | unit | npm test (node --test) | issue_planned | - |
