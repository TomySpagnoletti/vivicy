/**
 * Vivicy control plane: drive the Naight dev-factory scripts from the app.
 *
 * Server-only. This module owns the policy (single-run lock, path safety, how
 * each factory script is invoked) and stays independent of `child_process` via
 * an injectable {@link Spawner}. Real routes use {@link nodeSpawner}; tests
 * inject a fake so `start` never launches real claude/codex.
 *
 * Roots:
 *   factoryRoot = VIVICY_FACTORY_ROOT ?? <cwd>/factory   (the in-package factory)
 *   targetRoot  = VIVICY_TARGET_ROOT  ?? <cwd>/..        (the project being built)
 *
 * The factory is bundled inside this package (vivicy/factory). The default
 * target is the project Vivicy is vendored into (the parent of the app dir).
 * Scripts are resolved inside factoryRoot and always invoked with
 * VIVICY_TARGET_ROOT=<targetRoot> (plus `--dir <targetRoot>` where the script
 * documents it). Nothing is ever written or spawned outside these two roots.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { settingsToEnv } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"

/** A single detached child process the spawner has launched. */
export interface DetachedHandle {
  pid: number
}

/** Outcome of a script run to completion. */
export interface RunResult {
  code: number | null
  /** Last non-empty line of stdout (trimmed), for surfacing in the UI. */
  lastLine: string
  /** Combined stdout (already collected); kept small by callers. */
  stdout: string
  stderr: string
}

export interface SpawnDetachedOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Absolute path to the file the detached process' stdio is redirected to. */
  logFile: string
}

export interface RunOptions {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

/**
 * Injection seam for process control. The real implementation shells out via
 * `child_process`; tests substitute a fake that records calls and never spawns.
 */
export interface Spawner {
  /** Launch a long-lived process detached from this server; return its pid. */
  spawnDetached(options: SpawnDetachedOptions): DetachedHandle
  /** Run a short-lived script to completion and collect its output. */
  run(options: RunOptions): Promise<RunResult>
  /** Kill a process group by pid. Returns false if the process was already gone. */
  killGroup(pid: number, signal?: NodeJS.Signals): boolean
  /** Whether a process with this pid is currently alive. */
  isAlive(pid: number): boolean
}

/** Persisted lock describing the currently supervised run. */
export interface RunState {
  pid: number
  started_at: string
  target_root: string
  factory_root: string
  log_file: string
  mode: "start" | "resume"
}

/**
 * One rolling quota window's REAL usage, extracted from a provider's transcript.
 * `used_pct` is null when the provider does not expose a percentage (honest
 * unknown — Claude's stream-json gives a reset but no %); the footer shows "—".
 */
export interface QuotaWindow {
  /** Real usage percentage 0–100, or null when the provider exposes none. */
  used_pct: number | null
  /** Real remaining percentage (100 - used_pct), or null when unknown. */
  remaining: number | null
  /** ISO time this window resets, or null when unknown. */
  reset_at: string | null
}

/** The rolling windows the footer surfaces, keyed by canonical label. */
export interface QuotaWindows {
  /** Short rolling window (Codex primary / Claude five_hour). */
  "5h"?: QuotaWindow
  /** Long rolling window (Codex secondary). */
  weekly?: QuotaWindow
}

/** Per-agent quota/rate-limit status, written by the dev-loop quota handler. */
export interface AgentQuota {
  /** Model id the leg runs (e.g. "claude-opus-4-8"), or null when unknown. */
  model: string | null
  /** "available" steady state; "throttled" while waiting out a rate limit. */
  status: "available" | "throttled"
  /** ISO time the quota is expected to reopen, when throttled and parseable. */
  reset_at: string | null
  /** The rate-limit line we matched (honest provenance), or null. */
  last_message: string | null
  /**
   * Real per-window usage (Codex: % for 5h + weekly; Claude: 5h reset only).
   * Absent => unknown; a present window with `used_pct: null` is an honest
   * "we have a reset but no percentage" signal, never a fabricated number.
   */
  windows?: QuotaWindows
  updated_at?: string | null
}

/** The whole quota block: per-agent state keyed by actor (claude / codex). */
export interface QuotaBlock {
  updated_at: string | null
  agents: Record<string, AgentQuota>
}

/** Snapshot returned by {@link readDevStatus}. */
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
  /** Per-agent quota state; absent on older runs => treat as unknown. */
  quota?: QuotaBlock
  [key: string]: unknown
}

/** One step of the extraction sequence. */
export interface ExtractStep {
  name: string
  code: number | null
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
      | "spawn_failed"
  ) {
    super(message)
    this.name = "ControlError"
  }
}

const RUNTIME_DIR_NAME = ".vivicy-runtime"
const RUN_STATE_FILE = "run-state.json"
const LOG_FILE = "supervisor.log"

const SUPERVISOR_SCRIPT = "dev-loop-supervised.mjs"
const STATUS_SCRIPT = "dev-status.mjs"
const SEMANTIC_SCRIPT = "semantic-extraction-check.mjs"
const TRACEABILITY_SCRIPT = "traceability-check.mjs"
const GENERATE_MAP_SCRIPT = "generate-viewer-data.ts"

/** Resolve the in-package factory root (vivicy/factory by default). */
export function getFactoryRoot(): string {
  const fromEnv = process.env.VIVICY_FACTORY_ROOT
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), "factory")
}

/** Resolve the target project the scripts operate on (defaults to the parent of the app). */
export function getControlTargetRoot(): string {
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), "..")
}

/** Absolute path to the Vivicy runtime dir (logs + lock), created on demand. */
export function getRuntimeDir(): string {
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}

function getRunStatePath(): string {
  return path.join(getRuntimeDir(), RUN_STATE_FILE)
}

function getLogPath(): string {
  return path.join(getRuntimeDir(), LOG_FILE)
}

/** Assert `child` resolves inside `root`; throws otherwise. Path-safety guard. */
function assertInside(root: string, child: string): string {
  const abs = path.resolve(root, child)
  const rel = path.relative(root, abs)
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ControlError(`path escapes ${root}: ${child}`, "missing_script")
  }
  return abs
}

/** Resolve a factory script path and verify it exists on disk. */
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
  return { ...process.env, VIVICY_TARGET_ROOT: targetRoot }
}

/** Read the persisted run-state lock, or null when no run is recorded. */
export function readRunState(): RunState | null {
  const file = getRunStatePath()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState
  } catch {
    return null
  }
}

/** Overwrite the lock in place (used to patch the real pid after spawn). */
function updateRunState(state: RunState): void {
  writeFileSync(getRunStatePath(), `${JSON.stringify(state, null, 2)}\n`)
}

/**
 * Atomically claim the single-run lock BEFORE spawning, closing the
 * check-then-spawn TOCTOU window. The lock file is created with the `wx` flag
 * (exclusive create): if it already exists the call fails with EEXIST, and only
 * then do we consult liveness — a stale lock (dead pid) is cleared and the claim
 * retried once; a live lock is refused. Returns the placeholder state written;
 * callers patch the real pid in via {@link updateRunState} after spawn.
 */
function claimRunLock(spawner: Spawner, placeholder: RunState): void {
  mkdirSync(getRuntimeDir(), { recursive: true })
  const file = getRunStatePath()
  const body = `${JSON.stringify(placeholder, null, 2)}\n`
  try {
    writeFileSync(file, body, { flag: "wx" })
    return
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  }
  // A lock already exists: refuse if live, clear and retry once if stale.
  if (isRunActive(spawner)) {
    throw new ControlError("a supervised run is already active", "already_running")
  }
  try {
    writeFileSync(file, body, { flag: "wx" })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Lost a concurrent race to claim the freed lock.
      throw new ControlError("a supervised run is already active", "already_running")
    }
    throw error
  }
}

function clearRunState(): void {
  const file = getRunStatePath()
  if (existsSync(file)) rmSync(file)
}

/**
 * Is a supervised run currently active? A run is active when the lock exists
 * AND the recorded pid is still alive; a stale lock (process gone) is cleared
 * so a fresh start can proceed.
 */
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
  return { factoryRoot: getFactoryRoot(), targetRoot: getControlTargetRoot() }
}

/**
 * Start (or resume) the supervisor detached. Refuses when a run is already
 * active (single-run lock). `mode` only affects the recorded label — the
 * supervisor itself resumes from done/ + the ledger either way.
 */
export function startSupervisor(
  spawner: Spawner,
  mode: "start" | "resume" = "start"
): RunState {
  const { factoryRoot, targetRoot } = resolveContext()

  // Validate inputs before touching the lock so a bad request never leaves a
  // dangling claim.
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const command = resolveScript(factoryRoot, SUPERVISOR_SCRIPT)
  const logFile = getLogPath()

  // The placeholder pid (this server's pid) keeps the lock "live" per isAlive
  // between the atomic claim and patching in the real child pid, so a
  // concurrent claimant correctly sees an active run rather than a stale one.
  const state: RunState = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    target_root: targetRoot,
    factory_root: factoryRoot,
    log_file: logFile,
    mode,
  }

  // Atomically claim the lock BEFORE spawning (closes the TOCTOU window).
  claimRunLock(spawner, state)

  // Per-agent model + thinking level chosen in Settings, surfaced to the dev-loop
  // as VIVICY_CLAUDE_*/VIVICY_CODEX_* env vars so a run uses exactly the user's
  // choices (start AND resume both go through here). Invalid/missing settings
  // normalize to the documented defaults.
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
    // Release the claim so a retry can proceed.
    clearRunState()
    throw new ControlError(
      `failed to spawn supervisor: ${error instanceof Error ? error.message : String(error)}`,
      "spawn_failed"
    )
  }

  // Patch in the real child pid now that the process exists.
  state.pid = handle.pid
  updateRunState(state)
  return state
}

/**
 * Stop the supervised run by killing its process group and clearing the lock.
 * Refuses when no run is recorded.
 */
export function stopSupervisor(spawner: Spawner): { pid: number } {
  const state = readRunState()
  if (!state) {
    throw new ControlError("no supervised run is recorded", "not_running")
  }
  spawner.killGroup(state.pid, "SIGTERM")
  clearRunState()
  return { pid: state.pid }
}

/**
 * Read dev-status as JSON by running `dev-status.mjs --dir <target> --json`.
 * Layers in whether a supervised run is active per the lock.
 */
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

/**
 * Run the deterministic extraction VERIFICATION + map regeneration in order:
 *   1. semantic-extraction-check.mjs
 *   2. traceability-check.mjs
 *   3. generate-viewer-data.ts
 * Each step runs regardless of the previous one's exit code so the caller sees
 * every result; the response carries each step's code + last line.
 */
export async function runExtract(spawner: Spawner): Promise<ExtractStep[]> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }

  const steps: Array<{ name: string; script: string }> = [
    { name: "semantic-extraction-check", script: SEMANTIC_SCRIPT },
    { name: "traceability-check", script: TRACEABILITY_SCRIPT },
    { name: "generate-viewer-data", script: GENERATE_MAP_SCRIPT },
  ]

  const out: ExtractStep[] = []
  for (const step of steps) {
    const command = resolveScript(factoryRoot, step.script)
    const result = await spawner.run({
      command: process.execPath,
      args: [command],
      cwd: factoryRoot,
      env: devEnv(targetRoot),
    })
    out.push({
      name: step.name,
      code: result.code,
      lastLine: result.lastLine || result.stderr.trim().split("\n").filter(Boolean).at(-1) || "",
    })
  }
  return out
}
