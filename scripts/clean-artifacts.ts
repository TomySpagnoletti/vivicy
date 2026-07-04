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
import { readdirSync, rmSync } from "node:fs"
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
