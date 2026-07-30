import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { MANAGED_TEMP_PREFIX } from "../lib/managed-block.ts"
import { AGENT_SKILLS_DIR } from "../lib/spec-kind.ts"
import { skillBundleRel, type SkillRef } from "./skill-id.ts"
import { hashBundle, type SkillBundlePin } from "./skill-pin.ts"

const CACHE_SUBDIR = "skill-bundles"
const HEAL_SCRATCH_PREFIX = "skill-heal-"

export function bundleCacheDir(runtimeDir: string): string {
  return resolve(runtimeDir, CACHE_SUBDIR)
}

export type HealRung = "cache" | "git" | "refetch"

export interface HealAttempt {
  rung: HealRung
  reason: string
}

export type HealOutcome = { ok: true; rung: HealRung } | { ok: false; attempts: HealAttempt[] }

export type RunInstall = (args: { repoRoot: string; source: string; skill: string }) => { code: number; output?: string }

export type GitSeam = (args: string[], envOverrides?: NodeJS.ProcessEnv) => { status: number; stderr: string }

export interface HealBundleArgs {
  repoRoot: string
  ref: SkillRef
  pin: SkillBundlePin
  runtimeDir: string
  runInstall: RunInstall
  git?: GitSeam
}

// The deposit that makes self-healing offline: published by one rename over a content-addressed name, so a killed copy leaves a temp nobody reads and a concurrent depositor of the same bytes is a no-op, never a half-populated entry.
export function cacheBundle(runtimeDir: string, pin: SkillBundlePin, bundleDir: string): boolean {
  const cacheDir = bundleCacheDir(runtimeDir)
  const dest = resolve(cacheDir, pin.bundle_hash)
  // An entry that does not hash to the name it is filed under is not the bundle it claims to be, and a restore would refuse it forever: the deposit replaces it instead of leaving the project permanently on the slower rungs.
  if (existsSync(dest)) {
    if (hashBundle(dest)?.bundle_hash === pin.bundle_hash) return true
    rmSync(dest, { recursive: true, force: true })
  }
  const temp = resolve(cacheDir, `${MANAGED_TEMP_PREFIX}${process.pid}.${pin.bundle_hash}`)
  try {
    mkdirSync(cacheDir, { recursive: true })
    rmSync(temp, { recursive: true, force: true })
    cpSync(bundleDir, temp, { recursive: true, verbatimSymlinks: true })
    renameSync(temp, dest)
    return true
  } catch {
    rmSync(temp, { recursive: true, force: true })
    return existsSync(dest)
  }
}

function removeQuietly(abs: string): void {
  try {
    rmSync(abs, { recursive: true, force: true })
  } catch {}
}

// Janitorial and total — it can never fail the pass that just ended, which is why every removal here is quiet. Three residues, all reachable only while this pass holds the stage lock: cache entries no pin references, the scratch trees a KILLED restore left behind (each holding a whole bundle copy), and a temp a killed publish left beside the bundles. An EMPTY keep-set is never authoritative for the cache: an unparseable or absent declaration would otherwise read as "cache nothing" and destroy the very bytes the next pass heals from, so that half waits until the project pins something again.
export function sweepRuntimeResidue(runtimeDir: string, repoRoot: string, keep: ReadonlySet<string>): void {
  const cacheDir = bundleCacheDir(runtimeDir)
  if (keep.size > 0) {
    for (const entry of readdirQuietly(cacheDir)) {
      if (!keep.has(entry)) removeQuietly(resolve(cacheDir, entry))
    }
  }
  for (const entry of readdirQuietly(runtimeDir)) {
    if (entry.startsWith(HEAL_SCRATCH_PREFIX)) removeQuietly(resolve(runtimeDir, entry))
  }
  const bundles = resolve(repoRoot, AGENT_SKILLS_DIR)
  for (const entry of readdirQuietly(bundles)) {
    if (entry.startsWith(MANAGED_TEMP_PREFIX)) removeQuietly(resolve(bundles, entry))
  }
}

function readdirQuietly(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function firstLine(text: string, max = 200): string {
  const line = text.trim().split("\n")[0] ?? ""
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function defaultGit(repoRoot: string): GitSeam {
  return (args, envOverrides = {}) => {
    const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", env: { ...process.env, ...envOverrides } })
    return { status: r.status ?? 1, stderr: r.stderr ?? "" }
  }
}

// The candidate's bytes are hashed BEFORE the target is touched, so a poisoned cache entry or a committed tamper can never replace a bundle: it is refused and the next rung runs. The publish itself is a copy into a temp beside the target, then one rename over it — POSIX cannot rename over a populated directory, and the rm-then-rename window costs nothing it cannot get back: every writer of this tree holds the skills stage lock, and what the rm destroys is bytes already judged NOT to be the pin, while the pinned ones are in the cache the next pass reads. The published bytes are hashed AGAIN, since the outcome this reports is "the bundle now matches its pin", which a truncated copy would otherwise claim falsely.
function publishBundle(target: string, candidate: string, pin: SkillBundlePin): string | null {
  const staged = hashBundle(candidate)
  if (staged === null) return "nothing was restored"
  if (staged.bundle_hash !== pin.bundle_hash) return "the restored bytes do not match the pin"
  const temp = resolve(dirname(target), `${MANAGED_TEMP_PREFIX}${process.pid}.${basename(target)}`)
  try {
    rmSync(temp, { recursive: true, force: true })
    mkdirSync(dirname(target), { recursive: true })
    cpSync(candidate, temp, { recursive: true, verbatimSymlinks: true })
    rmSync(target, { recursive: true, force: true })
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { recursive: true, force: true })
    return `could not write the bundle back (${error instanceof Error ? error.message : String(error)})`
  }
  return hashBundle(target)?.bundle_hash === pin.bundle_hash ? null : "the bundle on disk still does not match the pin after the restore"
}

// The absorption commits every installed bundle, so a clone that never held the cache still carries the pinned bytes in its own history: HEAD is read into a scratch work tree with its own index, which leaves the real index and working tree untouched and preserves file modes the pin does not carry.
function gitCandidate(repoRoot: string, bundleRel: string, scratch: string, git: GitSeam): { dir: string } | { reason: string } {
  const worktree = resolve(scratch, "head")
  mkdirSync(worktree, { recursive: true })
  const result = git(["--work-tree", worktree, "checkout", "HEAD", "--", bundleRel], { GIT_INDEX_FILE: resolve(scratch, "head-index") })
  if (result.status !== 0) {
    return { reason: `git holds no committed copy of ${bundleRel} (${firstLine(result.stderr) || "checkout refused"})` }
  }
  return { dir: resolve(worktree, bundleRel) }
}

function refetchCandidate(ref: SkillRef, bundleRel: string, scratch: string, runInstall: RunInstall): { dir: string } | { reason: string } {
  const fetchRoot = resolve(scratch, "refetch")
  mkdirSync(fetchRoot, { recursive: true })
  const result = runInstall({ repoRoot: fetchRoot, source: ref.source, skill: ref.skill })
  if ((result.code ?? 1) !== 0) {
    return { reason: `the skills CLI could not re-fetch ${ref.id} (${firstLine(result.output ?? "")})` }
  }
  return { dir: resolve(fetchRoot, bundleRel) }
}

// The ladder, in cost order: the machine-local cache (zero network), the repository's own history (zero network), then one re-fetch that is accepted ONLY if upstream still serves the pinned bytes. Every rung publishes through the same hash gate, so "healed" always means byte-identical to the pin — and when no rung can satisfy it the caller gets every rung's reason, because the owner has to act on the real one.
export function healBundle({ repoRoot, ref, pin, runtimeDir, runInstall, git }: HealBundleArgs): HealOutcome {
  const bundleRel = skillBundleRel(ref.skill)
  const target = resolve(repoRoot, bundleRel)
  const gitSeam = git ?? defaultGit(repoRoot)
  const attempts: HealAttempt[] = []
  mkdirSync(runtimeDir, { recursive: true })
  const scratch = mkdtempSync(resolve(runtimeDir, HEAL_SCRATCH_PREFIX))
  try {
    const rungs: Array<{ rung: HealRung; locate: () => { dir: string } | { reason: string } }> = [
      {
        rung: "cache",
        locate: () => {
          const cached = resolve(bundleCacheDir(runtimeDir), pin.bundle_hash)
          return existsSync(cached) ? { dir: cached } : { reason: "no cached copy of the pinned bundle on this machine" }
        },
      },
      { rung: "git", locate: () => gitCandidate(repoRoot, bundleRel, scratch, gitSeam) },
      { rung: "refetch", locate: () => refetchCandidate(ref, bundleRel, scratch, runInstall) },
    ]
    for (const { rung, locate } of rungs) {
      const located = locate()
      if ("reason" in located) {
        attempts.push({ rung, reason: located.reason })
        continue
      }
      const failure = publishBundle(target, located.dir, pin)
      if (failure !== null) {
        attempts.push({ rung, reason: failure })
        continue
      }
      // A heal that came from anywhere but the cache warms it, so the same drift never needs the network twice.
      if (rung !== "cache") cacheBundle(runtimeDir, pin, target)
      return { ok: true, rung }
    }
    return { ok: false, attempts }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
