#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { countOf } from "../lib/count-form.ts"

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts"
import type { AgentIssue, LegConfig } from "./agent-spawn.ts"
import { legDepsForTarget } from "./leg-deps.ts"
import { doneSetHash, issueTotals } from "./acceptance.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import type { Leg, LegResult } from "./dev-loop.ts"
import { findFrozenManifest } from "./extract-issues.ts"
import { notify } from "./notify.ts"
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts"
import { SKILLS_REPORT_FILE } from "../lib/skills-report.ts"
import { deriveSkillUsage, normalizeSkillIds, reportedSkillIds, type SkillUsage } from "../lib/skill-usage.ts"
import type { NotificationInput } from "../lib/notification-events.ts"
import { installSkills } from "./install-skills.ts"
import type { SkillsReport } from "./install-skills.ts"
import { parseSkillId } from "./skill-id.ts"
import {
  RETRO_LANDINGS,
  RETRO_REPORT_FILE,
  type RetroLanding,
  type RetroProposal,
  type RetroRecurringClass,
  type RetroReport,
  type RetroSkillInstall,
} from "../lib/retro-report.ts"

export const RETRO_REPORT_REL = RETRO_REPORT_FILE
export const RETRO_VERDICT_REL = ".vivicy/development/reports/retro-verdict.json"

export class RetroConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RetroConfigError"
  }
}

interface FrozenBaseline {
  manifestPath: string
  baselineId: string
}

export type SpawnRetroLeg = (args: {
  repoRoot: string
  manifestPath: string
  baselineId: string
  verdictRel: string
  skillUsage: SkillUsage
}) => Promise<LegResult | void>

export type InstallProposedSkills = (ids: string[]) => Promise<SkillsReport>

export interface RunRetroOptions {
  repoRoot?: string | null
  spawnLeg?: SpawnRetroLeg
  findBaseline?: (repoRoot: string) => FrozenBaseline | null
  emitReport?: (report: RetroReport, repoRoot: string) => void
  installSkills?: InstallProposedSkills
  now?: () => Date
  force?: boolean
  promptsDir?: string
  cfg?: Record<string, unknown>
}

interface RawClass {
  id?: unknown
  kind?: unknown
  signature?: unknown
  evidence?: unknown
}

interface RawProposal {
  landing?: unknown
  title?: unknown
  rationale?: unknown
  detail?: unknown
  addresses?: unknown
  skill_id?: unknown
}

interface RawVerdict {
  recurring_classes?: unknown
  proposals?: unknown
}

function readJsonOrNull(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch {
    return null
  }
}

function readDeclaredSkillUsage(repoRoot: string): SkillUsage {
  const ledger = readJsonOrNull(resolve(repoRoot, DEFAULT_CONFIG.progressLedgerPath!)) as { skill_usage?: unknown } | null
  const report = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_FILE)) as { installed?: unknown } | null
  return deriveSkillUsage({ entries: ledger?.skill_usage, installed: reportedSkillIds(report) })
}

function skillUsageLine(usage: SkillUsage): string {
  const claimed = usage.not_installed.map((entry) => `\`${entry.id}\` on ${countOf(entry.issues, "issue", "issues")}`).join(", ")
  const claimedClause = claimed ? ` Claimed by a leg but not installed, so dropped: ${claimed}.` : ""
  if (usage.applied.length === 0) {
    const head =
      usage.issues === 0
        ? "no skills are installed and no issue's legs declared."
        : `no skills are installed; ${countOf(usage.issues, "issue", "issues")} still answered the declaration.`
    return head + claimedClause
  }
  if (usage.issues === 0) {
    return (
      `${countOf(usage.applied.length, "skill is", "skills are")} installed, but no issue's legs have declared yet — nothing is known about their use.` +
      claimedClause
    )
  }
  const perSkill = usage.applied
    .map((entry) => `\`${entry.id}\` applied on ${entry.applied} of the ${countOf(entry.issues, "issue", "issues")} that had it installed`)
    .join(", ")
  return `${countOf(usage.issues, "issue", "issues")} declared which skills their legs applied; ${perSkill}.` + claimedClause
}

export function retroContext({
  manifestPath,
  baselineId,
  verdictRel,
  skillUsage,
}: {
  manifestPath: string
  baselineId: string
  verdictRel: string
  skillUsage: SkillUsage
}): string {
  return (
    `\n\n---\n\n## Retro context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). The cycle you are reviewing built the product from this baseline.\n` +
    `- Read the run's lived history: the progress ledger \`.vivicy/development/progress-ledger.json\`, every block report under \`.vivicy/development/reports/*-blocked.json\` and \`*-integration-blocked.json\`, the gate evidence under \`.vivicy/development/gates/*.json\`, the whole-product \`.vivicy/development/reports/acceptance-report.json\`, and the quota history \`.vivicy/development/reports/quota-state.json\`.\n` +
    `- Project-skill usage, declared by each issue's implementer and reviewer and recorded in that same ledger: ${skillUsageLine(skillUsage)}\n` +
    `- A RECURRING class is the SAME failure shape seen at least TWICE across the cycle (same gate flake, same blocked cause, same review finding, same quota exhaustion). One-off failures are not recurring.\n` +
    `- Write your JSON verdict — and nothing else — to \`${verdictRel}\`. Write no other file: you propose, the orchestrator records and the owner decides.\n`
  )
}

function makeDefaultSpawnRetroLeg(options: RunRetroOptions): SpawnRetroLeg {
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
  const leg: Leg = { ...implementer, role: "retro" }
  return async ({ repoRoot, manifestPath, baselineId, verdictRel, skillUsage }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot }
    const issue: AgentIssue = {
      id: TRANSCRIPT_DIRS.retro,
      transcript_dir: TRANSCRIPT_DIRS.retro,
      graph_refs: ["node:retro"],
      path: verdictRel,
    }
    const context = retroContext({ manifestPath, baselineId, verdictRel, skillUsage })
    const deps = legDepsForTarget(repoRoot, context)
    return leg.provider === "codex"
      ? runCodexLeg(leg, issue, legCfg as LegConfig, deps)
      : runClaudeLeg(leg, issue, legCfg as LegConfig, deps)
  }
}

// Never notify for a proposal the loop closed itself (P9); a refusal the skills stage DECIDED is told by that stage's own report, never a second time from here.
function ownerMustDecide(proposal: RetroProposal): boolean {
  return proposal.skill_id === undefined || proposal.skill_install?.status === "undecided"
}

export function retroNotifications(report: RetroReport): NotificationInput[] {
  if (report.phase !== "proposals" || !(report.proposals ?? []).some(ownerMustDecide)) return []
  return [
    {
      level: "warning",
      stage: "SR",
      event: "retro_proposals",
      message: report.summary || "post-cycle retro found recurring failure classes and drafted method amendments for you to decide",
    },
  ]
}

function defaultEmitReport(report: RetroReport, repoRoot: string): void {
  const abs = resolve(repoRoot, RETRO_REPORT_REL)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`)
  for (const notification of retroNotifications(report)) notify(notification)
}

function normalizeClasses(raw: unknown): RetroRecurringClass[] {
  if (!Array.isArray(raw)) return []
  const classes: RetroRecurringClass[] = []
  for (const entry of raw as RawClass[]) {
    if (!entry || typeof entry !== "object") continue
    const signature = typeof entry.signature === "string" ? entry.signature.trim() : ""
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : ""
    const witnesses = Array.isArray(entry.evidence)
      ? [...new Set(entry.evidence.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()))]
      : []
    if (!signature || !kind || witnesses.length < 2) continue
    classes.push({
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined,
      kind,
      signature,
      occurrences: witnesses.length,
      evidence: witnesses,
    })
  }
  return classes
}

// Return the declared literal itself, never the raw value: `["skill"]` stringifies into the list and would otherwise be RECORDED as the landing.
function recognizedLanding(raw: unknown): RetroLanding | null {
  return RETRO_LANDINGS.find((landing) => landing === String(raw)) ?? null
}

// An id is an INSTALL ORDER only where the leg asked for the skill landing or named none this module recognizes; never let it override an explicit non-skill landing, which the owner still decides.
function skillIdHonored(raw: unknown, recognized: RetroLanding | null): boolean {
  if (recognized === null || recognized === "skill") return true
  if (raw !== undefined && raw !== null) {
    process.stderr.write(
      `retro: ignored the skill_id on a ${recognized} proposal — only a skill proposal is installed, so this one stays owner-decided\n`
    )
  }
  return false
}

function proposedSkillId(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null
  const [candidate] = normalizeSkillIds([raw])
  const id = candidate !== undefined && parseSkillId(candidate) !== null ? candidate : null
  if (id === null) {
    process.stderr.write(
      `retro: refused an unusable skill_id ${JSON.stringify(String(raw).slice(0, 120))} at the boundary; that proposal stays a text suggestion for the owner\n`
    )
  }
  return id
}

function normalizeProposals(raw: unknown): RetroProposal[] {
  if (!Array.isArray(raw)) return []
  const proposals: RetroProposal[] = []
  for (const entry of raw as RawProposal[]) {
    if (!entry || typeof entry !== "object") continue
    const title = typeof entry.title === "string" ? entry.title.trim() : ""
    const detail = typeof entry.detail === "string" ? entry.detail.trim() : ""
    if (!title || !detail) continue
    const addresses = Array.isArray(entry.addresses)
      ? entry.addresses.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      : []
    const recognized = recognizedLanding(entry.landing)
    const skillId = skillIdHonored(entry.skill_id, recognized) ? proposedSkillId(entry.skill_id) : null
    proposals.push({
      landing: skillId === null ? (recognized ?? "canonical_clarification") : "skill",
      title,
      rationale: typeof entry.rationale === "string" && entry.rationale.trim() ? entry.rationale.trim() : undefined,
      detail,
      addresses: addresses.length > 0 ? addresses : undefined,
      skill_id: skillId ?? undefined,
    })
  }
  return proposals
}

type InstallOutcome = { report: SkillsReport } | { failure: string }

async function runProposedInstall(install: InstallProposedSkills, ids: readonly string[]): Promise<InstallOutcome> {
  try {
    return { report: await install([...ids]) }
  } catch (error) {
    const failure = error instanceof Error ? error.message : String(error)
    process.stderr.write(`retro: the skills stage could not run for ${ids.join(", ")} (${failure}); nothing was installed\n`)
    return { failure }
  }
}

function skillInstallOutcome(id: string, outcome: InstallOutcome): RetroSkillInstall {
  if ("failure" in outcome) {
    return {
      status: "undecided",
      detail: `the skills stage could not run (${outcome.failure}), so nothing was installed for this proposal`,
    }
  }
  const { report } = outcome
  if (report.added.includes(id)) return { status: "installed", detail: "the skills stage installed it" }
  const rejected = report.rejected.find((entry) => entry.id === id)
  // A transport failure is not a refusal: the stage decided nothing about this skill, so the proposal stays the owner's to decide rather than reading as vetoed.
  if (rejected?.reason === "audit_unreachable")
    return { status: "undecided", detail: rejected.detail ?? "the skills stage could not decide" }
  if (rejected)
    return { status: "refused", detail: `${rejected.reason} — ${rejected.detail ?? "the skills stage kept it out of the project"}` }
  if (report.installed.some((entry) => entry.id === id)) return { status: "installed", detail: "the project already had it installed" }
  return { status: "refused", detail: report.summary || "the skills stage neither installed nor refused it" }
}

function skillOutcomeIds(proposals: readonly RetroProposal[], status: RetroSkillInstall["status"]): string[] {
  return [...new Set(proposals.flatMap((p) => (p.skill_id !== undefined && p.skill_install?.status === status ? [p.skill_id] : [])))]
}

function proposalsSummary(proposals: readonly RetroProposal[], classes: number): string {
  const byLanding = proposals.reduce<Record<string, number>>((acc, p) => {
    const key = String(p.landing)
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})
  const breakdown = Object.entries(byLanding)
    .map(([landing, n]) => `${n} ${landing}`)
    .join(", ")
  const head = `${countOf(proposals.length, "method amendment", "method amendments")} proposed (${breakdown}) from ${countOf(classes, "recurring class", "recurring classes")}`
  const clauses: string[] = []
  const installed = skillOutcomeIds(proposals, "installed")
  const refused = skillOutcomeIds(proposals, "refused")
  const undecided = skillOutcomeIds(proposals, "undecided")
  if (installed.length > 0) clauses.push(`the skills stage installed ${installed.join(", ")}`)
  if (refused.length > 0) clauses.push(`${clauses.length > 0 ? "refused" : "the skills stage refused"} ${refused.join(", ")}`)
  if (undecided.length > 0)
    clauses.push(`${clauses.length > 0 ? "could not decide" : "the skills stage could not decide"} ${undecided.join(", ")}`)
  const owed = proposals.filter(ownerMustDecide).length
  const tail =
    owed === 0
      ? "nothing is left for you to decide"
      : clauses.length === 0
        ? "each is owner-decided data — nothing is applied until you click"
        : `${countOf(owed, "amendment is", "amendments are")} owner-decided data — nothing else is applied until you click`
  return `${head}${clauses.length > 0 ? `; ${clauses.join(", ")}` : ""}; ${tail}.`
}

export async function runRetro(options: RunRetroOptions = {}): Promise<RetroReport> {
  const repoRoot = options.repoRoot
  if (!repoRoot) {
    throw new RetroConfigError("runRetro: no target project configured. Set VIVICY_TARGET_ROOT or pass options.repoRoot.")
  }
  const now = options.now ?? (() => new Date())
  const emitReport = options.emitReport ?? defaultEmitReport
  const findBaseline = options.findBaseline ?? findFrozenManifest
  const spawnLeg = options.spawnLeg ?? makeDefaultSpawnRetroLeg(options)

  const baseline = findBaseline(repoRoot)
  const { done, total } = issueTotals(repoRoot)
  const hash = doneSetHash(repoRoot)
  const prior = readJsonOrNull(resolve(repoRoot, RETRO_REPORT_REL)) as RetroReport | null

  const report: RetroReport = {
    phase: "checking",
    baseline_id: baseline?.baselineId ?? null,
    done_set_hash: hash,
    recurring_classes: [],
    proposals: [],
    summary: "",
    updated_at: "",
  }
  const emit = (): RetroReport => {
    report.updated_at = now().toISOString()
    emitReport(report, repoRoot)
    return report
  }

  if (total <= 0 || done < total) {
    report.phase = "failed"
    report.summary = `retro runs once the cycle has closed (done ${done}/${total}); nothing to reflect on. The cycle close is not affected.`
    return emit()
  }
  if (!baseline) {
    report.phase = "failed"
    report.summary =
      "no active frozen baseline to reflect against — the product was not built from a frozen canonical. The cycle close is not affected."
    return emit()
  }

  const settled = prior && (prior.phase === "quiet" || prior.phase === "proposals")
  if (!options.force && settled && prior.baseline_id === baseline.baselineId && prior.done_set_hash === hash) {
    return prior
  }

  report.summary = "reading the run's ledger, blocks, gate evidence, and quota history for recurring failure classes"
  emit()

  let legResult: LegResult | void
  try {
    legResult = await spawnLeg({
      repoRoot,
      manifestPath: baseline.manifestPath,
      baselineId: baseline.baselineId,
      verdictRel: RETRO_VERDICT_REL,
      skillUsage: readDeclaredSkillUsage(repoRoot),
    })
  } catch (error) {
    report.phase = "failed"
    report.summary = `retro leg errored: ${error instanceof Error ? error.message : String(error)}. The cycle close is not affected.`
    return emit()
  }
  if (legResult && legResult.result?.timedOut) {
    report.phase = "failed"
    report.summary = `retro leg timed out (${legResult.result.timeoutReason ?? "no output"}); no amendments proposed this cycle. The cycle close is not affected.`
    return emit()
  }

  const verdict = readJsonOrNull(resolve(repoRoot, RETRO_VERDICT_REL)) as RawVerdict | null
  if (!verdict || typeof verdict !== "object" || (!("recurring_classes" in verdict) && !("proposals" in verdict))) {
    report.phase = "failed"
    report.summary =
      "retro leg produced no valid verdict (missing or malformed retro-verdict.json); no amendments proposed this cycle. The cycle close is not affected."
    return emit()
  }

  const recurringClasses = normalizeClasses(verdict.recurring_classes)
  const proposals = normalizeProposals(verdict.proposals)
  report.recurring_classes = recurringClasses
  report.proposals = proposals

  if (proposals.length === 0) {
    report.phase = "quiet"
    report.summary =
      recurringClasses.length === 0
        ? "clean cycle: no recurring failure classes and nothing to amend."
        : `${countOf(recurringClasses.length, "recurring class", "recurring classes")} noted but no actionable amendment proposed; recorded for the owner, nothing to decide.`
    return emit()
  }

  const ids = [...new Set(proposals.flatMap((p) => (p.skill_id === undefined ? [] : [p.skill_id])))]
  if (ids.length > 0) {
    report.summary = `installing ${countOf(ids.length, "skill this retro proposed", "skills this retro proposed")} (${ids.join(", ")}) through the project's own skills stage — the same security audit, cap and name-collision gates every install passes`
    emit()
    const outcome = await runProposedInstall(options.installSkills ?? ((installIds) => installSkills({ repoRoot, ids: installIds })), ids)
    for (const proposal of proposals) {
      if (proposal.skill_id !== undefined) proposal.skill_install = skillInstallOutcome(proposal.skill_id, outcome)
    }
  }

  report.phase = "proposals"
  report.summary = proposalsSummary(proposals, recurringClasses.length)
  return emit()
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null
if (cliEntry === fileURLToPath(import.meta.url)) {
  const repoRoot = resolveTargetRoot()
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.")
    process.exit(2)
  }
  const json = process.argv.includes("--json")
  runRetro({ repoRoot })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(report.summary)
      process.exit(0)
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(error instanceof RetroConfigError ? 2 : 0)
    })
}
