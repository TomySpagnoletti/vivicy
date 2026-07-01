# 05 - Sheet Model

Document status: stable contract.

## Cell addresses

A cell address is an A1 string with one or more column letters followed by a one-based row number, such as `A1` or `AB12`; column letters are case-insensitive and normalized to upper case. The CellRef module converts an address to and from a zero-based column index and zero-based row index, and rejects a syntactically invalid address.

## Ranges

A range is two cell addresses separated by a colon, such as `A1:B3`. The CellRef module expands a range into the ordered list of addresses it covers, iterating row by row from the top-left corner to the bottom-right corner, and normalizes a reversed range so the smaller column and row come first.

## Cell storage

The Sheet stores a value per cell address keyed by its normalized A1 address; setting a cell records its value as the single source of truth, and reading an address that was never set returns an empty cell value rather than throwing. The Sheet is the only owner of stored cell values.

## Sheet reads

The Sheet reads a single cell value by address and a range of cell values as a rectangular block of its rows and columns. Returned range blocks are copies, so mutating a returned block never alters stored cell values, and reading is a pure query that never changes stored state.

## Dependency graph

The DepGraph records, for each cell that holds a formula, the set of cells its formula reads. It exposes the direct dependents of a cell and computes a recalculation order. A dependency cycle is detected and reported to recalculation.
