#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// .next is deliberately excluded here — it's a reusable dev/build cache, not a per-run artifact.
const ARTIFACTS = ["test-results", "playwright-report"]

// The e2e matrix writes one dist dir per shape×browser as .next-e2e-<shape>-<browser>, set via VIVICY_DIST_DIR in playwright.config.
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

// Next.js appends every dist dir it serves to tsconfig.json's include and never removes them; .next and the e2e matrix dirs are kept unconditionally (Next re-adds them) to avoid tsconfig diff noise.
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
  cleanArtifacts()
  process.exit(0)
}

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
if (typeof result.status === "number") {
  process.exit(result.status)
}
process.exit(result.signal ? 1 : 0)
