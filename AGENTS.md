# Vivicy — agent guide

Vivicy is a visual autonomous dev factory. See [README](./README.md) for what it is and how to run it. This package has two parts:

- `factory/` — standalone Node ESM tooling (the dev loop, supervisor, status probe, rehearsal harness, progress ledger/MCP/hooks, baseline lock, extraction and traceability gates, and the viewer-data generator). Plain `node`, no Next coupling. It has its own `factory/tsconfig.json` and a Node `--test` suite; it is excluded from the Next app's TypeScript and ESLint configs on purpose.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane.

The factory operates on a **target project**. The app resolves it in order: the project the user picked in the UI (persisted in the runtime dir) → the `VIVICY_TARGET_ROOT` env var → the parent of the process cwd (`..`). Vivicy is standalone, not vendored into the target. Never hardcode machine-specific paths.

Gates: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run e2e` for the app; `npm run factory:typecheck` and `npm run factory:test` for the factory; `node factory/dev-rehearsal.mjs --dry` for the end-to-end method rehearsal.

Vivicy is a web app — `npm run dev` to develop, `npm run build && npm run start` to run. See the README's Run / Build section.

This repo pins Next.js 16, which has breaking changes from older releases — confirm App Router APIs and conventions against the bundled docs in `node_modules/next/dist/docs/` rather than from memory.

## Per-leg timeouts (agent legs cannot hang the loop)

Every agent leg (both the dev-loop's implementer/reviewer and the extractor/verifier) runs through the shared spawn infra (`factory/agent-spawn.mjs` → `factory/leg-timeout.mjs` → `factory/leg-supervisor.mjs`) under TWO independent watchdogs, so a wedged `codex exec`/`claude` (alive but producing nothing) can never block the orchestrator the way it once did for ~5 hours:

- a **hard wall-clock cap** (`VIVICY_LEG_TIMEOUT_MS`, default 45 min) — the absolute ceiling for one leg, generous enough for legit xhigh-effort issues (15–30 min);
- a **stall/idle timeout** (`VIVICY_LEG_IDLE_MS`, default 12 min) — no new stdout/stderr for this long means the CLI is wedged even before the cap.

Whichever trips first kills the leg's **whole process group** (SIGTERM, then SIGKILL after `VIVICY_LEG_KILL_GRACE_MS`, default 10 s) — the CLI spawns children, so the group kill leaves no orphans — and returns a structured timeout failure (`timedOut: true`, a human reason, a non-zero status). The dev-loop and the extractor both treat a timed-out leg as a FAILED attempt inside their existing bounded retries (retry the issue; if it keeps timing out, record `issue_blocked` / `extraction_blocked` naming the timeout — never hang). Set any of the env values to `0` to disable that watchdog. The gate command (`npm test`) is NOT an agent leg and is not subject to this policy.

## Public-API quality bar (where it lives, and why no dead-code gate)

Two classes of defect live in the seams of the per-issue two-agent loop and are NOT caught by the deterministic gates (which prove coverage, traceability, and that the project's own test command exits 0):

1. a public function that works only via a side-channel hack, backed by a dead exported symbol that production never calls and a unit test that exercises a hand-built input instead of the real public path; and
2. a public entry point that throws a raw `TypeError` on garbage input (`null`, wrong-type, …) because the "never throws / typed error" invariant was only tested for valid-shaped failures.

These are addressed in the **role prompts**, not by new deterministic checks. The implementer prompt (`factory/prompts/implementer.md`, "QUALITY BAR") requires, for any issue touching a public API/boundary: end-to-end testing through the real public entry point (not just internal helpers), type-fuzzing each public boundary to its documented typed degradation, no side-channel reconciliation of a contract conflict (STOP and route to change control instead), and no dead/unreferenced exports. The reviewer prompt (`factory/prompts/reviewer.md`) carries the matching MUST-fail checklist, including a cross-check against ALL canonical docs that touch the feature. The extractor's independent fidelity verifier (`factory/prompts/extraction-verifier.md`) adds a cross-document consistency check so a spec that describes the same data shape two ways is reconciled BEFORE implementation, not by the implementer at build time. `factory/dev-loop.test.mjs` locks these prompt invariants so they cannot be silently dropped.

**No deterministic dead-export gate.** We deliberately did NOT add an "unreferenced export" check to the gate. Vivicy is language- and project-agnostic, and a robust detector needs per-language call-graph reachability from declared entry points plus a declared public-API surface to avoid false positives. Without those, a grep/regex "referenced only inside its own module + tests" heuristic flags every legitimate public-library export (the API surface is unreferenced internally by design) and misses the actual audit defect (its dead export WAS test-reachable; the real signal was "not on the production path"). That tradeoff is noise without coverage, so the reviewer checklist — which has the semantic context to tell a genuine dead export from an intended public one — owns this instead.

## Writing prose

Markdown and prose use **natural** line breaks: one line per paragraph. Never hard-wrap prose to a fixed column — a line break is semantic (a new paragraph or list item), not cosmetic. List items stay one item per line; tables, fenced code, and intentional hard breaks are preserved as authored. Editors and Prettier must not re-wrap prose (`proseWrap: preserve`).
