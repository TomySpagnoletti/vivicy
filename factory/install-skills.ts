#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts"
import type { AgentIssue, LegConfig } from "./agent-spawn.ts"
import { legDepsForTarget } from "./leg-deps.ts"
import { notify } from "./notify.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import type { Leg, LegResult } from "./dev-loop.ts"
import { ensureLocalGitIdentity, findFrozenManifest } from "./extract-issues.ts"
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts"
import { AGENT_SKILLS_DIR, PER_AGENT_SKILL_DIRS, SKILLS_CLI_LOCKFILE } from "../lib/spec-kind.ts"
import { countForm, countOf } from "../lib/count-form.ts"
import { normalizeSkillId, parseSkillId, SKILL_DOC_FILE, skillBundleRel, skillDocRel, type SkillRef } from "./skill-id.ts"
import {
  bundleDrift,
  hashBundle,
  pinnedBundles,
  PROJECT_SKILLS_SOURCE,
  readSkillDeclarations,
  writeSkillDeclarations,
  type BundleDrift,
  type SkillBundlePin,
  type SkillDeclaration,
} from "./skill-pin.ts"
import {
  cacheBundle,
  healBundle,
  sweepRuntimeResidue,
  type GitSeam,
  type HealAttempt,
  type HealBundleArgs,
  type HealOutcome,
  type RunInstall,
} from "./skill-heal.ts"
import { PROJECT_CONFIG_FILENAME } from "./project-config.ts"
import {
  MANAGED_MARKDOWN_FILES,
  MANAGED_TEMP_PREFIX,
  managedWriteFailureReason,
  resolvedManagedTarget,
  SKILLS_MARKERS,
  writeManaged,
  type ManagedSpec,
} from "../lib/managed-block.ts"
import { pruneGitkeeps, SKELETON_DIRS } from "../lib/skeleton.ts"
import { claimStageLock, SKILLS_LOCK_FILE, stageLockHolder, type HeldStageLock } from "../lib/stage-lock.ts"

export const SKILLS_REPORT_REL = ".vivicy/development/reports/skills-report.json"
const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json"
const SKELETON_GITKEEPS = SKELETON_DIRS.map((dir) => `${dir}/.gitkeep`)

// Everything the stage COULD write. It is the pre-stage snapshot's reading only — never the absorption's pathspec, which is what this run actually wrote: `.agents/skills` and `.claude/skills` are also where an owner keeps their OWN skills, and the two governance documents plus vivicy.json carry owner bytes the stage merges into.
const SKILLS_STAGE_PATHS: readonly string[] = [
  ...MANAGED_MARKDOWN_FILES,
  "vivicy.json",
  SKILLS_CLI_LOCKFILE,
  SKILLS_REPORT_REL,
  AGENT_SKILLS_DIR,
  ...PER_AGENT_SKILL_DIRS,
  ...SKELETON_GITKEEPS,
]
export const MAX_PROJECT_SKILLS = 6

// Priority/label only — never a security gate; the audits are the gate.
export const OFFICIAL_VENDOR_OWNERS: ReadonlySet<string> = new Set([
  "vercel-labs",
  "vercel",
  "supabase",
  "anthropics",
  "shadcn",
  "shadcn-ui",
  "openai",
  "stripe",
  "cloudflare",
  "expo",
  "prisma",
  "tailwindlabs",
  "remotion-dev",
  "microsoft",
  "google",
  "googleapis",
  "aws",
  "awslabs",
  "azure",
  "getsentry",
  "firebase",
  "mongodb",
  "redis",
  "docker",
  "github",
  "huggingface",
  "langchain-ai",
  "pydantic",
  "astral-sh",
  "denoland",
  "oven-sh",
  "sveltejs",
  "vuejs",
  "nuxt",
  "angular",
  "facebook",
  "vitejs",
  "playwright",
  "nodejs",
  "golang",
  "rust-lang",
  "python",
  "dotnet",
  "apple",
  "flutter",
  "kubernetes",
  "hashicorp",
  "elastic",
  "grafana",
  "rails",
  "laravel",
  "django",
  "spring-projects",
  "nestjs",
  "tanstack",
  "apollographql",
  "netlify",
  "twilio",
  "clerk",
])

export type SkillRejectReason =
  | "red_audit"
  | "too_many_warnings"
  | "unaudited"
  | "cap_exceeded"
  | "name_collision"
  | "invalid_id"
  | "install_failed"
  | "not_installed"
  | "remove_failed"
  | "heal_failed"
export type SkillsPhase = "selecting" | "auditing" | "installing" | "removing" | "healing" | "green" | "failed" | "skipped"

interface SkillCandidate extends SkillRef {
  name: string
  reason: string
  official: boolean
}

export interface SkillAuditRecord {
  provider: string
  status: string
}

// found:false covers both unreachable and 404 alike — the UNVERIFIED gate (and any test fetchAudit double) must treat them identically.
export interface SkillAuditFetch {
  found: boolean
  audits: SkillAuditRecord[]
}

export interface InstalledSkillEntry {
  id: string
  source: string
  skill: string
  name: string
  official: boolean
  security_waived: boolean
  audits: SkillAuditRecord[]
  reason: string
}

export interface RejectedSkillEntry {
  id: string
  reason: SkillRejectReason
  detail?: string
}

export interface SkillsReport {
  phase: SkillsPhase
  selection_baseline_id: string | null
  mode: "auto" | "explicit" | "remove" | "maintain"
  installed: InstalledSkillEntry[]
  added: string[]
  removed: string[]
  verified: string[]
  healed: string[]
  rejected: RejectedSkillEntry[]
  summary: string
  updated_at: string
}

interface SpawnScoutArgs {
  repoRoot: string
  manifestPath: string
  baselineId: string
  resultRel: string
  attempt: number
  feedback: string | null
  installed: readonly InstalledSkillEntry[]
}

export interface InstallSkillsOptions {
  repoRoot?: string
  ids?: string[]
  cfg?: Record<string, unknown>
  promptsDir?: string
  env?: NodeJS.ProcessEnv
  spawnScout?: (args: SpawnScoutArgs) => Promise<LegResult | void>
  fetchAudit?: (args: { source: string; skill: string }) => Promise<SkillAuditFetch>
  runInstall?: (args: { repoRoot: string; source: string; skill: string }) => { code: number; output?: string }
  emitReport?: (report: SkillsReport, repoRoot: string) => void
  findBaseline?: (repoRoot: string) => { manifestPath: string; baselineId: string } | null
  now?: () => Date
}

const NO_TARGET_MESSAGE =
  "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project, or pass options.repoRoot."

export class SkillsConfigError extends Error {}

export class SkillsLockError extends Error {}

// The stage claims the lock ITSELF, where the writes are: vivicy.json, the two governance documents, the report and the absorption commit are one read-modify-write over the target, so every client — the supervisor's own child, the app's detached spawn, the CLI, Vivi — inherits one refusal instead of each claiming for itself. The clients still PROBE the same file to refuse fast; this claim is what decides a dead heat.
function claimSkillsStage(runtimeDir: string): HeldStageLock {
  const lock = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
  if (lock) return lock
  const holder = stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)
  throw new SkillsLockError(`a skills install is already in flight${holder === null ? "" : ` (pid ${holder})`}`)
}

// VIVICY_RUNTIME_DIR is already the PROJECT-scoped runtime dir every client hands its children (lib/control.ts `devEnv`, factory/cli.ts `childEnv`), so both sides address one lock file. A caller that hands none gets the project's own gitignored runtime dir — project-scoped by construction, and never a cwd-derived one, which would fork the lock between a supervisor started in the target and an app started in its own root.
function stageRuntimeDir(repoRoot: string, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.VIVICY_RUNTIME_DIR
  return fromEnv && fromEnv.trim().length > 0 ? resolve(fromEnv) : resolve(repoRoot, ".vivicy-runtime")
}

export function auditVerdict(audit: SkillAuditFetch): "safe" | "red_audit" | "too_many_warnings" | "unaudited" {
  if (!audit.found) return "unaudited"
  const fails = audit.audits.filter((a) => a.status === "fail").length
  if (fails > 0) return "red_audit"
  const warns = audit.audits.filter((a) => a.status === "warn").length
  if (warns > 1) return "too_many_warnings"
  return "safe"
}

// The ONE derivation of how much room a project has left, over the installed SET — so the cap, the scout's budget and the sentence the scout reads cannot state different numbers.
function remainingSlots(installed: readonly InstalledSkillEntry[]): number {
  return Math.max(0, MAX_PROJECT_SKILLS - installed.length)
}

// The ONE predicate for "this baseline still owes an automatic skill selection", read by the supervisor before spawning the stage and by the stage itself to skip — so the gate and the skip can never drift apart. `selection_baseline_id` is written by the AUTO path alone, which is what makes an explicit install or a removal incapable of cancelling scouting the project has not had: a settled auto stage is the only thing that can settle it.
export function skillsStageNeeded(baseline: { baselineId: string } | null, report: { selection_baseline_id?: unknown } | null): boolean {
  if (!baseline) return false
  return report?.selection_baseline_id !== baseline.baselineId
}

export async function installSkills(options: InstallSkillsOptions = {}): Promise<SkillsReport> {
  const repoRoot = options.repoRoot
  if (!repoRoot) throw new SkillsConfigError(NO_TARGET_MESSAGE)
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const emitReport = options.emitReport ?? defaultEmitReport
  const fetchAudit = options.fetchAudit ?? defaultFetchAudit
  const runInstall = options.runInstall ?? defaultRunInstall
  const findBaseline = options.findBaseline ?? findFrozenManifest
  const explicitIds = (options.ids ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  const mode: "auto" | "explicit" = explicitIds.length > 0 ? "explicit" : "auto"
  const allowUnsafe = env.VIVICY_ALLOW_UNSAFE_SKILLS === "1"

  const baseline = findBaseline(repoRoot)
  if (mode === "auto" && !baseline) {
    throw new SkillsConfigError(
      'install-skills: AUTO mode requires an active frozen baseline (.vivicy/baselines/*.json with status "frozen" and not superseded). Freeze the canonical docs (extraction does this) before the skills stage, or pass --ids for an explicit install.'
    )
  }

  const tree = openStageTree(repoRoot, "install", env)
  try {
    const priorReport = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_REL)) as Partial<SkillsReport> | null
    const report: SkillsReport = {
      phase: "selecting",
      selection_baseline_id: priorSelectionBaselineId(priorReport),
      mode,
      installed: projectInstalledSet(repoRoot, priorReport),
      added: [],
      removed: [],
      verified: [],
      healed: [],
      rejected: [],
      summary: "",
      updated_at: "",
    }
    const emit = (): void => {
      report.updated_at = now().toISOString()
      emitReport(report, repoRoot)
    }

    if (mode === "auto" && !skillsStageNeeded(baseline, priorReport)) {
      const failures = writeSkillsBlock(tree, report.installed)
      if (failures.length > 0) return blockWriteFailed(report, failures, emit)
      report.phase = "skipped"
      report.summary = `skills stage already settled for baseline ${report.selection_baseline_id}; nothing to do. A new frozen baseline re-runs the automatic selection; use --ids to add a specific skill.`
      emit()
      return report
    }

    // Every COUNT and every budget reads the installed SET, never `installedSkillIds`, whose raw ids the set deliberately drops when they name no skill: an owner typo in the skills declaration would otherwise make the cap, the scout's budget and the report disagree — and a 5-skill project would fire the at-capacity gate, settle the baseline and kill its own scouting while the summary announced 5/6. The raw id set answers exactly one kind of question, MEMBERSHIP, and never how many.
    const alreadyInstalled = installedSkillIds(repoRoot, priorReport)
    // The scout's own budget, settled BEFORE the leg is spawned rather than discovered by discarding its proposals afterwards.
    const slots = remainingSlots(report.installed)
    const atCapacity = mode === "auto" && slots === 0
    report.summary = atCapacity
      ? `project already holds all ${MAX_PROJECT_SKILLS} skill slots; no selection to run`
      : mode === "auto"
        ? "scouting project skills from the frozen canonical docs"
        : `validating ${countOf(explicitIds.length, "explicitly requested skill id", "explicitly requested skill ids")}`
    emit()

    let candidates: SkillCandidate[]
    if (mode === "explicit") {
      candidates = []
      const seen = new Set<string>()
      for (const raw of explicitIds) {
        const ref = normalizeSkillId(raw)
        if (!ref) {
          report.rejected.push({ id: raw, reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" })
          continue
        }
        if (seen.has(ref.id)) continue
        seen.add(ref.id)
        candidates.push({ ...ref, name: ref.skill, reason: "explicitly requested", official: OFFICIAL_VENDOR_OWNERS.has(ref.owner) })
      }
    } else if (atCapacity) {
      // Not a refusal and not a skip: the selection has nothing to choose. Spawning the leg would burn an agent run whose every proposal the cap already refuses.
      candidates = []
    } else {
      const spawnScout = options.spawnScout ?? makeDefaultSpawnScout(options)
      const selection = await runScoutSelection({
        repoRoot,
        spawnScout,
        manifestPath: baseline!.manifestPath,
        baselineId: baseline!.baselineId,
        installed: report.installed,
      })
      if (!selection.ok) {
        report.phase = "failed"
        report.summary = `skill scout produced no valid result after a bounded re-prompt: ${selection.problems.join("; ")}`
        emit()
        return report
      }
      candidates = selection.candidates
    }

    candidates = candidates.filter((c) => !alreadyInstalled.has(c.id))
    if (mode === "auto") {
      candidates = [...candidates.filter((c) => c.official), ...candidates.filter((c) => !c.official)]
    }
    candidates = withoutNameCollisions(candidates, report)
    const accepted = candidates.slice(0, slots)
    for (const c of candidates.slice(slots)) {
      report.rejected.push({
        id: c.id,
        reason: "cap_exceeded",
        detail: `project already has ${countOf(report.installed.length, "skill", "skills")}; the installed set may never exceed ${MAX_PROJECT_SKILLS} total`,
      })
    }

    report.phase = "auditing"
    report.summary = `auditing ${countOf(accepted.length, "candidate skill", "candidate skills")} against skills.sh security audits`
    emit()
    const toInstall: Array<SkillCandidate & { security_waived: boolean; audits: SkillAuditRecord[]; waiveReason?: SkillRejectReason }> = []
    for (const c of accepted) {
      const audit = await fetchAudit({ source: c.source, skill: c.skill })
      const verdict = auditVerdict(audit)
      if (verdict === "safe") {
        toInstall.push({ ...c, security_waived: false, audits: audit.audits })
      } else if (allowUnsafe) {
        toInstall.push({ ...c, security_waived: true, audits: audit.audits, waiveReason: verdict })
      } else {
        report.rejected.push({ id: c.id, reason: verdict, detail: auditDetail(audit, verdict) })
      }
    }

    report.phase = "installing"
    report.summary = `installing ${countOf(toInstall.length, "skill", "skills")} at the repository level via the skills CLI`
    emit()
    const installedNow: InstalledSkillEntry[] = []
    const pins: SkillDeclaration[] = []
    for (const c of toInstall) {
      recordSkillWrite(tree, c.skill)
      const r = runInstall({ repoRoot, source: c.source, skill: c.skill })
      if ((r.code ?? 1) !== 0) {
        report.rejected.push({ id: c.id, reason: "install_failed", detail: tail(r.output) })
        continue
      }
      // The pin is taken from the bytes that just landed, before anything else can touch them, and cached machine-locally in the same breath — a pin whose bytes were never captured could only ever self-heal over the network.
      const pin = hashBundle(resolve(repoRoot, skillBundleRel(c.skill)))
      if (pin === null || pin.files[SKILL_DOC_FILE] === undefined) {
        report.rejected.push({
          id: c.id,
          reason: "install_failed",
          detail: `the skills CLI reported success but left no ${skillDocRel(c.skill)} in the target project, so there is nothing to pin`,
        })
        continue
      }
      cacheBundle(tree.runtimeDir, pin, resolve(repoRoot, skillBundleRel(c.skill)))
      pins.push({ id: c.id, pin })
      installedNow.push({
        id: c.id,
        source: c.source,
        skill: c.skill,
        name: c.name,
        official: c.official,
        security_waived: c.security_waived,
        audits: c.audits.map((a) => ({ provider: a.provider, status: a.status })),
        reason: c.security_waived ? (c.waiveReason ?? c.reason) : c.reason,
      })
    }

    report.added = installedNow.map((e) => e.id)
    if (pins.length > 0) mergeSkillPins(tree, pins)
    report.installed = projectInstalledSet(repoRoot, priorReport, { installed: installedNow })
    const failures = writeSkillsBlock(tree, report.installed)
    if (failures.length > 0) return blockWriteFailed(report, failures, emit)

    report.phase = "green"
    if (mode === "auto") report.selection_baseline_id = baseline!.baselineId
    report.summary =
      `skills stage green: ${report.added.length} installed, ${report.rejected.length} rejected this run; project total ${report.installed.length}/${MAX_PROJECT_SKILLS}` +
      (atCapacity
        ? " — every slot was already filled, so no selection ran; remove a skill to free one"
        : report.installed.length === 0 && report.rejected.length === 0
          ? " (zero skills is a legitimate outcome)"
          : "")
    emit()
    return report
  } finally {
    settleStageTree(tree)
  }
}

// One bundle directory per NAME, whatever vendor published it: `.agents/skills/<name>` is the on-disk primary key, so a second vendor's same-named skill would overwrite the first's bundle and removing either would orphan the other. Refused rather than installed, naming the id that holds the name — and the run's own acceptances hold names too, so two colliding candidates in ONE selection cannot both land. Order decides the winner, which is why the official-first pass runs before this one.
function withoutNameCollisions(candidates: readonly SkillCandidate[], report: SkillsReport): SkillCandidate[] {
  const holders = new Map<string, string>(report.installed.map((entry) => [entry.skill, entry.id]))
  const kept: SkillCandidate[] = []
  for (const candidate of candidates) {
    const holder = holders.get(candidate.skill)
    if (holder === undefined) {
      holders.set(candidate.skill, candidate.id)
      kept.push(candidate)
      continue
    }
    report.rejected.push({
      id: candidate.id,
      reason: "name_collision",
      detail: `the name "${candidate.skill}" is already taken by ${holder}; ${skillBundleRel(candidate.skill)} holds one skill, so keep one of the two`,
    })
  }
  return kept
}

export interface RemoveSkillsOptions {
  repoRoot?: string
  ids?: string[]
  env?: NodeJS.ProcessEnv
  runRemove?: (args: { repoRoot: string; source: string; skill: string }) => { code: number; output?: string }
  emitReport?: (report: SkillsReport, repoRoot: string) => void
  now?: () => Date
}

export async function removeSkills(options: RemoveSkillsOptions = {}): Promise<SkillsReport> {
  const repoRoot = options.repoRoot
  if (!repoRoot) throw new SkillsConfigError(NO_TARGET_MESSAGE)
  const ids = (options.ids ?? []).map((s) => s.trim()).filter((s) => s.length > 0)
  if (ids.length === 0) {
    throw new SkillsConfigError("remove requires at least one skill id (owner/repo@skill or a skills.sh URL)")
  }
  const now = options.now ?? (() => new Date())
  const emitReport = options.emitReport ?? defaultEmitReport
  const runRemove = options.runRemove ?? defaultRunRemove

  const tree = openStageTree(repoRoot, "remove", options.env ?? process.env)
  try {
    const priorReport = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_REL)) as Partial<SkillsReport> | null
    const installedIds = installedSkillIds(repoRoot, priorReport)

    const report: SkillsReport = {
      phase: "removing",
      selection_baseline_id: priorSelectionBaselineId(priorReport),
      mode: "remove",
      installed: projectInstalledSet(repoRoot, priorReport),
      added: [],
      removed: [],
      verified: [],
      healed: [],
      rejected: [],
      summary: `removing ${countOf(ids.length, "skill", "skills")}`,
      updated_at: "",
    }
    const emit = (): void => {
      report.updated_at = now().toISOString()
      emitReport(report, repoRoot)
    }
    emit()

    const toDrop = new Set<string>()
    for (const raw of ids) {
      const ref = normalizeSkillId(raw)
      if (!ref) {
        report.rejected.push({ id: raw, reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" })
        continue
      }
      if (toDrop.has(ref.id)) continue
      if (!installedIds.has(ref.id)) {
        report.rejected.push({
          id: ref.id,
          reason: "not_installed",
          detail: "this skill is not part of the project's installed set (the vivicy.json skills declaration / the skills report)",
        })
        continue
      }
      recordSkillWrite(tree, ref.skill)
      const r = runRemove({ repoRoot, source: ref.source, skill: ref.skill })
      if ((r.code ?? 1) !== 0) {
        report.rejected.push({ id: ref.id, reason: "remove_failed", detail: tail(r.output) })
        continue
      }
      toDrop.add(ref.id)
      report.removed.push(ref.id)
    }

    if (toDrop.size > 0) dropSkillDeclarations(tree, toDrop)
    report.installed = projectInstalledSet(repoRoot, priorReport, { removed: toDrop })
    const failures = writeSkillsBlock(tree, report.installed)
    if (failures.length > 0) return blockWriteFailed(report, failures, emit)

    report.phase = "green"
    report.summary = `skills remove green: ${report.removed.length} removed, ${report.rejected.length} refused this run; project total ${report.installed.length}/${MAX_PROJECT_SKILLS}`
    emit()
    return report
  } finally {
    settleStageTree(tree)
  }
}

export interface MaintainSkillsOptions {
  repoRoot?: string
  env?: NodeJS.ProcessEnv
  runInstall?: RunInstall
  git?: GitSeam
  heal?: (args: HealBundleArgs) => HealOutcome
  emitReport?: (report: SkillsReport, repoRoot: string) => void
  now?: () => Date
}

// The owner's third rule: between passes, bytes ≠ pin with no update ordered is RESTORED automatically — no question, no red — the way the managed governance files renormalize when a project opens. It runs at every supervisor start, spawns no leg and asks no LLM, and it is deliberately write-free when everything verifies: a clean pass emits no report, no notification and no commit, so the steady state costs the project nothing and the last selection's own record survives on every surface.
export function maintainSkills(options: MaintainSkillsOptions = {}): SkillsReport {
  const repoRoot = options.repoRoot
  if (!repoRoot) throw new SkillsConfigError(NO_TARGET_MESSAGE)
  const env = options.env ?? process.env
  const now = options.now ?? (() => new Date())
  const emitReport = options.emitReport ?? defaultEmitReport
  const runInstall = options.runInstall ?? defaultRunInstall
  const heal = options.heal ?? healBundle

  const report: SkillsReport = {
    phase: "green",
    selection_baseline_id: null,
    mode: "maintain",
    installed: [],
    added: [],
    removed: [],
    verified: [],
    healed: [],
    rejected: [],
    summary: "",
    updated_at: "",
  }
  const pinned = pinnedBundles(readSkillDeclarations(repoRoot))
  if (pinned.length === 0) {
    report.summary = `no pinned skill bundles to verify — ${PROJECT_SKILLS_SOURCE} declares none`
    return report
  }

  let tree: StageTree
  try {
    tree = openStageTree(repoRoot, "maintain", env)
  } catch (error) {
    // A stage already in flight IS the writer of these bytes: verifying mid-install would read a half-written bundle and "heal" it back over the installer. The next supervisor start asks again, so this is never the owner's problem and never a notification.
    if (!(error instanceof SkillsLockError)) throw error
    report.summary = `skills maintenance deferred: ${error.message}`
    return report
  }
  try {
    const priorReport = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_REL)) as Partial<SkillsReport> | null
    report.selection_baseline_id = priorSelectionBaselineId(priorReport)
    report.installed = projectInstalledSet(repoRoot, priorReport)
    // A refusal the SELECTION recorded — a red audit, a name collision — is a standing fact the owner still has to act on, so a verification pass carries it forward instead of wiping the surface that shows it; its own restore failures replace only the previous pass's.
    report.rejected = standingRejections(priorReport)
    const emit = (): void => {
      report.updated_at = now().toISOString()
      emitReport(report, repoRoot)
    }

    // Re-read under the lock: the declarations that decided this pass runs at all were read before the claim, and an installer that published a new pin in that window would otherwise be healed back to the bytes it just replaced.
    const drifted: Array<{ ref: SkillRef; pin: SkillBundlePin; drift: BundleDrift; abs: string }> = []
    for (const { ref, pin } of pinnedBundles(readSkillDeclarations(repoRoot))) {
      const abs = resolve(repoRoot, skillBundleRel(ref.skill))
      const drift = bundleDrift(pin, hashBundle(abs))
      if (drift === null) report.verified.push(ref.id)
      else drifted.push({ ref, pin, drift, abs })
    }

    // The in-flight phase is published for a drift the project has not already given up on; a repeat of a failure it already exhausted every rung on would write it only to write the identical terminal state again, once per supervisor start.
    let announced = false
    if (drifted.length > 0) {
      if (!repeatsPriorFailure(priorReport, drifted)) {
        report.phase = "healing"
        report.summary = `restoring ${countOf(drifted.length, "skill bundle", "skill bundles")} whose bytes no longer match the pin`
        emit()
        announced = true
      }
      for (const { ref, pin, drift, abs } of drifted) {
        recordHealedBundle(tree, ref.skill)
        // A restore that could not even RUN — an unwritable runtime dir, no git on PATH — is one more reason the bundle is not there, never an exception out of a pass that must always leave a terminal report behind.
        let failure: string
        try {
          const outcome = heal({ repoRoot, ref, pin, runtimeDir: tree.runtimeDir, runInstall, git: options.git })
          if (outcome.ok) {
            report.healed.push(ref.id)
            continue
          }
          failure = healFailureDetail(drift, abs, outcome.attempts)
        } catch (error) {
          failure = `${driftedFiles(drift, abs)}; the restore could not run (${error instanceof Error ? error.message : String(error)})`
        }
        forgetHealedBundle(tree, ref.skill)
        report.rejected.push({ id: ref.id, reason: "heal_failed", detail: failure })
      }
    }
    report.phase = report.rejected.some((entry) => entry.reason === "heal_failed") ? "failed" : "green"
    report.summary = maintenanceSummary(report)
    // A pass that ANNOUNCED work always publishes how it ended: byte-equality may suppress a record that says the same thing, never a phase TRANSITION, or the report keeps claiming work in progress that finished — the sidebar greyed, the stage pinned running, and the owner's own click refused for the staleness window.
    if (announced || maintenanceWorthPublishing(priorReport, report)) emit()
    return report
  } finally {
    settleStageTree(tree)
  }
}

// Everything the prior report still says about skills the project has a problem with, minus the restore failures this pass re-decides for itself.
function standingRejections(priorReport: Partial<SkillsReport> | null): RejectedSkillEntry[] {
  const rejected = Array.isArray(priorReport?.rejected) ? priorReport.rejected : []
  return rejected
    .filter((entry): entry is RejectedSkillEntry => Boolean(entry) && typeof entry === "object" && typeof entry.id === "string")
    .filter((entry) => entry.reason !== "heal_failed")
    .map((entry) =>
      entry.detail === undefined ? { id: entry.id, reason: entry.reason } : { id: entry.id, reason: entry.reason, detail: entry.detail }
    )
}

// The drift this pass found is exactly the one a previous verification already exhausted every rung on: the retry still runs (nothing else can ever repair it without a human), but it has nothing new to announce.
function repeatsPriorFailure(priorReport: Partial<SkillsReport> | null, drifted: readonly { ref: SkillRef }[]): boolean {
  if (priorReport?.mode !== "maintain") return false
  const rejected = Array.isArray(priorReport.rejected) ? priorReport.rejected : []
  const gaveUpOn = new Set(rejected.filter((entry) => entry?.reason === "heal_failed").map((entry) => entry.id))
  return gaveUpOn.size === drifted.length && drifted.every(({ ref }) => gaveUpOn.has(ref.id))
}

// This pass runs at EVERY supervisor start, so what it publishes has to be new or it publishes nothing — one commit and one error notification per start, for as long as a bundle stayed broken, is what the naive version costs. Two clauses: over a record a previous verification left, it writes only what DIFFERS from it (a repeated unhealable bundle is silent, a cleared failure is not); over a SELECTION's record, it writes only when it has something of its own — a restore or a failure — so a project where nothing drifted keeps the selection's own summary and counts on every surface. `updated_at` is the one field that always differs, so it is what the comparison ignores rather than what it reads.
function maintenanceWorthPublishing(priorReport: Partial<SkillsReport> | null, report: SkillsReport): boolean {
  const strip = (value: Partial<SkillsReport>): string => JSON.stringify({ ...value, updated_at: "" })
  if (priorReport?.mode === "maintain") return strip(priorReport) !== strip(report)
  return report.healed.length > 0 || report.rejected.some((entry) => entry.reason === "heal_failed")
}

// The cause the owner reads, and it must be the real one: a directory that cannot be READ is not a directory that is GONE, and a pin whose own hash disagrees with the manifest it carries was edited by hand rather than drifted.
function driftedFiles(drift: BundleDrift, bundleAbs: string): string {
  if (drift.missing) {
    return existsSync(bundleAbs) ? "the bundle is on disk but could not be read" : "the bundle is gone from the project"
  }
  return drift.changed.length === 0
    ? "every file matches the pin's own manifest but not its bundle hash — the pin itself looks hand-edited"
    : `${countOf(drift.changed.length, "file differs", "files differ")} from the pin (${drift.changed.join(", ")})`
}

// Every rung's own reason, in the order they were tried: the owner acts on the real cause — an upstream deletion is a different move from an empty cache.
function healFailureDetail(drift: BundleDrift, bundleAbs: string, attempts: readonly HealAttempt[]): string {
  const tried = attempts.map((attempt) => `${attempt.rung}: ${attempt.reason}`).join("; ")
  return `${driftedFiles(drift, bundleAbs)}; no restore path could reproduce the pinned bytes — ${tried}`
}

// One sentence in the order the owner cares about: what is still broken, what was repaired, what was already whole.
function maintenanceSummary(report: SkillsReport): string {
  const unhealable = report.rejected.filter((entry) => entry.reason === "heal_failed")
  const parts: string[] = []
  if (unhealable.length > 0) {
    parts.push(
      `${countOf(unhealable.length, "bundle", "bundles")} could NOT be restored (${unhealable.map((entry) => entry.id).join(", ")})`
    )
  }
  if (report.healed.length > 0) {
    parts.push(`${countOf(report.healed.length, "bundle", "bundles")} restored to the pinned bytes (${report.healed.join(", ")})`)
  }
  // Named only when there is something to name, or when it is the whole story — "0 bundles verified" beside the one that broke is noise.
  if (report.verified.length > 0 || parts.length === 0) {
    parts.push(`${countOf(report.verified.length, "bundle", "bundles")} verified unchanged`)
  }
  const head = unhealable.length > 0 ? "skills maintenance failed" : "skills maintenance green"
  const tail =
    unhealable.length > 0
      ? ` — re-install ${countForm(unhealable.length, "it", "them")} or drop ${countForm(unhealable.length, "it", "them")} from ${PROJECT_SKILLS_SOURCE}; the build continues without ${countForm(unhealable.length, "it", "them")}`
      : ""
  return `${head}: ${parts.join(", ")}${tail}`
}

function defaultRunRemove({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }): {
  code: number
  output?: string
} {
  const viaCli = spawnSync("npx", ["-y", "skills", "remove", skill, "-y"], { cwd: repoRoot, encoding: "utf8", env: process.env })
  if ((viaCli.status ?? 1) === 0) {
    return { code: 0, output: `${viaCli.stdout ?? ""}\n${viaCli.stderr ?? ""}`.trim() }
  }
  const skillDir = resolve(repoRoot, skillBundleRel(skill))
  if (!existsSync(skillDir)) {
    return { code: 1, output: `skills CLI could not remove "${skill}" (${source}) and ${skillDir} does not exist` }
  }
  try {
    rmSync(skillDir, { recursive: true, force: true })
    pruneDanglingSkillLinks(repoRoot)
    return { code: 0, output: `removed ${skillDir} directly (skills CLI remove unavailable)` }
  } catch (error) {
    return { code: 1, output: `failed to remove ${skillDir}: ${error instanceof Error ? error.message : String(error)}` }
  }
}

function pruneDanglingSkillLinks(repoRoot: string): void {
  for (const rel of PER_AGENT_SKILL_DIRS) {
    const dir = realpathOrNull(resolve(repoRoot, rel))
    if (dir === null) continue
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry)
      try {
        if (lstatSync(abs).isSymbolicLink() && !existsSync(abs)) rmSync(abs, { force: true })
      } catch {}
    }
  }
}

type StageMode = "install" | "remove" | "maintain"

const STAGE_COMMIT_MESSAGE: Record<StageMode, string> = {
  install:
    "skills: absorb the project-skills stage writes\n\n" +
    "What this run wrote — the stage report, and for each skill it installed the bundle, its per-agent links, the pinned vivicy.json skills entry and the skills block in AGENTS.md and CLAUDE.md — " +
    "committed mechanically so the dev loop starts on a clean tree and every per-issue worktree, cut from HEAD, carries the skills. No human git step.",
  remove:
    "skills: absorb the project-skills removal\n\n" +
    "What this run wrote — the stage report, and for each skill it removed the deleted bundle and per-agent links, the shrunken vivicy.json skills declaration and skills block in both governance documents — " +
    "committed mechanically so the dev loop starts on a clean tree. No human git step.",
  maintain:
    "skills: absorb the project-skills verification pass\n\n" +
    "What this pass wrote — the stage report, and the bundle of every skill it restored to the bytes vivicy.json pins (from the local cache, this repository's own history or an exact re-fetch) — " +
    "committed mechanically so the dev loop starts on a clean tree and every per-issue worktree carries the pinned skills. No human git step.",
}

// One run's own git footprint, plus the exclusive claim that makes it one run. `baseline` is everything under the stage's declared paths that was ALREADY dirty when the run opened: those bytes are the owner's manuscript, and the clean-tree refusal on them is correct behavior, not something Vivicy may commit away. `written` accumulates what this run actually wrote, so a path the stage merely COULD write is never staged.
interface StageTree {
  repoRoot: string
  runtimeDir: string
  owns: boolean
  baseline: Set<string>
  written: Set<string>
  skills: Set<string>
  mode: StageMode
  lock: HeldStageLock
}

// The lock rides the tree's own lifecycle — claimed before the pre-stage snapshot, released by `settleStageTree`, which every entry point already reaches from a `finally` on the return AND the throw path, so the claim cannot leak whatever the stage does. A claim whose own tree never opens is released here, since no `finally` covers it yet.
function openStageTree(repoRoot: string, mode: StageMode, env: NodeJS.ProcessEnv): StageTree {
  const runtimeDir = stageRuntimeDir(repoRoot, env)
  const lock = claimSkillsStage(runtimeDir)
  try {
    const owns = ownsGitRepo(repoRoot)
    return {
      repoRoot,
      runtimeDir,
      owns,
      baseline: new Set(owns ? dirtyPaths(repoRoot, stageSnapshotPaths(repoRoot)) : []),
      // Written on every run: the report by emit(), the keeps by the pruneGitkeeps that rides it.
      written: new Set([SKILLS_REPORT_REL, ...SKELETON_GITKEEPS]),
      skills: new Set(),
      mode,
      lock,
    }
  } catch (error) {
    lock.release()
    throw error
  }
}

// The snapshot must read the SAME key space the causal record writes, or the two narrowings stop intersecting: a governance document symlinked to another in-repo file is dirty under the target's name, which the declared paths never mention, and the owner's uncommitted bytes there would land in the absorption commit.
function stageSnapshotPaths(repoRoot: string): string[] {
  const resolved = MANAGED_MARKDOWN_FILES.map((rel) => repoRelativeWrite(repoRoot, resolvedManagedTarget(resolve(repoRoot, rel)), rel))
  return [...new Set([...SKILLS_STAGE_PATHS, ...resolved])]
}

// Recorded BEFORE the write, never after: a crash in between must leave the path staged-and-committable rather than dirty, which is the whole point of the causal record.
function recordWrite(tree: StageTree, rel: string): void {
  tree.written.add(rel)
}

// The one legitimate withdrawal: a write that THREW published nothing, so the path is not this run's — and leaving it recorded would stage whatever the owner does to that file next.
function forgetWrite(tree: StageTree, rel: string): void {
  tree.written.delete(rel)
}

// Recorded BEFORE the skills CLI runs, since it is the writer either way: a half-written bundle a failed install left behind is the stage's own residue, and leaving it uncommitted would re-open the very refusal this absorption closes. Every skill reaching here came out of `parseSkillId`, so its name is a plain segment by construction.
function recordSkillWrite(tree: StageTree, skill: string): void {
  tree.skills.add(skill)
  recordWrite(tree, SKILLS_CLI_LOCKFILE)
  recordWrite(tree, skillBundleRel(skill))
  for (const dir of PER_AGENT_SKILL_DIRS) recordWrite(tree, `${dir}/${skill}`)
}

// A heal writes the bundle directory and NOTHING else: the per-agent links point at that directory and survive the rename, and the skills CLI lockfile is never touched — recording either would put an owner's concurrent edit there into Vivicy's own commit. The restored paths also LEAVE the pre-stage snapshot: a pinned bundle's bytes are machine-owned, the restore replaces the whole directory whatever state it was in, and keeping them out of the absorption would leave Vivicy's own bytes dirty — refusing the owner's next Run and blaming them for it. Recorded BEFORE the restore, so a crash mid-rename leaves the bundle staged rather than dirty.
function recordHealedBundle(tree: StageTree, skill: string): void {
  const rel = skillBundleRel(skill)
  recordWrite(tree, rel)
  for (const path of [...tree.baseline]) {
    if (path === rel || path.startsWith(`${rel}/`)) tree.baseline.delete(path)
  }
}

// What is still on disk for a bundle no rung could restore is the DRIFT. Committing it would put a tamper in HEAD under a message that claims a restore, destroy the history rung the next pass reads (the drift would then BE the committed copy, so the bundle is unhealable offline forever), and ship the tampered skill to every worktree cut from HEAD. Withdrawing the write RECORD is the whole withdrawal: the absorption stages what this run wrote and only ever SUBTRACTS the pre-stage snapshot from it, so a path that is no longer recorded cannot be staged whatever the snapshot says about it.
function forgetHealedBundle(tree: StageTree, skill: string): void {
  forgetWrite(tree, skillBundleRel(skill))
}

function runGit(repoRoot: string, args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8", input })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

// A target nested under a FOREIGN parent repo resolves to that parent's top level; committing there would write the owner's unrelated history, so the absorber only ever acts on a repo the target itself roots. Both sides are realpath'd because macOS spells /tmp two ways.
function ownsGitRepo(repoRoot: string): boolean {
  const top = runGit(repoRoot, ["rev-parse", "--show-toplevel"])
  if (top.status !== 0) return false
  const resolved = realpathOrNull(top.stdout.trim())
  return resolved !== null && resolved === realpathOrNull(repoRoot)
}

// -uall because an untracked DIRECTORY otherwise arrives as one entry that `git add` re-globs, swallowing whatever appeared under it since the read; -z because a skill bundle may ship any filename and plain porcelain quotes those.
function dirtyPaths(repoRoot: string, pathspecs: readonly string[]): string[] {
  if (pathspecs.length === 0) return []
  const status = runGit(repoRoot, ["status", "--porcelain", "-z", "--untracked-files=all", "--", ...pathspecs])
  return status.status === 0 ? porcelainPaths(status.stdout) : []
}

// Rename and copy entries carry their ORIGIN path in the next NUL field; both sides need staging.
function porcelainPaths(stdout: string): string[] {
  const fields = stdout.split("\0")
  const paths: string[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (field.length < 4) continue
    paths.push(field.slice(3))
    const state = field.slice(0, 2)
    if (state.includes("R") || state.includes("C")) {
      i += 1
      if (fields[i]) paths.push(fields[i])
    }
  }
  return paths
}

// `npx skills add` is a third-party writer and the absorption commits whatever it left: an ABSOLUTE link would put this machine's paths in the owner's history and dangle in every clone and every per-issue worktree. Only the links THIS run wrote are considered — an owner's own skill link in the same directory is not Vivicy's to rewrite — and a link out of the repo, or onto nothing, is left alone since relativizing either would still not resolve.
function relativizeSkillLinks(tree: StageTree): string[] {
  const root = realpathOrNull(tree.repoRoot)
  if (root === null) return []
  const relativized: string[] = []
  for (const rel of PER_AGENT_SKILL_DIRS) {
    const dir = realpathOrNull(resolve(root, rel))
    if (dir === null) continue
    for (const skill of tree.skills) {
      const link = resolve(dir, skill)
      try {
        if (!lstatSync(link).isSymbolicLink() || !isAbsolute(readlinkSync(link))) continue
        const target = realpathSync(link)
        const inside = relative(root, target)
        if (inside.length === 0 || inside.startsWith("..") || isAbsolute(inside)) continue
        const temp = resolve(dir, `${MANAGED_TEMP_PREFIX}${process.pid}.${skill}`)
        rmSync(temp, { force: true })
        symlinkSync(relative(dir, target), temp)
        renameSync(temp, link)
        relativized.push(`${rel}/${skill}`)
      } catch {}
    }
  }
  return relativized
}

// The stage's last act, reached from a `finally` so a throw closes it too: one commit over what THIS run wrote and the owner had not already touched, so the dev loop's clean-tree gate is not refused for bytes Vivicy wrote unasked and a worktree cut from HEAD carries the skills. Absorbing nothing is the normal steady state — no dirty path of ours means no commit at all, so a replayed run adds no empty commit. The cache sweep is janitorial and can never fail the pass that just ended; the lock is released last, after the commit that ends the mutation.
function settleStageTree(tree: StageTree): void {
  try {
    absorbStageWrites(tree)
  } finally {
    sweepRuntimeResidue(tree.runtimeDir, tree.repoRoot, pinnedBundleHashes(tree.repoRoot))
    tree.lock.release()
  }
}

// Read back from vivicy.json rather than accumulated in memory, so the sweep keeps exactly what the file now pins. An empty set is NEVER authoritative — an unparseable or absent declaration would otherwise read as "cache nothing" and destroy the very bytes the next pass heals from — so the sweep does nothing until a pin exists again.
function pinnedBundleHashes(repoRoot: string): Set<string> {
  return new Set(pinnedBundles(readSkillDeclarations(repoRoot)).map((entry) => entry.pin.bundle_hash))
}

function absorbStageWrites(tree: StageTree): void {
  const relativized = relativizeSkillLinks(tree)
  if (relativized.length > 0) {
    process.stderr.write(
      `install-skills: rewrote ${countOf(relativized.length, "per-agent skill link", "per-agent skill links")} to a repo-relative target before committing (${relativized.join(", ")})\n`
    )
  }
  if (!tree.owns) return
  const dirty = dirtyPaths(tree.repoRoot, [...tree.written])
  const mine = dirty.filter((path) => !tree.baseline.has(path))
  const theirs = dirty.length - mine.length
  if (theirs > 0) {
    process.stderr.write(
      `install-skills: left ${countOf(theirs, "path", "paths")} uncommitted — already modified before this run, so they are the owner's to commit, never the skills stage's\n`
    )
  }
  if (mine.length === 0) return
  ensureLocalGitIdentity(tree.repoRoot)
  // Both commands take the pathspec through stdin, never argv (a bundle's file count has no upper bound) and never `-A`/a bare commit (`git add -A` would swallow the owner's in-flight work, and a pathspec-less commit would sweep in whatever they had already staged — including the .env.example lib/scaffold.ts stages deliberately without committing).
  const spec = mine.join("\0")
  const add = runGit(tree.repoRoot, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], spec)
  const message = STAGE_COMMIT_MESSAGE[tree.mode]
  const commit =
    add.status === 0
      ? runGit(tree.repoRoot, ["commit", "--only", "--pathspec-from-file=-", "--pathspec-file-nul", "-m", message], spec)
      : null
  const empty = commit !== null && commit.status !== 0 && /nothing to commit|no changes added/i.test(`${commit.stdout}\n${commit.stderr}`)
  const failed = add.status !== 0 ? add : commit !== null && commit.status !== 0 && !empty ? commit : null
  if (failed) {
    process.stderr.write(
      `install-skills: could not absorb the project-skills stage writes (${countOf(mine.length, "path", "paths")}); the dev loop will refuse this dirty tree: ${`${failed.stderr}\n${failed.stdout}`.trim()}\n`
    )
    return
  }
  if (empty) return
  const roots = [...new Set(mine.map((path) => path.split("/")[0]))].sort()
  process.stderr.write(
    `install-skills: absorbed ${countOf(mine.length, "path", "paths")} of the project-skills stage into one commit (${roots.join(", ")})\n`
  )
}

function dropSkillDeclarations(tree: StageTree, drop: Set<string>): void {
  if (!existsSync(resolve(tree.repoRoot, PROJECT_CONFIG_FILENAME))) return
  const kept = readSkillDeclarations(tree.repoRoot).filter((declaration) => !drop.has(declaration.id))
  recordWrite(tree, PROJECT_CONFIG_FILENAME)
  if (!writeSkillDeclarations(tree.repoRoot, kept)) forgetWrite(tree, PROJECT_CONFIG_FILENAME)
}

async function runScoutSelection({
  repoRoot,
  spawnScout,
  manifestPath,
  baselineId,
  installed,
}: {
  repoRoot: string
  spawnScout: (args: SpawnScoutArgs) => Promise<LegResult | void>
  manifestPath: string
  baselineId: string
  installed: readonly InstalledSkillEntry[]
}): Promise<{ ok: true; candidates: SkillCandidate[] } | { ok: false; problems: string[] }> {
  let feedback: string | null = null
  let problems: string[] = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    clearScoutResult(repoRoot)
    await spawnScout({ repoRoot, manifestPath, baselineId, resultRel: SCOUT_RESULT_REL, attempt, feedback, installed })
    const raw = readJsonOrNull(resolve(repoRoot, SCOUT_RESULT_REL))
    clearScoutResult(repoRoot)
    const validated = validateScoutResult(raw)
    if (validated.ok) return validated
    problems = validated.problems
    feedback = problems.join("; ")
  }
  return { ok: false, problems }
}

function validateScoutResult(raw: unknown): { ok: true; candidates: SkillCandidate[] } | { ok: false; problems: string[] } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, problems: [`no valid JSON result file was written (expected { "skills": [...] } at ${SCOUT_RESULT_REL})`] }
  }
  const skills = (raw as { skills?: unknown }).skills
  if (!Array.isArray(skills)) {
    return { ok: false, problems: ['the result JSON has no "skills" array'] }
  }
  if (skills.length > MAX_PROJECT_SKILLS) {
    return { ok: false, problems: [`${skills.length} skills proposed; the maximum is ${MAX_PROJECT_SKILLS} (fewer is better)`] }
  }
  const problems: string[] = []
  const candidates: SkillCandidate[] = []
  const seen = new Set<string>()
  for (const entry of skills) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined
    const ref = typeof id === "string" ? parseSkillId(id.trim()) : null
    if (!ref) {
      problems.push(`invalid skill id ${JSON.stringify(id)} (must be owner/repo@skill, exactly as seen in \`npx skills find\` output)`)
      continue
    }
    if (seen.has(ref.id)) continue
    seen.add(ref.id)
    const name = String((entry as { name?: unknown }).name ?? ref.skill).trim() || ref.skill
    const reason = String((entry as { reason?: unknown }).reason ?? "").trim()
    // The reason is not decoration: it becomes the skill's line in the block every leg reads, and the sidebar card. An unjustified candidate is a selection nobody can audit, so it is re-prompted rather than installed with an empty line.
    if (reason.length === 0) {
      problems.push(`${ref.id} has an empty "reason" — every skill must state the project need it covers, in one line`)
      continue
    }
    candidates.push({ ...ref, name, reason, official: OFFICIAL_VENDOR_OWNERS.has(ref.owner) })
  }
  if (problems.length > 0) return { ok: false, problems }
  return { ok: true, candidates }
}

function clearScoutResult(repoRoot: string): void {
  rmSync(resolve(repoRoot, SCOUT_RESULT_REL), { force: true })
}

function makeDefaultSpawnScout(options: InstallSkillsOptions): (args: SpawnScoutArgs) => Promise<LegResult | void> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) }
  const legs = resolveAgentLegs(process.env)
  const implementer: Leg = legs?.implementer ?? {
    actor: "claude",
    role: "implementer",
    provider: "claude",
    model: CLI_DEFAULTS.claude.model,
    effort: CLI_DEFAULTS.claude.effort,
    fast: false,
  }
  const leg: Leg = { ...implementer, role: "skill-scout" }
  return async ({ repoRoot, manifestPath, baselineId, resultRel, attempt, feedback, installed }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot }
    const issue: AgentIssue = {
      id: TRANSCRIPT_DIRS.autoskills,
      transcript_dir: TRANSCRIPT_DIRS.autoskills,
      graph_refs: ["node:skills"],
      path: SKILLS_REPORT_REL,
    }
    const context = scoutContext({ manifestPath, baselineId, resultRel, attempt, feedback, installed })
    const deps = legDepsForTarget(repoRoot, context)
    return leg.provider === "codex"
      ? runCodexLeg(leg, issue, legCfg as LegConfig, deps)
      : runClaudeLeg(leg, issue, legCfg as LegConfig, deps)
  }
}

// Everything the scout cannot derive from the canonical: where the corpus is, where its answer goes, and the three constraints the orchestrator will enforce on it afterwards — what the project already has, how many slots that leaves, and the audit gate. Told here rather than discovered by having its proposals discarded. The budget is DERIVED from the very set printed above it, never handed in beside it, so two adjacent lines cannot state different arithmetic.
export function scoutContext({
  manifestPath,
  baselineId,
  resultRel,
  attempt,
  feedback,
  installed,
}: {
  manifestPath: string
  baselineId: string
  resultRel: string
  attempt: number
  feedback: string | null
  installed: readonly InstalledSkillEntry[]
}): string {
  return (
    `\n\n---\n\n## Skill scouting context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). The canonical corpus it pins under \`.vivicy/canonical/**\` is your ONLY source of truth about the project.\n` +
    `- Write your JSON result — and nothing else — to \`${resultRel}\`.\n` +
    (installed.length === 0
      ? `- This project has NO skills installed yet: all ${MAX_PROJECT_SKILLS} slots are free.\n`
      : `- Already installed (${installed.length}/${MAX_PROJECT_SKILLS} slots taken): ${installed.map((entry) => `\`${entry.id}\``).join(", ")}. Never propose one of these again — a re-proposal is discarded — and never propose a different vendor's skill whose name (the part after \`@\`) matches one of theirs: \`${AGENT_SKILLS_DIR}/<name>\` holds ONE skill, so the orchestrator refuses a name collision.\n`) +
    `- Propose AT MOST ${countOf(remainingSlots(installed), "skill", "skills")}: ${MAX_PROJECT_SKILLS} is the project TOTAL across every run, not a per-run budget, and ${countOf(installed.length, "slot is", "slots are")} already taken. Fewer is better; zero is valid.\n` +
    `- Every skill you propose is then checked against the skills.sh security audits and REFUSED — never installed — when any audit fails, more than one warns, or no audit exists at all. Prefer skills that a first-party vendor publishes and that the registry actually audits; a skill nobody audited is a skill this project will not get.\n` +
    `- Every entry needs a non-empty one-line \`reason\` naming the canonical need it covers; one missing reason invalidates your whole result.\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback
      ? `\n### What was INVALID last time\n\nYour previous result was rejected by the orchestrator's strict validation. Fix exactly this and rewrite the result file:\n\n\`\`\`text\n${feedback}\n\`\`\`\n`
      : "")
  )
}

async function defaultFetchAudit({ source, skill }: { source: string; skill: string }): Promise<SkillAuditFetch> {
  try {
    const res = await fetch(`https://skills.sh/api/v1/skills/audit/${source}/${skill}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    })
    if (!res.ok) return { found: false, audits: [] }
    const body = (await res.json()) as { audits?: unknown }
    const audits = Array.isArray(body?.audits)
      ? body.audits
          .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
          .map((a) => ({ provider: String(a.provider ?? "unknown"), status: String(a.status ?? "") }))
      : []
    return { found: true, audits }
  } catch {
    return { found: false, audits: [] }
  }
}

// Installs at .agents/skills/<skill> with per-agent symlinks (.claude/skills, .codex/skills) — defaultRunRemove's fallback and pruneDanglingSkillLinks assume this exact layout.
function defaultRunInstall({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }): {
  code: number
  output?: string
} {
  const r = spawnSync("npx", ["-y", "skills", "add", source, "--skill", skill, "-y"], { cwd: repoRoot, encoding: "utf8", env: process.env })
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() }
}

// A green stage that kept a candidate OUT — a red security audit, the project cap, an install that failed — is the owner's to fix and re-run; a green that installed what it chose has nothing for them to do and stays silent. A successful self-heal is exactly as silent, like a managed file renormalizing: only a bundle no restore path could reproduce needs a hand, and it names the skill and the action rather than the stage. The rich report summary already counts the drops.
export function skillsNotification(
  report: SkillsReport
): { level: "info" | "success" | "warning" | "error"; stage: string; event: string; message: string } | null {
  const unhealable = (report.rejected ?? []).filter((entry) => entry.reason === "heal_failed").map((entry) => entry.id)
  if (unhealable.length > 0) {
    return {
      level: "error",
      stage: "SK",
      event: "heal_failed",
      message:
        `${countOf(unhealable.length, "project skill no longer matches", "project skills no longer match")} the bytes this project pinned, ` +
        `and no restore path could reproduce ${countForm(unhealable.length, "it", "them")} (${unhealable.join(", ")}) — ` +
        `re-install ${countForm(unhealable.length, "it", "them")} or drop ${countForm(unhealable.length, "it", "them")} from ${PROJECT_SKILLS_SOURCE}; the build runs without ${countForm(unhealable.length, "it", "them")}`,
    }
  }
  if (report.phase === "failed") {
    return { level: "error", stage: "SK", event: "skills_failed", message: "project skills stage failed" }
  }
  if (report.phase !== "green" || (report.rejected?.length ?? 0) === 0) return null
  return {
    level: "warning",
    stage: "SK",
    event: "skills_findings",
    message: report.summary || "the skills stage kept a candidate skill out of the project",
  }
}

function defaultEmitReport(report: SkillsReport, repoRoot: string): void {
  const abs = resolve(repoRoot, SKILLS_REPORT_REL)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  pruneGitkeeps(repoRoot)
  const mapped = skillsNotification(report)
  if (mapped) notify(mapped)
}

export interface SkillBlockEntry {
  id: string
  skill: string
  name: string
  official: boolean
  reason: string
}

// The bundle path is the leg's ONE actionable instruction — auto-discovery may be off in the agent CLI, a path never is.
function skillBullet(entry: SkillBlockEntry): string {
  return (
    `- **${entry.name}** (\`${entry.id}\`, ${entry.official ? "official" : "community"}) — \`${skillDocRel(entry.skill)}\`` +
    (entry.reason ? ` — ${entry.reason}` : "")
  )
}

export function buildSkillsBlock(entries: readonly SkillBlockEntry[]): string {
  const bullets = entries.length > 0 ? entries.map(skillBullet) : ["_No project skills are currently installed._"]
  return [
    SKILLS_MARKERS.begin,
    "## Project skills",
    "",
    "Vivicy installed these agent skills at the repository level, under `.agents/skills/` (with per-agent symlinks). Both the IMPLEMENTER and the REVIEWER MUST consult and apply the relevant skill whenever their work touches its domain — a skill listed here is part of this project's development contract, not optional reading.",
    "",
    "Each bullet names the skill's `SKILL.md`: READ that file before working in its domain, rather than relying on automatic skill discovery.",
    "",
    ...bullets,
    SKILLS_MARKERS.end,
  ].join("\n")
}

// A governance document the stage could not write, named with the reason the owner has to act on.
interface BlockWriteFailure {
  file: string
  reason: string
}

// A document the owner deleted is recreated by the stage under this head rather than skipped: the block is what a leg reads, and the project open puts the method block back into it at the next selection.
const SKILLS_DOC_HEAD = "# Agent instructions"

// The block is a projection of the report's installed set, so the two surfaces cannot state different things, and it rides the SAME engine and the SAME file set as the method block (lib/managed-block.ts): a byte splice over the owner's raw bytes, damaged markers repaired, UTF-16/32 refused untouched, an owner's `CLAUDE.md -> AGENTS.md` symlink kept, mode preserved, published by one rename. Both documents, because two CLIs read two files and a brownfield CLAUDE.md that points nowhere would otherwise never learn the project has skills. Write-if-different is the engine's, and the causal record is taken from inside it, on the one path that publishes — then withdrawn when that path threw, since a refused write published nothing and a recorded path an owner dirties mid-run would ride Vivicy's commit.
function writeSkillsBlock(tree: StageTree, entries: readonly SkillBlockEntry[]): BlockWriteFailure[] {
  const block = buildSkillsBlock(entries)
  const spec: ManagedSpec = { block, template: `${SKILLS_DOC_HEAD}\n\n${block}\n`, markers: SKILLS_MARKERS }
  const failures: BlockWriteFailure[] = []
  for (const rel of MANAGED_MARKDOWN_FILES) {
    const abs = resolve(tree.repoRoot, rel)
    const current = readFileOrNull(abs)
    // Never CREATE a block for a project with no skills: the stage declares what is installed, it does not stamp an empty section into a document that never carried one — residue of a damaged block still counts as carrying it, so the engine can clean it.
    if (entries.length === 0 && !(current?.includes(SKILLS_MARKERS.begin) || current?.includes(SKILLS_MARKERS.end))) continue
    // The withdrawal has to name the key the record took — the RESOLVED target, which for a symlinked document is not `rel` — or a failed write leaves the published path in the pathspec and the absorption commits whatever the owner does to it next.
    const recorded: { key: string | null } = { key: null }
    try {
      writeManaged(abs, spec, (published) => {
        recorded.key = repoRelativeWrite(tree.repoRoot, published, rel)
        recordWrite(tree, recorded.key)
      })
    } catch (error) {
      if (recorded.key !== null) forgetWrite(tree, recorded.key)
      failures.push({ file: rel, reason: managedWriteFailureReason(error, abs) })
    }
  }
  return failures
}

function readFileOrNull(abs: string): Buffer | null {
  try {
    return readFileSync(abs)
  } catch {
    return null
  }
}

// The record follows the BYTES, not the name: a managed document that is a symlink publishes into the file it points at, and a pathspec naming the unchanged link would leave the write the stage really made dirty.
function repoRelativeWrite(repoRoot: string, published: string, fallback: string): string {
  const inside = relative(repoRoot, published)
  return inside.length > 0 && !inside.startsWith("..") && !isAbsolute(inside) ? inside : fallback
}

// The skills are installed and declared, but a leg only learns about them from the block: a document that refused it is the owner's to fix, so the stage ends red and says which file and why rather than reporting a green nobody can act on. A converged document is never written at all, so a read-only file Vivicy has nothing left to say to cannot fail a run.
function blockWriteFailed(report: SkillsReport, failures: readonly BlockWriteFailure[], emit: () => void): SkillsReport {
  const files = failures.map((f) => f.file).join(" and ")
  const refused =
    failures.length === 1
      ? `${files} refused the project skills block (${failures[0].reason})`
      : `${countOf(failures.length, "governance file", "governance files")} refused the project skills block — ${failures.map((f) => `${f.file} (${f.reason})`).join("; ")}`
  const fix = `fix ${countForm(failures.length, "that file", "those files")} and re-run the skills stage`
  report.phase = "failed"
  // The consequence names the REFUSED documents and nothing else: a partial failure still delivered the block to the other one, and claiming no leg reads the skills would be false for whichever CLI reads that one.
  report.summary =
    `skills stage failed: ${refused}. ` +
    (report.installed.length === 0
      ? `${files} still ${countForm(failures.length, "lists", "list")} skills this project no longer has — ${fix}.`
      : `The project's ${countOf(report.installed.length, "skill is", "skills are")} installed and declared in vivicy.json, but nothing reading ${files} learns about ${countForm(report.installed.length, "it", "them")} until the block lands there — ${fix}.`)
  emit()
  return report
}

// vivicy.json's `skills` is the project's standing declaration AND the pin every later pass verifies against: an id the owner hand-declared keeps its place and gains this run's pin, and the write is withdrawn from the causal record when the file refused it (an unparseable vivicy.json is never clobbered — the install still stands in the report).
function mergeSkillPins(tree: StageTree, pins: readonly SkillDeclaration[]): void {
  const declarations = readSkillDeclarations(tree.repoRoot)
  const merged = declarations.map((declaration) => pins.find((pin) => pin.id === declaration.id) ?? declaration)
  const declaredIds = new Set(declarations.map((declaration) => declaration.id))
  for (const pin of pins) {
    if (!declaredIds.has(pin.id)) merged.push(pin)
  }
  recordWrite(tree, PROJECT_CONFIG_FILENAME)
  if (!writeSkillDeclarations(tree.repoRoot, merged)) forgetWrite(tree, PROJECT_CONFIG_FILENAME)
}

// The project's FULL installed set — the report, the skills block, the sidebar and the workflow evidence are all projections of THIS one value, so no two of them can contradict each other. Ids are vivicy.json's `skills` declaration unioned with the prior report (defence in depth: the declaration writer silently no-ops on an unparseable vivicy.json), plus what this run installed, minus what it removed. Metadata priority is this-run > prior report > derived from the id alone.
function projectInstalledSet(
  repoRoot: string,
  priorReport: Partial<SkillsReport> | null,
  delta: { installed?: readonly InstalledSkillEntry[]; removed?: ReadonlySet<string> } = {}
): InstalledSkillEntry[] {
  const installedNow = delta.installed ?? []
  const known = new Map<string, InstalledSkillEntry>()
  for (const entry of priorInstalledEntries(priorReport)) known.set(entry.id, entry)
  for (const entry of installedNow) known.set(entry.id, entry)
  const ids = installedSkillIds(repoRoot, priorReport)
  for (const entry of installedNow) ids.add(entry.id)
  const set: InstalledSkillEntry[] = []
  for (const id of ids) {
    if (delta.removed?.has(id)) continue
    const entry = known.get(id) ?? derivedSkillEntry(id)
    if (entry) set.push(entry)
  }
  return set
}

// An id declared in vivicy.json that no report ever described: everything derivable from the id is derived, and nothing is claimed — no audit, no waiver.
function derivedSkillEntry(id: string): InstalledSkillEntry | null {
  const ref = parseSkillId(id)
  if (!ref) return null
  return {
    id,
    source: ref.source,
    skill: ref.skill,
    name: ref.skill,
    official: OFFICIAL_VENDOR_OWNERS.has(ref.owner),
    security_waived: false,
    audits: [],
    reason: "",
  }
}

// The single normalization of the prior report's installed entries — every reader of that agent-independent file goes through here rather than trusting its shape. `source` and `skill` are re-derived from the id rather than read back: they are projections of it, and a hand-edited pair disagreeing with the id would name a bundle the id does not. An id that does not parse describes no skill at all and is dropped, exactly as an unparseable vivicy.json declaration is.
function priorInstalledEntries(priorReport: Partial<SkillsReport> | null): InstalledSkillEntry[] {
  const raw = priorReport && Array.isArray(priorReport.installed) ? priorReport.installed : []
  const entries: InstalledSkillEntry[] = []
  for (const value of raw) {
    if (!value || typeof value !== "object") continue
    const record = value as Partial<InstalledSkillEntry>
    const ref = typeof record.id === "string" ? parseSkillId(record.id) : null
    if (ref === null) continue
    entries.push({
      id: ref.id,
      source: ref.source,
      skill: ref.skill,
      name: typeof record.name === "string" && record.name.length > 0 ? record.name : ref.skill,
      official: record.official === true,
      security_waived: record.security_waived === true,
      audits: Array.isArray(record.audits)
        ? record.audits
            .filter((a): a is SkillAuditRecord => Boolean(a) && typeof a === "object")
            .map((a) => ({ provider: String(a.provider ?? "unknown"), status: String(a.status ?? "") }))
        : [],
      reason: typeof record.reason === "string" ? record.reason : "",
    })
  }
  return entries
}

function priorSelectionBaselineId(priorReport: Partial<SkillsReport> | null): string | null {
  return typeof priorReport?.selection_baseline_id === "string" ? priorReport.selection_baseline_id : null
}

function installedSkillIds(repoRoot: string, priorReport: Partial<SkillsReport> | null): Set<string> {
  const ids = new Set<string>()
  for (const declaration of readSkillDeclarations(repoRoot)) ids.add(declaration.id)
  for (const entry of priorInstalledEntries(priorReport)) ids.add(entry.id)
  return ids
}

function auditDetail(audit: SkillAuditFetch, verdict: string): string {
  if (verdict === "unaudited")
    return "no security audit is available for this skill (endpoint unreachable or skill not audited); set VIVICY_ALLOW_UNSAFE_SKILLS=1 to install anyway (flagged security_waived)"
  const counts = audit.audits.map((a) => `${a.provider}:${a.status}`).join(", ")
  return `audits [${counts}]; the rule is: zero "fail" and at most one "warn"; set VIVICY_ALLOW_UNSAFE_SKILLS=1 to install anyway (flagged security_waived)`
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch {
    return null
  }
}

function tail(output: string | undefined, max = 800): string {
  const text = (output ?? "").trim()
  return text.length > max ? text.slice(-max) : text
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null
if (cliEntry === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  let ids: string[] = []
  let removeIds: string[] = []
  let maintain = false
  let json = false
  let usageError: string | null = null
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === "--json") {
      json = true
    } else if (arg === "--maintain") {
      maintain = true
    } else if (arg === "--ids") {
      const value = argv[i + 1]
      if (!value) {
        usageError = "--ids requires a comma-separated list of skill ids/URLs"
        break
      }
      ids = value.split(",")
      i += 1
    } else if (arg.startsWith("--ids=")) {
      ids = arg.slice("--ids=".length).split(",")
    } else if (arg === "--remove") {
      const value = argv[i + 1]
      if (!value) {
        usageError = "--remove requires a comma-separated list of skill ids/URLs"
        break
      }
      removeIds = value.split(",")
      i += 1
    } else if (arg.startsWith("--remove=")) {
      removeIds = arg.slice("--remove=".length).split(",")
    } else {
      usageError = `unknown argument: ${arg}`
      break
    }
  }
  if (!usageError && [ids.length > 0, removeIds.length > 0, maintain].filter(Boolean).length > 1) {
    usageError = "--ids, --remove and --maintain are mutually exclusive (one run installs, removes OR verifies)"
  }
  if (usageError) {
    console.error(
      `error: ${usageError}\nusage: node factory/install-skills.ts [--ids <id1,id2,...>] [--remove <id1,id2,...>] [--maintain] [--json]`
    )
    process.exit(2)
  }
  const repoRoot = resolveTargetRoot()
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.")
    process.exit(2)
  }
  const run = maintain
    ? Promise.resolve().then(() => maintainSkills({ repoRoot }))
    : removeIds.length > 0
      ? removeSkills({ repoRoot, ids: removeIds })
      : installSkills({ repoRoot, ids })
  run
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(report.summary)
      process.exit(report.phase === "failed" ? 1 : 0)
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(error instanceof SkillsConfigError ? 2 : 1)
    })
}
