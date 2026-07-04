# {{PROJECT_NAME}}

This repository is built with the **Vivicy development factory**: you write the canonical product/architecture spec under `.vivicy/canonical/**`, Vivicy freezes and hashes it into a documentation baseline, extracts a traceable issue set, and runs a two-agent loop (an implementer agent and an independent reviewer agent) that implements, reviews, and verifies each slice against a real gate.

## Where things live

- `.vivicy/canonical/**` — **the product truth you write.** Start here: one Markdown file per coherent product/architecture decision area, one source of truth per fact. Until at least one canonical doc exists and a baseline is frozen, there is nothing to extract and the architecture map is empty.
- `.vivicy/development/` — the extracted issue set, progress ledger, and reports (development OUTPUT; created/updated by the factory).
- `vivicy.json` — the project gate config. `gateCommand` is the test command Vivicy runs as the per-issue verification gate; set it to YOUR runner (currently: `{{GATE_COMMAND}}`).
- `AGENTS.md` — the lean development operating guide and entrypoint for any development agent. `CLAUDE.md` includes it.

## Build, test, validate

The verification gate is whatever `gateCommand` in `vivicy.json` runs. Replace the default with your project's real test command (e.g. `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, `npm test`).
