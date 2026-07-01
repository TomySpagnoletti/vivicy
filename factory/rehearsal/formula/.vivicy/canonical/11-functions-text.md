# 11 - Text Functions

Document status: stable contract.

## Concatenation and length

`CONCAT` joins all of its arguments into one string in argument order, coercing numbers and booleans to their text form and treating an empty cell value as the empty string. `LEN(text)` returns the number of characters in its single text argument after coercion.

## Case and trimming

`UPPER(text)` returns its argument with every letter in upper case and `LOWER(text)` returns it with every letter in lower case. `TRIM(text)` removes leading and trailing spaces and collapses each run of internal spaces to a single space.

## Substring functions

`LEFT(text, count)` returns the first `count` characters and `RIGHT(text, count)` returns the last `count` characters, where a `count` of zero returns the empty string and a `count` larger than the length returns the whole string. A negative `count` yields a `#VALUE!` error value.

## MID

`MID(text, start, count)` returns `count` characters beginning at the one-based `start` position, returning the empty string when `start` is past the end of the text and fewer characters when the text ends first. A `start` below one or a negative `count` yields a `#VALUE!` error value.
