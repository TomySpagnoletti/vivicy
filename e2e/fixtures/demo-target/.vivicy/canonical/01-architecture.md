# 01 - Pocket Ledger Architecture

Document status: stable architecture.

## Goal

Pocket Ledger is a small, dependency-free TypeScript library for tracking personal expenses. It runs entirely in memory and on the local filesystem; it talks to no external service, database, or network.

## Components

The library is composed of five cooperating modules, each owning one concern:

- The Ledger owns expense records and the in-memory store.
- The Categorizer owns the rules that assign a category to an expense.
- The Reporter owns monthly totals and budget evaluation.
- The Exporter owns serialization of expenses to CSV.
- The CLI owns the command-line entry point that wires the modules together.

## Boundaries

The Ledger is the single source of truth for stored expenses; no other module may mutate the store directly. The Categorizer, Reporter, and Exporter are pure read consumers of Ledger data and must not hold their own copy of the store. The CLI is the only module permitted to read from process arguments and to write to standard output.

## Data flow

An expense enters through the Ledger, is classified by the Categorizer, is aggregated by the Reporter, and may be serialized by the Exporter. The CLI drives this flow in response to user commands.

## Money representation

All monetary amounts are integers in minor units (cents). Floating-point money is forbidden because rounding error must never enter a stored total.
