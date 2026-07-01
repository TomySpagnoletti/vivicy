# 09 - Math Functions

Document status: stable contract.

## Aggregation functions

`SUM` returns the sum of its numeric arguments, `AVERAGE` returns their arithmetic mean, `MIN` returns the smallest and `MAX` the largest, and `COUNT` returns how many arguments are already numbers, before any coercion. `SUM`, `MIN`, and `MAX` over no numeric values return `0`, `0`, and `0` respectively, while `AVERAGE` over no numeric values returns a `#DIV/0!` error value.

## Aggregation semantics

Aggregation functions accept any mix of scalar arguments and ranges, flatten ranges in range order, skip empty cell values, and coerce booleans and numeric strings to numbers. `COUNT` counts only values that are already numbers, applying no coercion, and never counts empty cells; a non-coercible value yields a `#VALUE!` error value for `SUM`, `AVERAGE`, `MIN`, and `MAX`.

## Rounding and sign

`ROUND(number, digits)` rounds the number to the given number of decimal digits using round-half-away-from-zero, where a negative `digits` rounds to the left of the decimal point. `ABS(number)` returns the absolute value of its single numeric argument.

## Modulo and power

`MOD(number, divisor)` returns the remainder of `number` divided by `divisor` and carries the sign of the divisor, and a divisor of zero yields a `#DIV/0!` error value. `POWER(base, exponent)` raises `base` to `exponent` and yields a `#VALUE!` error value when the result is not a finite real number.
