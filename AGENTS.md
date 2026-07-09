# Vivicy — agent guide

Vivicy is a visual autonomous dev factory — a **web app**. See [README](./README.md) for what it is and how to run it. This package has two parts:

- `factory/` — standalone Node ESM tooling. The actual modules: the issue extractor (`extract-issues.ts`), the dev-loop orchestrator (`dev-loop.ts`) and resumable supervisor (`dev-loop-supervised.ts`), the status probe (`dev-status.ts`), the rehearsal harness (`dev-rehearsal.ts`), the per-issue progress ledger (`progress-ledger.ts` — the single source of truth for progress, written mechanically by the orchestrator), the polyglot gate config (`project-config.ts`, reading the target's `vivicy.json`), the agent-leg spawn + per-leg timeout infra (`agent-spawn.ts`, `leg-timeout.ts`, `leg-supervisor.ts`), the documentation-baseline lock (`doc-baseline.ts`), the semantic-extraction and traceability gates (`semantic-extraction-check.ts`, `traceability-check.ts`), the four agent prompts (`prompts/`), the lean-target scaffold templates (`templates/`), and the architecture-map viewer-data generator (`generate-viewer-data.ts`). Plain `node`, no Next coupling. It has its own `factory/tsconfig.json` and a Node `--test` suite; it is excluded from the Next app's TypeScript and ESLint configs on purpose. There is **no progress MCP and no lifecycle-hook seam** — agents never report progress; the orchestrator owns the ledger.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane that drives the factory and renders the architecture map. The map data is a static graph generated once at extraction; `app/api/map/route.ts` overlays the live ledger (`lib/development-overlay.ts`, `lib/map-data.ts`) at read time, so the loop never regenerates the map per issue.

The factory operates on a **target project**. The app resolves it in order: the project the user picked in the UI (persisted in the runtime dir) → the `VIVICY_TARGET_ROOT` env var → the parent of the process cwd (`..`). Vivicy is standalone, not vendored into the target. Never hardcode machine-specific paths.

Gates: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run e2e` for the app; `npm run factory:typecheck` and `npm run factory:test` for the factory; `node factory/dev-rehearsal.ts --dry` for the end-to-end method rehearsal.

Always run tests through the wrapped npm commands, never `npx vitest`/`npx playwright test` directly: the wrappers auto-clean transient artifacts (`.next-e2e-*` dist dirs, `test-results/`, `playwright-report/`) after the run, including Playwright's post-teardown `.last-run.json` that the config-level teardown cannot catch. Targeted runs pass through: `npm test -- <test files>`, `npm run e2e -- <spec> --project=<project>`.

Vivicy is a web app — `npm run dev` to develop, `npm run build && npm run start` to run. See the README's Run / Build section.

This repo pins Next.js 16, which has breaking changes from older releases — confirm App Router APIs and conventions against the bundled docs in `node_modules/next/dist/docs/` rather than from memory.

## Method invariants (bind every change to this repo)

The pipeline contract is implemented and locked by tests; **the code is the contract** — never maintain a sidecar document that re-describes what the project is (the durable "why" lives here, the rest lives in code, tests, and `git log`). This repo is **public**: the local method backlog (`TASKS.md`) stays gitignored, and nothing session-internal gets committed. Before any sizable evolution: state-of-play audit of the existing engine by an agent team first, then evolve the audited modules — never restart from zero, never overwrite working machinery.

These are the standing principles — the "why" a diff cannot derive from the code alone. Any change that violates one of these is wrong even if every gate stays green:

- **P1 — No fakery.** Every safety/traceability/coverage/progress mechanism must be genuinely verified and enforced by the orchestrator. A report, matrix, or hash that nothing downstream checks is forbidden. Deterministic wherever possible.
- **P2 — Zero humans in the development loop.** Exactly one legitimate human touchpoint exists: the owner decision on a Change Request. Retry buttons are human interventions *on* the machine, never steps the machine waits for.
- **P3/P4 — Loud failures, no blind states.** On any detected problem the orchestrator remediates automatically within bounded attempts, then blocks loudly (report + notification). Being silent about what happened, where, or why is forbidden; the loop always progresses or surfaces a block.
- **P5 — Flexibility inside determinism.** Judgment lives in agent legs at decision points (readiness verdicts, proof verdicts); the orchestration around them stays deterministic and evidence-based. Enforcement of rules is always the orchestrator's, never the agent's.
- **P6 — ShadcnUI only.** All UI comes from shadcn primitives and tokens; nothing hand-invented in raw Tailwind.
- **P7 — Non-loop / dev-loop boundary.** Left of the boundary (spec intake: import, Vivi) there is no automatism — only user ↔ Vivi. Right of it, everything is autonomous. UI must preserve and display this boundary.
- **P8 — Stage typing.** Every pipeline stage is typed deterministic / agent / mixed (`components/pipeline/pipeline-stages.ts`); a new stage declares its type and the UI shows it.
- **P9 — Notifications at every step,** including autonomous internals and automatic redos.
- **P10 — No useless work.** The canonical never chases the code; doc updates happen only when intention changes.

## Truth model (why CRs exist, and when direct edits are legal)

One source of truth per type of truth: product intention = canonical spec + accepted CRs; work to do = issues; real result = code + tests; conformity proof = gates + traceability. Issues and code are never the product truth. The current product contract = the latest frozen canonical baseline + accepted CRs not yet folded in; an accepted CR must eventually be folded into the canonical (never an old spec plus infinite annexes).

**Spec kinds and cycles (v0.7.0).** A governed project's life is an ordered chain of spec CYCLES: at most one **project** spec (greenfield — the repo carries no product code when the spec starts) then any number of **feature** specs (evolutions of the existing codebase), one active at a time. The kind is detected MECHANICALLY (`lib/spec-kind.ts`, tracked files outside `.vivicy/` and the scaffold surface) and stamped into the frozen baseline manifest (`spec_kind`) — never an agent's judgment. Between two builds, opening a feature cycle (`lib/spec-cycle.ts`, the `.vivicy/development/reports/spec-cycle.json` state file) is the official mechanism for evolving the canonical: it reopens Vivi's pre-freeze allowlist, the supervised build is refused while it is open, and the NEXT extraction freeze (a MINOR version bump, `approval_ref` = the cycle id) closes it mechanically — a cycle is never closed by declaration. Mid-build intention changes remain CRs (rule 3 above); post-delivery feedback triages into CRs (conformity) or the next feature cycle (new intention). Cancelling a cycle is legal only while the canonical still verifies against the frozen baseline.

The four routing rules, all enforced in code (`lib/vivi.ts` allowlists, `factory/change-control.ts`, `factory/cr-apply.ts`, the readiness leg):

1. Ambiguity found during extraction (pre-build): fix the spec directly, re-freeze, re-extract — no CR.
2. A spike discovers a real constraint post-freeze: CR mandatory — the spike proposes, never edits the spec (pre-freeze spike proving may edit directly).
3. The need changes during development: CR mandatory — the official mechanism for "the initial intention is no longer right".
4. An issue becomes non-implementable because of already-produced code: execution-plan problem → modify the issue only; intention problem → CR toward the spec. A CR whose application touches the canonical always forces a re-freeze.

## Per-leg timeouts (agent legs cannot hang the loop)

Every agent leg (both the dev-loop's implementer/reviewer and the extractor/verifier) runs through the shared spawn infra (`factory/agent-spawn.ts` → `factory/leg-timeout.ts` → `factory/leg-supervisor.ts`) under TWO independent watchdogs, so a wedged `codex exec`/`claude` (alive but producing nothing) can never block the orchestrator the way it once did for ~5 hours:

- a **hard wall-clock cap** (`VIVICY_LEG_TIMEOUT_MS`, default 45 min) — the absolute ceiling for one leg, generous enough for legit xhigh-effort issues (15–30 min);
- a **stall/idle timeout** (`VIVICY_LEG_IDLE_MS`, default 12 min) — no new stdout/stderr for this long means the CLI is wedged even before the cap.

Whichever trips first kills the leg's **whole process group** (SIGTERM, then SIGKILL after `VIVICY_LEG_KILL_GRACE_MS`, default 10 s) — the CLI spawns children, so the group kill leaves no orphans — and returns a structured timeout failure (`timedOut: true`, a human reason, a non-zero status). The dev-loop and the extractor both treat a timed-out leg as a FAILED attempt inside their existing bounded retries (retry the issue; if it keeps timing out, record `issue_blocked` / `extraction_blocked` naming the timeout — never hang). Set any of the env values to `0` to disable that watchdog. The verification gate (the target's `vivicy.json` `gateCommand`, e.g. `go test ./...`, `cargo test`, `pytest -q`, `npm test`) is NOT an agent leg and is not subject to this policy.

## Public-API quality bar (where it lives, and why no dead-code gate)

Two classes of defect live in the seams of the per-issue two-agent loop and are NOT caught by the deterministic gates (which prove coverage, traceability, and that the project's own test command exits 0):

1. a public function that works only via a side-channel hack, backed by a dead exported symbol that production never calls and a unit test that exercises a hand-built input instead of the real public path; and
2. a public entry point that throws a raw `TypeError` on garbage input (`null`, wrong-type, …) because the "never throws / typed error" invariant was only tested for valid-shaped failures.

These are addressed in the **role prompts**, not by new deterministic checks. The implementer prompt (`factory/prompts/implementer.md`, "QUALITY BAR") requires, for any issue touching a public API/boundary: end-to-end testing through the real public entry point (not just internal helpers), type-fuzzing each public boundary to its documented typed degradation, no side-channel reconciliation of a contract conflict (STOP and route to change control instead), and no dead/unreferenced exports. The reviewer prompt (`factory/prompts/reviewer.md`) carries the matching MUST-fail checklist, including a cross-check against ALL canonical docs that touch the feature. The extractor's independent fidelity verifier (`factory/prompts/extraction-verifier.md`) adds a cross-document consistency check so a spec that describes the same data shape two ways is reconciled BEFORE implementation, not by the implementer at build time. `factory/dev-loop.test.ts` locks these prompt invariants so they cannot be silently dropped.

**No deterministic dead-export gate.** We deliberately did NOT add an "unreferenced export" check to the gate. Vivicy is language- and project-agnostic, and a robust detector needs per-language call-graph reachability from declared entry points plus a declared public-API surface to avoid false positives. Without those, a grep/regex "referenced only inside its own module + tests" heuristic flags every legitimate public-library export (the API surface is unreferenced internally by design) and misses the actual audit defect (its dead export WAS test-reachable; the real signal was "not on the production path"). That tradeoff is noise without coverage, so the reviewer checklist — which has the semantic context to tell a genuine dead export from an intended public one — owns this instead.

## Test matrix (mandatory upkeep)

`test/TEST-MATRIX.md` (committed) is the exhaustive inventory of every test case — covered and GAP — for the whole system, organized by area plus cross-matrices. **Every change that adds, changes, or removes behavior MUST update the matrix in the same working session**: add new cases at the next free id in the right area, update the scenario/expected text of changed ones, delete cases for removed behavior (ids retire, never get reused), flip `GAP` to the covering test reference when you write one, and adjust the status table counts for the touched areas. Case ids are stable and never renumbered. A behavior-touching session that ends without reconciling the matrix is incomplete work.

This mandate is machine-verified (P1): the matrix header carries a `Reconciled fingerprint:` over the behavior-bearing source tree plus the HEAD commit hash at reconciliation, and `scripts/test-matrix.test.ts` (in the vitest suite, so `npm test` runs it) fails when the code changed without a re-stamp — printing the exact behavior files changed since the stamped commit (`git diff` + dirty tree) — when the status-table counts drift from the actual bullets/GAPs, or when case ids collide. After reconciling the matrix — including after a pure no-behavior refactor — run `npm run matrix:stamp`; the stamp is the explicit declaration that the reconciliation happened, and `git log test/TEST-MATRIX.md` is its audit trail.

The reconciliation itself is agent work with a git-derived work-list: `npm run matrix:delta` prints exactly the behavior files changed since the stamped commit — read those files, reconcile their cases, recount, stamp. Stamping without doing that reading is falsifying the declaration; never do it.

Repo skills live under `.agents/skills/` (committed, standard SKILL.md format — the same convention Vivicy's own skills stage installs into target repos). Every agent must follow them when their trigger applies; this list is their registry:

- **matrix-reconcile** ([.agents/skills/matrix-reconcile/SKILL.md](./.agents/skills/matrix-reconcile/SKILL.md)) — reconcile `test/TEST-MATRIX.md` from the git delta; trigger: the matrix guard is red, a behavior change is about to be committed, or the matrix is being updated for any reason.

## Writing prose

Markdown and prose use **natural** line breaks: one line per paragraph. Never hard-wrap prose to a fixed column — a line break is semantic (a new paragraph or list item), not cosmetic. List items stay one item per line; tables, fenced code, and intentional hard breaks are preserved as authored. Editors and Prettier must not re-wrap prose (`proseWrap: preserve`).
