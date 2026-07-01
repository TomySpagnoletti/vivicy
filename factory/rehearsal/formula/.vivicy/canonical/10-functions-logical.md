# 10 - Logical Functions

Document status: stable contract.

## Truthiness

A logical function treats a boolean as itself, a number as false when it is zero and true otherwise, and an empty cell value as false; a value being truthiness-tested that is an error value propagates unchanged (see the calling convention), and any other value that is neither boolean, number, nor empty yields a `#VALUE!` error value. Logical functions return a boolean except `IF`, which returns one of its branch values.

## IF

`IF(condition, whenTrue, whenFalse)` evaluates the condition to a boolean and returns `whenTrue` when it is true and `whenFalse` when it is false. When the condition is an error value, `IF` returns that error value, and a missing third argument defaults its false branch to the boolean false.

## AND and OR

`AND` returns true only when every argument is truthy and false otherwise, while `OR` returns true when at least one argument is truthy and false otherwise. Both accept ranges, flatten them in range order, skip empty cell values, and require at least one non-empty argument.

## NOT

`NOT(value)` returns the boolean negation of its single argument's truthiness: true becomes false and false becomes true. `NOT` requires exactly one argument and yields a `#VALUE!` error value when given the wrong number of arguments.
