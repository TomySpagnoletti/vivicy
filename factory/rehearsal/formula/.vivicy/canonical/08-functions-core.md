# 08 - Functions Core

Document status: stable contract.

## Registry

The function Registry maps an upper-cased function name to a function implementation. Lookup is case-insensitive, so `sum`, `Sum`, and `SUM` resolve to the same implementation, and a name with no registered implementation resolves to nothing so the Evaluator can raise `#NAME?`.

## Calling convention

Every registered function receives its already-evaluated arguments as an ordered list, error values included, and returns a single value. By default an error argument is resolved by propagation before any coercion or truthiness classification: the function returns the first error value among its arguments, and its coercion and type rules then apply only to the remaining non-error values. Two kinds of function override this default. Error-aware functions inspect an error argument to decide their result: `IF` (only an error condition propagates), `VLOOKUP` (only an error key propagates), and the error predicate and error-code reader. Error-skipping functions filter error values out instead of propagating them: `COUNT`, which counts only its numeric arguments. A function never reads the Sheet directly and never throws for a domain error: it returns one of the typed error values instead.

## Argument coercion

A function that expects a number coerces a boolean to `1` for true and `0` for false and parses a numeric string, and treats an empty cell value as `0`; a value that cannot be coerced yields a `#VALUE!` error value. A function that expects text coerces a number or boolean to its text form.

## Range flattening

When an argument is a range, the function receives the range's rectangular block of cell values. An aggregating function reduces that block over its values in row-by-row order and skips empty cell values; a wrong-type value inside a range yields a `#VALUE!` error value for functions that compute over numbers, except a pure counting function, which skips any value that is not a number rather than erroring. A lookup function instead reads the block by its rows and columns.
