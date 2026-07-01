# 01 - Formula Engine Architecture

Document status: stable architecture.

## Goal

Formula is a small, dependency-free JavaScript (ESM) library that evaluates spreadsheet formula strings against an in-memory sheet. It runs entirely in memory; it talks to no external service, database, file system, or network.

## Components

The library is composed of cooperating modules grouped into three clusters, each module owning one concern:

- The pipeline cluster turns a formula string into a value: the Tokenizer lexes characters into tokens, the Parser builds an abstract syntax tree, and the Evaluator walks the tree.
- The model cluster holds spreadsheet state: the CellRef module parses A1 references and ranges, the Sheet module stores cell values, and the DepGraph module tracks dependencies and drives recalculation.
- The functions cluster supplies the callable functions: a function Registry plus the math, logical, text, and lookup function families.

## Boundaries

The Sheet is the single source of truth for stored cell values; no other module may mutate a cell's stored value directly. The Tokenizer, Parser, Evaluator, and the function families are pure transformations that hold no spreadsheet state of their own. The API module is the only public entry point and the only module a caller imports.

## Data flow

A formula string enters through the API, is lexed by the Tokenizer into tokens, parsed by the Parser into an abstract syntax tree, and walked by the Evaluator. The Evaluator resolves cell and range references against the Sheet, calls registered functions for function nodes, and returns a single value to the API.

## Error model

Evaluation never throws for a spreadsheet-level error; instead it produces one of the typed error values and propagates it. Any operand that is already an error value makes the whole expression evaluate to that same error value.
