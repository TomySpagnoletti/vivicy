# 04 - Reporting

Document status: stable contract.

## Purpose

The Reporter computes derived read models over Ledger data: monthly totals and budget evaluation. The Reporter never mutates the Ledger.

## Monthly totals

A monthly total groups expenses by their calendar month, derived from the `YYYY-MM` prefix of each expense `date`. For each month present in the Ledger, the Reporter sums `amountCents` across that month's expenses.

The monthly total result is ordered by month ascending. A month with no expenses does not appear in the result.

## Category totals within a month

For a given month, the Reporter can break the monthly total down by category, summing `amountCents` per category. Category breakdown is ordered by category label ascending.

## Budget evaluation

A budget is a positive integer `limitCents` for a given month. The Reporter evaluates a month against its budget and reports whether the month's total is within budget, equal to the limit, or over budget, plus the signed difference between the total and the limit.

A month exactly equal to its limit is reported as within budget, not over.
