# Vivicy

A **visual autonomous dev factory**. You write the canonical spec; Vivicy extracts
the work, runs a two-agent loop that implements, independently reviews, and
verifies each slice, and shows the whole thing moving on an architecture map.

Vivicy is project- and language-agnostic. It operates **on** a target project —
it reads that project's docs, architecture map, issues, and progress ledger, and
drives agents over them. The repository Vivicy ships inside is simply its first
user.

## What it does

1. **You write the spec.** A frozen canonical documentation baseline plus an
   architecture map describe the system you want — the single source of truth.
2. **Vivicy extracts the work.** Deterministic gates turn the frozen spec into a
   traceable issue set: every requirement maps to an issue, every issue maps to
   architecture-map nodes and verification gates.
3. **A two-agent loop builds it.** A deterministic orchestrator sequences ready
   issues. For each one it runs an **implementer** agent and then a separate,
   independent **reviewer** agent (the reviewer never authored the issue), then
   **re-runs the gate itself** as the authoritative verdict — it never trusts an
   agent's "done". Green checkpoints are committed and the issue is retired.
4. **You watch it on the map.** The Next.js control plane renders the
   architecture map with live status (not started / in progress / reviewing /
   implemented / verified / blocked), the issue list, per-agent quota, and
   Run / Stop / Resume / Extract controls.

The method is generic; the spec is whatever project you point it at.

## Layout

- `factory/` — the standalone Node ESM tooling (the "factory"): the dev-loop
  orchestrator and supervisor, the status probe, the rehearsal harness, the
  progress ledger + MCP + hook emitters, the documentation-baseline lock, the
  semantic-extraction and traceability gates, and the architecture-map viewer-data
  generator. No framework coupling — plain `node`.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane that drives
  and visualizes the factory.
- `scripts/subtree-split.sh` — publish `vivicy/` as its own public repo.

## Quickstart

Point Vivicy at any project via `VIVICY_TARGET_ROOT` (absolute path). The target
must hold the spec/data layout the factory reads: `docs/canonical/**`,
`docs/architecture-map/architecture-map.yml`, `docs/baselines/*.json`, and
`spec/development/` (issue index, progress ledger).

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

If `--target` / `VIVICY_TARGET_ROOT` is omitted, the factory falls back to the
legacy `NAIGHT_DEV_ROOT`, then to the project Vivicy is vendored into (the parent
of this app directory).

### Try it end to end (no agents, no target needed)

The rehearsal exercises the **whole** chain against an isolated throwaway fixture
with the real tooling and fake agents — a fast proof the factory is wired
correctly:

```sh
node factory/cli.mjs rehearsal --dry
# -> REHEARSAL PASSED (11/11 stages), 0 UNCOVERED
```

## The two agents

The MVP loop runs two **distinct** agents so the reviewer never authored the code
it reviews:

- **Implementer** — Claude Code (gate-first implementer).
- **Reviewer & fix** — Codex (independent review, runs its own review sub-agents).

The orchestrator (`factory/dev-loop.mjs`) invokes each agent CLI per issue as a
**fresh conversation** (one issue = no carryover), re-runs the gate itself,
commits green checkpoints, and moves done issues aside; on a gate still red after
bounded retries it records a block and stops for a human. Lifecycle hooks
(`factory/progress-emit.mjs`, `factory/progress-ensure-report.mjs`) emit mechanical
progress events and inject each agent's actor/role; the agents emit semantic
events through the progress MCP (`factory/progress-mcp.mjs`); a Stop hook backfills
if an agent forgot to report.

## Models, quota, and settings

Policy: always run the latest model; the **thinking/effort level** is the tunable
knob. Per-agent model and effort are chosen in the app's Settings dialog and
flow to a run as `VIVICY_CLAUDE_*` / `VIVICY_CODEX_*` environment variables.
Defaults pin the latest known ids/levels (implementer = Claude Opus at `xhigh`,
reviewer = Codex at `high`).

When an agent hits a provider rate limit, the loop detects it from the failure
itself (no usage API exists), waits out the quota window with bounded backoff,
and surfaces per-agent quota state in the control plane's footer — never
fabricated numbers.

Both agent CLIs run with isolated config (project config plus the progress MCP
only, never the operator's personal global plugins).

## Language-agnostic

Nothing in the factory assumes a language or stack for the **target** project.
The per-issue gate command is configurable (it defaults to `npm test`, but it is
whatever the target's verification gate is), and the spec, issues, and
architecture map are plain docs + JSON. Point Vivicy at a Rust crate, a Python
service, a Go binary, or a monorepo — the loop, the map, and the gates are the
same.

## Publishing Vivicy

`vivicy/` is self-contained, so a `git subtree split` of this prefix yields a
complete public project with history:

```sh
# from the host repo root, on a clean tree:
vivicy/scripts/subtree-split.sh --branch vivicy-public

# then publish:
git remote add vivicy-public <git-url>          # once
git push vivicy-public vivicy-public:main

# or in one step:
vivicy/scripts/subtree-split.sh --remote <git-url> --push
```

## License

MIT © Tomy Spagnoletti Duval. See [LICENSE](./LICENSE).
