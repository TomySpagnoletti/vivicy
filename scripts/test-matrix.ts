#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
export const MATRIX_FILE = "test/TEST-MATRIX.md"
export const FINGERPRINT_RE = /^Reconciled fingerprint: `([0-9a-f]{64})` @ commit `([0-9a-f]{7,40}|unknown)`$/m

// Test files (.test/.spec) are deliberately excluded from the fingerprint — adding a test alone must not force a re-stamp.
const BEHAVIOR_DIRS = ["app", "components", "lib", "factory", "hooks", "scripts", "e2e"]
const BEHAVIOR_ROOT_FILES = ["playwright.config.ts", "vitest.config.ts", "vitest.setup.ts", "next.config.ts", "eslint.config.mjs", "package.json"]

// Regenerated gitignored artifacts must stay excluded from the fingerprint, or every rehearsal run would invalidate a freshly-stamped matrix.
const ARTIFACT_PATHS = ["factory/rehearsal/reports/"]

function isBehaviorFile(rel: string): boolean {
  if (/\.(test|spec)\.(ts|tsx)$/.test(rel)) return false
  if (ARTIFACT_PATHS.some((p) => rel.startsWith(p))) return false
  return /\.(ts|tsx|mjs|md|json)$/.test(rel)
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    const abs = path.join(dir, entry)
    if (statSync(abs).isDirectory()) walk(abs, out)
    else out.push(abs)
  }
}

export function computeBehaviorFingerprint(root = REPO_ROOT): string {
  const files: string[] = []
  for (const dir of BEHAVIOR_DIRS) {
    try {
      walk(path.join(root, dir), files)
    } catch {
      // A missing behavior dir is itself a behavior change; it shows up through the file list.
    }
  }
  const rels = files
    .map((abs) => path.relative(root, abs).split(path.sep).join("/"))
    .filter(isBehaviorFile)
  for (const rootFile of BEHAVIOR_ROOT_FILES) rels.push(rootFile)
  rels.sort()
  const hash = createHash("sha256")
  for (const rel of rels) {
    hash.update(rel)
    hash.update("\0")
    try {
      hash.update(readFileSync(path.join(root, rel)))
    } catch {
      hash.update("<missing>")
    }
    hash.update("\0")
  }
  return hash.digest("hex")
}

export function readStamp(root = REPO_ROOT): { fingerprint: string; commit: string } | null {
  const text = readFileSync(path.join(root, MATRIX_FILE), "utf8")
  const match = text.match(FINGERPRINT_RE)
  return match ? { fingerprint: match[1], commit: match[2] } : null
}

function headCommit(root: string): string {
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" })
  const hash = (r.stdout ?? "").trim()
  return r.status === 0 && /^[0-9a-f]{40}$/.test(hash) ? hash : "unknown"
}

export function changedBehaviorFilesSince(commit: string, root = REPO_ROOT): string[] {
  const changed = new Set<string>()
  if (commit !== "unknown") {
    const diff = spawnSync("git", ["diff", "--name-only", commit], { cwd: root, encoding: "utf8" })
    if (diff.status === 0) for (const line of diff.stdout.split("\n")) if (line.trim()) changed.add(line.trim())
  }
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })
  if (status.status === 0) for (const line of status.stdout.split("\n")) {
    const rel = line.slice(3).trim()
    if (rel) changed.add(rel)
  }
  return [...changed].filter((rel) => (BEHAVIOR_DIRS.some((d) => rel.startsWith(`${d}/`)) || BEHAVIOR_ROOT_FILES.includes(rel)) && isBehaviorFile(rel)).sort()
}

export function stampFingerprint(root = REPO_ROOT): string {
  const file = path.join(root, MATRIX_FILE)
  // Drop a pre-commit-hash era stamp line so the format upgrade never leaves two stamps.
  const text = readFileSync(file, "utf8").replace(/^Reconciled fingerprint: `[0-9a-f]{64}`\n/m, "")
  const fingerprint = computeBehaviorFingerprint(root)
  const line = `Reconciled fingerprint: \`${fingerprint}\` @ commit \`${headCommit(root)}\``
  const next = FINGERPRINT_RE.test(text)
    ? text.replace(FINGERPRINT_RE, line)
    : text.replace(/^(# .*\n)/, `$1\n${line}\n`)
  writeFileSync(file, next)
  return fingerprint
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--delta")) {
    const stamp = readStamp()
    if (!stamp) {
      console.error("no reconciliation stamp in test/TEST-MATRIX.md — run `npm run matrix:stamp` once first")
      process.exit(2)
    }
    if (computeBehaviorFingerprint() === stamp.fingerprint) {
      console.log("Matrix reconciled with the current tree (fingerprint match) — nothing to reconcile.")
      process.exit(0)
    }
    const changed = changedBehaviorFilesSince(stamp.commit)
    console.log(`Behavior files changed since the last matrix reconciliation (stamped @ ${stamp.commit}):`)
    if (changed.length === 0) console.log("(none via git — the change is outside git's view; diff your working tree manually)")
    for (const rel of changed) console.log(`- ${rel}`)
  } else {
    const fingerprint = stampFingerprint()
    console.log(`TEST-MATRIX.md stamped: ${fingerprint}`)
  }
}
