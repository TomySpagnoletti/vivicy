# 04 - Evaluator

Document status: stable contract.

## Purpose

The Evaluator walks an abstract syntax tree and reduces it to a single value. It is a pure function of the tree and the Sheet it is given; it stores no state between calls.

## Literals and operators

A `number` or `string` literal node evaluates to its literal value. A `binary` arithmetic node applies the operator to its evaluated children using JavaScript number arithmetic; a comparison node yields a boolean. A `unary` minus negates its evaluated child. Division whose right operand evaluates to zero produces a `#DIV/0!` error value.

## Error propagation

If any operand of an operator node evaluates to an error value, the node evaluates to that same error value without applying the operator, and the first error in evaluation order is the one propagated. A `call` node does not short-circuit this way: it passes its evaluated arguments, error values included, to the function, which handles errors per its own contract (see the calling convention). An arithmetic operator applied to a non-numeric, non-coercible operand produces a `#VALUE!` error value.

## Function dispatch

A `call` node resolves its function name against the Registry case-insensitively, evaluates the argument nodes left to right, and invokes the function with the evaluated arguments, error values included. A name that is not registered makes the node evaluate to a `#NAME?` error value.

## Reference resolution

A `ref` node for a single cell resolves to that cell's current value through the Sheet; a `ref` node for a range resolves to the rectangular block of cell values the range covers — its rows and columns. A reference whose address does not exist in the Sheet contributes an empty value, and a structurally invalid reference produces a `#REF!` error value.
