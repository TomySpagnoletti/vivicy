// Server-only; deliberately independent of factory/cli.ts (Next-bundled TS vs a plain Node ESM bin) — parity is both spawning the same factory scripts/args and reading the same state files, not shared code.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import {
  clearSpecCycle,
  hasActiveFrozenBaseline,
  isSpecCycleOpen,
  readSpecCycle,
  writeSpecCycle,
  type SpecCycle,
} from "@/lib/spec-cycle"
import { settingsToEnv } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"
import {
  SKILLS_IN_FLIGHT_PHASES,
  SKILLS_REPORT_FILE,
  type SkillsReport,
} from "@/lib/skills-report"
import { canonicalHasSpecDoc, getTargetRoot } from "@/lib/target"

export interface DetachedHandle {
  pid: number
}

export interface RunResult {
  code: number | null
  lastLine: string
  stdout: string
  stderr: string
}

export interface SpawnDetachedOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logFile: string
}

export interface RunOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface Spawner {
  spawnDetached(options: SpawnDetachedOptions): DetachedHandle
  run(options: RunOptions): Promise<RunResult>
  killGroup(pid: number, signal?: NodeJS.Signals): boolean
  isAlive(pid: number): boolean
}

export interface RunState {
  pid: number
  started_at: string
  target_root: string
  factory_root: string
  log_file: string
  mode: "start" | "resume"
}

export interface QuotaWindow {
  used_pct: number | null
  remaining: number | null
  reset_at: string | null
}

export interface QuotaWindows {
  "5h"?: QuotaWindow
  weekly?: QuotaWindow
}

export interface AgentQuota {
  model: string | null
  status: "available" | "throttled"
  reset_at: string | null
  last_message: string | null
  windows?: QuotaWindows
  last_probe_at?: string | null
  updated_at?: string | null
}

export interface QuotaBlock {
  updated_at: string | null
  agents: Record<string, AgentQuota>
}

export interface DevStatus {
  verdict: string
  issues_total: number
  issues_done: number
  done: string[]
  remaining: string[]
  active: unknown[]
  process_alive: boolean
  idle_seconds: number | null
  gates: { pass: number; fail: number }
  quota?: QuotaBlock
  [key: string]: unknown
}

export interface ExtractResult {
  ok: boolean
  blocked: boolean
  status: string
  summary: string
  lastLine: string
}

export class ControlError extends Error {
  constructor(
    message: string,
    readonly code:
      | "already_running"
      | "not_running"
      | "missing_script"
      | "missing_target"
      | "empty_canonical"
      | "spawn_failed"
      | "unknown_cr"
      | "cr_not_decidable"
      | "cycle_state"
  ) {
    super(message)
    this.name = "ControlError"
  }
}

const RUN_STATE_FILE = "run-state.json"
const LOG_FILE = "supervisor.log"

const SUPERVISOR_SCRIPT = "dev-loop-supervised.ts"
const STATUS_SCRIPT = "dev-status.ts"
const EXTRACT_SCRIPT = "extract-issues.ts"
const CHANGE_CONTROL_SCRIPT = "change-control.ts"
const CR_APPLY_SCRIPT = "cr-apply.ts"
const SKILLS_SCRIPT = "install-skills.ts"
const SKILLS_LOG_FILE = "skills-install.log"

export function getFactoryRoot(): string {
  const fromEnv = process.env.VIVICY_FACTORY_ROOT
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), "factory")
}

// Runtime files live under <runtime>/projects/<key>/, derived here from the shared lib/project-runtime.ts — cli.ts uses the same module so CLI-started state stays visible to the UI and vice versa.
function projectRuntimeDir(targetRoot: string): string {
  return getProjectRuntimeDir(getRuntimeDir(), targetRoot)
}

function getRunStatePath(targetRoot: string): string {
  return path.join(projectRuntimeDir(targetRoot), RUN_STATE_FILE)
}

function getLogPath(targetRoot: string): string {
  return path.join(projectRuntimeDir(targetRoot), LOG_FILE)
}

function assertInside(root: string, child: string): string {
  const abs = path.resolve(root, child)
  const rel = path.relative(root, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ControlError(`path escapes ${root}: ${child}`, "missing_script")
  }
  return abs
}

function resolveScript(factoryRoot: string, relativeScript: string): string {
  const abs = assertInside(factoryRoot, relativeScript)
  if (!existsSync(abs)) {
    throw new ControlError(
      `factory script not found: ${relativeScript} (looked under ${factoryRoot})`,
      "missing_script"
    )
  }
  return abs
}

function devEnv(targetRoot: string): NodeJS.ProcessEnv {
  // VIVICY_RUNTIME_DIR must be set explicitly — factory-side notify is a silent no-op without it.
  return { ...process.env, VIVICY_TARGET_ROOT: targetRoot, VIVICY_RUNTIME_DIR: projectRuntimeDir(targetRoot) }
}

export function readRunState(): RunState | null {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return null
  const file = getRunStatePath(targetRoot)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState
  } catch {
    return null
  }
}

function updateRunState(targetRoot: string, state: RunState): void {
  writeFileSync(getRunStatePath(targetRoot), `${JSON.stringify(state, null, 2)}\n`)
}

// Lock claimed with wx (exclusive create) before spawn to close the check-then-spawn TOCTOU window; a dead pid is cleared and the claim retried once.
function claimRunLock(spawner: Spawner, targetRoot: string, placeholder: RunState): void {
  mkdirSync(projectRuntimeDir(targetRoot), { recursive: true })
  const file = getRunStatePath(targetRoot)
  const body = `${JSON.stringify(placeholder, null, 2)}\n`
  try {
    writeFileSync(file, body, { flag: "wx" })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (isRunActive(spawner)) {
    throw new ControlError("a supervised run is already active", "already_running")
  }
  try {
    writeFileSync(file, body, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ControlError("a supervised run is already active", "already_running")
    }
    throw error
  }
}

function clearRunState(): void {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return
  const file = getRunStatePath(targetRoot)
  if (existsSync(file)) rmSync(file)
}

export function isRunActive(spawner: Spawner): boolean {
  const state = readRunState()
  if (!state) return false
  if (spawner.isAlive(state.pid)) return true
  clearRunState()
  return false
}

export interface ControlContext {
  factoryRoot: string
  targetRoot: string
}

function resolveContext(): ControlContext {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) {
    throw new ControlError("no project selected — choose a target project first", "missing_target")
  }
  return { factoryRoot: getFactoryRoot(), targetRoot }
}

export function startSupervisor(
  spawner: Spawner,
  mode: "start" | "resume" = "start"
): RunState {
  const { factoryRoot, targetRoot } = resolveContext()

  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  if (isSpecCycleOpen(targetRoot)) {
    throw new ControlError(
      "a drafting spec cycle is open — run the extraction to freeze it (or cancel the cycle) before building",
      "cycle_state"
    )
  }
  const command = resolveScript(factoryRoot, SUPERVISOR_SCRIPT)
  const logFile = getLogPath(targetRoot)

  // Placeholder pid is THIS server's own pid (not the eventual child's) so isAlive sees it as live during the claim-to-spawn window.
  const state: RunState = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    target_root: targetRoot,
    factory_root: factoryRoot,
    log_file: logFile,
    mode,
  }

  claimRunLock(spawner, targetRoot, state)

  const supervisorEnv = { ...devEnv(targetRoot), ...settingsToEnv(readSettings()) }

  let handle: DetachedHandle
  try {
    handle = spawner.spawnDetached({
      command: process.execPath,
      args: [command],
      cwd: factoryRoot,
      env: supervisorEnv,
      logFile,
    })
  } catch (error) {
    clearRunState()
    throw new ControlError(
      `failed to spawn supervisor: ${error instanceof Error ? error.message : String(error)}`,
      "spawn_failed"
    )
  }

  state.pid = handle.pid
  updateRunState(targetRoot, state)
  return state
}

export function openSpecCycle(spawner: Spawner, openedBy: string): SpecCycle {
  const { targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  if (!hasActiveFrozenBaseline(targetRoot)) {
    throw new ControlError(
      "no frozen baseline — before the first freeze the spec is already editable; a cycle is only needed to reopen a FROZEN spec",
      "cycle_state"
    )
  }
  if (isSpecCycleOpen(targetRoot)) {
    throw new ControlError("a drafting spec cycle is already open", "cycle_state")
  }
  if (isRunActive(spawner)) {
    throw new ControlError(
      "a supervised run is active — stop it (or let it finish) before opening a spec cycle",
      "already_running"
    )
  }
  const cycle: SpecCycle = {
    status: "drafting",
    kind: "feature",
    id: `cycle-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
    opened_at: new Date().toISOString(),
    opened_by: openedBy,
  }
  writeSpecCycle(targetRoot, cycle)
  return cycle
}

export async function cancelSpecCycle(spawner: Spawner): Promise<{ id: string }> {
  const { factoryRoot, targetRoot } = resolveContext()
  const cycle = readSpecCycle(targetRoot)
  if (!cycle) {
    throw new ControlError("no drafting spec cycle is open", "cycle_state")
  }
  const manifest = findActiveFrozenManifestRel(targetRoot)
  if (manifest) {
    const tool = resolveScript(factoryRoot, "doc-baseline.ts")
    const verify = await spawner.run({
      command: process.execPath,
      args: [tool, "verify", "--manifest", manifest, "--require-status", "frozen"],
      cwd: targetRoot,
      env: devEnv(targetRoot),
    })
    if (verify.code !== 0) {
      throw new ControlError(
        "the canonical has already drifted from the frozen baseline — cancelling would strand the spec; extract to freeze the evolution, or revert the canonical edits first",
        "cycle_state"
      )
    }
  }
  clearSpecCycle(targetRoot)
  return { id: cycle.id }
}

function findActiveFrozenManifestRel(targetRoot: string): string | null {
  const dir = path.join(targetRoot, ".vivicy", "baselines")
  if (!existsSync(dir)) return null
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue
    try {
      const manifest = JSON.parse(readFileSync(path.join(dir, entry), "utf8")) as {
        status?: unknown
        superseded?: unknown
      }
      if (manifest?.status === "frozen" && !manifest.superseded) {
        return `.vivicy/baselines/${entry}`
      }
    } catch {
      continue
    }
  }
  return null
}

export function getSpecCycle(): SpecCycle | null {
  const { targetRoot } = resolveContext()
  return readSpecCycle(targetRoot)
}

export function stopSupervisor(spawner: Spawner): { pid: number } {
  const state = readRunState()
  if (!state) {
    throw new ControlError("no supervised run is recorded", "not_running")
  }
  spawner.killGroup(state.pid, "SIGTERM")
  clearRunState()
  return { pid: state.pid }
}

export async function readDevStatus(
  spawner: Spawner
): Promise<DevStatus & { run_active: boolean }> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const command = resolveScript(factoryRoot, STATUS_SCRIPT)

  const result = await spawner.run({
    command: process.execPath,
    args: [command, "--dir", targetRoot, "--json"],
    cwd: factoryRoot,
    env: devEnv(targetRoot),
  })

  let parsed: DevStatus
  try {
    parsed = JSON.parse(result.stdout) as DevStatus
  } catch {
    throw new ControlError(
      `dev-status did not return JSON (exit ${result.code}): ${result.stderr || result.lastLine}`,
      "spawn_failed"
    )
  }
  return { ...parsed, run_active: isRunActive(spawner) }
}

const EXTRACTION_STATUS_FILE = ".vivicy/development/reports/extraction-status.json"

export interface ExtractionStatus {
  // phase: "authoring" | "fixing" | "refreezing" | "validating" | "mapping" | "verifying" | "map-review" | "green" | "extraction_blocked" | "blocked_on_unverified_spikes"
  phase?: string
  attempt?: number
  spike_mode?: "integrate" | "extract"
  map_mode?: "reused" | "authored"
  spike_proving?: { proved?: unknown[]; failed?: unknown[]; skipped?: unknown[] }
  unverified_spike_gate_ids?: string[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}

export async function runExtract(spawner: Spawner): Promise<ExtractResult> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  assertRealCanonical(targetRoot)
  const command = resolveScript(factoryRoot, EXTRACT_SCRIPT)

  const result = await spawner.run({
    command: process.execPath,
    args: [command],
    cwd: factoryRoot,
    env: devEnv(targetRoot),
  })

  const lastLine =
    result.lastLine || result.stderr.trim().split("\n").filter(Boolean).at(-1) || ""

  const status = readExtractionStatus(targetRoot)
  const blocked = status?.phase === "extraction_blocked"
  const ok = result.code === 0 && status?.phase === "green"

  return {
    ok,
    blocked,
    status: status?.phase ?? "error",
    summary: status?.summary ?? lastLine,
    lastLine,
  }
}

// Without this guard, extracting against an empty canonical launches agents into a void that spins until the retry budget dies.
function assertRealCanonical(targetRoot: string): void {
  const canonicalDir = path.join(targetRoot, ".vivicy", "canonical")
  if (!existsSync(canonicalDir)) {
    throw new ControlError(
      `no canonical directory at ${path.join(".vivicy", "canonical")} — import or write the spec before extracting`,
      "empty_canonical"
    )
  }
  if (!canonicalHasSpecDoc(targetRoot)) {
    throw new ControlError(
      "canonical is empty (only the scaffold README) — write or import canonical docs (01-<area>.md, ...) before extracting",
      "empty_canonical"
    )
  }
}

function readExtractionStatus(targetRoot: string): ExtractionStatus | null {
  const file = path.join(targetRoot, EXTRACTION_STATUS_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ExtractionStatus
  } catch {
    return null
  }
}

export function getExtractionStatus(): ExtractionStatus | null {
  const { targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  return readExtractionStatus(targetRoot)
}

// Deliberately generous: a false "stale" read would double-spawn agent legs — worse than waiting out a slow install.
const SKILLS_STALE_MS = 15 * 60 * 1000

const SKILLS_IN_FLIGHT = new Set<string>(SKILLS_IN_FLIGHT_PHASES)

function readSkillsReportFrom(targetRoot: string): SkillsReport | null {
  const file = path.join(targetRoot, SKILLS_REPORT_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SkillsReport
  } catch {
    return null
  }
}

export function readSkillsReport(): SkillsReport | null {
  const { targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  return readSkillsReportFrom(targetRoot)
}

function isSkillsInstallInFlight(targetRoot: string): boolean {
  const report = readSkillsReportFrom(targetRoot)
  if (!report?.phase || !SKILLS_IN_FLIGHT.has(report.phase)) return false
  const updated = Date.parse(report.updated_at ?? "")
  // Unparseable timestamp fails toward "in flight" (refuse) rather than risk a double-spawned install.
  if (!Number.isFinite(updated)) return true
  return Date.now() - updated < SKILLS_STALE_MS
}

// Same TOCTOU-safe wx-claim pattern as the run lock — the report file alone can't stop two callers from double-spawning.
const SKILLS_LOCK_FILE = "skills-install.lock"

interface SkillsLock {
  pid: number
  started_at: string
}

// targetRoot is threaded through, never re-resolved mid-operation, so a project switch mid-call can't touch another project's lock.
function skillsLockPath(targetRoot: string): string {
  return path.join(projectRuntimeDir(targetRoot), SKILLS_LOCK_FILE)
}

function readSkillsLock(targetRoot: string): SkillsLock | null {
  try {
    const raw = JSON.parse(readFileSync(skillsLockPath(targetRoot), "utf8")) as SkillsLock
    return typeof raw?.pid === "number" ? raw : null
  } catch {
    return null
  }
}

function clearSkillsLock(targetRoot: string): void {
  rmSync(skillsLockPath(targetRoot), { force: true })
}

function isSkillsLockLive(spawner: Spawner, targetRoot: string): boolean {
  const lock = readSkillsLock(targetRoot)
  if (!lock) return false
  if (spawner.isAlive(lock.pid)) return true
  clearSkillsLock(targetRoot)
  return false
}

function claimSkillsLock(spawner: Spawner, targetRoot: string): void {
  mkdirSync(path.dirname(skillsLockPath(targetRoot)), { recursive: true })
  const body = `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`
  try {
    writeFileSync(skillsLockPath(targetRoot), body, { flag: "wx" })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  if (isSkillsLockLive(spawner, targetRoot)) {
    throw new ControlError("a skills install is already in flight", "already_running")
  }
  try {
    writeFileSync(skillsLockPath(targetRoot), body, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ControlError("a skills install is already in flight", "already_running")
    }
    throw error
  }
}

export interface SkillsInstallStart {
  pid: number
  mode: "auto" | "explicit"
  ids: string[]
}

export function startSkillsInstall(
  spawner: Spawner,
  opts: { ids?: string[] } = {}
): SkillsInstallStart {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const ids = (opts.ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (isSkillsInstallInFlight(targetRoot)) {
    throw new ControlError("a skills install is already in flight", "already_running")
  }
  claimSkillsLock(spawner, targetRoot)
  const command = resolveScript(factoryRoot, SKILLS_SCRIPT)
  const logFile = path.join(projectRuntimeDir(targetRoot), SKILLS_LOG_FILE)

  let handle: DetachedHandle
  try {
    handle = spawner.spawnDetached({
      command: process.execPath,
      args: [command, ...(ids.length > 0 ? ["--ids", ids.join(",")] : [])],
      cwd: factoryRoot,
      env: { ...devEnv(targetRoot), ...settingsToEnv(readSettings()) },
      logFile,
    })
  } catch (error) {
    clearSkillsLock(targetRoot)
    throw new ControlError(
      `failed to spawn skills install: ${error instanceof Error ? error.message : String(error)}`,
      "spawn_failed"
    )
  }
  writeFileSync(skillsLockPath(targetRoot), `${JSON.stringify({ pid: handle.pid, started_at: new Date().toISOString() }, null, 2)}\n`)
  return { pid: handle.pid, mode: ids.length > 0 ? "explicit" : "auto", ids }
}

export async function removeSkills(
  spawner: Spawner,
  opts: { ids: string[] }
): Promise<SkillsReport> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const ids = (opts.ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0)
  if (ids.length === 0) {
    throw new ControlError("skills remove requires at least one skill id", "missing_target")
  }
  if (isSkillsInstallInFlight(targetRoot)) {
    throw new ControlError("a skills install is already in flight", "already_running")
  }
  claimSkillsLock(spawner, targetRoot)
  try {
    const command = resolveScript(factoryRoot, SKILLS_SCRIPT)
    const result = await spawner.run({
      command: process.execPath,
      args: [command, "--remove", ids.join(","), "--json"],
      cwd: factoryRoot,
      env: { ...devEnv(targetRoot), ...settingsToEnv(readSettings()) },
    })
    const report = readSkillsReportFrom(targetRoot)
    if (result.code !== 0 || report === null) {
      throw new ControlError(
        `skills remove failed (exit ${result.code}): ${result.stderr.trim() || result.lastLine || "no report written"}`,
        "spawn_failed"
      )
    }
    return report
  } finally {
    clearSkillsLock(targetRoot)
  }
}

const CHANGE_REQUESTS_DIR = ".vivicy/change-requests"
const REPORTS_DIR = ".vivicy/development/reports"
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"])

export interface ChangeRequestSummary {
  id: string
  title: string
  status: string
  classification: string
  created_at: string | null
  source: string | null
}

export interface DecideCrResult {
  ok: boolean
  id: string
  decision: "approved" | "rejected"
  status: string
  applied?: {
    ok: boolean
    blocked: boolean
    status: "green" | "blocked" | string
    summary: string
  }
  summary: string
}

export function listChangeRequests(): { crs: ChangeRequestSummary[] } {
  const { targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const dir = path.join(targetRoot, CHANGE_REQUESTS_DIR)
  if (!existsSync(dir)) return { crs: [] }
  const crs: ChangeRequestSummary[] = []
  for (const file of readdirSync(dir).sort()) {
    const lower = file.toLowerCase()
    if (!lower.endsWith(".md") || NON_CR_FILES.has(lower)) continue
    const fm = parseFrontmatter(readFileSync(path.join(dir, file), "utf8"))
    const id = typeof fm.id === "string" ? fm.id : ""
    if (!/^CR-\d{4}$/.test(id)) continue
    crs.push({
      id,
      title: typeof fm.title === "string" ? fm.title : id,
      status: typeof fm.status === "string" ? fm.status : "",
      classification: typeof fm.classification === "string" ? fm.classification : "",
      created_at: typeof fm.created_at === "string" ? fm.created_at : null,
      source: typeof fm.source === "string" ? fm.source : null,
    })
  }
  return { crs }
}

export async function decideCr(
  spawner: Spawner,
  input: { id: string; decision: "approved" | "rejected"; decidedBy: string }
): Promise<DecideCrResult> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const { id, decision, decidedBy } = input
  if (decision !== "approved" && decision !== "rejected") {
    throw new ControlError(`invalid decision "${decision}" (expected approved|rejected)`, "cr_not_decidable")
  }

  const ccScript = resolveScript(factoryRoot, CHANGE_CONTROL_SCRIPT)
  const decideRun = await spawner.run({
    command: process.execPath,
    args: [ccScript, "decide", "--cr", id, "--decision", decision, "--by", decidedBy],
    cwd: factoryRoot,
    env: devEnv(targetRoot),
  })
  const decided = parseJsonLine(decideRun.stdout) ?? parseJsonLine(decideRun.stderr)
  if (decideRun.code !== 0 || !decided?.ok) {
    const message = typeof decided?.error === "string" ? decided.error : decideRun.stderr || decideRun.lastLine || "decision failed"
    throw classifyDecisionError(id, message)
  }
  const status = typeof decided.status === "string" ? decided.status : decision === "approved" ? "accepted_current_build" : "rejected"

  if (decision === "rejected") {
    return { ok: true, id, decision, status, summary: `CR ${id} rejected` }
  }

  const applyScript = resolveScript(factoryRoot, CR_APPLY_SCRIPT)
  const applyRun = await spawner.run({
    command: process.execPath,
    args: [applyScript, "--cr", id],
    cwd: factoryRoot,
    env: devEnv(targetRoot),
  })
  const report = readCrApplyReport(targetRoot, id)
  const applyStatus = report?.status ?? (applyRun.code === 0 ? "green" : "blocked")
  const applied = {
    ok: applyRun.code === 0 && applyStatus === "green",
    blocked: applyStatus === "blocked",
    status: applyStatus,
    summary: report?.summary ?? applyRun.lastLine ?? applyRun.stderr.trim().split("\n").filter(Boolean).at(-1) ?? "cr-apply produced no report",
  }
  return {
    ok: applied.ok,
    id,
    decision,
    status,
    applied,
    summary: applied.summary,
  }
}

function classifyDecisionError(id: string, message: string): ControlError {
  if (/no CR with id/i.test(message)) return new ControlError(`unknown change request: ${id}`, "unknown_cr")
  if (/only idea\|under_review|can be decided|only .* can be/i.test(message)) {
    return new ControlError(message, "cr_not_decidable")
  }
  if (/no frozen baseline/i.test(message)) return new ControlError(message, "cr_not_decidable")
  return new ControlError(message, "spawn_failed")
}

function readCrApplyReport(targetRoot: string, id: string): { status?: string; summary?: string } | null {
  const file = path.join(targetRoot, REPORTS_DIR, `apply-${id}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { status?: string; summary?: string }
  } catch {
    return null
  }
}

function parseJsonLine(text: string): Record<string, unknown> | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
    }
  }
  return null
}

function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return {}
  const fm: Record<string, string> = {}
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!km) continue
    fm[km[1]] = km[2].trim().replace(/^["']|["']$/g, "")
  }
  return fm
}
