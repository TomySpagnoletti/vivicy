# Vivicy — agent guide

Vivicy is a visual autonomous dev factory. See [README](./README.md) for what it is and how to run it. This package has two parts:

- `factory/` — standalone Node ESM tooling (the dev loop, supervisor, status probe, rehearsal harness, progress ledger/MCP/hooks, baseline lock, extraction and traceability gates, and the viewer-data generator). Plain `node`, no Next coupling. It has its own `factory/tsconfig.json` and a Node `--test` suite; it is excluded from the Next app's TypeScript and ESLint configs on purpose.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane.
- `src-tauri/` — the Tauri v2 desktop shell (Rust). It runs the Next server as a localhost sidecar (the app's API routes need a Node runtime, so a static export is impossible). The web build is the default and is unaffected by the desktop packaging; the native folder picker and CLI-install upgrades feature-detect the Tauri shell (`lib/desktop.ts`) and fall back to the web behavior in the browser.

The factory operates on a **target project**. The app resolves it in order: the project the user picked in the UI (persisted in the runtime dir) → the `VIVICY_TARGET_ROOT` env var → the parent of the process cwd (`..`). Vivicy is standalone, not vendored into the target. Never hardcode machine-specific paths.

Gates: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run e2e` for the app; `npm run factory:typecheck` and `npm run factory:test` for the factory; `node factory/dev-rehearsal.mjs --dry` for the end-to-end method rehearsal.

Desktop (Tauri): `npm run tauri:dev` / `npm run tauri:build`. Needs the Rust toolchain + Tauri system prerequisites; the build stages the Next standalone server and an official Node sidecar via `src-tauri/scripts/prepare-sidecar.mjs`. Cross-OS bundles build in CI (`.github/workflows/desktop.yml`). See the README's Desktop section.

This repo pins Next.js 16, which has breaking changes from older releases — confirm App Router APIs and conventions against the bundled docs in `node_modules/next/dist/docs/` rather than from memory.

## Writing prose

Markdown and prose use **natural** line breaks: one line per paragraph. Never hard-wrap prose to a fixed column — a line break is semantic (a new paragraph or list item), not cosmetic. List items stay one item per line; tables, fenced code, and intentional hard breaks are preserved as authored. Editors and Prettier must not re-wrap prose (`proseWrap: preserve`).
