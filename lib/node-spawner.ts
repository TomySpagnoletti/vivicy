/**
 * Real {@link Spawner} backed by `node:child_process`. Server-only.
 *
 * `spawnDetached` launches the supervisor in its own process group
 * (`detached: true`), redirects stdio to a log file, and `.unref()`s it so the
 * Next.js server can exit without killing the run. `killGroup` signals the
 * whole group (negative pid) so the supervisor's relaunched children die with
 * it. `run` collects bounded output for short-lived check scripts.
 */

import { spawn, type SpawnOptions } from "node:child_process"
import { openSync } from "node:fs"

import type {
  DetachedHandle,
  RunOptions,
  RunResult,
  SpawnDetachedOptions,
  Spawner,
} from "@/lib/control"

/** Keep collected output bounded; we only surface the last line in the UI. */
const MAX_OUTPUT_BYTES = 256 * 1024

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.length > 0) return line
  }
  return ""
}

export const nodeSpawner: Spawner = {
  spawnDetached({ command, args, cwd, env, logFile }: SpawnDetachedOptions): DetachedHandle {
    // Append so resume runs accumulate rather than truncate the prior log.
    const out = openSync(logFile, "a")
    const err = openSync(logFile, "a")
    const options: SpawnOptions = {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", out, err],
    }
    const child = spawn(command, args, options)
    if (typeof child.pid !== "number") {
      throw new Error("child process did not start (no pid)")
    }
    // Let the server exit independently of the supervised run.
    child.unref()
    return { pid: child.pid }
  },

  run({ command, args, cwd, env }: RunOptions): Promise<RunResult> {
    return new Promise((resolve) => {
      const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
      let stdout = ""
      let stderr = ""
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString("utf8")
      })
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString("utf8")
      })
      child.on("error", (error) => {
        resolve({
          code: null,
          lastLine: error.message,
          stdout,
          stderr: stderr || error.message,
        })
      })
      child.on("close", (code) => {
        resolve({
          code,
          lastLine: lastNonEmptyLine(stdout),
          stdout,
          stderr,
        })
      })
    })
  },

  killGroup(pid: number, signal: NodeJS.Signals = "SIGTERM"): boolean {
    try {
      // Negative pid targets the whole process group created by detached spawn.
      process.kill(-pid, signal)
      return true
    } catch {
      // Fall back to the single pid (e.g. group already partially reaped).
      try {
        process.kill(pid, signal)
        return true
      } catch {
        return false
      }
    }
  },

  isAlive(pid: number): boolean {
    try {
      // Signal 0 probes existence without affecting the process.
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
}
