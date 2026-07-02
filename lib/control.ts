/**
 * Vivicy control plane: drive the Vivicy dev-factory scripts from the app.
 *
 * Server-only. This module owns the policy (single-run lock, path safety, how
 * each factory script is invoked) and stays independent of `child_process` via
 * an injectable {@link Spawner}. Real routes use {@link nodeSpawner}; tests
 * inject a fake so `start` never launches real claude/codex.
 *
 * Roots:
 *   factoryRoot = VIVICY_FACTORY_ROOT ?? <cwd>/factory   (the in-package factory)
 *   targetRoot  = the UI-chosen project (persisted) ?? VIVICY_TARGET_ROOT
 *                 (the project being built; resolved by {@link getTargetRoot})
 *
 * The factory is bundled inside this package (vivicy/factory). The target is the
 * project the user picked from the UI (R10), falling back to the env override;
 * with neither, there is no target and {@link resolveContext} refuses with a
 * `missing_target` error rather than guessing a directory (Vivicy is standalone).
 * Scripts are resolved inside factoryRoot and always invoked with
 * VIVICY_TARGET_ROOT=<targetRoot> (plus `--dir <targetRoot>` where the script
 * documents it). Nothing is ever written or spawned outside these two roots.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getRuntimeDir } from "@/lib/runtime-dir"
import { settingsToEnv } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"
import {
  getStagingDir,
  normalizeStaging,
  readReport,
  type NormalizedFile,
  type NormalizationProblem,
} from "@/lib/upload"

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
  /**
   * ISO time the Claude status-line quota probe last ran (claude only). Used to
   * throttle the probe to once per refresh window; durable across loop restarts.
   */
  last_probe_at?: string | null
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

/**
 * Outcome of a full extraction run (freeze -> author -> verify -> map). `ok` is
 * true only when the orchestrator reached green; `blocked` is true when the
 * deterministic checks stayed red after the bounded retries (a human must look) —
 * surfaced honestly to the caller rather than hidden behind a generic failure.
 */
export interface ExtractResult {
  ok: boolean
  blocked: boolean
  /** Terminal phase the orchestrator reported: "green" | "extraction_blocked". */
  status: string
  /** One-line human summary (issue count on green, the failing checks on block). */
  summary: string
  /** The orchestrator's raw last stdout line (provenance for the UI). */
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
  ) {
    super(message)
    this.name = "ControlError"
  }
}

const RUN_STATE_FILE = "run-state.json"
const LOG_FILE = "supervisor.log"

const SUPERVISOR_SCRIPT = "dev-loop-supervised.mjs"
const STATUS_SCRIPT = "dev-status.mjs"
// The single orchestrator that AUTHORS the issues from the frozen spec, then
// validates and regenerates the map (freeze -> author -> verify -> map). The
// agent leg lives inside this script; the control plane only launches it.
const EXTRACT_SCRIPT = "extract-issues.mjs"
// The S1-import CHECK: one agent leg reads a normalized upload corpus and writes
// its verdict report. The agent leg lives inside this script; the control plane
// only launches it (same pattern as EXTRACT_SCRIPT) — see runUploadVerify.
const UPLOAD_VERIFY_SCRIPT = "verify-upload.mjs"
// The Change-Request registry validator, which also carries the `decide` subcommand
// that records an owner decision deterministically (no agent) — see decideCr.
const CHANGE_CONTROL_SCRIPT = "change-control.mjs"
// The CR APPLICATION chain (G7): apply -> re-freeze -> re-extract -> re-drive for an
// approved CR. A standalone factory script; the agent APPLY leg lives inside it and the
// control plane only launches it (same pattern as EXTRACT_SCRIPT) — see decideCr.
const CR_APPLY_SCRIPT = "cr-apply.mjs"

/** Resolve the in-package factory root (vivicy/factory by default). */
export function getFactoryRoot(): string {
  const fromEnv = process.env.VIVICY_FACTORY_ROOT
  if (fromEnv && fromEnv.trim().length > 0) return path.resolve(fromEnv)
  return path.resolve(process.cwd(), "factory")
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
  const targetRoot = getTargetRoot()
  if (targetRoot === null) {
    throw new ControlError("no project selected — choose a target project first", "missing_target")
  }
  return { factoryRoot: getFactoryRoot(), targetRoot }
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

/** Repo-relative status the extraction orchestrator writes as it runs. */
const EXTRACTION_STATUS_FILE = ".vivicy/development/reports/extraction-status.json"

/**
 * AUTHOR the issues from the frozen canonical spec, then validate and regenerate
 * the map. This drives the single `extract-issues.mjs` orchestrator, which:
 *   1. freezes .vivicy/canonical/** if no frozen baseline exists (else reuses it),
 *   2. spawns a real agent to author the full corpus (catalog, matrix, exclusions,
 *      vertical issues, issue index, architecture map),
 *   3. runs the deterministic checks (semantic-extraction + traceability),
 *   4. re-prompts the agent to FIX on a red check (bounded retries), and
 *   5. regenerates architecture-data.json on green.
 *
 * The agent leg lives INSIDE the orchestrator; this control plane only launches
 * the script through the injected {@link Spawner} (so tests never spawn an agent).
 * The blocked case — checks still red after the retries — is surfaced honestly via
 * {@link ExtractResult.blocked}, read back from the status file the orchestrator
 * writes, never hidden behind a generic failure.
 */
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

  // The orchestrator exits 0 on green and non-zero when blocked or erroring; the
  // status file it writes is the source of truth for WHICH terminal state. Read it
  // back so the UI can tell "blocked for a human" from a transient script error.
  const status = readExtractionStatus(targetRoot)
  const blocked = status?.phase === "extraction_blocked"
  const ok = result.code === 0 && status?.phase === "green"

  return {
    ok,
    blocked,
    // Never claim "green" without a green status file backing it: a 0 exit with no
    // (or unparseable) status is an honest "error", not a silent success.
    status: status?.phase ?? "error",
    summary: status?.summary ?? lastLine,
    lastLine,
  }
}

/**
 * Pre-flight guard: extraction needs a real canonical corpus. The scaffold ships
 * a placeholder README.md in `.vivicy/canonical/`, and canonical docs are numbered
 * area files by contract — so "real" means at least one non-README `.md` anywhere
 * under the canonical dir. Without this, "Extract from docs" launches agents into
 * an empty spec and spins until the retry budget dies.
 */
function assertRealCanonical(targetRoot: string): void {
  const canonicalDir = path.join(targetRoot, ".vivicy", "canonical")
  if (!existsSync(canonicalDir)) {
    throw new ControlError(
      `no canonical directory at ${path.join(".vivicy", "canonical")} — import or write the spec before extracting`,
      "empty_canonical"
    )
  }
  const stack = [canonicalDir]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
        return
      }
    }
  }
  throw new ControlError(
    "canonical is empty (only the scaffold README) — write or import canonical docs (01-<area>.md, ...) before extracting",
    "empty_canonical"
  )
}

/** Read the orchestrator's terminal status file (best-effort). */
function readExtractionStatus(
  targetRoot: string
): { phase?: string; summary?: string } | null {
  const file = path.join(targetRoot, EXTRACTION_STATUS_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { phase?: string; summary?: string }
  } catch {
    return null
  }
}

/**
 * Outcome of the S1-import CHECK (G1): the deterministic normalization pass plus
 * the agent verdict. `verdict` is "green" only when the CHECK leg wrote a green
 * report AND normalization had no fatal problem; a red verdict (or a leg that died
 * without a report) is surfaced honestly rather than hidden — nothing is placed
 * downstream unless this is green.
 */
export interface UploadVerifyResult {
  ok: boolean
  verdict: "green" | "red"
  problems: Array<{ file: string; kind: string; detail: string }>
  summary: string
  normalized: NormalizedFile[]
}

/**
 * VERIFY a staged upload (G1's check-then-place gate). Two passes:
 *   1. deterministic NORMALIZATION (lib/upload normalizeStaging) into
 *      <staging>/normalized/ — .txt/.doc/.docx -> MD, map verbatim; a per-file
 *      conversion problem excludes that file and continues.
 *   2. the agent CHECK — drives `verify-upload.mjs` through the injected
 *      {@link Spawner} (identical control-plane pattern to {@link runExtract}); the
 *      script spawns ONE claude leg (role upload-verifier) that reads the normalized
 *      corpus and writes <staging>/report.json { verdict, problems, summary }.
 *
 * The agent leg lives INSIDE the script; this control plane only launches it (so
 * tests inject a fake spawner and never spawn claude). The final verdict is green
 * only when the report says green AND normalization produced no problems — the
 * report is the source of truth for the AGENT half, and a red normalization is a
 * fatal problem the agent never gets to override.
 */
export async function runUploadVerify(
  spawner: Spawner,
  stagingId: string
): Promise<UploadVerifyResult> {
  const { factoryRoot, targetRoot } = resolveContext()
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  const stagingDir = getStagingDir(stagingId)
  if (!existsSync(stagingDir)) {
    throw new ControlError(`unknown staging id: ${stagingId}`, "missing_target")
  }
  const command = resolveScript(factoryRoot, UPLOAD_VERIFY_SCRIPT)

  // Deterministic normalization first; its per-file problems are fatal (they mean
  // a file could not be normalized), so a non-empty problems list forces red.
  const { normalized, problems: normProblems } = normalizeStaging(stagingId)

  // The agent CHECK. VIVICY_TARGET_ROOT lets the leg cross-check the normalized
  // corpus against the target's EXISTING .vivicy/canonical docs; --staging points
  // it at the corpus + the report path it must write.
  const result = await spawner.run({
    command: process.execPath,
    args: [command, "--staging", stagingDir],
    cwd: factoryRoot,
    env: devEnv(targetRoot),
  })

  const report = readReport(stagingId)
  const lastLine =
    result.lastLine || result.stderr.trim().split("\n").filter(Boolean).at(-1) || ""

  // Honest verdict: green requires the script to have exited 0, a green report, AND
  // no fatal normalization problem. Any other combination is red — a missing report
  // (a dead/timed-out leg) or a red report both fail closed, never a silent pass.
  const reportGreen = result.code === 0 && report?.verdict === "green"
  const verdict: "green" | "red" =
    reportGreen && normProblems.length === 0 ? "green" : "red"

  return {
    ok: verdict === "green",
    verdict,
    problems: mergeUploadProblems(normProblems, report),
    summary: report?.summary ?? lastLine ?? "upload verification produced no report",
    normalized,
  }
}

/** Combine the deterministic normalization problems with the agent report's. */
function mergeUploadProblems(
  normProblems: NormalizationProblem[],
  report: { problems?: Array<{ file: string; kind: string; detail: string }> } | null
): Array<{ file: string; kind: string; detail: string }> {
  const fromReport = Array.isArray(report?.problems) ? report.problems : []
  return [...normProblems, ...fromReport]
}

// ---------------------------------------------------------------------------
// Change requests (G7 — the CR decision + application chain, control-plane verbs)
// ---------------------------------------------------------------------------

/** Repo-relative registry directory the CR files live under. */
const CHANGE_REQUESTS_DIR = ".vivicy/change-requests"
/** Repo-relative dir the cr-apply chain writes its per-CR progress report into. */
const REPORTS_DIR = ".vivicy/development/reports"
/** Non-CR files in the registry directory (the template + the readme). */
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"])

/** One CR as surfaced to the UI/CLI list — read-only display data. */
export interface ChangeRequestSummary {
  id: string
  title: string
  status: string
  classification: string
  created_at: string | null
  source: string | null
}

/**
 * Outcome of a CR decision (G7). `recorded` is always true once the deterministic
 * decision landed; for an APPROVED CR the application chain then ran, and `applied`
 * carries its terminal state (green vs. blocked, surfaced honestly like {@link ExtractResult}).
 * A rejection records the decision only — no chain, `applied` absent.
 */
export interface DecideCrResult {
  ok: boolean
  id: string
  decision: "approved" | "rejected"
  /** The registry status after the decision (accepted_current_build | rejected). */
  status: string
  /** Present for an approval: the apply chain's terminal state. */
  applied?: {
    ok: boolean
    blocked: boolean
    status: "green" | "blocked" | string
    summary: string
  }
  summary: string
}

/**
 * List the change requests as read-only display data for the UI/CLI. Deterministic
 * disk read (no agent, no spawn): the registry frontmatter is parsed directly here —
 * change-control.mjs stays the VALIDATOR of record (the `decide`/apply paths and the
 * extraction gate enforce well-formedness); this is a lightweight projection for
 * display, mirroring how {@link readDevStatus} reads status files rather than owning
 * their schema. Malformed/ template files are skipped, never surfaced.
 */
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
    if (!/^CR-\d{4}$/.test(id)) continue // only well-identified CRs are display rows
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

/**
 * Record the owner decision on a CR (G7 — P2's single human touchpoint), and, for an
 * APPROVAL, run the application chain. Two factory steps, both launched through the
 * injected {@link Spawner} (so tests never spawn agents):
 *   1. DECIDE — `change-control.mjs decide` records the decision deterministically
 *      (approved -> accepted_current_build with previous_* from the frozen baseline;
 *      rejected -> rejected). It prints a JSON line the control plane reads.
 *   2. APPLY (approvals only) — `cr-apply.mjs --cr <id>` runs apply -> re-freeze ->
 *      re-extract -> re-drive; the agent APPLY leg lives inside the script. Its terminal
 *      state is read back from the cr-apply-<id>.json report (blocked vs green surfaced
 *      honestly, exactly as {@link runExtract} does for extraction).
 *
 * `decidedBy` is the actor recorded as owner_decision_by (the route passes "owner:ui";
 * the G14 CLI passes its own actor) — honest provenance, never an agent self-assertion.
 */
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

  // 1. DECIDE — deterministic, no agent. The subcommand exits 0 with a JSON line on
  // success; non-zero with a JSON error otherwise. Map its known failures to typed
  // ControlErrors so the route can surface them (422) distinctly from a spawn error.
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

  // A rejection stops here — the decision is the whole outcome (no chain).
  if (decision === "rejected") {
    return { ok: true, id, decision, status, summary: `CR ${id} rejected` }
  }

  // 2. APPLY chain (approvals) — spawn cr-apply.mjs; read its terminal report back.
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

/** Map a change-control `decide` failure message to a typed ControlError. */
function classifyDecisionError(id: string, message: string): ControlError {
  if (/no CR with id/i.test(message)) return new ControlError(`unknown change request: ${id}`, "unknown_cr")
  if (/only idea\|under_review|can be decided|only .* can be/i.test(message)) {
    return new ControlError(message, "cr_not_decidable")
  }
  if (/no frozen baseline/i.test(message)) return new ControlError(message, "cr_not_decidable")
  return new ControlError(message, "spawn_failed")
}

/** Read the cr-apply chain's terminal report for a CR (best-effort). */
function readCrApplyReport(targetRoot: string, id: string): { status?: string; summary?: string } | null {
  const file = path.join(targetRoot, REPORTS_DIR, `cr-apply-${id}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, "utf8")) as { status?: string; summary?: string }
  } catch {
    return null
  }
}

/** Parse one JSON object from text (the first `{...}` line), or null. */
function parseJsonLine(text: string): Record<string, unknown> | null {
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // keep scanning — a non-JSON `{` line is not the payload
    }
  }
  return null
}

/**
 * Minimal, dependency-free frontmatter reader for the CR list (read-only display).
 * Mirrors change-control.mjs's parser: the `--- ... ---` block's `key: value` lines,
 * unquoted. This is display projection only; change-control.mjs stays the validator.
 */
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
