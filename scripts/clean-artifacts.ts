#!/usr/bin/env node
// Remove transient test/build artifacts so a normal `npm test` / `npm run e2e`
// leaves the working tree clean. All paths here are gitignored; this script just
// keeps them off disk too. Two uses:
//
//   node scripts/clean-artifacts.ts              -> clean, exit 0 (the `clean` script)
//   node scripts/clean-artifacts.ts -- <cmd...>  -> run <cmd>, ALWAYS clean after,
//                                                    then exit with <cmd>'s code
//
// The wrapper form is how `test` / `e2e` auto-clean: cleanup runs even when the
// command fails, but the command's non-zero exit code is preserved so CI/gates
// still see the failure.
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Transient artifacts the app's test/build steps create. Each is already in
// .gitignore; listed once here so the `clean` script and the auto-clean wrapper
// agree. `.next` (the dev/build cache) is intentionally NOT included — it is a
// reusable cache, not a per-run artifact.
const ARTIFACTS = ["test-results", "playwright-report"]

// The e2e matrix spins up one Next dev server per (shape × browser), each writing
// its own dist dir `.next-e2e-<shape>-<browser>` (set via VIVICY_DIST_DIR in
// playwright.config). They're gitignored; remove every one so a run leaves the
// tree clean regardless of how many matrix projects ran.
function cleanArtifacts(): void {
  for (const rel of ARTIFACTS) {
    rmSync(resolve(REPO_ROOT, rel), { recursive: true, force: true })
  }
  let entries: string[] = []
  try {
    entries = readdirSync(REPO_ROOT)
  } catch {
    entries = []
  }
  for (const name of entries) {
    if (name.startsWith(".next-e2e-")) {
      rmSync(resolve(REPO_ROOT, name), { recursive: true, force: true })
    }
  }
  pruneTsconfigIncludes()
}

// The Next plugin auto-appends every dist dir it ever serves (`VIVICY_DIST_DIR`
// one-offs included) to tsconfig.json's `include` — and never removes them, so
// dead `.next-*` entries accrete forever. Prune the entries whose dir no longer
// exists, KEEPING `.next` and the official e2e matrix dirs (Next would re-add
// those on the next run; keeping them avoids a noisy tsconfig diff every time).
// Byte-preserving no-op when nothing is dead; a best-effort step (a malformed
// tsconfig is left untouched — the typecheck gate owns that failure, not clean).
const MATRIX_DIST_RE = /^\.next-e2e-(demo|empty|onboarding)-(chromium|firefox|webkit)-(desktop|mobile)$/

function pruneTsconfigIncludes(): void {
  const file = resolve(REPO_ROOT, "tsconfig.json")
  try {
    const raw = readFileSync(file, "utf8")
    const config = JSON.parse(raw) as { include?: string[] }
    if (!Array.isArray(config.include)) return
    const keep = config.include.filter((entry) => {
      const dist = /^(\.next[^/]*)\//.exec(entry)?.[1]
      if (!dist || dist === ".next" || MATRIX_DIST_RE.test(dist)) return true
      return existsSync(resolve(REPO_ROOT, dist))
    })
    if (keep.length === config.include.length) return
    config.include = keep
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  } catch {
    // Never let cleanup break the wrapped command's exit semantics.
  }
}

const argv = process.argv.slice(2)
const sep = argv.indexOf("--")

if (sep === -1) {
  // No command: just clean and exit 0.
  cleanArtifacts()
  process.exit(0)
}

// Wrapper form: run the command, clean unconditionally, preserve the exit code.
const [cmd, ...args] = argv.slice(sep + 1)
if (!cmd) {
  cleanArtifacts()
  process.exit(0)
}

const result = spawnSync(cmd, args, { stdio: "inherit", cwd: REPO_ROOT })
cleanArtifacts()

if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
// Preserve the command's exit code; a command killed by a signal exits non-zero
// (1) so a terminated run never looks green.
if (typeof result.status === "number") {
  process.exit(result.status)
}
process.exit(result.signal ? 1 : 0)
