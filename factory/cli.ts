#!/usr/bin/env node
// Vivicy CLI — point the autonomous dev factory at any target project, and drive
// or interrogate a running pipeline non-interactively (agent-consumable).
//
// Vivicy operates ON a target project: it reads that project's canonical docs,
// architecture map, issue index, and progress ledger, and drives the two-agent
// implement -> review -> verify loop over them. The target is selected with
// VIVICY_TARGET_ROOT (or `--dir`/`--target <dir>`); everything else is local to
// this package.
//
// ── G14: CLI + API PARITY (why this file and lib/control.ts do NOT share code) ──
// There is ONE control plane conceptually, exposed to two clients:
//   • the Next.js API routes (app/api/control/*) — the UI's client, TS, Next-side;
//   • this `vivicy` CLI — the agents' client, Node ESM, factory-side.
// cli.ts and lib/control.ts MUST NOT import each other: one is bundled by Next
// (server-only, `@/` alias, TS), the other is a plain executable resolved by the
// package `bin`. PARITY does not come from shared code — it comes from both
// clients (a) spawning the SAME factory scripts with the same args + env, and
// (b) reading the SAME state files with the same schema. Change a script/schema
// and both clients move together; neither owns policy the other lacks.
//
// ── Lock-path compatibility (a CLI-started run is visible to the UI and back) ──
// lib/control.ts keeps the single-run lock at
//   getRuntimeDir()/run-state.json,  getRuntimeDir() = VIVICY_RUNTIME_DIR ?? <cwd>/.vivicy-runtime
// That lock is NOT under the target — it is app-runtime state under the app's cwd.
// In every supported launch path the app's cwd IS the package root: `vivicy app`
// spawns `next dev` with cwd=<appDir>, and `npm run dev`/`start` run from the
// package root. This file lives in factory/, and the package root is exactly
// resolve(<factory>, ".."), so we reproduce the identical dir: VIVICY_RUNTIME_DIR
// when set, else <appDir>/.vivicy-runtime (deliberately NOT process.cwd(), since
// `vivicy` may be invoked from anywhere); `--runtime-dir` overrides for tests.
// VIVICY_RUNTIME_DIR is also the escape hatch that GUARANTEES agreement if the app
// is ever launched from some other cwd — set it on both sides and the lock (and the
// rest of .vivicy-runtime) coincide. The RunState schema
// { pid, started_at, target_root, factory_root, log_file, mode } and the
// wx-exclusive claim + stale-lock liveness logic are byte-compatible with
// lib/control.ts, so a `vivicy start` run appears in the UI and a UI-started run
// is seen (and stoppable) here.
//
// ── Why the CLI does NOT read the persisted current-project.json ──
// The app's persisted project (.vivicy-runtime/current-project.json) is
// app-runtime state written by the UI folder picker (R10). The CLI is
// target-explicit by contract: an agent driving a headless pipeline passes the
// target (VIVICY_TARGET_ROOT or --dir) rather than inheriting whatever the UI
// last picked. Reading it here would make `vivicy` on one machine silently act
// on another project the UI chose. So target resolution is env/flag only.
//
// ── CLI contract for non-human callers (agents) ──
//   • --json prints ONE JSON object on stdout and nothing else; all human/log
//     noise (child stdout/stderr, progress) goes to stderr.
//   • Exit codes are stable: 0 ok · 1 actionable refusal (blocked / not green /
//     unknown id / no run) · 2 usage (unknown verb/flag, unsupported stage) ·
//     3 unexpected (a bug/crash we did not model).
//   • No prompts, ever. A missing target is a code-2 usage error, not a question.
//
// Usage:
//   vivicy status        [--dir <d>] [--json]           merged run/dev/extraction health
//   vivicy extract       [--dir <d>]                    author issues from canonical (sync)
//   vivicy start         [--dir <d>]                    launch the resumable supervisor (detached)
//   vivicy resume        [--dir <d>]                    relaunch the supervisor (resumes from done/)
//   vivicy stop                                         stop the supervised run
//   vivicy crs           [--json]                       list change requests
//   vivicy cr approve <id> --by <actor>                 decide + apply an approved CR
//   vivicy cr reject  <id> --by <actor>                 decide (reject) a CR
//   vivicy skills        [--dir <d>] [--json]           read the project-skills report
//   vivicy skills install [ids...] [--dir <d>]          select/audit/install project skills
//   vivicy retry-stage <stage>                          re-run a retryable stage (extract|skills|dev)
//   vivicy notifications [--json]                       read the notification log
//   vivicy app           [--target <d>] [--port <n>]    start the visual control plane (Next.js)
//   vivicy loop          [--target <d>]                 run the two-agent dev loop once
//   vivicy supervise     [--target <d>]                 run the resumable supervisor (foreground-attached)
//   vivicy rehearsal     [--dry]                        end-to-end method rehearsal
//   vivicy --help
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

// This CLI lives in factory/, so its own directory IS the default factory root —
// the scripts it drives (dev-loop-supervised / dev-status / extract-issues /
// change-control / cr-apply) are its siblings. VIVICY_FACTORY_ROOT overrides it,
// symmetrically with lib/control.ts getFactoryRoot(): the control plane honors it
// so tests can point at a stub factory (scripts that write the expected state files
// without spawning agents), and the CLI's parity twin must offer the same seam.
const cliDir = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(cliDir, ".."); // the Vivicy app (package root)

function factoryRootDir() {
  const fromEnv = process.env.VIVICY_FACTORY_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return cliDir;
}
const factoryDir = factoryRootDir();

// ── Stable exit codes (mirror the CLI contract above) ──
const EXIT_OK = 0;
const EXIT_REFUSAL = 1; // actionable refusal: blocked / not green / unknown id / no run
const EXIT_USAGE = 2; // bad invocation: unknown verb/flag, unsupported stage, missing target
const EXIT_UNEXPECTED = 3; // a bug/crash we did not model

// ── Runtime-dir + lock (byte-compatible with lib/control.ts) ──
const RUN_STATE_FILE = "run-state.json";
const LOG_FILE = "supervisor.log";
const RUNTIME_DIR_NAME = ".vivicy-runtime";

const SUPERVISOR_SCRIPT = "dev-loop-supervised.ts";
const STATUS_SCRIPT = "dev-status.ts";
const EXTRACT_SCRIPT = "extract-issues.ts";
const CHANGE_CONTROL_SCRIPT = "change-control.ts";
const CR_APPLY_SCRIPT = "cr-apply.ts";
const SKILLS_SCRIPT = "install-skills.ts";

// Repo-relative state files the app reads too — the CLI reads the SAME ones.
const EXTRACTION_STATUS_REL = ".vivicy/development/reports/extraction-status.json";
const SKILLS_REPORT_REL = ".vivicy/development/reports/skills-report.json";
const CHANGE_REQUESTS_DIR = ".vivicy/change-requests";
const REPORTS_DIR = ".vivicy/development/reports";
// G9 (notifications) lands the WRITER after this CLI. The READ contract is fixed
// here so the widget + writer follow it: newline-delimited JSON, one object per
// line { ts, level, stage, event, message, dismissed? }; a missing/empty file is
// an empty list (exit 0), never an error.
const NOTIFICATIONS_REL = "notifications.jsonl";
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"]);

const HELP = `Vivicy — a visual autonomous dev factory (agent-drivable control surface).

Usage:
  vivicy status        [--dir <d>] [--json]        merged run/dev/extraction health
  vivicy extract       [--dir <d>]                 author issues from canonical (sync)
  vivicy start         [--dir <d>]                 launch the resumable supervisor (detached)
  vivicy resume        [--dir <d>]                 relaunch the supervisor (resumes)
  vivicy stop                                      stop the supervised run
  vivicy crs           [--json]                    list change requests
  vivicy cr approve <id> --by <actor>              decide + apply an approved CR
  vivicy cr reject  <id> --by <actor>              decide (reject) a CR
  vivicy skills        [--dir <d>] [--json]        read the project-skills report
  vivicy skills install [ids...] [--dir <d>]       select/audit/install project skills (sync)
  vivicy retry-stage <stage>                       re-run a retryable stage (extract|skills|dev)
  vivicy notifications [--json]                    read the notification log
  vivicy app           [--target <d>] [--port <n>] start the visual control plane
  vivicy loop          [--target <d>]              run the two-agent dev loop once
  vivicy supervise     [--target <d>]              run the resumable supervisor (attached)
  vivicy rehearsal     [--dry]                      end-to-end method rehearsal
  vivicy --help

Agent contract: --json prints one JSON object on stdout (nothing else); exit
0 ok · 1 refusal · 2 usage · 3 unexpected. No prompts. Target: --dir/--target
or VIVICY_TARGET_ROOT (the persisted UI project is NOT read here).
`;

// ── shared shapes ──

/** Hidden --runtime-dir override threaded through the lock-aware verbs. */
interface Opts {
  runtimeDir?: string | null;
}

/** An Error carrying a stable exit code the top-level catch maps to process.exit. */
interface VivicyError extends Error {
  vivicyCode?: number;
}

/** The single-run lock persisted at <runtimeDir>/run-state.json (byte-compatible
 *  with lib/control.ts). */
interface RunState {
  pid: number;
  started_at?: string;
  target_root?: string;
  factory_root?: string;
  log_file?: string;
  mode?: string;
}

/** Result of a factory-script spawn run to completion. */
interface ScriptResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

/** Read-only CR display projection derived from a CR file's frontmatter. */
interface CrSummary {
  id: string;
  title: string;
  status: string;
  classification: string;
  created_at: string | null;
  source: string | null;
}

/** Extraction-status.json fields the CLI surfaces (best-effort read). */
interface ExtractionStatus {
  phase?: string;
  spike_mode?: string;
  map_mode?: string;
  spike_proving?: unknown;
  summary?: string;
}

/** skills-report.json fields the CLI surfaces (best-effort read; the schema of
 *  record is install-skills.ts's writer — SAME file the app reads). */
interface SkillsReport {
  phase?: string;
  baseline_id?: string | null;
  mode?: string;
  installed?: unknown[];
  rejected?: unknown[];
  summary?: string;
  updated_at?: string;
}

/** apply-CR-####.json fields the CLI surfaces (best-effort read + null-normalized
 *  projection). */
interface CrApplyReport {
  cr?: string | null;
  status?: string | null;
  phase?: string | null;
  summary?: string | null;
  updated_at?: string | null;
}

/** One line of the notification log (read contract fixed in this file). */
interface Notification {
  ts?: string;
  level?: string;
  stage?: string;
  event?: string;
  message?: string;
  dismissed?: boolean;
}

/** The machine object emitted by emitJsonOrHuman; the human path reads ok/blocked/summary. */
interface EmitObject {
  ok: boolean;
  blocked?: boolean;
  summary?: string;
  [key: string]: unknown;
}

// ── arg helpers ──

/** Take `--name value` out of argv, returning the value (or null). A following
 *  token that itself starts with `--` is treated as absent (a bare flag). */
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

// ── stdout/stderr discipline ──

/** The one JSON object a --json invocation is allowed to write to stdout. */
function emitJson(obj: unknown): void {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

/** Human/log line — always stderr, so it never contaminates --json stdout. */
function note(line: string): void {
  process.stderr.write(`${line}\n`);
}

/** Emit an error either as JSON (stdout) or a human line (stderr) per --json,
 *  then exit with `code`. `extra` merges into the JSON error object. */
function fail(json: boolean, code: number, message: string, extra: Record<string, unknown> = {}): never {
  if (json) emitJson({ ok: false, error: message, ...extra });
  else note(`vivicy: ${message}`);
  process.exit(code);
}

// ── runtime dir / lock (compatible with lib/control.ts) ──

/** The runtime dir the lock lives in. VIVICY_RUNTIME_DIR (the one override that
 *  makes the CLI and the app coincide regardless of launch cwd), else the package
 *  root's .vivicy-runtime — which equals the app's getRuntimeDir() default because
 *  the app is launched from the package root (see the header). Deliberately NOT
 *  process.cwd(): `vivicy` may run from anywhere. `--runtime-dir` overrides for tests. */
function runtimeDir(opts: Opts = {}): string {
  if (opts.runtimeDir) return resolve(opts.runtimeDir);
  const fromEnv = process.env.VIVICY_RUNTIME_DIR;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return join(appDir, RUNTIME_DIR_NAME);
}

function runStatePath(opts: Opts): string {
  return join(runtimeDir(opts), RUN_STATE_FILE);
}

function logPath(opts: Opts): string {
  return join(runtimeDir(opts), LOG_FILE);
}

function readRunState(opts: Opts): RunState | null {
  const file = runStatePath(opts);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RunState;
  } catch {
    return null;
  }
}

/** Is a pid currently alive? Signal 0 probes existence without affecting it. */
function isAlive(pid: unknown): boolean {
  if (typeof pid !== "number") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A run is active when the lock exists AND its pid is alive; a stale lock
 *  (process gone) is cleared so a fresh start can claim it — same rule as
 *  lib/control.ts isRunActive. */
function isRunActive(opts: Opts): boolean {
  const state = readRunState(opts);
  if (!state) return false;
  if (isAlive(state.pid)) return true;
  rmSync(runStatePath(opts), { force: true });
  return false;
}

// ── target resolution (env/flag only; never the persisted UI project) ──

/** Resolve the target explicitly from --dir/--target or VIVICY_TARGET_ROOT.
 *  Returns null when none is set (callers surface a usage error). */
function resolveTarget(argv: string[]): string | null {
  const flag = takeFlag(argv, "--dir") ?? takeFlag(argv, "--target");
  if (flag && flag.trim().length > 0) return resolve(flag);
  const fromEnv = process.env.VIVICY_TARGET_ROOT;
  if (fromEnv && fromEnv.trim().length > 0) return resolve(fromEnv);
  return null;
}

/** Resolve a factory script path, verifying it exists on disk. Throws a coded
 *  Error the caller maps to exit 3 (a missing bundled script is a packaging bug,
 *  not a user error). */
function scriptPath(name: string): string {
  const abs = join(factoryDir, name);
  if (!existsSync(abs)) {
    const err: VivicyError = new Error(`factory script not found: ${name} (looked under ${factoryDir})`);
    err.vivicyCode = EXIT_UNEXPECTED;
    throw err;
  }
  return abs;
}

/** Child env for a factory spawn: inherit + point at the target. Every script
 *  reads VIVICY_TARGET_ROOT; dev-status/cr-apply additionally accept --dir, which
 *  callers pass where the script documents it (matching lib/control.ts). */
function childEnv(target: string): NodeJS.ProcessEnv {
  return { ...process.env, VIVICY_TARGET_ROOT: target };
}

/** Run a factory script to completion, streaming its stdout+stderr to OUR stderr
 *  (never stdout — that is reserved for the final --json object) and collecting
 *  both streams for the caller to parse. Factory CLIs print their JSON result on
 *  stdout OR stderr (change-control's `decide` errors go to stderr), so callers
 *  parse both, exactly as lib/control.ts does. */
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
      process.stderr.write(text); // human-follows-along on stderr
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

/** Parse the first `{...}` JSON line out of text (the single-line payload a
 *  factory CLI prints, e.g. change-control's `decide`), or null. Mirrors
 *  lib/control.ts parseJsonLine. */
function parseJsonLine(text: string): Record<string, unknown> | null {
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // keep scanning
    }
  }
  return null;
}

/** Parse a whole `{...}` JSON document out of text (dev-status.ts prints
 *  multi-line pretty JSON), tolerating surrounding noise by slicing from the
 *  first `{` to the last `}`. */
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

/** Minimal frontmatter reader for the CR list (read-only display projection),
 *  mirroring lib/control.ts parseFrontmatter and change-control.ts's parser. */
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

// ── legacy passthrough verbs (app / loop / supervise / rehearsal) ──
// These keep the original detached-inherit behavior: they hand the terminal to a
// long-lived child and exit with its code. Not part of the --json agent surface.
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

// ── verb: status ─────────────────────────────────────────────────────────────
// Merged, read-only view over the SAME files the app reads: the run-state lock
// (liveness), dev-status.ts --json (issues/gates/active/quota), the extraction
// status file (phase + spike_mode/map_mode + spike_proving), the latest
// cr-apply report, and the pending-CR count. Exit 0 always on a successful read;
// a missing target is a usage error (2).
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

  // 1. run-state lock (liveness of the detached supervisor) — SAME lock the app uses.
  const lock = readRunState(opts);
  const runActive = isRunActive(opts);
  const run = lock
    ? {
        pid: lock.pid,
        alive: isAlive(lock.pid),
        mode: lock.mode ?? null,
        started_at: lock.started_at ?? null,
        target_root: lock.target_root ?? null,
      }
    : null;

  // 2. dev-status.ts --json (deterministic + live process inspection). Best-effort:
  // a merged read-only view must not abort because one sub-source is unavailable
  // (missing script, ps failure), so an unreadable dev-status degrades to dev: null
  // rather than failing the whole status — the lock, extraction, and CR sources are
  // still worth returning. (In production dev-status.ts is a bundled sibling.)
  let devStatus = null;
  try {
    const dev = await runScript(process.execPath, [scriptPath(STATUS_SCRIPT), "--dir", target, "--json"], {
      cwd: factoryDir,
      env: childEnv(target),
    });
    devStatus = parseJsonBlock(dev.stdout);
  } catch {
    devStatus = null;
  }

  // 3. extraction-status.json (phase + spike/map modes + proving summary).
  const extraction = readJsonFile<ExtractionStatus>(join(target, EXTRACTION_STATUS_REL));

  // 4. latest cr-apply report (most recently updated), if any.
  const latestCrApply = readLatestCrApply(target);

  // 5. pending CRs (idea | under_review — the decidable ones).
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

// ── verb: extract ────────────────────────────────────────────────────────────
// Spawn extract-issues.ts synchronously, stream its progress to stderr, and read
// the terminal extraction-status.json back. Exit 0 ONLY on green; a blocked
// terminal (extraction_blocked / blocked_on_unverified_spikes) is a code-1
// refusal a human/agent must act on; any other non-green is code 1 too.
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
    env: childEnv(target),
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

// ── verbs: start / resume / stop ─────────────────────────────────────────────
// Detached supervisor lifecycle, byte-compatible with lib/control.ts's lock so a
// CLI-started run shows up in the UI and a UI-started run is seen (and stoppable)
// here. `start`/`resume` differ only in the recorded `mode` label — the
// supervisor resumes from done/ + the ledger either way.
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

  // Refuse a double start while a run is active (the single-run lock). isRunActive
  // clears a stale lock, so a dead prior run does not block a fresh start.
  if (isRunActive(opts)) {
    const lock = readRunState(opts);
    return fail(json, EXIT_REFUSAL, "a supervised run is already active", {
      code: "already_running",
      run: lock ? { pid: lock.pid, mode: lock.mode ?? null } : null,
    });
  }

  const command = scriptPath(SUPERVISOR_SCRIPT);
  const dir = runtimeDir(opts);
  mkdirSync(dir, { recursive: true });
  const logFile = logPath(opts);

  // Atomically claim the lock BEFORE spawning (closes the check-then-spawn TOCTOU
  // window), exactly as lib/control.ts claimRunLock does: `wx` exclusive create,
  // placeholder pid = OUR pid so a concurrent claimant sees a live lock, then patch
  // in the child pid after spawn. A lost race (EEXIST) is a code-1 refusal.
  const placeholder = {
    pid: process.pid,
    started_at: new Date().toISOString(),
    target_root: target,
    factory_root: factoryDir,
    log_file: logFile,
    mode,
  };
  try {
    writeFileSync(runStatePath(opts), `${JSON.stringify(placeholder, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    if (error && (error as NodeJS.ErrnoException).code === "EEXIST") {
      return fail(json, EXIT_REFUSAL, "a supervised run is already active", { code: "already_running" });
    }
    throw error;
  }

  // Detached, own process group, stdio -> the shared supervisor log (append, so a
  // resume accumulates), unref so this CLI can exit while the run keeps going.
  const out = openSync(logFile, "a");
  const err = openSync(logFile, "a");
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [command], {
      cwd: factoryDir,
      env: childEnv(target),
      detached: true,
      stdio: ["ignore", out, err],
    });
  } catch (error) {
    rmSync(runStatePath(opts), { force: true }); // release the claim for a retry
    return fail(json, EXIT_UNEXPECTED, `failed to spawn supervisor: ${errText(error)}`, {
      code: "spawn_failed",
    });
  }
  if (typeof child.pid !== "number") {
    rmSync(runStatePath(opts), { force: true });
    return fail(json, EXIT_UNEXPECTED, "supervisor did not start (no pid)", { code: "spawn_failed" });
  }
  child.unref();

  const state = { ...placeholder, pid: child.pid };
  writeFileSync(runStatePath(opts), `${JSON.stringify(state, null, 2)}\n`);

  note(`vivicy: supervisor ${mode} — pid ${child.pid}, log ${logFile}`);
  emitJsonOrHuman(json, { ok: true, run: state });
  process.exit(EXIT_OK);
}

function cmdStop(argv: string[], opts: Opts): void {
  const json = takeBool(argv, "--json");
  const state = readRunState(opts);
  if (!state) {
    return fail(json, EXIT_REFUSAL, "no supervised run is recorded", { code: "not_running" });
  }
  // Kill the whole group (negative pid) so the supervisor's relaunched children
  // die with it; fall back to the single pid. Clear the lock regardless — SAME
  // teardown as lib/control.ts stopSupervisor.
  killGroup(state.pid);
  rmSync(runStatePath(opts), { force: true });
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

// ── verb: crs (list) ─────────────────────────────────────────────────────────
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

// ── verb: cr approve|reject <id> --by <actor> ────────────────────────────────
// The decision + apply chain, driven through the SAME factory scripts the app
// spawns: change-control.ts `decide` (deterministic, no agent) then, for an
// approval, cr-apply.ts (its agent APPLY leg lives inside the script). Child
// output streams to stderr; the final JSON goes to stdout. Exit 0 only when the
// decision recorded AND (for an approval) the chain reached green; a blocked
// chain / unknown id / undecidable CR are code-1 refusals.
async function cmdCr(argv: string[], opts: Opts): Promise<void> {
  const json = takeBool(argv, "--json");
  const decision = argv.shift(); // "approve" | "reject"
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

  // 1. DECIDE — deterministic. change-control.ts reads VIVICY_TARGET_ROOT only
  // (no --dir), so the target rides the env. It prints a JSON result line; exit 0
  // ok, 1 on a decision error (unknown/undecidable/no-baseline), 2 usage.
  note(`vivicy: recording decision ${decisionWord} on ${id} (by ${by})…`);
  const decideRes = await runScript(
    process.execPath,
    [scriptPath(CHANGE_CONTROL_SCRIPT), "decide", "--cr", id, "--decision", decisionWord, "--by", by],
    { cwd: factoryDir, env: childEnv(target) }
  );
  const decided = parseJsonLine(decideRes.stdout) ?? parseJsonLine(decideRes.stderr);
  if (decideRes.code !== 0 || !decided?.ok) {
    const message =
      (decided && typeof decided.error === "string" && decided.error) ||
      lastLine(decideRes.stderr) ||
      lastLine(decideRes.stdout) ||
      "decision failed";
    // A usage exit (2) from the child stays a usage error; everything else is an
    // actionable refusal (unknown id / undecidable CR / no frozen baseline).
    const code = decideRes.code === 2 ? EXIT_USAGE : EXIT_REFUSAL;
    return fail(json, code, message, { id, code: classifyDecisionCode(message) });
  }
  const status =
    typeof decided.status === "string"
      ? decided.status
      : decisionWord === "approved"
        ? "accepted_current_build"
        : "rejected";

  // A rejection stops here — the decision is the whole outcome (no chain).
  if (decisionWord === "rejected") {
    emitJsonOrHuman(json, { ok: true, id, decision: decisionWord, status, summary: `CR ${id} rejected` });
    process.exit(EXIT_OK);
  }

  // 2. APPLY chain (approvals) — cr-apply.ts; read its terminal report back.
  note(`vivicy: applying ${id} (apply -> re-freeze -> re-extract -> reopen impacted issues)…`);
  const applyRes = await runScript(process.execPath, [scriptPath(CR_APPLY_SCRIPT), "--cr", id], {
    cwd: factoryDir,
    env: childEnv(target),
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

/** Map a decide-failure message to the same coded reason the control plane uses,
 *  for stable machine handling. */
function classifyDecisionCode(message: string): string {
  if (/no CR with id/i.test(message)) return "unknown_cr";
  if (/can be decided|no frozen baseline/i.test(message)) return "cr_not_decidable";
  return "decision_failed";
}

// ── verb: skills [install] ───────────────────────────────────────────────────
// `skills` reads the SAME skills-report.json the app reads (stable JSON on
// stdout; exit 1 when the last install's phase is failed — a report an agent
// must act on, not just display). `skills install [ids...]` drives
// install-skills.ts synchronously like `extract` drives extract-issues.ts:
// stream progress to stderr, read the terminal report back, exit 0 only on
// green/skipped. No ids = auto mode (selection from the frozen spec); ids =
// explicit mode (`--ids <id1,id2,...>`).
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

async function cmdSkillsInstall(argv: string[]): Promise<void> {
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

  note(
    ids.length > 0
      ? `vivicy: installing project skills (explicit: ${ids.join(", ")})…`
      : "vivicy: installing project skills (auto selection from the frozen spec)…"
  );
  const res = await runScript(
    process.execPath,
    [scriptPath(SKILLS_SCRIPT), ...(ids.length > 0 ? ["--ids", ids.join(",")] : [])],
    { cwd: factoryDir, env: childEnv(target) }
  );

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

function cmdSkills(argv: string[]): Promise<void> | void {
  if (argv[0] === "install") {
    argv.shift();
    return cmdSkillsInstall(argv);
  }
  return cmdSkillsReport(argv);
}

// ── verb: retry-stage <stage> ────────────────────────────────────────────────
// Honest scope: only three stages are actually retryable today — `extract`
// (re-run extraction), `skills` (re-run the skills installer, auto mode), and
// `dev` (relaunch the supervisor = resume). Map generation lives INSIDE
// extraction, so there is no standalone map stage to retry. This is a thin
// dispatcher; anything else is a code-2 usage error listing what IS supported
// (no fake generality). G8's per-stage retry buttons call POST /api/control/retry-stage
// with the same dispatch, so parity holds.
const RETRYABLE_STAGES: Record<string, string> = { extract: "extract", skills: "skills", dev: "resume" };

async function cmdRetryStage(argv: string[], opts: Opts): Promise<void> {
  const json = argv.includes("--json"); // peek; the sub-verb consumes it
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
  if (action === "extract") return cmdExtract(argv, opts);
  if (action === "skills") return cmdSkillsInstall(argv);
  return startSupervisor(argv, opts, "resume");
}

// ── verb: notifications ──────────────────────────────────────────────────────
// Read the notification log (.vivicy-runtime/notifications.jsonl). G9 lands the
// WRITER after this CLI; the READ contract is fixed here: newline-delimited JSON,
// one object per line { ts, level, stage, event, message, dismissed? }. A missing
// or empty file is an empty list (exit 0), never an error. Malformed lines are
// skipped so a partial write never breaks a read.
function cmdNotifications(argv: string[], opts: Opts): void {
  const json = takeBool(argv, "--json");
  const file = join(runtimeDir(opts), NOTIFICATIONS_REL);
  const notifications: Notification[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        notifications.push(JSON.parse(trimmed) as Notification);
      } catch {
        // Skip a malformed/partial line rather than failing the whole read.
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

// ── small utilities ──
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

/** Emit the machine object as JSON on stdout, or a terse human confirmation on
 *  stderr, per --json. Verbs with a richer human view call note() directly. */
function emitJsonOrHuman(json: boolean, obj: EmitObject): void {
  if (json) {
    emitJson(obj);
    return;
  }
  const verdict = obj.ok ? "ok" : obj.blocked ? "blocked" : "not ok";
  note(`vivicy: ${verdict}${obj.summary ? ` — ${obj.summary}` : ""}`);
}

// ── dispatch ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(argv.length === 0 ? EXIT_USAGE : EXIT_OK);
  }

  // A hidden --runtime-dir override (used by tests) so the lock/log land in an
  // isolated dir; production callers rely on VIVICY_RUNTIME_DIR / the default.
  const opts = { runtimeDir: takeFlag(argv, "--runtime-dir") };

  const command = argv.shift();
  switch (command) {
    // Agent-consumable control surface.
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
      return cmdSkills(argv);
    case "retry-stage":
      return cmdRetryStage(argv, opts);
    case "notifications":
      return cmdNotifications(argv, opts);

    // Legacy passthrough verbs (long-lived, terminal-attached; not the JSON surface).
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
      const env = target ? { VIVICY_TARGET_ROOT: resolve(target) } : {};
      passthrough(process.execPath, [scriptPath("dev-loop.ts"), ...argv], { env });
      return;
    }
    case "supervise": {
      const target = takeFlag(argv, "--target");
      const env = target ? { VIVICY_TARGET_ROOT: resolve(target) } : {};
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
  // An unmodeled crash: honest exit 3 with the message on stderr (never a
  // half-written JSON object on stdout).
  const code = error && typeof error.vivicyCode === "number" ? error.vivicyCode : EXIT_UNEXPECTED;
  note(`vivicy: ${errText(error)}`);
  process.exit(code);
});
