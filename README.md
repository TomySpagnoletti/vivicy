# Vivicy

A **visual autonomous dev factory**. You write the canonical spec; Vivicy extracts the work, runs a two-agent loop that implements, independently reviews, and verifies each slice, and shows the whole thing moving on an architecture map.

Vivicy is project- and language-agnostic. It operates **on** a target project — it reads that project's docs, architecture map, issues, and progress ledger, and drives agents over them. The repository Vivicy ships inside is simply its first user.

## What it does

1. **You write the spec.** A frozen canonical documentation baseline plus an architecture map describe the system you want — the single source of truth.
2. **Vivicy extracts the work.** Deterministic gates turn the frozen spec into a traceable issue set: every requirement maps to an issue, every issue maps to architecture-map nodes and verification gates.
3. **A two-agent loop builds it.** A deterministic orchestrator sequences ready issues. For each one it runs an **implementer** agent and then a separate, independent **reviewer** agent (the reviewer never authored the issue), then **re-runs the gate itself** as the authoritative verdict — it never trusts an agent's "done". Green checkpoints are committed and the issue is retired.
4. **You watch it on the map.** The Next.js control plane renders the architecture map with live status (not started / in progress / reviewing / implemented / verified / blocked), the issue list, per-agent quota, and Run / Stop / Resume / Extract controls.

The method is generic; the spec is whatever project you point it at.

## Layout

- `factory/` — the standalone Node ESM tooling (the "factory"): the issue extractor (`extract-issues.mjs`), the dev-loop orchestrator and resumable supervisor, the status probe, the rehearsal harness, the per-issue progress ledger, the project gate config (`project-config.mjs`, reading `vivicy.json`), the agent-leg spawn + per-leg timeout infra, the documentation-baseline lock, the semantic-extraction and traceability gates, the four agent prompts (`prompts/`), and the architecture-map viewer-data generator. No framework coupling — plain `node`.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane that drives and visualizes the factory.

## Run / Build

Vivicy is a **web app**: one Next server that hosts the control plane and the API routes that drive the factory. There is one way to run it.

| Develop                               | Build & run                      |
| ------------------------------------- | -------------------------------- |
| `npm run dev` → http://localhost:3000 | `npm run build && npm run start` |

It needs nothing but `npm ci`.

## Quickstart

Point Vivicy at any project via `VIVICY_TARGET_ROOT` (absolute path). Everything the factory reads and writes lives under a single `.vivicy/` folder at the target root — like `.git`, it holds all the autonomous dev factory needs and nothing cosmetic: `.vivicy/canonical/**` (the spec you write), `.vivicy/architecture-map/architecture-map.yml`, `.vivicy/baselines/*.json`, `.vivicy/requirements/`, and `.vivicy/development/` (issue index, progress ledger, reports, transcripts). Only `AGENTS.md`, `CLAUDE.md`, and `README.md` sit at the root.

```sh
cd vivicy
npm ci

# Run the visual control plane against a target project.
VIVICY_TARGET_ROOT=/abs/path/to/your/project npm run dev
# open http://localhost:3000

# …or use the CLI (also available as the `vivicy` bin once installed):
node factory/cli.mjs app    --target /abs/path/to/your/project
node factory/cli.mjs loop   --target /abs/path/to/your/project   # one loop pass
node factory/cli.mjs status --target /abs/path/to/your/project --json
```

If `--target` / `VIVICY_TARGET_ROOT` is omitted, the app resolves the target in order: the project you picked in the UI (persisted in the runtime dir), then `VIVICY_TARGET_ROOT`, then the parent of the process working directory.

### Two ways to start a project

The app's onboarding offers two modes:

- **Start from scratch** — give an empty folder and a name. Vivicy scaffolds a **lean** skeleton: a lean `AGENTS.md`/`CLAUDE.md`/`README.md` at the root, a `.vivicy/` folder holding a `.vivicy/canonical/` placeholder (you write the real spec) and the skeleton dirs the factory reads/writes, a complete `.gitignore`, and `vivicy.json` (the gate config). It does NOT bake in a language: no `package.json`, no test placeholder — the agents create the real project files per your spec.
- **Add Vivicy to an existing repo** — point at a populated folder. Vivicy writes ONLY the files that are missing and **never clobbers** an existing one; it prefills `gateCommand` from the repo's own test wiring when it can detect it.

Either way the target stays **lean by design**: Vivicy does NOT copy its governance/method docs into the target. The agents' full discipline travels in the Vivicy-bundled prompts (`factory/prompts/*.md`), and the rest is enforced by the deterministic checks — so the method machinery lives in the Vivicy repo, not duplicated into every project it builds.

### Try it end to end (no agents, no target needed)

The rehearsal exercises the **whole** chain against an isolated throwaway fixture with the real tooling and fake agents — a fast proof the factory is wired correctly:

```sh
node factory/cli.mjs rehearsal --dry
# -> REHEARSAL PASSED (18/18 stages)   # every stage green, 0 UNCOVERED lines
```

It proves the honest model end to end: the static map is generated once and stays byte-unchanged across the loop (no per-issue regeneration), the read-time overlay projects the live ledger onto it, and transcripts are produced but never committed.

## The two agents

The MVP loop runs two **distinct** agents so the reviewer never authored the code it reviews:

- **Implementer** — Claude Code (gate-first implementer).
- **Reviewer & fix** — Codex (independent review, runs its own review sub-agents).

The orchestrator (`factory/dev-loop.mjs`) invokes each agent CLI per issue as a **fresh conversation** (one issue = no carryover), re-runs the gate itself, commits green checkpoints, and moves done issues aside; on a gate still red after bounded retries it records a block and stops for a human. Each agent does EXACTLY one of four actions — extract issues, verify issue fidelity, implement an issue's code, review/fix that code — and NOTHING else: no git, no ledger, no map, no traceability, coverage, or progress action.

Everything else is **mechanical**, owned by the orchestrator: freeze the baseline, run the deterministic checks (doc-baseline hash, semantic-extraction, traceability), write the full per-issue progress ledger as it sequences and gates each issue (the single source of truth for progress — there is no agent self-report seam, no progress MCP, no lifecycle hooks), and commit each checkpoint with a `git add -A` made safe by a complete `.gitignore` (transcripts are NEVER committed; everything else Vivicy produces is). The architecture-map data is a **static graph generated once at extraction**; the dev-loop never regenerates it. The `/api/map` read path overlays the live ledger onto that static graph at request time, so the map always shows current progress with zero per-issue regeneration. An issue is "done" mechanically when its authoritative gate passes.

## Models, quota, and settings

Policy: always run the latest model; the **thinking/effort level** is the tunable knob. Per-agent model and effort are chosen in the app's Settings dialog and flow to a run as `VIVICY_CLAUDE_*` / `VIVICY_CODEX_*` environment variables. Defaults pin the latest known ids/levels (implementer = Claude Opus at `xhigh`, reviewer = Codex at `high`).

When an agent hits a provider rate limit, the loop detects it from the failure itself (no usage API exists), waits out the quota window with bounded backoff, and surfaces per-agent quota state in the control plane's footer — never fabricated numbers.

Both agent CLIs run with isolated config (project config only, never the operator's personal global plugins) — and no progress MCP, because agents never report progress; the orchestrator owns the ledger.

## Language-agnostic

Nothing in the factory assumes a language or stack for the **target** project. The per-issue gate command comes from the target's own `vivicy.json` (`gateCommand`) — `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `npm test`, `swift test`, or whatever the project's runner is. There is no hidden Node default: if neither the issue nor `vivicy.json` supplies a gate command, the loop fails loudly rather than assuming `npm test`. The spec, issues, and architecture map are plain docs + JSON. Point Vivicy at a Rust crate, a Python service, a Go binary, or a monorepo — the loop, the map, and the gates are the same.

## License

MIT © Tomy Spagnoletti Duval. See [LICENSE](./LICENSE).
