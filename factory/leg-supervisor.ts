#!/usr/bin/env node
// Per-leg timeout supervisor — the SINGLE owner of "run one agent-CLI leg in its
// own process group, enforce a hard wall-clock cap AND a stall/idle timeout, and
// kill the WHOLE process tree if either trips so no orphaned children linger".
//
// Why a separate process instead of an in-process timer: the dev-loop's default
// (sequential) path spawns legs synchronously (spawnSync), and spawnSync neither
// supports `detached` (own process group) nor an idle timeout nor a tree-kill. By
// running THIS supervisor as the child, both the sync caller (spawnSync of node
// leg-supervisor) and the async caller (spawn of node leg-supervisor) share ONE
// timeout + group-kill implementation — there is no second copy of the policy.
//
// Contract (the parent in agent-spawn.ts depends on it):
//   - argv[2] is a path to a JSON spec file:
//       { command, args, cwd, capMs, idleMs, graceMs, resultPath }
//   - the leg's stdout/stderr are piped straight through to THIS process's
//     stdout/stderr, so the parent's `stdio:[inherit,"pipe","pipe"]` capture +
//     tee work exactly as before (the supervisor is transparent on the streams).
//   - the supervisor itself writes NOTHING to stdout/stderr of its own (only the
//     leg's bytes flow), so captured output is the leg's output, unpolluted.
//   - on exit it writes `resultPath` with the structured outcome:
//       { status, signal, timedOut, timeoutReason }
//     and exits 0 (a timeout is NOT a supervisor crash — the parent reads the
//     result file to learn the leg's real fate).
//   - the leg runs DETACHED in its own process group; on a cap/idle trip the
//     supervisor sends SIGTERM to the whole group, then SIGKILL after graceMs.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// The JSON spec file the parent (leg-timeout.ts) writes and passes as argv[2].
interface Spec {
  command: string;
  args: string[];
  cwd?: string;
  capMs: number;
  idleMs: number;
  graceMs: number;
  resultPath: string;
}

// The structured outcome written to resultPath; the parent reads it to learn the
// leg's real fate.
interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutReason: string | null;
  spawnError?: string;
}

// Human duration for the timeout reason: minutes when >= 1 min, else seconds, so
// the message reads honestly at both production (45 min) and test (sub-second)
// scales instead of rounding everything to "0 min".
function humanMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)} min`;
  return `${Math.max(1, Math.round(ms / 1000))} s`;
}

function readSpec(): Spec {
  const specPath = process.argv[2];
  if (!specPath) {
    process.stderr.write("leg-supervisor: missing spec path argument\n");
    process.exit(64);
  }
  return JSON.parse(readFileSync(specPath, "utf8")) as Spec;
}

// SIGTERM the leg's whole process group, then SIGKILL the group after a grace
// period if anything survives. We signal the GROUP (negative pid) because the CLI
// launches its own children (codex/claude spawn subprocesses); killing only the
// leader would orphan them. The leader was spawned `detached`, so it is its own
// group leader and its pid doubles as the group id.
function killTree(child: ChildProcess, graceMs: number, onKilled?: () => void): void {
  const pgid = child.pid!;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pgid, signal); // negative pid => the whole group
    } catch {
      // Group already gone (race with natural exit) — fall back to the leader so
      // we never leave the immediate child alive on a platform quirk.
      try {
        child.kill(signal);
      } catch {
        /* already reaped */
      }
    }
  };
  signalGroup("SIGTERM");
  const killTimer = setTimeout(() => signalGroup("SIGKILL"), graceMs);
  killTimer.unref?.();
  if (onKilled) onKilled();
}

function main() {
  const spec = readSpec();
  const { command, args, cwd, capMs, idleMs, graceMs, resultPath } = spec;

  let settled = false;
  let timedOut = false;
  let timeoutReason: string | null = null;
  let capTimer: NodeJS.Timeout | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  const finish = (outcome: Outcome) => {
    if (settled) return;
    settled = true;
    if (capTimer) clearTimeout(capTimer);
    if (idleTimer) clearTimeout(idleTimer);
    try {
      writeFileSync(resultPath, JSON.stringify(outcome));
    } catch {
      /* best-effort: the parent treats a missing/unreadable result as a failure */
    }
    // Always exit 0: the supervisor itself did not fail. The leg's real status
    // (including a timeout) lives in the result file.
    process.exit(0);
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      env: process.env, // the parent already composed the leg env into our env
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // own process group so we can kill the whole tree
    });
  } catch (error) {
    finish({ status: null, signal: null, timedOut: false, timeoutReason: null, spawnError: String((error as Error)?.message ?? error) });
    return;
  }

  // Reset the idle watchdog on every byte from the leg. Whichever fires first —
  // the hard cap or the idle timeout — kills the group with a distinct reason.
  const armIdle = () => {
    if (!idleMs || idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      timedOut = true;
      timeoutReason = `leg idle for ${humanMs(idleMs)} (no output)`;
      killTree(child, graceMs);
    }, idleMs);
    idleTimer.unref?.();
  };

  child.stdout?.on("data", (chunk) => {
    process.stdout.write(chunk);
    armIdle();
  });
  child.stderr?.on("data", (chunk) => {
    process.stderr.write(chunk);
    armIdle();
  });

  if (capMs && capMs > 0) {
    capTimer = setTimeout(() => {
      timedOut = true;
      timeoutReason = `leg timed out after ${humanMs(capMs)} (hard cap)`;
      killTree(child, graceMs);
    }, capMs);
    capTimer.unref?.();
  }
  armIdle();

  child.on("error", (error) => {
    finish({ status: null, signal: null, timedOut, timeoutReason, spawnError: String((error as Error)?.message ?? error) });
  });
  child.on("close", (code, signal) => {
    // If we tripped a timeout, report it as a timeout REGARDLESS of the exit code
    // the kill produced (SIGTERM/SIGKILL surface as a signal or a 143/137 code).
    if (timedOut) {
      finish({ status: null, signal: signal ?? null, timedOut: true, timeoutReason });
      return;
    }
    finish({ status: code, signal: signal ?? null, timedOut: false, timeoutReason: null });
  });
}

main();
