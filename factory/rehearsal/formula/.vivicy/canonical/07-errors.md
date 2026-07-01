# 07 - Error Values

Document status: stable contract.

## Error set

The engine defines exactly these spreadsheet error values: `#DIV/0!` for division by zero, `#VALUE!` for a wrong-type or uncoercible operand, a malformed or unparseable formula, or an operation with no valid result value, `#NAME?` for an unknown function name or unlexable input, and `#REF!` for an invalid or cyclic reference. Each error value is a distinct, comparable sentinel and is never a plain string that could collide with cell text.

## Propagation rule

An error value propagates through every operator and, by default, through every function: if an operand of an operator, or an argument of a function, is an error value, the operation yields that same error value, and when several are errors the first in left-to-right evaluation order is the one propagated. A function's own contract may override this default — see the calling convention for the error-aware and error-skipping functions.

## Identification

The engine exposes a predicate that reports whether a value is an error value and a reader that returns the error's code string. A function may inspect an argument to decide its own result, but error values are not silently coerced to numbers, strings, or booleans.

## Stability

The four error codes are a fixed, closed set defined once and reused everywhere; no module invents a new error code or reformats an existing one. The exact code strings are part of the public contract and never change.
