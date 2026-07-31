import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from "node:fs"
import { basename, dirname, resolve } from "node:path"

import { MANAGED_TEMP_PREFIX } from "../lib/managed-block.ts"
import { AGENT_SKILLS_DIR } from "../lib/spec-kind.ts"
import { skillBundleRel, skillDocRel, SKILL_DOC_FILE, type SkillRef } from "./skill-id.ts"
import { hashBundle, type SkillBundlePin } from "./skill-pin.ts"

const CACHE_SUBDIR = "skill-bundles"
const CANDIDATE_SCRATCH_PREFIX = "skill-candidate-"

export function bundleCacheDir(runtimeDir: string): string {
  return resolve(runtimeDir, CACHE_SUBDIR)
}

export type HealRung = "cache" | "git" | "refetch"

export interface HealAttempt {
  rung: HealRung
  reason: string
}

export type HealOutcome = { ok: true; rung: HealRung } | { ok: false; attempts: HealAttempt[] }

type UpstreamCandidate =
  { state: "unavailable"; reason: string } | { state: "current" } | { state: "newer"; pin: SkillBundlePin; dir: string }

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

interface UpstreamProbeArgs {
  ref: SkillRef
  pin: SkillBundlePin
  runtimeDir: string
  runInstall: RunInstall
}

export function cacheBundle(runtimeDir: string, pin: SkillBundlePin, bundleDir: string): boolean {
  const cacheDir = bundleCacheDir(runtimeDir)
  const dest = resolve(cacheDir, pin.bundle_hash)
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

// An EMPTY keep-set is never authoritative: an unparseable or absent declaration would read as "cache nothing" and destroy the bytes the next pass heals from.
export function sweepRuntimeResidue(runtimeDir: string, repoRoot: string, keep: ReadonlySet<string>): void {
  const cacheDir = bundleCacheDir(runtimeDir)
  if (keep.size > 0) {
    for (const entry of readdirQuietly(cacheDir)) {
      if (!keep.has(entry)) removeQuietly(resolve(cacheDir, entry))
    }
  }
  for (const entry of readdirQuietly(runtimeDir)) {
    if (entry.startsWith(CANDIDATE_SCRATCH_PREFIX)) removeQuietly(resolve(runtimeDir, entry))
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

// Never call this outside the skills stage lock: POSIX cannot rename over a populated directory, so the rm-then-rename window is only safe while nothing else writes this tree.
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
    return `could not write the bundle back (${reasonOf(error)})`
  }
  return hashBundle(target)?.bundle_hash === pin.bundle_hash ? null : "the bundle on disk still does not match the pin after the restore"
}

function gitCandidate(repoRoot: string, bundleRel: string, scratch: string, git: GitSeam): { dir: string } | { reason: string } {
  const worktree = resolve(scratch, "head")
  mkdirSync(worktree, { recursive: true })
  const result = git(["--work-tree", worktree, "checkout", "HEAD", "--", bundleRel], { GIT_INDEX_FILE: resolve(scratch, "head-index") })
  if (result.status !== 0) {
    return { reason: `git holds no committed copy of ${bundleRel} (${firstLine(result.stderr) || "checkout refused"})` }
  }
  return { dir: resolve(worktree, bundleRel) }
}

// Never fetch into the live bundle: `skills add` takes no ref and always serves latest, so its answer may only land in a scratch.
function fetchUpstream(ref: SkillRef, bundleRel: string, scratch: string, runInstall: RunInstall): { dir: string } | { reason: string } {
  const fetchRoot = resolve(scratch, "upstream")
  mkdirSync(fetchRoot, { recursive: true })
  const result = runInstall({ repoRoot: fetchRoot, source: ref.source, skill: ref.skill })
  if ((result.code ?? 1) !== 0) {
    return { reason: `the skills CLI could not re-fetch ${ref.id} (${firstLine(result.output ?? "")})` }
  }
  return { dir: resolve(fetchRoot, bundleRel) }
}

function openScratch(runtimeDir: string): string {
  mkdirSync(runtimeDir, { recursive: true })
  return mkdtempSync(resolve(runtimeDir, CANDIDATE_SCRATCH_PREFIX))
}

// AT MOST ONE upstream touch per pinned skill, and never throw: a probe that could not run is one more `unavailable`, or the pass leaves no terminal report.
export async function withUpstreamCandidate<T>(args: UpstreamProbeArgs, use: (candidate: UpstreamCandidate) => Promise<T>): Promise<T> {
  let scratch: string
  try {
    scratch = openScratch(args.runtimeDir)
  } catch (error) {
    return use({ state: "unavailable", reason: `no scratch tree for the upstream check (${reasonOf(error)})` })
  }
  try {
    return await use(probeUpstream(args, scratch))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function probeUpstream({ ref, pin, runInstall }: UpstreamProbeArgs, scratch: string): UpstreamCandidate {
  let located: { dir: string } | { reason: string }
  try {
    located = fetchUpstream(ref, skillBundleRel(ref.skill), scratch, runInstall)
  } catch (error) {
    return { state: "unavailable", reason: `the upstream check could not run (${reasonOf(error)})` }
  }
  if ("reason" in located) return { state: "unavailable", reason: located.reason }
  const candidate = hashBundle(located.dir)
  // Never publish a candidate without SKILL.md: the skills block cites `<bundle>/SKILL.md`, so it would break that reference on a bundle that already works.
  if (candidate === null || candidate.files[SKILL_DOC_FILE] === undefined) {
    return { state: "unavailable", reason: `upstream served no ${skillDocRel(ref.skill)} for ${ref.id}` }
  }
  if (candidate.bundle_hash === pin.bundle_hash) return { state: "current" }
  return { state: "newer", pin: candidate, dir: located.dir }
}

export function publishCandidate({
  repoRoot,
  ref,
  pin,
  dir,
  runtimeDir,
}: {
  repoRoot: string
  ref: SkillRef
  pin: SkillBundlePin
  dir: string
  runtimeDir: string
}): string | null {
  const target = resolve(repoRoot, skillBundleRel(ref.skill))
  const failure = publishBundle(target, dir, pin)
  if (failure === null) cacheBundle(runtimeDir, pin, target)
  return failure
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function healBundle({ repoRoot, ref, pin, runtimeDir, runInstall, git }: HealBundleArgs): HealOutcome {
  const bundleRel = skillBundleRel(ref.skill)
  const target = resolve(repoRoot, bundleRel)
  const gitSeam = git ?? defaultGit(repoRoot)
  const attempts: HealAttempt[] = []
  const scratch = openScratch(runtimeDir)
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
      { rung: "refetch", locate: () => fetchUpstream(ref, bundleRel, scratch, runInstall) },
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
      if (rung !== "cache") cacheBundle(runtimeDir, pin, target)
      return { ok: true, rung }
    }
    return { ok: false, attempts }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
