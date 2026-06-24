# Vivicy — agent guide

Vivicy is a visual autonomous dev factory. See [README](./README.md) for what it
is and how to run it. This package has two parts:

- `factory/` — standalone Node ESM tooling (the dev loop, supervisor, status
  probe, rehearsal harness, progress ledger/MCP/hooks, baseline lock, extraction
  and traceability gates, and the viewer-data generator). Plain `node`, no Next
  coupling. It has its own `factory/tsconfig.json` and a Node `--test` suite; it
  is excluded from the Next app's TypeScript and ESLint configs on purpose.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane.
- `src-tauri/` — the Tauri v2 desktop shell (Rust). It runs the Next server as a
  localhost sidecar (the app's API routes need a Node runtime, so a static export
  is impossible). The web build is the default and is unaffected by the desktop
  packaging; the native folder picker and CLI-install upgrades feature-detect the
  Tauri shell (`lib/desktop.ts`) and fall back to the web behavior in the browser.

The factory operates on a **target project** selected by `VIVICY_TARGET_ROOT`
(legacy alias `NAIGHT_DEV_ROOT`), defaulting to the project Vivicy is vendored
into. Never hardcode machine-specific paths.

Gates: `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`,
`npm run e2e` for the app; `npm run factory:typecheck` and `npm run factory:test`
for the factory; `node factory/dev-rehearsal.mjs --dry` for the end-to-end method
rehearsal.

Desktop (Tauri): `npm run tauri:dev` / `npm run tauri:build`. Needs the Rust
toolchain + Tauri system prerequisites; the build stages the Next standalone
server and an official Node sidecar via `src-tauri/scripts/prepare-sidecar.mjs`.
Cross-OS bundles build in CI (`.github/workflows/desktop.yml`). See the README's
Desktop section.

<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->
