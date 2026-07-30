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
    return `could not write the bundle back (${reasonOf(error)})`
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

// The one upstream touch this module knows how to make, shared by the ladder's last rung and by the update probe: `skills add` takes no ref, so it always serves LATEST and a scratch root is the only place that answer may land.
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

// AT MOST ONE upstream touch per pinned skill, and the fetch IS the probe; `newer` carries the CANDIDATE's own pin, which is what a caller that accepts it publishes and re-pins: `skills add` takes no ref and no registry endpoint exposes a version (measured), so the only comparable notion of "newer" is the bytes upstream serves now against the pin's own bundle hash. The candidate lands in a scratch that dies with this call and NEVER in the live bundle, so unaudited bytes cannot reach the project before the gate has judged them; a probe that could not run at all is one more `unavailable`, never an exception out of a pass that must always leave a terminal report.
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
  // A candidate with no SKILL.md is not a skill: the block's `<bundle>/SKILL.md` line is what every leg reads, so publishing one would break the project's own reference on a bundle that already works.
  if (candidate === null || candidate.files[SKILL_DOC_FILE] === undefined) {
    return { state: "unavailable", reason: `upstream served no ${skillDocRel(ref.skill)} for ${ref.id}` }
  }
  if (candidate.bundle_hash === pin.bundle_hash) return { state: "current" }
  return { state: "newer", pin: candidate, dir: located.dir }
}

// An accepted update rides the ladder's own gate — hashed before the bundle is touched, hashed again after the rename — and warms the cache with the bytes it published, so the new pin can self-heal offline from the very next pass.
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

// The ladder, in cost order: the machine-local cache (zero network), the repository's own history (zero network), then one re-fetch that is accepted ONLY if upstream still serves the pinned bytes. Every rung publishes through the same hash gate, so "healed" always means byte-identical to the pin — and when no rung can satisfy it the caller gets every rung's reason, because the owner has to act on the real one.
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
      // A heal that came from anywhere but the cache warms it, so the same drift never needs the network twice.
      if (rung !== "cache") cacheBundle(runtimeDir, pin, target)
      return { ok: true, rung }
    }
    return { ok: false, attempts }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}
