#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { cleanupTree } from "../factory/cleanup-tree.ts"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

// Never add .next: it is a reusable dev/build cache, not a per-run artifact.
const ARTIFACTS = ["test-results", "playwright-report"]

// The .next-e2e- prefix swept below is playwright.config's VIVICY_DIST_DIR naming — edit together.
function cleanArtifacts(): void {
  for (const rel of ARTIFACTS) {
    cleanupTree(resolve(REPO_ROOT, rel))
  }
  let entries: string[] = []
  try {
    entries = readdirSync(REPO_ROOT)
  } catch {
    entries = []
  }
  for (const name of entries) {
    if (name.startsWith(".next-e2e-")) {
      cleanupTree(resolve(REPO_ROOT, name))
    }
  }
  pruneTsconfigIncludes()
}

// Next appends every dist dir it serves to tsconfig.json's include and never removes it.
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
  } catch {}
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
