# 06 - Recalculation

Document status: stable contract.

## Purpose

Recalculation keeps formula cells consistent with the cells they depend on. When a cell's stored value changes, every cell that transitively depends on it is recomputed in dependency order.

## Recalc order

The recalculation order is a topological sort of the dependency graph: a cell is recomputed only after every cell it reads has been recomputed. Cells that do not depend, directly or transitively, on a changed cell are not recomputed.

## Cycle handling

If the dependency graph contains a cycle, the cells that participate in the cycle each resolve to a `#REF!` error value, and recalculation still terminates for every cell outside the cycle. A cycle never causes infinite recomputation.

## Determinism

Given the same stored cells and the same formulas, recalculation produces the same values every time, independent of the order in which cells were set. Recalculation reads stored state through the Sheet and never mutates a cell the formula did not target.
