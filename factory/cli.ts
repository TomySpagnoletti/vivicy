#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getProjectRuntimeDir } from "../lib/project-runtime.ts";
import { clearSpecCycle, featureCycleOpenRefusal, isSpecCycleOpen, readSpecCycle, writeSpecCycle } from "../lib/spec-cycle.ts";

// cli.ts and lib/control.ts must not import each other — parity comes from both spawning the same factory scripts and reading the same state files, never shared code.
const cliDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(cliDir, "..");

// Keep symmetric with lib/control.ts's getFactoryRoot — same default/override on both clients.
function factoryRootDir() {
  const fromEnv = process.env.VIVICY_FACTORY_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return cliDir;
}
const factoryDir = factoryRootDir();

const EXIT_OK = 0;
const EXIT_REFUSAL = 1;
const EXIT_USAGE = 2;
const EXIT_UNEXPECTED = 3;

const RUN_STATE_FILE = "run-state.json";
const LOG_FILE = "supervisor.log";
const RUNTIME_DIR_NAME = ".vivicy-runtime";

const SUPERVISOR_SCRIPT = "dev-loop-supervised.ts";
const STATUS_SCRIPT = "dev-status.ts";
const EXTRACT_SCRIPT = "extract-issues.ts";
const CHANGE_CONTROL_SCRIPT = "change-control.ts";
const CR_APPLY_SCRIPT = "cr-apply.ts";
const SKILLS_SCRIPT = "install-skills.ts";
const PREPARE_SCRIPT = "prepare-docs.ts";

// Repo-relative state files the app reads too — the CLI reads the SAME ones.
const EXTRACTION_STATUS_REL = ".vivicy/development/reports/extraction-status.json";
const SKILLS_REPORT_REL = ".vivicy/development/reports/skills-report.json";
const DOC_PREP_REPORT_REL = ".vivicy/development/reports/doc-prep-report.json";
const CHANGE_REQUESTS_DIR = ".vivicy/change-requests";
const REPORTS_DIR = ".vivicy/development/reports";
// Notification log format: NDJSON, one { ts, level, stage, event, message, dismissed? } per line; a missing/empty file reads as [] (never an error).
const NOTIFICATIONS_REL = "notifications.jsonl";
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"]);

const HELP = `Vivicy — a visual autonomous dev factory (agent-drivable control surface).

Usage:
  vivicy status        [--dir <d>] [--json]        merged run/dev/extraction health
  vivicy prepare       [--dir <d>] [--json]        prepare imported docs into canonical (sync); no args reads the report
  vivicy extract       [--dir <d>]                 author issues from canonical (sync)
  vivicy start         [--dir <d>]                 launch the resumable supervisor (detached)
  vivicy resume        [--dir <d>]                 relaunch the supervisor (resumes)
  vivicy stop          [--dir <d>]                 stop the supervised run (per-project lock)
  vivicy crs           [--json]                    list change requests
  vivicy cr approve <id> --by <actor>              decide + apply an approved CR
  vivicy cr reject  <id> --by <actor>              decide (reject) a CR
  vivicy skills        [--dir <d>] [--json]        read the project-skills report
  vivicy skills install [ids...] [--dir <d>]       select/audit/install project skills (sync)
  vivicy skills remove <ids...> [--dir <d>]        uninstall project skills (deterministic)
  vivicy retry-stage <stage>                       re-run a retryable stage (prepare|extract|skills|dev)
  vivicy cycle <open|cancel|status> [--dir <d>]    spec-cycle transitions (extraction closes cycles)
  vivicy notifications [--dir <d>] [--json]        read the notification log (per-project)
  vivicy app           [--target <d>] [--port <n>] start the visual control plane
  vivicy loop          [--target <d>]              run the two-agent dev loop once
  vivicy supervise     [--target <d>]              run the resumable supervisor (attached)
  vivicy rehearsal     [--dry]                      end-to-end method rehearsal
  vivicy --help

Agent contract: --json prints one JSON object on stdout (nothing else); exit
0 ok · 1 refusal · 2 usage · 3 unexpected. No prompts. Target: --dir/--target
or VIVICY_TARGET_ROOT (the persisted UI project is NOT read here).
`;

interface Opts {
  runtimeDir?: string | null;
}

interface VivicyError extends Error {
  vivicyCode?: number;
}

// byte-compatible with lib/control.ts's RunState — cross-process lock reads depend on this shape.
interface RunState {
  pid: number;
  started_at?: string;
  target_root?: string;
  factory_root?: string;
  log_file?: string;
  mode?: string;
}

interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CrSummary {
  id: string;
  title: string;
  status: string;
  classification: string;
  created_at: string | null;
  source: string | null;
}

interface ExtractionStatus {
  phase?: string;
  spike_mode?: string;
  map_mode?: string;
  spike_proving?: unknown;
  summary?: string;
}

// Schema of record is install-skills.ts's writer — this is a partial read-only projection.
interface SkillsReport {
  phase?: string;
  baseline_id?: string | null;
  mode?: string;
  installed?: unknown[];
  rejected?: unknown[];
  summary?: string;
  updated_at?: string;
}

// Schema of record is prepare-docs.ts's writer — this is a partial read-only projection.
interface DocPrepReport {
  phase?: string;
  cycle_id?: string | null;
  batches_consumed?: string[];
  batches_pending?: string[];
  language?: string;
  placed?: unknown[];
  rejected?: unknown[];
  summary?: string;
  updated_at?: string;
}

interface CrApplyReport {
  cr?: string | null;
  status?: string | null;
  phase?: string | null;
  summary?: string | null;
  updated_at?: string | null;
}

interface Notification {
  ts?: string;
  level?: string;
  stage?: string;
  event?: string;
  message?: string;
  dismissed?: boolean;
}

interface EmitObject {
  ok: boolean;
  blocked?: boolean;
  summary?: string;
  [key: string]: unknown;
}

function takeFlag(argv: string[], name: string): string | null {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const value = argv[i + 1];
  const hasValue = value !== undefined && !value.startsWith("--");
  argv.splice(i, hasValue ? 2 : 1);
  return hasValue ? value : null;
}

function takeBool(argv: string[], name: string): boolean {
  const i = argv.indexOf(name);
  if (i === -1) return false;
  argv.splice(i, 1);
  return true;
}

function emitJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

function fail(json: boolean, code: number, message: string, extra: Record<string, unknown> = {}): never {
  if (json) emitJson({ ok: false, error: message, ...extra });
  else note(`vivicy: ${message}`);
  process.exit(code);
}

// Deliberately not process.cwd() — vivicy may run from anywhere; this default must equal the app's getRuntimeDir() default (both anchor to the package root) so a CLI run and the UI agree on one lock.
function runtimeDir(opts: Opts = {}): string {
  if (opts.runtimeDir) return resolve(opts.runtimeDir);
  const fromEnv = process.env.VIVICY_RUNTIME_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(appDir, RUNTIME_DIR_NAME);
}

function projectDir(opts: Opts, target: string): string {
  return getProjectRuntimeDir(runtimeDir(opts), target);
}

function runStatePath(opts: Opts, target: string): string {
  return join(projectDir(opts, target), RUN_STATE_FILE);
}

function logPath(opts: Opts, target: string): string {
  return join(projectDir(opts, target), LOG_FILE);
}

function readRunState(opts: Opts, target: string): RunState | null {
  const file = runStatePath(opts, target);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState;
  } catch {
    return null;
  }
}

// Signal 0 probes existence without sending an actual signal (POSIX idiom).
function isAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Mirrors lib/control.ts's isRunActive — keep both in sync.
function isRunActive(opts: Opts, target: string): boolean {
  const state = readRunState(opts, target);
  if (!state) return false;
  if (isAlive(state.pid)) return true;
  rmSync(runStatePath(opts, target), { force: true });
  return false;
}

// Target is env/flag only, by design — never the persisted UI project (.vivicy-runtime/current-project.json), or a CLI run could silently act on whatever project the UI last picked.
function resolveTarget(argv: string[]): string | null {
  const flag = takeFlag(argv, "--dir") ?? takeFlag(argv, "--target");
  if (flag && flag.trim().length > 0) return resolve(flag);
  const fromEnv = process.env.VIVICY_TARGET_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return null;
}

function scriptPath(name: string): string {
  const abs = join(factoryDir, name);
  if (!existsSync(abs)) {
    const err: VivicyError = new Error(`factory script not found: ${name} (looked under ${factoryDir})`);
    err.vivicyCode = EXIT_UNEXPECTED;
    throw err;
  }
  return abs;
}

function childEnv(target: string, opts: Opts = {}): NodeJS.ProcessEnv {
  // Matches lib/control.ts's devEnv — VIVICY_RUNTIME_DIR is project-scoped, not root.
  return { ...process.env, VIVICY_TARGET_ROOT: target, VIVICY_RUNTIME_DIR: projectDir(opts, target) };
}

// Streams child output to OUR stderr only (stdout stays reserved for the final --json object). Factory CLIs may print their JSON result on stdout OR stderr (e.g. change-control's decide errors go to stderr), so callers must parse both.
function runScript(
  command: string,
  args: string[],
  { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<ScriptResult> {
  return new Promise((res) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      process.stderr.write(text);
    });
    child.stderr!.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      process.stderr.write(text);
    });
    child.on("error", (error) => res({ code: null, stdout, stderr, error }));
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

function readJsonFile<T>(file: string, fallback: T | null = null): T | null {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

// Mirrors lib/control.ts's parseJsonLine exactly — keep both in sync.
function parseJsonLine(text: string): Record<string, unknown> | null {
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
    }
  }
  return null;
}

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const s = String(text);
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Mirrors lib/control.ts's parseFrontmatter and change-control.ts's parser — keep all three in sync.
function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (km) fm[km[1]] = km[2].trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

function passthrough(
  command: string,
  args: string[],
  { cwd, env }: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
  const child = spawn(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

async function cmdStatus(argv: string[], opts: Opts): Promise<void> {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(
      json,
      EXIT_USAGE,
      "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT",
      { code: "missing_target" }
    );
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, {
      code: "missing_target",
    });
  }

  const lock = readRunState(opts, target);
  const runActive = isRunActive(opts, target);
  const run = lock
    ? {
        pid: lock.pid,
        alive: isAlive(lock.pid),
        mode: lock.mode ?? null,
        started_at: lock.started_at ?? null,
        target_root: lock.target_root ?? null,
      }
    : null;

  // Best-effort: an unreadable dev-status degrades to dev: null rather than failing the whole merged view — the lock, extraction, and CR sources are still worth returning.
  let devStatus = null;
  try {
    const dev = await runScript(process.execPath, [scriptPath(STATUS_SCRIPT), "--dir", target, "--json"], {
      cwd: factoryDir,
      env: childEnv(target, opts),
    });
    devStatus = parseJsonBlock(dev.stdout);
  } catch {
    devStatus = null;
  }

  const extraction = readJsonFile<ExtractionStatus>(join(target, EXTRACTION_STATUS_REL));

  const latestCrApply = readLatestCrApply(target);

  const pendingCrs = countPendingCrs(target);

  emitJsonOrHuman(json, {
    ok: true,
    target,
    run,
    run_active: runActive,
    dev: devStatus
      ? {
          verdict: devStatus.verdict ?? null,
          issues_done: devStatus.issues_done ?? null,
          issues_total: devStatus.issues_total ?? null,
          process_alive: devStatus.process_alive ?? null,
          idle_seconds: devStatus.idle_seconds ?? null,
          gates: devStatus.gates ?? null,
          active: devStatus.active ?? [],
          ...(devStatus.quota ? { quota: devStatus.quota } : {}),
        }
      : null,
    extraction: extraction
      ? {
          phase: extraction.phase ?? null,
          spike_mode: extraction.spike_mode ?? null,
          map_mode: extraction.map_mode ?? null,
          ...(extraction.spike_proving ? { spike_proving: extraction.spike_proving } : {}),
          summary: extraction.summary ?? null,
        }
      : null,
    cr_apply: latestCrApply,
    pending_crs: pendingCrs,
  });
  process.exit(EXIT_OK);
}

function readLatestCrApply(target: string): CrApplyReport | null {
  const dir = join(target, REPORTS_DIR);
  if (!existsSync(dir)) return null;
  let newest: { when: number; value: CrApplyReport } | null = null;
  for (const file of readdirSync(dir)) {
    if (!/^apply-CR-\d{4}\.json$/.test(file)) continue;
    const report = readJsonFile<CrApplyReport>(join(dir, file));
    if (!report) continue;
    const when = Date.parse(report.updated_at ?? "") || 0;
    if (!newest || when > newest.when) {
      newest = {
        when,
        value: {
          cr: report.cr ?? null,
          status: report.status ?? null,
          phase: report.phase ?? null,
          summary: report.summary ?? null,
          updated_at: report.updated_at ?? null,
        },
      };
    }
  }
  return newest?.value ?? null;
}

function readCrSummaries(target: string): CrSummary[] {
  const dir = join(target, CHANGE_REQUESTS_DIR);
  if (!existsSync(dir)) return [];
  const crs: CrSummary[] = [];
  for (const file of readdirSync(dir).sort()) {
    const lower = file.toLowerCase();
    if (!lower.endsWith(".md") || NON_CR_FILES.has(lower)) continue;
    const fm = parseFrontmatter(readFileSync(join(dir, file), "utf8"));
    const id = typeof fm.id === "string" ? fm.id : "";
    if (!/^CR-\d{4}$/.test(id)) continue;
    crs.push({
      id,
      title: typeof fm.title === "string" ? fm.title : id,
      status: typeof fm.status === "string" ? fm.status : "",
      classification: typeof fm.classification === "string" ? fm.classification : "",
      created_at: typeof fm.created_at === "string" ? fm.created_at : null,
      source: typeof fm.source === "string" ? fm.source : null,
    });
  }
  return crs;
}

function countPendingCrs(target: string): number {
  return readCrSummaries(target).filter((c) => c.status === "idea" || c.status === "under_review")
    .length;
}

async function cmdExtract(argv: string[], opts: Opts): Promise<void> {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }

  note("vivicy: extracting issues from canonical (this spawns a real agent leg)…");
  const res = await runScript(process.execPath, [scriptPath(EXTRACT_SCRIPT)], {
    cwd: factoryDir,
    env: childEnv(target, opts),
  });

  const status = readJsonFile<ExtractionStatus>(join(target, EXTRACTION_STATUS_REL));
  const phase = status?.phase ?? "error";
  const summary = status?.summary ?? lastLine(res.stdout) ?? "extraction produced no status";
  const ok = res.code === 0 && phase === "green";
  const blocked = phase === "extraction_blocked" || phase === "blocked_on_unverified_spikes";

  emitJsonOrHuman(json, {
    ok,
    blocked,
    phase,
    ...(status?.spike_mode ? { spike_mode: status.spike_mode } : {}),
    ...(status?.map_mode ? { map_mode: status.map_mode } : {}),
    ...(status?.spike_proving ? { spike_proving: status.spike_proving } : {}),
    summary,
  });
  process.exit(ok ? EXIT_OK : EXIT_REFUSAL);
}

function startSupervisor(argv: string[], opts: Opts, mode: string): void {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }

  if (isSpecCycleOpen(target)) {
    return fail(json, EXIT_REFUSAL, "a drafting spec cycle is open — run `vivicy extract` to freeze it (or `vivicy cycle cancel`) before building", {
      code: "cycle_state",
    });
  }

  if (isRunActive(opts, target)) {
    const lock = readRunState(opts, target);
    return fail(json, EXIT_REFUSAL, "a supervised run is already active", {
      code: "already_running",
      run: lock ? { pid: lock.pid, mode: lock.mode ?? null } : null,
    });
  }

  const command = scriptPath(SUPERVISOR_SCRIPT);
  mkdirSync(projectDir(opts, target), { recursive: true });
  const logFile = logPath(opts, target);

  // Claims the lock (wx exclusive, placeholder pid = ours) BEFORE spawning to close the check-then-spawn TOCTOU window — mirrors lib/control.ts's claimRunLock; a lost race (EEXIST) is a refusal.
  const placeholder = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    target_root: target,
    factory_root: factoryDir,
    log_file: logFile,
    mode,
  };
  try {
    writeFileSync(runStatePath(opts, target), `${JSON.stringify(placeholder, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      return fail(json, EXIT_REFUSAL, "a supervised run is already active", { code: "already_running" });
    }
    throw error;
  }

  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [command], {
      cwd: factoryDir,
      env: childEnv(target, opts),
      detached: true,
      stdio: ["ignore", out, err],
    });
  } catch (error) {
    rmSync(runStatePath(opts, target), { force: true });
    return fail(json, EXIT_UNEXPECTED, `failed to spawn supervisor: ${errText(error)}`, {
      code: "spawn_failed",
    });
  }
  if (typeof child.pid !== "number") {
    rmSync(runStatePath(opts, target), { force: true });
    return fail(json, EXIT_UNEXPECTED, "supervisor did not start (no pid)", { code: "spawn_failed" });
  }
  child.unref();

  const state = { ...placeholder, pid: child.pid };
  writeFileSync(runStatePath(opts, target), `${JSON.stringify(state, null, 2)}\n`);

  note(`vivicy: supervisor ${mode} — pid ${child.pid}, log ${logFile}`);
  emitJsonOrHuman(json, { ok: true, run: state });
  process.exit(EXIT_OK);
}

function cmdStop(argv: string[], opts: Opts): void {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT (the run lock is per project)", {
      code: "missing_target",
    });
  }
  const state = readRunState(opts, target);
  if (!state) {
    return fail(json, EXIT_REFUSAL, "no supervised run is recorded", { code: "not_running" });
  }
  // Negative pid kills the whole process group (so the supervisor's relaunched children die too), falling back to the single pid; same teardown as lib/control.ts stopSupervisor.
  killGroup(state.pid);
  rmSync(runStatePath(opts, target), { force: true });
  note(`vivicy: stopped supervised run pid ${state.pid}`);
  emitJsonOrHuman(json, { ok: true, stopped: { pid: state.pid } });
  process.exit(EXIT_OK);
}

function killGroup(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }
}

function cmdCrs(argv: string[]): void {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const crs = readCrSummaries(target);
  if (json) {
    emitJson({ ok: true, crs });
  } else if (crs.length === 0) {
    note("(no change requests)");
  } else {
    for (const c of crs) note(`${c.id}  ${c.status.padEnd(24)}  ${c.classification.padEnd(22)}  ${c.title}`);
  }
  process.exit(EXIT_OK);
}

async function cmdCr(argv: string[], opts: Opts): Promise<void> {
  const json = takeBool(argv, "--json");
  const decision = argv.shift();
  const id = argv[0] && !argv[0].startsWith("--") ? argv.shift() : null;
  const by = takeFlag(argv, "--by");
  const target = resolveTarget(argv);

  if (decision !== "approve" && decision !== "reject") {
    return fail(json, EXIT_USAGE, "usage: vivicy cr approve|reject <id> --by <actor>", {
      code: "usage",
    });
  }
  if (!id || !/^CR-\d{4}$/.test(id)) {
    return fail(json, EXIT_USAGE, "a CR id of the form CR-#### is required", { code: "usage" });
  }
  if (!by || by.trim().length === 0) {
    return fail(json, EXIT_USAGE, "--by <actor> is required (honest owner-decision provenance)", {
      code: "usage",
    });
  }
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }

  const decisionWord = decision === "approve" ? "approved" : "rejected";

  // change-control.ts reads VIVICY_TARGET_ROOT only (no --dir) — target must ride the env.
  note(`vivicy: recording decision ${decisionWord} on ${id} (by ${by})…`);
  const decideRes = await runScript(
    process.execPath,
    [scriptPath(CHANGE_CONTROL_SCRIPT), "decide", "--cr", id, "--decision", decisionWord, "--by", by],
    { cwd: factoryDir, env: childEnv(target, opts) }
  );
  const decided = parseJsonLine(decideRes.stdout) ?? parseJsonLine(decideRes.stderr);
  if (decideRes.code !== 0 || !decided?.ok) {
    const message =
      (decided && typeof decided.error === "string" && decided.error) ||
      lastLine(decideRes.stderr) ||
      lastLine(decideRes.stdout) ||
      "decision failed";
    const code = decideRes.code === 2 ? EXIT_USAGE : EXIT_REFUSAL;
    return fail(json, code, message, { id, code: classifyDecisionCode(message) });
  }
  const status =
    typeof decided.status === "string"
      ? decided.status
      : decisionWord === "approved"
        ? "accepted_current_build"
        : "rejected";

  if (decisionWord === "rejected") {
    emitJsonOrHuman(json, { ok: true, id, decision: decisionWord, status, summary: `CR ${id} rejected` });
    process.exit(EXIT_OK);
  }

  note(`vivicy: applying ${id} (apply -> re-freeze -> re-extract -> reopen impacted issues)…`);
  const applyRes = await runScript(process.execPath, [scriptPath(CR_APPLY_SCRIPT), "--cr", id], {
    cwd: factoryDir,
    env: childEnv(target, opts),
  });
  const report = readJsonFile<CrApplyReport>(join(target, REPORTS_DIR, `apply-${id}.json`));
  const applyStatus = report?.status ?? (applyRes.code === 0 ? "green" : "blocked");
  const applied = {
    ok: applyRes.code === 0 && applyStatus === "green",
    blocked: applyStatus === "blocked",
    status: applyStatus,
    summary: report?.summary ?? lastLine(applyRes.stdout) ?? "cr-apply produced no report",
  };

  emitJsonOrHuman(json, {
    ok: applied.ok,
    id,
    decision: decisionWord,
    status,
    applied,
    summary: applied.summary,
  });
  process.exit(applied.ok ? EXIT_OK : EXIT_REFUSAL);
}

// Codes must match lib/control.ts's equivalent classifier — same machine-readable reasons on both clients.
function classifyDecisionCode(message: string): string {
  if (/no CR with id/i.test(message)) return "unknown_cr";
  if (/can be decided|no frozen baseline/i.test(message)) return "cr_not_decidable";
  return "decision_failed";
}

function cmdSkillsReport(argv: string[]): void {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const report = readJsonFile<SkillsReport>(join(target, SKILLS_REPORT_REL));
  const failed = report?.phase === "failed";
  if (json) {
    emitJson({ ok: !failed, report: report ?? null });
  } else if (!report) {
    note("(no skills report — no install has run yet)");
  } else {
    note(`skills: ${report.phase ?? "?"} (${report.mode ?? "?"} mode) — ${report.summary ?? ""}`);
    for (const entry of Array.isArray(report.installed) ? report.installed : []) {
      const s = entry as { id?: string; name?: string; official?: boolean; security_waived?: boolean };
      note(`  + ${s.id ?? "?"}  ${s.name ?? ""}  ${s.official ? "official" : "community"}${s.security_waived ? "  [audits waived]" : ""}`);
    }
    for (const entry of Array.isArray(report.rejected) ? report.rejected : []) {
      const r = entry as { id?: string; reason?: string };
      note(`  - ${r.id ?? "?"}  rejected: ${r.reason ?? ""}`);
    }
  }
  process.exit(failed ? EXIT_REFUSAL : EXIT_OK);
}

async function cmdSkillsInstall(argv: string[], opts: Opts = {}): Promise<void> {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const ids = argv.filter((a) => !a.startsWith("--") && a.trim().length > 0);

  const release = claimCliSkillsLock(opts, target);
  if (!release) {
    return fail(json, EXIT_REFUSAL, "a skills install is already in flight", { code: "already_running" });
  }
  note(
    ids.length > 0
      ? `vivicy: installing project skills (explicit: ${ids.join(", ")})…`
      : "vivicy: installing project skills (auto selection from the frozen spec)…"
  );
  let res;
  try {
    res = await runScript(
      process.execPath,
      [scriptPath(SKILLS_SCRIPT), ...(ids.length > 0 ? ["--ids", ids.join(",")] : [])],
      { cwd: factoryDir, env: childEnv(target, opts) }
    );
  } finally {
    release();
  }

  const report = readJsonFile<SkillsReport>(join(target, SKILLS_REPORT_REL));
  const phase = report?.phase ?? "error";
  const ok = res.code === 0 && (phase === "green" || phase === "skipped");
  emitJsonOrHuman(json, {
    ok,
    phase,
    mode: report?.mode ?? (ids.length > 0 ? "explicit" : "auto"),
    installed: report?.installed ?? [],
    rejected: report?.rejected ?? [],
    summary: report?.summary ?? lastLine(res.stdout) ?? "skills install produced no report",
  });
  process.exit(ok ? EXIT_OK : EXIT_REFUSAL);
}

function cmdSkills(argv: string[], opts: Opts = {}): Promise<void> | void {
  if (argv[0] === "install") {
    argv.shift();
    return cmdSkillsInstall(argv, opts);
  }
  if (argv[0] === "remove") {
    argv.shift();
    return cmdSkillsRemove(argv, opts);
  }
  return cmdSkillsReport(argv);
}

function cmdPrepare(argv: string[], opts: Opts = {}): Promise<void> | void {
  if (argv[0] === "run") {
    argv.shift();
    return cmdPrepareRun(argv, opts);
  }
  return cmdPrepareReport(argv);
}

function cmdPrepareReport(argv: string[]): void {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", { code: "missing_target" });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const report = readJsonFile<DocPrepReport>(join(target, DOC_PREP_REPORT_REL));
  const failed = report?.phase === "failed";
  if (json) {
    emitJson({ ok: !failed, report: report ?? null });
  } else if (!report) {
    note("(no doc-prep report — the stage has not run yet)");
  } else {
    const consumed = Array.isArray(report.batches_consumed) ? report.batches_consumed.length : 0;
    const pending = Array.isArray(report.batches_pending) ? report.batches_pending.length : 0;
    note(`doc-prep: ${report.phase ?? "?"} (cycle ${report.cycle_id ?? "none"}, ${consumed} batch(es) consumed, ${pending} pending, language ${report.language ?? "?"}) — ${report.summary ?? ""}`);
    for (const entry of Array.isArray(report.placed) ? report.placed : []) {
      const p = entry as { batch?: string; target?: string; route?: string; translated?: boolean };
      note(`  + ${p.target ?? "?"}  ${p.route ?? ""}${p.translated ? "  [translated]" : ""}${p.batch ? `  (${p.batch})` : ""}`);
    }
    for (const entry of Array.isArray(report.rejected) ? report.rejected : []) {
      const r = entry as { source?: string; reason?: string };
      note(`  - ${r.source ?? "?"}  rejected: ${r.reason ?? ""}`);
    }
  }
  process.exit(failed ? EXIT_REFUSAL : EXIT_OK);
}

async function cmdPrepareRun(argv: string[], opts: Opts = {}): Promise<void> {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", { code: "missing_target" });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const release = claimCliLock(opts, target, "doc-prep.lock");
  if (!release) {
    return fail(json, EXIT_REFUSAL, "document preparation is already in flight", { code: "already_running" });
  }
  note("vivicy: preparing imported documents into canonical form…");
  let res;
  try {
    res = await runScript(process.execPath, [scriptPath(PREPARE_SCRIPT)], { cwd: factoryDir, env: childEnv(target, opts) });
  } finally {
    release();
  }
  const report = readJsonFile<DocPrepReport>(join(target, DOC_PREP_REPORT_REL));
  const phase = report?.phase ?? "error";
  const ok = res.code === 0 && phase !== "failed";
  emitJsonOrHuman(json, {
    ok,
    phase,
    cycle_id: report?.cycle_id ?? null,
    batches_consumed: report?.batches_consumed ?? [],
    batches_pending: report?.batches_pending ?? [],
    language: report?.language ?? null,
    placed: report?.placed ?? [],
    rejected: report?.rejected ?? [],
    summary: report?.summary ?? lastLine(res.stdout) ?? "document preparation produced no report",
  });
  process.exit(ok ? EXIT_OK : EXIT_REFUSAL);
}

function claimCliSkillsLock(opts: Opts, target: string): (() => void) | null {
  return claimCliLock(opts, target, "skills-install.lock");
}

// Byte-compatible with lib/control.ts's per-stage lock — the app patches its process's pid into the same file, so a live stage from either client refuses the other (no cross-client double-spawn).
function claimCliLock(opts: Opts, target: string, lockFileName: string): (() => void) | null {
  const file = join(projectDir(opts, target), lockFileName);
  mkdirSync(projectDir(opts, target), { recursive: true });
  const body = `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`;
  const tryClaim = (): boolean => {
    try {
      writeFileSync(file, body, { flag: "wx" });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return false;
    }
  };
  if (tryClaim()) return () => rmSync(file, { force: true });
  let stale = true;
  try {
    const lock = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown };
    stale = !(typeof lock.pid === "number" && isAlive(lock.pid));
  } catch {
    stale = true;
  }
  if (!stale) return null;
  rmSync(file, { force: true });
  return tryClaim() ? () => rmSync(file, { force: true }) : null;
}

async function cmdSkillsRemove(argv: string[], opts: Opts = {}): Promise<void> {
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (!existsSync(target)) {
    return fail(json, EXIT_USAGE, `target root does not exist: ${target}`, { code: "missing_target" });
  }
  const ids = argv.filter((a) => !a.startsWith("--") && a.trim().length > 0);
  if (ids.length === 0) {
    return fail(json, EXIT_USAGE, "skills remove requires at least one skill id (owner/repo@skill or a skills.sh URL)", {
      code: "missing_ids",
    });
  }

  const release = claimCliSkillsLock(opts, target);
  if (!release) {
    return fail(json, EXIT_REFUSAL, "a skills install is already in flight", { code: "already_running" });
  }
  note(`vivicy: removing project skills: ${ids.join(", ")}…`);
  let res;
  try {
    res = await runScript(
      process.execPath,
      [scriptPath(SKILLS_SCRIPT), "--remove", ids.join(",")],
      { cwd: factoryDir, env: childEnv(target, opts) }
    );
  } finally {
    release();
  }

  const report = readJsonFile<SkillsReport>(join(target, SKILLS_REPORT_REL));
  const phase = report?.phase ?? "error";
  const ok = res.code === 0 && phase === "green";
  emitJsonOrHuman(json, {
    ok,
    phase,
    summary: report?.summary ?? lastLine(res.stderr) ?? "skills remove produced no report",
    report,
  });
  process.exit(ok ? EXIT_OK : EXIT_REFUSAL);
}

// Only prepare/extract/skills/dev are retryable — map generation lives inside extraction, so there's no standalone map stage; POST /api/control/retry-stage must dispatch the same set.
const RETRYABLE_STAGES: Record<string, string> = { prepare: "prepare", extract: "extract", skills: "skills", dev: "resume" };

async function cmdRetryStage(argv: string[], opts: Opts): Promise<void> {
  const json = argv.includes("--json"); // peek only — the dispatched sub-verb consumes it via its own takeBool
  const stage = argv[0] && !argv[0].startsWith("--") ? argv.shift() : null;
  const action = stage ? RETRYABLE_STAGES[stage] : undefined;
  if (!action) {
    return fail(
      json,
      EXIT_USAGE,
      `stage "${stage ?? ""}" is not retryable`,
      { code: "unsupported_stage", supported: Object.keys(RETRYABLE_STAGES) }
    );
  }
  if (action === "prepare") return cmdPrepareRun(argv, opts);
  if (action === "extract") return cmdExtract(argv, opts);
  if (action === "skills") return cmdSkillsInstall(argv, opts);
  return startSupervisor(argv, opts, "resume");
}

// Extraction closes cycles — never this dispatcher (no "close" action exists here by design).
async function cmdCycle(argv: string[], opts: Opts): Promise<void> {
  const action = argv.shift();
  const json = takeBool(argv, "--json");
  const target = resolveTarget(argv);
  if (!target) {
    return fail(json, EXIT_USAGE, "no target project — pass --dir <path> or set VIVICY_TARGET_ROOT", {
      code: "missing_target",
    });
  }
  if (action === "status" || action === undefined) {
    const cycle = readSpecCycle(target);
    if (json) emitJson({ ok: true, cycle });
    else note(cycle ? `vivicy: drafting cycle ${cycle.id} open since ${cycle.opened_at}` : "vivicy: no spec cycle open");
    process.exit(EXIT_OK);
  }
  if (action === "open") {
    const refusal = featureCycleOpenRefusal(target);
    if (refusal) {
      return fail(json, EXIT_REFUSAL, refusal.reason, { code: "cycle_state" });
    }
    if (isRunActive(opts, target)) {
      return fail(json, EXIT_REFUSAL, "a supervised run is active — stop it before opening a spec cycle", { code: "already_running" });
    }
    const cycle = {
      status: "drafting" as const,
      kind: "feature" as const,
      id: `cycle-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`,
      opened_at: new Date().toISOString(),
      opened_by: "owner:cli",
    };
    writeSpecCycle(target, cycle);
    if (json) emitJson({ ok: true, cycle });
    else note(`vivicy: drafting cycle ${cycle.id} opened — extract to freeze it when the spec evolution is written`);
    process.exit(EXIT_OK);
  }
  if (action === "cancel") {
    const cycle = readSpecCycle(target);
    if (!cycle) {
      return fail(json, EXIT_REFUSAL, "no drafting spec cycle is open", { code: "cycle_state" });
    }
    const manifest = activeFrozenManifestRel(target);
    if (manifest) {
      const verify = spawnSync(process.execPath, [scriptPath("doc-baseline.ts"), "verify", "--manifest", manifest, "--require-status", "frozen"], {
        cwd: target,
        encoding: "utf8",
        env: childEnv(target, opts),
      });
      if ((verify.status ?? 1) !== 0) {
        return fail(json, EXIT_REFUSAL, "the canonical has drifted from the frozen baseline — extract to freeze the evolution, or revert the edits first", { code: "cycle_state" });
      }
    }
    clearSpecCycle(target);
    if (json) emitJson({ ok: true, cancelled: cycle.id });
    else note(`vivicy: drafting cycle ${cycle.id} cancelled`);
    process.exit(EXIT_OK);
  }
  return fail(json, EXIT_USAGE, `unknown cycle action "${action}" (expected open|cancel|status)`, { code: "usage" });
}

function activeFrozenManifestRel(target: string): string | null {
  const dir = join(target, ".vivicy", "baselines");
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(dir, entry), "utf8")) as { status?: unknown; superseded?: unknown };
      if (manifest?.status === "frozen" && !manifest.superseded) return `.vivicy/baselines/${entry}`;
    } catch {
      continue;
    }
  }
  return null;
}

function cmdNotifications(argv: string[], opts: Opts): void {
  const json = takeBool(argv, "--json");
  // A still-unmigrated legacy root log is read FIRST (older by construction) so this view matches the app's own fold-in order; this reader stays read-only and never migrates it.
  const target = resolveTarget(argv);
  const files = target
    ? [join(runtimeDir(opts), NOTIFICATIONS_REL), join(projectDir(opts, target), NOTIFICATIONS_REL)]
    : [join(runtimeDir(opts), NOTIFICATIONS_REL)];
  const notifications: Notification[] = [];
  for (const file of files) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        notifications.push(JSON.parse(trimmed) as Notification);
      } catch {
      }
    }
  }
  if (json) {
    emitJson({ ok: true, notifications });
  } else if (notifications.length === 0) {
    note("(no notifications)");
  } else {
    for (const n of notifications) {
      note(`${n.ts ?? "?"}  ${String(n.level ?? "info").padEnd(6)}  ${n.stage ?? "-"}/${n.event ?? "-"}  ${n.message ?? ""}`);
    }
  }
  process.exit(EXIT_OK);
}

function lastLine(text: string): string | null {
  const lines = String(text ?? "").split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().length > 0) return lines[i].trim();
  }
  return null;
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function emitJsonOrHuman(json: boolean, obj: EmitObject): void {
  if (json) {
    emitJson(obj);
    return;
  }
  const verdict = obj.ok ? "ok" : obj.blocked ? "blocked" : "not ok";
  note(`vivicy: ${verdict}${obj.summary ? ` — ${obj.summary}` : ""}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? EXIT_USAGE : EXIT_OK);
  }

  const opts = { runtimeDir: takeFlag(argv, "--runtime-dir") };

  const command = argv.shift();
  switch (command) {
    case "status":
      return cmdStatus(argv, opts);
    case "extract":
      return cmdExtract(argv, opts);
    case "start":
      return startSupervisor(argv, opts, "start");
    case "resume":
      return startSupervisor(argv, opts, "resume");
    case "stop":
      return cmdStop(argv, opts);
    case "crs":
      return cmdCrs(argv);
    case "cr":
      return cmdCr(argv, opts);
    case "skills":
      return cmdSkills(argv, opts);
    case "prepare":
      return cmdPrepare(argv, opts);
    case "retry-stage":
      return cmdRetryStage(argv, opts);
    case "cycle":
      return cmdCycle(argv, opts);
    case "notifications":
      return cmdNotifications(argv, opts);

    case "app": {
      const target = takeFlag(argv, "--target");
      const env = target ? { VIVICY_TARGET_ROOT: resolve(target) } : {};
      const port = takeFlag(argv, "--port");
      passthrough("npx", ["next", "dev", ...(port ? ["--port", port] : []), ...argv], {
        cwd: appDir,
        env,
      });
      return;
    }
    case "loop": {
      const target = takeFlag(argv, "--target");
      const env = target
        ? { VIVICY_TARGET_ROOT: resolve(target), VIVICY_RUNTIME_DIR: projectDir(opts, resolve(target)) }
        : {};
      passthrough(process.execPath, [scriptPath("dev-loop.ts"), ...argv], { env });
      return;
    }
    case "supervise": {
      const target = takeFlag(argv, "--target");
      const env = target
        ? { VIVICY_TARGET_ROOT: resolve(target), VIVICY_RUNTIME_DIR: projectDir(opts, resolve(target)) }
        : {};
      passthrough(process.execPath, [scriptPath(SUPERVISOR_SCRIPT), ...argv], { env });
      return;
    }
    case "rehearsal":
      passthrough(process.execPath, [scriptPath("dev-rehearsal.ts"), ...argv]);
      return;

    default:
      note(`Unknown command: ${command}\n`);
      process.stdout.write(HELP);
      process.exit(EXIT_USAGE);
  }
}

main().catch((error) => {
  const code = error && typeof error.vivicyCode === "number" ? error.vivicyCode : EXIT_UNEXPECTED;
  note(`vivicy: ${errText(error)}`);
  process.exit(code);
});
