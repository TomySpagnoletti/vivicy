// Single source of truth for leg timeout policy: dev-loop.ts and extract-issues.ts both route legs through agent-spawn.ts into these helpers.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SUPERVISOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "leg-supervisor.ts");

export interface LegTimeout {
  capMs: number;
  idleMs: number;
  graceMs: number;
}

export type LegTimeoutOptions = Partial<LegTimeout>;

export interface LegResult {
  status: number | null;
  stdout: string;
  stderr: string;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  timeoutReason?: string;
  error?: Error;
}

// Written by leg-supervisor.ts to resultPath as JSON; keep this shape in sync with that writer (no compile-time check across the process boundary).
interface SupervisorOutcome {
  status: number | null;
  signal?: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutReason: string | null;
  spawnError?: string;
}

interface SpawnLegOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: LegTimeoutOptions;
}

export const DEFAULT_LEG_CAP_MS = 45 * 60 * 1000;
export const DEFAULT_LEG_IDLE_MS = 12 * 60 * 1000;
export const DEFAULT_LEG_KILL_GRACE_MS = 10 * 1000;

// n=0 is valid and means "disabled" (no cap/idle) — do not treat 0 as falsy/invalid here.
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

export function resolveLegTimeout(options: LegTimeoutOptions = {}): LegTimeout {
  return {
    capMs: options.capMs ?? envMs("VIVICY_LEG_TIMEOUT_MS", DEFAULT_LEG_CAP_MS),
    idleMs: options.idleMs ?? envMs("VIVICY_LEG_IDLE_MS", DEFAULT_LEG_IDLE_MS),
    graceMs: options.graceMs ?? envMs("VIVICY_LEG_KILL_GRACE_MS", DEFAULT_LEG_KILL_GRACE_MS),
  };
}

// Writes spec.json read by leg-supervisor.ts; keep field names in sync with that reader (no compile-time check across the process boundary).
function writeSpec({ command, args, cwd, timeout }: { command: string; args: string[]; cwd?: string; timeout: LegTimeout }): { dir: string; specPath: string; resultPath: string } {
  const dir = mkdtempSync(resolve(tmpdir(), "vivicy-leg-"));
  const specPath = resolve(dir, "spec.json");
  const resultPath = resolve(dir, "result.json");
  writeFileSync(
    specPath,
    JSON.stringify({ command, args, cwd, capMs: timeout.capMs, idleMs: timeout.idleMs, graceMs: timeout.graceMs, resultPath }),
  );
  return { dir, specPath, resultPath };
}

function toLegResult({ outcome, stdout, stderr, supervisorFailed }: { outcome: SupervisorOutcome | null; stdout: string; stderr: string; supervisorFailed: boolean }): LegResult {
  if (supervisorFailed || !outcome) {
    return { status: null, stdout, stderr: `${stderr}\n[leg-timeout] supervisor produced no result`.trim() };
  }
  if (outcome.spawnError) {
    return { status: null, stdout, stderr: `${stderr}${outcome.spawnError}`, error: new Error(outcome.spawnError) };
  }
  if (outcome.timedOut) {
    const reason = outcome.timeoutReason || "leg timed out";
    return {
      status: outcome.status ?? 124, // 124 is the conventional timeout exit code
      stdout,
      stderr: `${stderr}\n[leg-timeout] ${reason}`.trim(),
      timedOut: true,
      timeoutReason: reason,
    };
  }
  return { status: outcome.status, stdout, stderr, signal: outcome.signal ?? null };
}

function readOutcome(resultPath: string): SupervisorOutcome | null {
  try {
    return JSON.parse(readFileSync(resultPath, "utf8")) as SupervisorOutcome;
  } catch {
    return null;
  }
}

// stdio:["inherit","pipe","pipe"] captures the LEG's output because leg-supervisor.ts relays the leg's stdout/stderr straight through to its own.
export function spawnLegSync(command: string, args: string[], options: SpawnLegOptions = {}): LegResult {
  const timeout = resolveLegTimeout(options.timeout);
  const { dir, specPath, resultPath } = writeSpec({ command, args, cwd: options.cwd, timeout });
  try {
    const result = spawnSync(process.execPath, [SUPERVISOR_PATH, specPath], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      // Safety net in case the supervisor itself wedges: cap + grace + margin, independent of the supervisor's own enforcement.
      timeout: timeout.capMs > 0 ? timeout.capMs + timeout.graceMs + 60_000 : undefined,
      killSignal: "SIGKILL",
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    const outcome = readOutcome(resultPath);
    return toLegResult({ outcome, stdout, stderr, supervisorFailed: result.error != null && outcome == null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function spawnLegAsync(command: string, args: string[], options: SpawnLegOptions = {}): Promise<LegResult> {
  const timeout = resolveLegTimeout(options.timeout);
  const { dir, specPath, resultPath } = writeSpec({ command, args, cwd: options.cwd, timeout });
  return new Promise<LegResult>((resolveLeg) => {
    let stdout = "";
    let stderr = "";
    const done = (extra: LegResult) => {
      rmSync(dir, { recursive: true, force: true });
      resolveLeg(extra);
    };
    let sup: ChildProcess;
    try {
      sup = spawn(process.execPath, [SUPERVISOR_PATH, specPath], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      done({ status: null, stdout: "", stderr: String((error as Error)?.message ?? error), error: error as Error });
      return;
    }
    sup.stdout?.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    sup.stderr?.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    sup.on("error", (error) => {
      done({ status: null, stdout, stderr: `${stderr}${error?.message ?? error}`, error });
    });
    sup.on("close", () => {
      const outcome = readOutcome(resultPath);
      done(toLegResult({ outcome, stdout, stderr, supervisorFailed: outcome == null }));
    });
  });
}
