# 12 - Lookup Functions

Document status: stable contract.

## VLOOKUP

`VLOOKUP(key, range, columnIndex, exactMatch)` searches the first column of the given range for the key and returns the value in the same row at the one-based `columnIndex`. The range argument is a two-dimensional range of cell values, and `columnIndex` counts columns from one starting at the range's first column.

## Match modes

When `exactMatch` is true, `VLOOKUP` returns the value from the first row whose first-column value equals the key. When `exactMatch` is false, the first column is assumed sorted ascending and `VLOOKUP` returns the value for the largest first-column entry that is less than or equal to the key.

## Bounds and errors

A `columnIndex` below one or greater than the range's column count yields a `#REF!` error value, and a key not found in exact-match mode yields a `#VALUE!` error value. An empty range, or a non-range value supplied as the `range` argument, yields a `#VALUE!` error value, and any error value passed as the key propagates unchanged.
