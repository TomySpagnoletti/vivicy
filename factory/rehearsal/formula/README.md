# Formula — rehearsal fixture

A second self-test fixture for the Vivicy development method, alongside `pocket-ledger`.

Where pocket-ledger is a small ledger/CLI, `formula` is a **spreadsheet-formula engine**: a tokenizer, a Pratt parser, an evaluator, a sheet model with dependency-graph recalculation, an error model, and the core/math/logical/text/lookup function families. Its spec has a very different shape — deep parsing rules, an error taxonomy, and many small function contracts — so rehearsing against it exercises the extraction, traceability, and architecture-map checks on requirement shapes that pocket-ledger does not produce.

The fixture ships the frozen spec and the authored corpus (`.vivicy/canonical/**`, the frozen baseline, the requirement catalog / source map / traceability matrix / coverage report, the architecture map, and the generated issues) in their **pre-loop** state: the issues are active (not in `done/`), the progress ledger is empty, and `src/` is a scaffold with a trivial green test. `vivicy.json` ships `gateCommand` as the `null` sentinel (real scaffold output); the stack-setup issue establishes the real command (`npm test`) mechanically. The dev-loop implements the issues during a rehearsal run.

Run it with:

```bash
node factory/dev-rehearsal.ts --fixture=formula        # real two-agent loop
node factory/dev-rehearsal.ts --fixture=formula --dry  # harness validation with fake agents
```

Omitting `--fixture` runs the default `pocket-ledger` fixture.
