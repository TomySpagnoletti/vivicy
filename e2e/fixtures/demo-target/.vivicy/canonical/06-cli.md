# 06 - Command Line Interface

Document status: stable contract.

## Purpose

The CLI is the single command-line entry point that wires the Ledger, Categorizer, Reporter, and Exporter together in response to user commands.

## Commands

The CLI supports these commands:

- `add <amountCents> <date> <description>`: adds an expense to the Ledger, categorizing it via the Categorizer, and prints the assigned id.
- `list`: prints all expenses in insertion order.
- `report <month>`: prints the monthly total and category breakdown for the given `YYYY-MM` month.
- `export`: prints the full Ledger as CSV to standard output.

## Argument handling

The CLI reads its command and arguments from process arguments only. An unknown command, or a command with the wrong number of arguments, exits with a non-zero status and a single error line on standard error.

## Output discipline

Normal command output goes to standard output; error messages go to standard error. The CLI never prints partial output before an argument-validation error. The CLI holds no state across invocations beyond what the Ledger persists.
