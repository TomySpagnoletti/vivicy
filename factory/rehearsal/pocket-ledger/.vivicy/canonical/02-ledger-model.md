# 02 - Ledger Model

Document status: stable contract.

## Expense record

An expense record has exactly these fields:

- `id`: a unique, non-empty string identifier.
- `amountCents`: a positive integer amount in minor units (cents).
- `description`: a non-empty human-readable string.
- `date`: an ISO-8601 calendar date string in `YYYY-MM-DD` form.
- `category`: a string category label, assigned by the Categorizer.

## Storage rules

The Ledger stores expense records in insertion order. An expense whose `id` duplicates an already-stored record must be rejected with an error; ids are unique within a Ledger.

An `amountCents` that is zero, negative, or non-integer must be rejected. A `date` that does not match the `YYYY-MM-DD` form must be rejected. A blank `description` or blank `id` must be rejected.

## Retrieval rules

The Ledger exposes a read of all expenses in insertion order and a read of a single expense by id. Reading an unknown id returns no record rather than throwing. The returned collections are copies; mutating a returned value must never alter the stored record.

## Totals

The Ledger can compute the sum of `amountCents` across all stored expenses. The total of an empty Ledger is zero.
