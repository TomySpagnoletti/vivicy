# 03 - Parser

Document status: stable contract.

## Purpose

The Parser consumes the Tokenizer's token list and produces an abstract syntax tree. It is a precedence-climbing (Pratt) parser that encodes operator precedence and associativity.

## Node kinds

The Parser produces these AST node kinds: `number` and `string` literal nodes, a `ref` node carrying a cell reference or range, a `unary` node for a prefix operator, a `binary` node for an infix operator with a left and right child, and a `call` node carrying a function name and an ordered list of argument nodes.

## Precedence and associativity

Comparison operators bind most loosely, then addition and subtraction, then multiplication and division, then exponentiation; the arithmetic operators are left-associative except exponentiation, which is right-associative. A unary minus binds tighter than any binary operator. Parentheses override precedence by grouping a sub-expression.

## Function calls

A `name` token immediately followed by a left parenthesis begins a function call; arguments are expressions separated by commas, and an empty argument list is allowed. The function name is preserved verbatim so the Evaluator can look it up in the Registry.

## Parse errors

A token sequence that does not form a complete expression, an unmatched parenthesis, or a trailing token after a complete expression makes the Parser report a `#VALUE!` error result rather than throwing.
