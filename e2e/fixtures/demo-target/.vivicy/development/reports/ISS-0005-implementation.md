# ISS-0005 — Report monthly totals and per-category breakdown

Status: implemented

The Reporter's read models are implemented: per-month amountCents totals ordered
by month ascending, and a per-category breakdown for a month ordered by category
label ascending. The Ledger is never mutated. Verification gates have not yet run,
so this stays at `implemented` until the monthly-report gate passes.
