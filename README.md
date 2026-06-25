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

- `factory/` — the standalone Node ESM tooling (the "factory"): the dev-loop orchestrator and supervisor, the status probe, the rehearsal harness, the progress ledger + MCP + hook emitters, the documentation-baseline lock, the semantic-extraction and traceability gates, and the architecture-map viewer-data generator. No framework coupling — plain `node`.
- `app/`, `components/`, `lib/` — the Next.js App Router control plane that drives and visualizes the factory.
- `src-tauri/` — the Tauri v2 desktop shell (Rust) that wraps the Next server as a localhost sidecar for the native macOS/Windows app. See [Desktop app](#desktop-app-tauri).

## Run / Build — three ways

Vivicy is one codebase that ships as a **web app** and as a **native desktop app for macOS and Windows**. All three run the same Next server (the desktop app wraps it as a localhost sidecar — see [Desktop app](#desktop-app-tauri)).

| Mode                | Develop                               | Build & run                                                                                                                |
| ------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Web**             | `npm run dev` → http://localhost:3000 | `npm run build && npm run start`                                                                                           |
| **macOS desktop**   | `npm run tauri:dev`                   | `npm run tauri:build` → `.app` / `.dmg` under `src-tauri/target/release/bundle/`                                           |
| **Windows desktop** | (build only — see below)              | from Windows/CI: `npm run tauri:build`; **from macOS**: `npm run tauri:build:windows` (cross-compile, prerequisites below) |

The web mode needs nothing but `npm ci`. The desktop modes additionally need the Rust toolchain and Tauri prerequisites ([Toolchain](#toolchain)). Building the Windows app **from a Mac** is a real, documented path — see [Windows app from macOS](#windows-app-from-macos).

## Quickstart

Point Vivicy at any project via `VIVICY_TARGET_ROOT` (absolute path). The target must hold the spec/data layout the factory reads: `docs/canonical/**`, `docs/architecture-map/architecture-map.yml`, `docs/baselines/*.json`, and `spec/development/` (issue index, progress ledger).

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

If `--target` / `VIVICY_TARGET_ROOT` is omitted, the app resolves the target in order: the project you picked in the UI (persisted in the runtime dir), then `VIVICY_TARGET_ROOT`, then the parent of the process working directory. The factory CLI accepts the legacy `NAIGHT_DEV_ROOT` alias for the env override.

### Try it end to end (no agents, no target needed)

The rehearsal exercises the **whole** chain against an isolated throwaway fixture with the real tooling and fake agents — a fast proof the factory is wired correctly:

```sh
node factory/cli.mjs rehearsal --dry
# -> REHEARSAL PASSED (11/11 stages), 0 UNCOVERED
```

## The two agents

The MVP loop runs two **distinct** agents so the reviewer never authored the code it reviews:

- **Implementer** — Claude Code (gate-first implementer).
- **Reviewer & fix** — Codex (independent review, runs its own review sub-agents).

The orchestrator (`factory/dev-loop.mjs`) invokes each agent CLI per issue as a **fresh conversation** (one issue = no carryover), re-runs the gate itself, commits green checkpoints, and moves done issues aside; on a gate still red after bounded retries it records a block and stops for a human. Lifecycle hooks (`factory/progress-emit.mjs`, `factory/progress-ensure-report.mjs`) emit mechanical progress events and inject each agent's actor/role; the agents emit semantic events through the progress MCP (`factory/progress-mcp.mjs`); a Stop hook backfills if an agent forgot to report.

## Models, quota, and settings

Policy: always run the latest model; the **thinking/effort level** is the tunable knob. Per-agent model and effort are chosen in the app's Settings dialog and flow to a run as `VIVICY_CLAUDE_*` / `VIVICY_CODEX_*` environment variables. Defaults pin the latest known ids/levels (implementer = Claude Opus at `xhigh`, reviewer = Codex at `high`).

When an agent hits a provider rate limit, the loop detects it from the failure itself (no usage API exists), waits out the quota window with bounded backoff, and surfaces per-agent quota state in the control plane's footer — never fabricated numbers.

Both agent CLIs run with isolated config (project config plus the progress MCP only, never the operator's personal global plugins).

## Language-agnostic

Nothing in the factory assumes a language or stack for the **target** project. The per-issue gate command is configurable (it defaults to `npm test`, but it is whatever the target's verification gate is), and the spec, issues, and architecture map are plain docs + JSON. Point Vivicy at a Rust crate, a Python service, a Go binary, or a monorepo — the loop, the map, and the gates are the same.

## Desktop app (Tauri)

Vivicy ships as a native desktop app for **macOS and Windows** in addition to the web app. Both share one codebase and one Next server: Vivicy's UI requires a live Node/Next runtime (its API routes spawn the agent CLIs via `child_process`, browse the filesystem, and stream the map/status), so the desktop app **cannot** be a static export. Instead it runs that exact Next server as a Tauri **sidecar** on a free localhost port, and the Tauri webview loads `http://127.0.0.1:<port>`. Tauri owns the sidecar's lifecycle: it spawns it on launch and kills it on quit, so no orphaned server is left behind.

In the desktop shell two affordances upgrade to native OS integration (the web build is unchanged and remains the fallback):

- **Folder picker** — a "Choose folder (native)" button opens the OS directory dialog (`@tauri-apps/plugin-dialog`) and posts the chosen path to `/api/project`, the same endpoint the web in-app browser uses.
- **CLI install** — when an agent CLI is missing, a "Run install" button runs the documented install command natively (`@tauri-apps/plugin-shell`), streaming its output inline. The shell allow-list (`src-tauri/capabilities/default.json`) fixes the exact command and arguments, so it can only run those two installs plus the Next sidecar — never an arbitrary shell.

### Toolchain

The desktop build needs the Rust toolchain and the Tauri system prerequisites (on macOS: Xcode command-line tools; on Windows: the MSVC build tools + WebView2, preinstalled on Windows 11). The Node/Tauri CLIs come from `npm ci`.

```sh
# Rust via rustup (recommended — required for the Windows-from-macOS cross-build,
# because rustup is what adds cross targets; Homebrew's standalone `rust` cannot):
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
```

A host-only macOS or Windows build also works with `brew install rust`, but only rustup can `rustup target add x86_64-pc-windows-msvc`, so use rustup if you intend to cross-build the Windows app from a Mac.

### Build and run (host OS)

```sh
npm ci
npm run tauri:dev      # native window + Next sidecar, hot-reloads on rebuilds
npm run tauri:build    # produces the installers under src-tauri/target/release/bundle/
```

`tauri:build` first runs `src-tauri/scripts/prepare-sidecar.mjs`, which builds the Next standalone server, stages it as a bundled resource, and downloads an official self-contained Node binary named `node-<target-triple>` for the build's target as the sidecar (so the app needs no system Node). The sidecar Node always matches the **target** OS/arch, not the build host: a Windows target stages the Windows `node.exe`, a macOS target stages the macOS `node`. On macOS this yields a `.app` and a `.dmg`; on Windows, an `.exe` (NSIS) and an `.msi`.

One headless caveat on macOS: the `.app` is built without a GUI, but the `.dmg` step drives the Finder/`hdiutil` to lay out the disk image, so it can fail or hang when there is no logged-in window server (a bare SSH/CI shell). The `.app` under `src-tauri/target/release/bundle/macos/` is still the real, runnable artifact; the `.dmg` is only the distributable wrapper. To skip it, build just the app target: `npm run tauri:build -- --bundles app`.

### Windows app from macOS

Yes — you can build the Windows installer on a Mac, the same way Electron's cross-packagers do, using Tauri's `cargo-xwin` runner (Tauri documents this as a convenience path; **CI on a real `windows-latest` runner remains the reliable, signed-quality path** — see below). The `tauri:build:windows` script wires it up:

```sh
# One-time prerequisites (macOS):
brew install nsis llvm                                   # NSIS installer maker + clang-cl/lld
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y   # rustup (brew rust can't add cross targets)
rustup target add x86_64-pc-windows-msvc                 # the Windows target std
cargo install --locked cargo-xwin                        # downloads the Windows SDK/CRT on first build

# Build (clang-cl from llvm must be on PATH):
export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
npm run tauri:build:windows
# → VIVICY_TARGET_TRIPLE=x86_64-pc-windows-msvc tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
# output: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

`prepare-sidecar.mjs` reads `VIVICY_TARGET_TRIPLE` (the script the npm command sets) and stages the **Windows** `node.exe` as `node-x86_64-pc-windows-msvc.exe`, so the cross-built app ships the correct Node runtime — not the host's macOS Node. `cargo-xwin` downloads the Windows SDK and CRT headers/libs on the first run (cached afterward), and `llvm`'s `clang-cl`/`lld-link` stand in for the MSVC toolchain. The MSI target needs Windows-only WiX, so the cross-build produces the NSIS `.exe` installer.

Cross-compiling is a "last resort" in Tauri's own words: it can break on toolchain/SDK mismatches that never appear on a native Windows build, and it cannot Authenticode-sign. For releases, prefer CI.

### Cross-OS builds in CI (the reliable path)

[`.github/workflows/desktop.yml`](.github/workflows/desktop.yml) builds **both** the macOS and Windows bundles natively on a `v*` tag (matrix: `macos-latest` + `windows-latest`) and attaches them to a draft release. The Windows leg runs on `windows-latest`, so its `.exe`/`.msi` are produced by the real MSVC toolchain — no cross-compilation caveats. This is the path to trust for distributable builds; `tauri:build:windows` is the local-from-Mac convenience for quick iteration.

## License

MIT © Tomy Spagnoletti Duval. See [LICENSE](./LICENSE).
