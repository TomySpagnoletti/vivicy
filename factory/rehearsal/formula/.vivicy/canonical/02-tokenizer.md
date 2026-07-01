# 02 - Tokenizer

Document status: stable contract.

## Purpose

The Tokenizer turns a formula string into a flat, ordered list of tokens. It performs lexical analysis only: it recognizes token kinds but never interprets precedence or structure.

## Token kinds

The Tokenizer emits these token kinds: `number` for numeric literals, `string` for double-quoted string literals, `ref` for an A1 cell reference or range, `name` for a bare identifier such as a function name, `operator` for one of the arithmetic or comparison operators, `lparen` and `rparen` for parentheses, `comma` for an argument separator, and `eof` at the end of input.

## Numbers and strings

A number token matches an optional integer part, an optional fractional part introduced by a decimal point, and an optional exponent; the lexeme is converted to a JavaScript number. A string token is delimited by double quotes, and a doubled double quote inside the literal encodes a single literal double quote.

## References and names

A `ref` token matches an A1 cell reference such as `A1` or `BC12`, optionally followed by a colon and a second A1 reference to form a range such as `A1:B3`. A `name` token matches a letter followed by letters or digits and is used for function names; a `name` is only produced when the identifier is not a valid A1 reference.

## Whitespace and errors

Spaces and tabs between tokens are skipped and never produce a token. Any character that cannot begin a valid token makes the Tokenizer report a `#NAME?` error result rather than throwing.
