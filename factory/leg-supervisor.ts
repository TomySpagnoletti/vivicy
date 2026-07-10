#!/usr/bin/env node
// Standalone process, not an in-process timer: spawnSync (the dev-loop's sync leg-spawn path) can't do detached/idle-timeout/tree-kill, so both sync and async callers share this one process as the timeout+kill implementation.
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

interface Spec {
  command: string;
  args: string[];
  cwd?: string;
  capMs: number;
  idleMs: number;
  graceMs: number;
  resultPath: string;
}

interface Outcome {
  status: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  timeoutReason: string | null;
  spawnError?: string;
}

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

// Signal the group (-pgid), not the leader: the CLI spawns its own subprocesses, so killing only the leader would orphan them.
function killTree(child: ChildProcess, graceMs: number, onKilled?: () => void): void {
  const pgid = child.pid!;
  const signalGroup = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pgid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
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
    }
    process.exit(0);
  };

  let child: ChildProcess;
  try {
    child = spawn(command, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
  } catch (error) {
    finish({ status: null, signal: null, timedOut: false, timeoutReason: null, spawnError: String((error as Error)?.message ?? error) });
    return;
  }

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
    // Report timedOut regardless of exit code: SIGTERM/SIGKILL surface as a signal or a 143/137 code that would otherwise look like a normal exit.
    if (timedOut) {
      finish({ status: null, signal: signal ?? null, timedOut: true, timeoutReason });
      return;
    }
    finish({ status: code, signal: signal ?? null, timedOut: false, timeoutReason: null });
  });
}

main();
