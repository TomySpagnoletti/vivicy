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

**Spec kinds and cycles.** A governed project's life is an ordered chain of spec CYCLES: at most one **project** spec (greenfield — the repo carries no product code when the spec starts) then any number of **feature** specs (evolutions of the existing codebase), one active at a time. The kind is detected MECHANICALLY (`lib/spec-kind.ts`, tracked files outside `.vivicy/` and the scaffold surface) and stamped into the frozen baseline manifest (`spec_kind`) — never an agent's judgment. Between two builds, opening a feature cycle (`lib/spec-cycle.ts`, the `.vivicy/development/reports/spec-cycle.json` state file) is the official mechanism for evolving the canonical: it reopens Vivi's pre-freeze allowlist, the supervised build is refused while it is open, and the NEXT extraction freeze (a MINOR version bump, `approval_ref` = the cycle id) closes it mechanically — a cycle is never closed by declaration. Mid-build intention changes remain CRs (rule 3 above); post-delivery feedback triages into CRs (conformity) or the next feature cycle (new intention). Cancelling a cycle is legal only while the canonical still verifies against the frozen baseline.

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

## Code comments (owner rule — enforced on every contribution)

This codebase is written and read by AI agents. Comments cost tokens on every read, and they rot into lies. The default is **zero comments**: the code, its names, and its tests are the documentation.

A comment may exist ONLY when it states a structural invariant, constraint, or danger that is **not derivable from the code itself** — the "this breaks if you change it" class: a cross-process byte-compatibility contract, a deliberately non-obvious ordering, a platform trap, a security boundary. One dense line, no story. The canonical set of such invariants lives in the "Structural invariants" section below — prefer pointing there over repeating them inline.

Never write: narration or paraphrase of the next line, JSDoc/docstrings that restate names and types, module-header essays, session or history references, plan/sprint codes, version markers, decorative banners. Tool directives (`eslint-disable`, `@ts-expect-error`, `"use client"`, shebangs) are not comments — keep them. When editing a file that still carries legacy comments, delete them as you pass.

## Structural invariants (the non-derivable "why"s — the only sanctioned comment content)

**CLI ↔ app parity**
- `factory/cli.ts`, `lib/control.ts` – never import each other; parity holds only because both spawn the identical factory scripts/args and read/write the same state-file schemas (`run-state.json`, `skills-install.lock`, `notifications.jsonl`, `current-project.json`), never shared code.
- `lib/project-runtime.ts` – single derivation of project-scoped runtime/lock paths, imported identically by the Next app and by `factory/cli.ts` via a raw relative import with no bundler, so it must stay free of `@/` aliases and Next-only imports; this is what makes a CLI-started and a UI-started run agree on one lock.
- `lib/control.ts` (`claimRunLock`), `factory/cli.ts` (`claimCliSkillsLock`) – every single-run lock is claimed with the fs `wx` exclusive-create flag before spawning, never written unconditionally, closing the check-then-spawn TOCTOU window both clients depend on.
- `factory/cli.ts` – exit codes (0 ok, 1 actionable refusal, 2 usage, 3 unexpected) are a stable agent-facing contract; never renumber or repurpose them.
- `factory/cli.ts` – target resolution is env/flag-only and deliberately never reads the UI's persisted `current-project.json`, so a CLI run can never silently act on whatever project the UI last picked.

**Freeze/extraction ordering**
- `factory/extract-issues.ts`, `factory/doc-baseline.ts` – a baseline freeze must be the first observable side effect of any extraction/CR-apply chain; no status/progress/report write may land before it, since a freeze refuses a dirty working tree.
- `factory/spike-prover.ts`, `factory/doc-baseline.ts` – spike proving must run before the baseline freeze, never after, or an owner-accepted correction to canonical docs forces a repeated re-freeze.
- `factory/dev-loop.ts` (`frozenIntegrationPaths`) – frozen extraction-corpus paths (`.vivicy/canonical/`, `baselines/`, `requirements/`, `architecture-map.yml`, `issue-index.json`) are reset to the integration HEAD one path at a time, never one batched `git checkout` (a single missing pathspec aborts the whole command); `package.json` is deliberately excluded from this frozen set so a legitimate new runtime dependency survives worktree integration.
- `factory/doc-baseline.ts` (`BaselineManifest.manifest_hash`) – deliberately excludes `generated_at`, `git`, `approval`, and `superseded` so the same document set always hashes identically regardless of commit/working-tree state or later supersession.
- `factory/cr-apply.ts` – orders its chain strictly: write the freeze-phase report before `commitApplied` (freezing a dirty tree fails), retire affected spikes and commit before spawning re-extraction, and never reopen impacted issues itself since the spawned `extract-issues.ts` already does so internally.

**Vivi enforcement**
- `lib/vivi.ts` – the `.vivicy` write allowlist is phase-dependent (`CANONICAL_DIRS` pre-freeze, `CHANGE_REQUESTS_DIR` post-freeze) and is re-derived every action round, since a tool call within the same turn (`pipeline.extract`, `cycle.open`/`close`) can freeze or reopen the baseline mid-turn.
- `lib/vivi.ts` – a rejected turn rolls back atomically (allowed writes and violations discarded together, never just the illegal part) to the owner's own pre-turn uncommitted bytes, never git HEAD; `.vivicy/development/transcripts/` is excluded from every snapshot/diff/rollback or a turn would roll back and destroy the spike files it just wrote.
- `lib/vivi.ts` – `git status`, not the prompt and not a byte-diff, is the sole witness that Vivi wrote no code outside `.vivicy`; gitignored paths are structurally invisible to it, so a null result means the probe itself is unusable this turn, not that Vivi is clean.
- `lib/vivi-actions.ts` (`VIVI_ACTION_TOOLS`), `factory/prompts/vivi.md` – the action registry excludes `cr.decide` (the CR decision is the owner's sole human touchpoint) and must stay mirrored with the tool table in the prompt; `map.move` reuses the exact same validated save path as the UI (`lib/map-layout-save.ts`, including the `VIVICY_MAP_LAYOUT_WRITE` kill-switch) — no action gets a privileged bypass.
- `lib/vivi.ts` (`transcriptPath`) – a card's action fires only on the owner's explicit click, never self-fires, and its content is always server-authored/deterministic, never LLM-generated; session ids must match the minted-UUID regex since `transcriptPath` interpolates them unsanitized into a file path.

**Dev-loop integration**
- `factory/dev-loop.ts` (`moveIssueToDone`) – must be persisted before the git commit that checkpoints it, at both call sites (sequential loop and parallel integration path), so a crash between the two can never leave an issue committed but absent from `done/`; the parallel path also captures the pre-merge HEAD sha while holding the integration lock, and each issue's worktree marker filename is keyed by `issue.id` since a shared name would collide when branches merge onto the shared main.
- `factory/progress-ledger.ts`, `factory/reopen.ts` – `issue_reopened` is the only progress event allowed to downgrade a graph item's terminal status and the only one that bypasses the stale-timestamp guard; `runReopen` must keep its file-move and this event atomic for the same reason `moveIssueToDone` must precede its commit; completing an issue clears every `active_items` entry for that issue id, not just the completing actor's, since implementer and reviewer run under different actors.
- `factory/progress-ledger.ts` – writes are protected by an O_EXCL lockfile plus a revision-based compare-and-swap; the CAS is not redundant with the lock — it also covers a lock force-reclaimed as stale by another writer mid-write.
- `factory/dev-loop.ts`, `factory/project-config.ts` – the verification gate command always comes from the target project (`issue.gate_command`, else the target's `vivicy.json#gateCommand`), never a hardcoded Node/npm default; a field explicitly declared in `vivicy.json`, even as an empty array, always wins over the `package.json#vivicy` fallback for that field.
- `lib/development-overlay.ts` (`deriveDevelopmentOverlay`) – the single implementation mapping the progress ledger to `{graph_item_states, active_items}`; the extraction-time generator (`factory/generate-viewer-data.ts`) calls it with a strict `evidenceRefChecker`, the `/api/map` read path (`lib/map-data.ts`) calls it without one so stale on-disk evidence never 500s a request — it must never be forked.

**Hand-synced duplicates**
- `factory/dev-loop.ts` (`CLI_DEFAULTS`/`DEFAULT_CONFIG`, `FAST_CAPABLE_MODELS`, `VALID_EFFORTS`, `MIN_CONCURRENCY`/`MAX_CONCURRENCY`), `lib/settings.ts` (`DEFAULT_SETTINGS`) – hand-duplicated with no shared source or type-level check; edit together.
- `lib/spec-cycle.ts` (`hasActiveFrozenBaseline`), `factory/extract-issues.ts` (`findFrozenManifest`), `factory/change-control.ts` (`readFrozenBaselineIdentity`), `factory/doc-baseline.ts` (supersede logic) – four independent implementations of the "active frozen baseline" predicate (`status: frozen`, no `superseded` marker); all four must move together.
- `lib/development-overlay.ts` (`slugGraphRefPart`, `canonicalEdgeGraphRef`), `factory/generate-viewer-data.ts` (`slugGraphRefPart`, `getEdgeGraphRef`) – must stay byte-for-byte identical, or generated data and live overlays stop matching each other's `graph_refs`.
- `lib/vivi.ts` (`CR_FILENAME`, `PENDING_CR_STATUSES`), `factory/change-control.ts` (own `CR_FILENAME`), `components/chat/vivi-notifications.tsx` (own `PENDING_STATUSES`) – both hand-duplicated with no shared import.
- `factory/cli.ts` mirrors several of `lib/control.ts`'s helpers with no shared import — `isRunActive`, `classifyDecisionCode`/`classifyDecisionError`, `factoryRootDir`/`getFactoryRoot`, and its own skills-lock claim (byte-compatible with `lib/control.ts`'s lock file) — plus a third independent `parseFrontmatter` implementation split across `factory/cli.ts`, `lib/control.ts`, and `factory/change-control.ts`.

**Platform traps & security boundaries**
- repo-wide – any code deriving a stable key or doing path comparison from a path under the OS temp dir or a persisted target root (runtime-key hashing, e2e fixtures, test assertions) must `realpathSync` it first: macOS symlinks `/tmp` to `/private/tmp` (and `/var` to `/private/var`), so an unresolved path forks state/locks across two spellings of the same directory.
- repo-wide UI components – interactive controls that must stay focusable while conceptually disabled/busy/locked (composer, send button, decision-card buttons, Radix `AlertDialogTrigger`, the one-shot Extract button) use `aria-disabled` plus a guarded no-op handler, never the native `disabled` attribute, which drops keyboard focus to `<body>` or breaks Radix's return-focus-to-trigger on close.
- `lib/agents-health-types.ts`, `lib/project-types.ts`, `lib/skills-report.ts`, `components/pipeline/pipeline-stages.ts` (`ExtractionStatusLike`) – any module importing `node:fs`/`node:child_process` must never be reachable from a `"use client"` component; since no compiler guard enforces this, server-only shapes are hand-split into sibling `*-types.ts` files or subset-redeclared inline instead of imported directly, and a credential/token field must never appear on a client-reachable type.
- repo-wide subprocess calls (`lib/agents-update.ts`, `lib/agents-health.ts`, `factory/doc-baseline.ts`, and others) – all git/subprocess invocations pass args as an argv array to `execFile`/`spawnSync`, never a shell string or `shell: true`; the same discipline backs a closed, fixed allow-list of executable commands (agent self-update, git), since Vivicy execs under the assumption of being a local single-user tool — a trust boundary that breaks if the app is ever exposed multi-tenant.
- `hooks/use-panel-state.ts`, `hooks/use-persisted-boolean.ts` – client state that must survive SSR hydration without a mismatch lives in a module-level external store read via `useSyncExternalStore`, with `getServerSnapshot` always returning a fixed default and the real (`localStorage`-backed) value swapped in only post-hydration, never via `useState`+`useEffect`.
- `lib/agents-health.ts` – Windows stores Claude Code credentials only in `%USERPROFILE%\.claude\.credentials.json`, never Keychain/Credential Manager; a keyring-only Codex user (`cli_auth_credentials_store=keyring`) reads as unauthenticated by design since that store can't be probed non-interactively; auth detection must never invoke the agent CLI itself, only `which`/`--version`/documented auth-file reads.

## Writing prose

Markdown and prose use **natural** line breaks: one line per paragraph. Never hard-wrap prose to a fixed column — a line break is semantic (a new paragraph or list item), not cosmetic. List items stay one item per line; tables, fenced code, and intentional hard breaks are preserved as authored. Editors and Prettier must not re-wrap prose (`proseWrap: preserve`).
