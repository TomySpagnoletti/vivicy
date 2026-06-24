# Pocket Ledger Requirement Catalog

Human-readable rendering of `spec/requirements/catalog.json`. Authored by the semantic issue extraction write step from frozen baseline `baseline-v1.0.0` (version 1.0.0). The JSON file is the machine-readable source of truth.

- Baseline manifest: `docs/baselines/baseline-v1.0.0.json`
- Manifest hash: `420ce29efdd4fb98e4c28618f65a33f9f06e1bc6d887a7d6b04285d88d701e1f`
- Document set hash: `bc9560ce4e0d91ea0782b1890ac48c0a4c3fe95673f5497862f8d0d7d0e642cf`
- Requirements: 21 (all maturity `mvp`, disposition `must_implement`)

| ID | Title | Area | Type | Maturity | Disposition | Verification | Source refs | Covered by issues |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| REQ-ARCH-001 | Ledger is the single source of truth for stored expenses | architecture | runtime_invariant | mvp | must_implement | unit | docs/canonical/01-architecture.md:23-25 | ISS-0001 |
| REQ-ARCH-002 | Money is represented as integer minor units | architecture | data_contract | mvp | must_implement | unit | docs/canonical/01-architecture.md:37-38 | ISS-0003 |
| REQ-ARCH-003 | CLI is the sole process-argument and stdout owner that drives the flow | cli | runtime_invariant | mvp | must_implement | unit | docs/canonical/01-architecture.md:26-27; docs/canonical/01-architecture.md:31-33 | ISS-0008 |
| REQ-LEDGER-001 | Expense record has exactly five typed fields | ledger | data_contract | mvp | must_implement | unit | docs/canonical/02-ledger-model.md:7-13 | ISS-0001 |
| REQ-LEDGER-002 | Ledger stores in insertion order and rejects invalid or duplicate records | ledger | data_contract | mvp | must_implement | unit | docs/canonical/02-ledger-model.md:17-23 | ISS-0001 |
| REQ-LEDGER-003 | Ledger reads return defensive copies and tolerate unknown ids | ledger | data_contract | mvp | must_implement | unit | docs/canonical/02-ledger-model.md:27-30 | ISS-0002 |
| REQ-LEDGER-004 | Ledger total sums amountCents with empty total zero | ledger | data_contract | mvp | must_implement | unit | docs/canonical/02-ledger-model.md:34-35 | ISS-0003 |
| REQ-CATEGORY-001 | Categorizer matches a rule by lowercase keyword substring | category | tool_contract | mvp | must_implement | unit | docs/canonical/03-category-rules.md:7-8; docs/canonical/03-category-rules.md:12-14 | ISS-0004 |
| REQ-CATEGORY-002 | Rules are evaluated in order, first match wins, case-insensitively | category | tool_contract | mvp | must_implement | unit | docs/canonical/03-category-rules.md:18-19 | ISS-0004 |
| REQ-CATEGORY-003 | Unmatched expenses get the fixed uncategorized label | category | tool_contract | mvp | must_implement | unit | docs/canonical/03-category-rules.md:23-25 | ISS-0004 |
| REQ-CATEGORY-004 | Categorization is a pure, stateless function | category | tool_contract | mvp | must_implement | unit | docs/canonical/03-category-rules.md:29-31 | ISS-0004 |
| REQ-REPORT-001 | Monthly totals group by YYYY-MM and order ascending | report | product_behavior | mvp | must_implement | unit | docs/canonical/04-reporting.md:7-8; docs/canonical/04-reporting.md:12-17 | ISS-0005 |
| REQ-REPORT-002 | Category breakdown within a month is ordered by label ascending | report | product_behavior | mvp | must_implement | unit | docs/canonical/04-reporting.md:21-23 | ISS-0005 |
| REQ-REPORT-003 | Budget evaluation classifies the month and reports the signed difference | report | product_behavior | mvp | must_implement | unit | docs/canonical/04-reporting.md:27-30; docs/canonical/04-reporting.md:32 | ISS-0006 |
| REQ-EXPORT-001 | CSV export has a fixed header and column order | export | tool_contract | mvp | must_implement | unit | docs/canonical/05-csv-export.md:7-8; docs/canonical/05-csv-export.md:12-14 | ISS-0007 |
| REQ-EXPORT-002 | CSV rows follow Ledger insertion order | export | tool_contract | mvp | must_implement | unit | docs/canonical/05-csv-export.md:18-19 | ISS-0007 |
| REQ-EXPORT-003 | CSV quotes special characters and escapes inner quotes | export | tool_contract | mvp | must_implement | unit | docs/canonical/05-csv-export.md:23-25 | ISS-0007 |
| REQ-EXPORT-004 | CSV uses LF separators, plain-integer amounts, header-only when empty | export | tool_contract | mvp | must_implement | unit | docs/canonical/05-csv-export.md:29-31 | ISS-0007 |
| REQ-CLI-001 | CLI dispatches add, list, report, and export commands | cli | product_behavior | mvp | must_implement | unit | docs/canonical/06-cli.md:7-8; docs/canonical/06-cli.md:12; docs/canonical/06-cli.md:14-19 | ISS-0008 |
| REQ-CLI-002 | CLI reads only process arguments and fails non-zero on bad invocation | cli | product_behavior | mvp | must_implement | unit | docs/canonical/06-cli.md:23-25 | ISS-0008 |
| REQ-CLI-003 | CLI separates stdout and stderr and emits no partial output on error | cli | product_behavior | mvp | must_implement | unit | docs/canonical/06-cli.md:29-31 | ISS-0008 |

## Requirement statements

### REQ-ARCH-001 - Ledger is the single source of truth for stored expenses

The Ledger is the single source of truth for stored expenses; no other module may mutate the store directly, and the Categorizer, Reporter, and Exporter are pure read consumers that must not hold their own copy of the store.

Source: `docs/canonical/01-architecture.md:23-25` - Covered by: ISS-0001

### REQ-ARCH-002 - Money is represented as integer minor units

All monetary amounts are integers in minor units (cents); floating-point money is forbidden because rounding error must never enter a stored total.

Source: `docs/canonical/01-architecture.md:37-38` - Covered by: ISS-0003

### REQ-ARCH-003 - CLI is the sole process-argument and stdout owner that drives the flow

The CLI is the only module permitted to read from process arguments and to write to standard output, and it drives the flow in which an expense enters through the Ledger, is classified by the Categorizer, aggregated by the Reporter, and may be serialized by the Exporter.

Source: `docs/canonical/01-architecture.md:26-27; docs/canonical/01-architecture.md:31-33` - Covered by: ISS-0008

### REQ-LEDGER-001 - Expense record has exactly five typed fields

An expense record has exactly these fields: id (a unique non-empty string), amountCents (a positive integer amount in cents), description (a non-empty human-readable string), date (an ISO-8601 YYYY-MM-DD calendar date string), and category (a string label assigned by the Categorizer).

Source: `docs/canonical/02-ledger-model.md:7-13` - Covered by: ISS-0001

### REQ-LEDGER-002 - Ledger stores in insertion order and rejects invalid or duplicate records

The Ledger stores expense records in insertion order and rejects with an error: an id duplicating an already-stored record, an amountCents that is zero, negative, or non-integer, a date not matching YYYY-MM-DD, and a blank description or blank id.

Source: `docs/canonical/02-ledger-model.md:17-23` - Covered by: ISS-0001

### REQ-LEDGER-003 - Ledger reads return defensive copies and tolerate unknown ids

The Ledger exposes a read of all expenses in insertion order and a read of a single expense by id; reading an unknown id returns no record rather than throwing, and returned collections are copies so mutating a returned value never alters the stored record.

Source: `docs/canonical/02-ledger-model.md:27-30` - Covered by: ISS-0002

### REQ-LEDGER-004 - Ledger total sums amountCents with empty total zero

The Ledger can compute the sum of amountCents across all stored expenses, and the total of an empty Ledger is zero.

Source: `docs/canonical/02-ledger-model.md:34-35` - Covered by: ISS-0003

### REQ-CATEGORY-001 - Categorizer matches a rule by lowercase keyword substring

The Categorizer assigns a category label based on an ordered set of keyword rules applied to the description; a rule has a category label and a list of lowercase keywords and matches when the lowercased description contains at least one keyword as a substring.

Source: `docs/canonical/03-category-rules.md:7-8; docs/canonical/03-category-rules.md:12-14` - Covered by: ISS-0004

### REQ-CATEGORY-002 - Rules are evaluated in order, first match wins, case-insensitively

Rules are evaluated in declaration order; the first matching rule wins and later rules are not consulted once a match is found, and evaluation is case-insensitive.

Source: `docs/canonical/03-category-rules.md:18-19` - Covered by: ISS-0004

### REQ-CATEGORY-003 - Unmatched expenses get the fixed uncategorized label

When no rule matches, the Categorizer assigns the category uncategorized; that default label is a fixed constant and is never configurable per call.

Source: `docs/canonical/03-category-rules.md:23-25` - Covered by: ISS-0004

### REQ-CATEGORY-004 - Categorization is a pure, stateless function

Categorization is a pure function of the description and the rule list: the same description and rule list always produce the same category, and the Categorizer holds no mutable state between calls.

Source: `docs/canonical/03-category-rules.md:29-31` - Covered by: ISS-0004

### REQ-REPORT-001 - Monthly totals group by YYYY-MM and order ascending

The Reporter computes monthly totals by grouping expenses by the YYYY-MM prefix of each expense date and summing amountCents per month, never mutating the Ledger; the result is ordered by month ascending and a month with no expenses does not appear.

Source: `docs/canonical/04-reporting.md:7-8; docs/canonical/04-reporting.md:12-17` - Covered by: ISS-0005

### REQ-REPORT-002 - Category breakdown within a month is ordered by label ascending

For a given month the Reporter can break the monthly total down by category, summing amountCents per category, with the breakdown ordered by category label ascending.

Source: `docs/canonical/04-reporting.md:21-23` - Covered by: ISS-0005

### REQ-REPORT-003 - Budget evaluation classifies the month and reports the signed difference

Given a positive integer limitCents for a month, the Reporter reports whether the month's total is within budget, equal to the limit, or over budget, plus the signed difference (total minus limit); a month exactly equal to its limit is within budget, not over.

Source: `docs/canonical/04-reporting.md:27-30; docs/canonical/04-reporting.md:32` - Covered by: ISS-0006

### REQ-EXPORT-001 - CSV export has a fixed header and column order

The Exporter serializes Ledger expenses to a deterministic CSV string as a pure read; the CSV has a fixed header row with columns in exactly the order id,date,description,category,amountCents, and every data row follows the same column order.

Source: `docs/canonical/05-csv-export.md:7-8; docs/canonical/05-csv-export.md:12-14` - Covered by: ISS-0007

### REQ-EXPORT-002 - CSV rows follow Ledger insertion order

Data rows are emitted in Ledger insertion order, matching the order in which expenses were added.

Source: `docs/canonical/05-csv-export.md:18-19` - Covered by: ISS-0007

### REQ-EXPORT-003 - CSV quotes special characters and escapes inner quotes

A field containing a comma, double quote, or newline must be wrapped in double quotes; a double quote inside a quoted field is escaped by doubling it; fields without those characters are emitted unquoted.

Source: `docs/canonical/05-csv-export.md:23-25` - Covered by: ISS-0007

### REQ-EXPORT-004 - CSV uses LF separators, plain-integer amounts, header-only when empty

Rows are separated by a single line feed; amountCents is emitted as a plain integer with no currency symbol, thousands separator, or decimal point; an empty Ledger exports just the header row.

Source: `docs/canonical/05-csv-export.md:29-31` - Covered by: ISS-0007

### REQ-CLI-001 - CLI dispatches add, list, report, and export commands

The CLI is the single command-line entry point wiring the modules together and supports: add <amountCents> <date> <description> (adds a categorized expense and prints its id), list (prints all expenses in insertion order), report <month> (prints the monthly total and category breakdown for a YYYY-MM month), and export (prints the full Ledger as CSV).

Source: `docs/canonical/06-cli.md:7-8; docs/canonical/06-cli.md:12; docs/canonical/06-cli.md:14-19` - Covered by: ISS-0008

### REQ-CLI-002 - CLI reads only process arguments and fails non-zero on bad invocation

The CLI reads its command and arguments from process arguments only; an unknown command, or a command with the wrong number of arguments, exits with a non-zero status and a single error line on standard error.

Source: `docs/canonical/06-cli.md:23-25` - Covered by: ISS-0008

### REQ-CLI-003 - CLI separates stdout and stderr and emits no partial output on error

Normal command output goes to standard output and error messages go to standard error; the CLI never prints partial output before an argument-validation error and holds no state across invocations beyond what the Ledger persists.

Source: `docs/canonical/06-cli.md:29-31` - Covered by: ISS-0008

