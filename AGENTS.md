# Vivicy — agent guide

Vivicy is a visual autonomous dev factory. See [README](./README.md) for what it is and how to run it. This package has two parts:

- `factory/` — standalone Node ESM tooling (the dev loop, supervisor, status probe, rehearsal harness, progress ledger/MCP/hooks, baseline lock, extraction and traceability gates, and the viewer-data generator). Plain `node`, no Next coupling. It has its own `factory/tsconfig.json` and a Node `--test` suite; it is excluded from the Next app's TypeScript and ESLint configs on purpose.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane.
- `src-tauri/` — the Tauri v2 desktop shell (Rust). It runs the Next server as a localhost sidecar (the app's API routes need a Node runtime, so a static export is impossible). The web build is the default and is unaffected by the desktop packaging; the native folder picker and CLI-install upgrades feature-detect the Tauri shell (`lib/desktop.ts`) and fall back to the web behavior in the browser.

The factory operates on a **target project**. The app resolves it in order: the project the user picked in the UI (persisted in the runtime dir) → the `VIVICY_TARGET_ROOT` env var → the parent of the process cwd (`..`). Vivicy is standalone, not vendored into the target. Never hardcode machine-specific paths.

Gates: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run e2e` for the app; `npm run factory:typecheck` and `npm run factory:test` for the factory; `node factory/dev-rehearsal.mjs --dry` for the end-to-end method rehearsal.

Desktop (Tauri): `npm run tauri:dev` / `npm run tauri:build` (host OS), and `npm run tauri:build:windows` to cross-compile the Windows installer from macOS via `cargo-xwin`. Needs the Rust toolchain (rustup — Homebrew `rust` cannot add cross targets) + Tauri system prerequisites; the build stages the Next standalone server and an official Node sidecar via `src-tauri/scripts/prepare-sidecar.mjs`, which selects the sidecar Node for the **target** triple (`VIVICY_TARGET_TRIPLE`), so a Windows build ships `node.exe`. Cross-OS bundles also build natively in CI (`.github/workflows/desktop.yml`), which is the reliable release path. See the README's Run / Build section.

This repo pins Next.js 16, which has breaking changes from older releases — confirm App Router APIs and conventions against the bundled docs in `node_modules/next/dist/docs/` rather than from memory.

## Per-leg timeouts (agent legs cannot hang the loop)

Every agent leg (both the dev-loop's implementer/reviewer and the extractor/verifier) runs through the shared spawn infra (`factory/agent-spawn.mjs` → `factory/leg-timeout.mjs` → `factory/leg-supervisor.mjs`) under TWO independent watchdogs, so a wedged `codex exec`/`claude` (alive but producing nothing) can never block the orchestrator the way it once did for ~5 hours:

- a **hard wall-clock cap** (`VIVICY_LEG_TIMEOUT_MS`, default 45 min) — the absolute ceiling for one leg, generous enough for legit xhigh-effort issues (15–30 min);
- a **stall/idle timeout** (`VIVICY_LEG_IDLE_MS`, default 12 min) — no new stdout/stderr for this long means the CLI is wedged even before the cap.

Whichever trips first kills the leg's **whole process group** (SIGTERM, then SIGKILL after `VIVICY_LEG_KILL_GRACE_MS`, default 10 s) — the CLI spawns children, so the group kill leaves no orphans — and returns a structured timeout failure (`timedOut: true`, a human reason, a non-zero status). The dev-loop and the extractor both treat a timed-out leg as a FAILED attempt inside their existing bounded retries (retry the issue; if it keeps timing out, record `issue_blocked` / `extraction_blocked` naming the timeout — never hang). Set any of the env values to `0` to disable that watchdog. The gate command (`npm test`) is NOT an agent leg and is not subject to this policy.

## Writing prose

Markdown and prose use **natural** line breaks: one line per paragraph. Never hard-wrap prose to a fixed column — a line break is semantic (a new paragraph or list item), not cosmetic. List items stay one item per line; tables, fenced code, and intentional hard breaks are preserved as authored. Editors and Prettier must not re-wrap prose (`proseWrap: preserve`).
