# 13 - Public API

Document status: stable contract.

## Surface

The package exposes a single public entry function that evaluates a formula string against a sheet, plus a factory that creates an empty sheet, the error-inspection predicate, and an error-code reader that returns an error value's code string. No other module is part of the public surface; callers import only from the package entry point.

## evaluate

`evaluate(formula, sheet)` accepts a formula string and a sheet, runs the formula through the Tokenizer, Parser, and Evaluator, and returns the resulting value. A leading equals sign on the formula is optional and stripped, and any lexical, parse, evaluation, or reference failure is returned as one of the typed error values rather than thrown.

## Sheet construction

The factory creates an empty sheet and exposes setting a cell's literal value or formula by A1 address and reading a cell's current value. Setting a formula cell registers its dependencies so a later read reflects recalculation against the cells it references.

## Guarantees

The public functions are pure with respect to inputs other than the sheet they are given: evaluating the same formula against the same sheet returns the same value, and `evaluate` never mutates the sheet it reads. Errors surface only as typed error values, so a caller can branch on them with the error-inspection predicate.
