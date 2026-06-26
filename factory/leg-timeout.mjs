// Per-leg timeout POLICY + the spawn driver that enforces it via leg-supervisor.
//
// One source of truth for "how long may a single agent leg run, and what happens
// when it overruns". Both the dev-loop (dev-loop.mjs) and the issue extractor
// (extract-issues.mjs) drive their legs through agent-spawn.mjs, which delegates
// the actual process launch to the helpers here — so the cap, the idle timeout,
// the process-group kill, and the structured timeout result are defined ONCE.
//
// The real failure that motivated this: a `codex exec` reviewer leg stalled
// internally (alive but producing nothing) and the orchestrator awaited it for
// ~5 hours because there was NO per-leg timeout. Heartbeats/retries at the loop
// level cannot rescue a single process that is alive-but-stuck — only killing the
// leg can. So every leg now runs under TWO independent watchdogs:
//   - a hard WALL-CLOCK CAP (default 45 min): the absolute ceiling for one leg.
//     Legit hard issues at xhigh effort can take 15-30 min, so the cap is generous.
//   - a STALL / IDLE timeout (default 12 min): no new stdout/stderr for this long
//     means the CLI is wedged even if it has not hit the cap.
// Whichever trips first kills the leg's whole process group and returns a
// structured timeout failure (distinct from a normal non-zero exit) so the loop
// treats it as a FAILED attempt within its existing bounded-retry logic.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const SUPERVISOR_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "leg-supervisor.mjs");

// Defaults, overridable per-deployment via env (documented in factory/AGENTS.md).
//   VIVICY_LEG_TIMEOUT_MS — hard wall-clock cap per leg.
//   VIVICY_LEG_IDLE_MS    — stall timeout: max gap between output bytes.
//   VIVICY_LEG_KILL_GRACE_MS — SIGTERM -> SIGKILL grace after a trip.
export const DEFAULT_LEG_CAP_MS = 45 * 60 * 1000; // 45 minutes
export const DEFAULT_LEG_IDLE_MS = 12 * 60 * 1000; // 12 minutes
export const DEFAULT_LEG_KILL_GRACE_MS = 10 * 1000; // 10 seconds

// Parse a positive-integer env override; fall back to the default for anything
// missing or non-numeric. `0` is honored as "disabled" (no cap / no idle) so an
// operator can opt out explicitly without code changes.
function envMs(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

// Resolve the effective timeout policy. Explicit options (used by tests to make
// the cap/idle tiny) win over env, which wins over the documented defaults.
export function resolveLegTimeout(options = {}) {
  return {
    capMs: options.capMs ?? envMs("VIVICY_LEG_TIMEOUT_MS", DEFAULT_LEG_CAP_MS),
    idleMs: options.idleMs ?? envMs("VIVICY_LEG_IDLE_MS", DEFAULT_LEG_IDLE_MS),
    graceMs: options.graceMs ?? envMs("VIVICY_LEG_KILL_GRACE_MS", DEFAULT_LEG_KILL_GRACE_MS),
  };
}

// Build the spec file the supervisor reads, in a private temp dir we clean up.
function writeSpec({ command, args, cwd, timeout }) {
  const dir = mkdtempSync(resolve(tmpdir(), "vivicy-leg-"));
  const specPath = resolve(dir, "spec.json");
  const resultPath = resolve(dir, "result.json");
  writeFileSync(
    specPath,
    JSON.stringify({ command, args, cwd, capMs: timeout.capMs, idleMs: timeout.idleMs, graceMs: timeout.graceMs, resultPath }),
  );
  return { dir, specPath, resultPath };
}

// Turn the supervisor's structured outcome into the spawnSync-shaped leg result
// the rest of the pipeline understands ({ status, stdout, stderr }), enriched with
// the timeout fields. A timed-out leg gets a non-zero status AND timedOut:true +
// a human reason, so a caller can distinguish it from an ordinary red exit.
function toLegResult({ outcome, stdout, stderr, supervisorFailed }) {
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

function readOutcome(resultPath) {
  try {
    return JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    return null;
  }
}

// SYNC: run one leg under the timeout supervisor, blocking until it settles (the
// supervisor enforces cap + idle + tree-kill; spawnSync just waits for it). The
// supervisor pipes the leg's stdout/stderr straight through to its own, so our
// `stdio:[inherit,"pipe","pipe"]` captures the leg's real output unchanged.
export function spawnLegSync(command, args, options = {}) {
  const timeout = resolveLegTimeout(options.timeout);
  const { dir, specPath, resultPath } = writeSpec({ command, args, cwd: options.cwd, timeout });
  try {
    const result = spawnSync(process.execPath, [SUPERVISOR_PATH, specPath], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["inherit", "pipe", "pipe"],
      encoding: "utf8",
      // A safety net far above the leg cap, so even a wedged supervisor cannot
      // block forever: the leg cap + grace plus a generous margin.
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

// ASYNC: same supervisor, spawned non-blocking so N parallel legs each have a
// child running at once. Resolves to the same leg-result shape as spawnLegSync.
export function spawnLegAsync(command, args, options = {}) {
  const timeout = resolveLegTimeout(options.timeout);
  const { dir, specPath, resultPath } = writeSpec({ command, args, cwd: options.cwd, timeout });
  return new Promise((resolveLeg) => {
    let stdout = "";
    let stderr = "";
    const done = (extra) => {
      rmSync(dir, { recursive: true, force: true });
      resolveLeg(extra);
    };
    let sup;
    try {
      sup = spawn(process.execPath, [SUPERVISOR_PATH, specPath], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ["inherit", "pipe", "pipe"],
      });
    } catch (error) {
      done({ status: null, stdout: "", stderr: String(error?.message ?? error), error });
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
