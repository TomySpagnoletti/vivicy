// A tree a child process may still be flushing into needs the WHOLE recursive removal re-invoked after a wait (AGENTS.md "Platform traps" — fs.rm's own retry budget cannot do it), and a cleanup that throws would replace its caller's outcome, so a leftover is announced on fd 2, never raised, and retried at exit when every child is reaped.
import { existsSync, rmSync, writeSync } from "node:fs";
import { countOf } from "../lib/count-form.ts";
import { sleepSync } from "./sleep-sync.ts";

const DEFAULT_ATTEMPTS = 10;
const DEFAULT_BACKOFF_STEP_MS = 50;
const EXIT_ATTEMPTS = 3;

// The codes worth re-invoking the removal for, each stating only what it witnesses: ENOTEMPTY covers BOTH a live writer and a subdirectory whose permissions deny removal (node reports that inner EACCES as a non-empty parent), so the hint never asserts a cause it cannot know. A code absent from this table is not transient — it is announced once and never retried.
const RETRYABLE: Record<string, string> = {
  ENOTEMPTY: "entries keep reappearing or resist removal — a live writer, or a subdirectory that denies removal",
  EBUSY: "the tree or a file in it is held open",
  ENOTDIR: "a path component changed type under the walk",
  EMFILE: "this process is out of file descriptors",
  ENFILE: "the system is out of file descriptors",
  EPERM: "the filesystem or its permissions deny removal",
  EACCES: "the filesystem or its permissions deny removal",
};

export interface CleanupTreeOptions {
  attempts?: number;
  backoffStepMs?: number;
}

interface Failure {
  reason: string;
  attempts: number;
  retryable: boolean;
}

const leftover = new Set<string>();
let drainInstalled = false;

function announce(message: string): void {
  try {
    writeSync(2, `${message}\n`);
  } catch {
  }
}

function describe(error: unknown, attempts: number): Failure {
  const code = (error as NodeJS.ErrnoException)?.code ?? "";
  const hint = RETRYABLE[code];
  if (hint) return { reason: `${code} — ${hint}`, attempts, retryable: true };
  return { reason: code || String((error as Error)?.message ?? error), attempts, retryable: false };
}

function removeOnce(dir: string, attempts: number, backoffStepMs: number): Failure | null {
  let failure: Failure = { reason: "unknown", attempts, retryable: false };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return null;
    } catch (error) {
      failure = describe(error, attempt);
      if (!failure.retryable) return failure;
      if (attempt < attempts) sleepSync(attempt * backoffStepMs);
    }
  }
  return failure;
}

function attemptsMade(failure: Failure): string {
  return countOf(failure.attempts, "removal attempt", "removal attempts");
}

function drainLeftovers(): void {
  const pending = [...leftover];
  leftover.clear();
  for (const dir of pending) {
    if (!existsSync(dir)) continue;
    const failure = removeOnce(dir, EXIT_ATTEMPTS, DEFAULT_BACKOFF_STEP_MS);
    announce(
      failure === null
        ? `[cleanup] removed at exit: ${dir}`
        : `[cleanup] LEAKED ${dir} after ${attemptsMade(failure)} at exit (${failure.reason}) — nothing else will remove it; delete it by hand`,
    );
  }
}

export function cleanupTree(dir: string, options: CleanupTreeOptions = {}): boolean {
  const attempts = Math.max(1, Math.floor(options.attempts ?? DEFAULT_ATTEMPTS));
  const backoffStepMs = Math.max(0, Math.floor(options.backoffStepMs ?? DEFAULT_BACKOFF_STEP_MS));
  const failure = removeOnce(dir, attempts, backoffStepMs);
  if (failure === null) {
    leftover.delete(dir);
    return true;
  }
  if (!failure.retryable) {
    announce(`[cleanup] ${dir} was not removed after ${attemptsMade(failure)} (${failure.reason}); nothing further will retry it`);
    return false;
  }
  leftover.add(dir);
  if (!drainInstalled) {
    drainInstalled = true;
    process.once("exit", drainLeftovers);
  }
  announce(`[cleanup] ${dir} survived ${attemptsMade(failure)} (${failure.reason}); up to ${EXIT_ATTEMPTS} more attempts at exit`);
  return false;
}
