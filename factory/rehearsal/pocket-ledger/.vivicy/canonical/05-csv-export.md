# 05 - CSV Export

Document status: stable contract.

## Purpose

The Exporter serializes Ledger expenses to CSV text. Export is a pure read of the Ledger and produces a deterministic string.

## Column order

The CSV has a fixed header row with columns in this exact order: `id,date,description,category,amountCents`. Every data row follows the same column order.

## Row order

Data rows are emitted in Ledger insertion order, matching the order in which expenses were added.

## Quoting rules

A field that contains a comma, a double quote, or a newline must be wrapped in double quotes. A double quote inside a quoted field is escaped by doubling it. Fields without those characters are emitted unquoted.

## Line endings and amount format

Rows are separated by a single line feed (`\n`). The `amountCents` value is emitted as a plain integer with no currency symbol, thousands separator, or decimal point. An empty Ledger exports just the header row.
