# Vivicy

> **visual vibe coding** — describe the product you want, let an autonomous dev factory build it, and watch it happen live on the architecture map.

Vibe coding usually means prompt-and-pray. Vivicy keeps the vibe but adds an engineering spine: your intention is captured as a canonical spec, everything downstream is derived from it through deterministic gates, and the whole build stays visible, traceable, and provable — live, on a map.

Vivicy is project- and language-agnostic. It operates **on** a target project (yours), reading and writing a single `.vivicy/` folder at its root — like `.git`, but for autonomous development.

## Meet the kitchen

Every project is a pizza, and two hands cook it to perfection. **Vivi** is _la Nonna_ — the governess who runs the whole kitchen: she grills your idea into a spec, drives the pipeline, tidies the map, and manages change requests. She directs everything and never cooks the code herself. The **reviewer** is _il Nonno_ — the chef of finished dishes, who checks every issue the implementer plates up before it leaves the pass. You talk to Vivi from the bubble in the corner; she does the rest.

## The truth model

Four rules keep an autonomous build honest:

1. **The canonical spec + change requests are the intention.** Nothing else defines the product.
2. **Extracted issues are a projection** of that intention — regenerable, never hand-curated.
3. **Code is the result** — never the reference.
4. **Gates + traceability are the proof.** The orchestrator re-runs every verification gate itself; it never trusts an agent's "done".

The reviewer never authored the code it reviews: the loop runs two distinct agent CLIs — Claude Code and Codex — each invoked per issue as a fresh conversation.

## How a build runs

1. **Bring a spec.** Four ways in: open an existing Vivicy project, start from scratch, import the docs you already have, or **build the spec with Vivi** — a chat agent that grills you until your idea is a canonical spec.
2. **Risky assumptions get proved first.** Each external unknown (a provider API, a runtime capability) becomes a *spike*: a prover agent runs real experiments in the repo, an independent verifier counter-checks the evidence, and the orchestrator decides. A disproven assumption becomes a change request — never silent drift.
3. **The spec freezes.** The canonical docs are hashed into an immutable baseline; from here on, no idea touches the spec directly.
4. **Issues are extracted.** Deterministic gates turn the frozen baseline into a requirement catalog, traceable vertical issues, and the architecture map — with full line coverage: every spec line is covered by an issue, explicitly excluded, or the gate fails.
5. **The two-agent loop builds it.** For each ready issue: implement (gate-first), independently review and fix, then the orchestrator re-runs the gate as the authoritative verdict, commits the green checkpoint, and retires the issue.
6. **Changes go through change requests.** Mid-run, you talk to Vivi; post-freeze your asks are drafted as CRs. Approving or rejecting a CR is the **single human touchpoint** — an approved CR folds into the spec, re-freezes the baseline, re-extracts, and reopens exactly the impacted issues.
7. **You watch all of it.** The control plane shows the 13-stage pipeline, the architecture map with live per-node status, notifications with in-app CR review, per-agent quota, and Run / Stop / Resume controls.

## Quick start

```sh
git clone https://github.com/TomySpagnoletti/vivicy.git
cd vivicy
npm ci

# Run the visual control plane, then pick or create a project in the onboarding.
npm run dev            # → http://localhost:3000

# …or point it at a target project directly:
VIVICY_TARGET_ROOT=/abs/path/to/your/project npm run dev

# …or drive the factory headless via the CLI:
node factory/cli.ts app     --target /abs/path/to/your/project
node factory/cli.ts extract --target /abs/path/to/your/project
node factory/cli.ts start   --target /abs/path/to/your/project   # resumable supervisor
node factory/cli.ts status  --target /abs/path/to/your/project --json
```

**Requirements:** Node 20+, git. Real runs need the two agent CLIs installed and authenticated: [Claude Code](https://code.claude.com/docs/en/quickstart) and [Codex](https://learn.chatgpt.com/docs/codex/cli). No agents installed? See the rehearsal below.

### Try it end to end — no agents, no target needed

```sh
node factory/cli.ts rehearsal --dry
# → REHEARSAL PASSED (all stages green)
```

The rehearsal exercises the whole chain (prepare docs → freeze → extract → gates → loop → ledger → map) against an isolated throwaway fixture with real tooling and fake agents — a fast proof the factory is wired correctly on your machine.

### Fake missing agent CLIs — even when they're installed

`VIVICY_FAKE_MISSING_CLI` forces the agent-CLI health check to report Claude Code and/or Codex as absent, triggering the **Install the agent CLIs** gate — the fast way to develop or test that flow without uninstalling anything.

```sh
VIVICY_FAKE_MISSING_CLI=claude,codex npm run dev   # =claude or =codex to fake just one
```

Server-side only; unknown tokens are ignored, and an unset value means real detection.

## What lands in your repo

Everything Vivicy reads and writes lives under `.vivicy/` at the target root: `canonical/` (the spec — the only part you write), `baselines/`, `requirements/`, `architecture-map/`, `change-requests/`, and `development/` (issues, spikes, progress ledger, reports). The scaffold adds only three root files (`AGENTS.md`, `CLAUDE.md`, `README.md`) plus `vivicy.json` and a complete `.gitignore` — and **never clobbers** an existing file when added to a populated repo.

The target stays lean by design: no method docs, no templates, no framework assumptions. The agents' full discipline travels in Vivicy's bundled prompts, and the shape of every artifact is enforced by deterministic checks on Vivicy's side.

## Any language, any stack

Nothing in the factory assumes a stack for the target. The per-issue verification gate is the target's own command (`gateCommand` in `vivicy.json`): `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, `npm test` — whatever your runner is. No hidden default and no human edit: the scaffold writes a `null` sentinel and the pipeline establishes the real command mechanically — from the frozen canonical when the spec states one, otherwise the stack-setup issue — and the loop refuses to verify while the sentinel still stands rather than assuming a runner. Point Vivicy at a Rust crate, a Python service, a Go binary, or a monorepo — the loop, the map, and the gates are the same.

## Under the hood

- `factory/` — the standalone Node ESM factory: the deterministic orchestrator and resumable supervisor, the spike prover, the issue extractor, the documentation-baseline lock, the semantic-extraction / traceability / spike / change-control gates, the per-issue progress ledger, the agent-leg spawn + timeout infra, the agent prompts (`prompts/`), and the CLI.
- `app/`, `components/`, `lib/` — the Next.js control plane that drives and visualizes it. Its UI was bootstrapped from this [shadcn/ui preset](https://ui.shadcn.com/create?preset=b5dMkF7CK&pointer=true): `npx shadcn@latest init --preset b5dMkF7CK --template next --pointer`.

Design choices worth knowing: the orchestrator owns all state transitions (agents only ever do one of a few bounded actions — there is no agent self-reporting seam); the architecture map is generated once at extraction and the live status is a read-time overlay (no per-issue regeneration); transcripts of every agent leg are kept on disk but never committed; every green checkpoint is a real git commit made safe by the scaffolded `.gitignore`.

## Status

Young and moving fast. Vivi is now the governess: reach her from the bubble in the corner and she drives the whole factory (spec, pipeline, skills, map, change requests) without ever writing code herself; a project's life is a chain of spec cycles (one project spec, then feature specs), and its runtime state is isolated per project. The pipeline is torture-tested (it survived a deliberately hostile, contradiction-riddled spec and turned the wreckage into evidence-backed change requests), but interfaces may still change without notice.

## License

MIT © Tomy Spagnoletti Duval. See [LICENSE](./LICENSE).
