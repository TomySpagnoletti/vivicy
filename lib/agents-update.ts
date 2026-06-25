/**
 * Server-only self-update for the two agent CLIs Vivicy drives (Claude Code and
 * the Codex CLI). Vivicy is a LOCAL, single-user tool, so the Next server is
 * allowed to exec — but ONLY a fixed, allow-listed update command per agent.
 *
 * Safety by construction:
 *   - The agent name selects an entry from {@link AGENT_UPDATE_COMMANDS}; an
 *     unknown name is rejected before anything runs.
 *   - Each entry hard-codes the command and its argv. NO user input is ever
 *     interpolated into a shell — there is no shell at all (`execFile`-style argv
 *     spawn), so command injection is structurally impossible.
 *   - The chosen update command is the CLI's OWN built-in self-updater, verified
 *     to exist on this machine:
 *       · `claude update` — Claude Code's built-in `update|upgrade` command.
 *       · `codex update`  — Codex CLI's built-in `update` subcommand.
 *     (The global-`npm install` form is the documented manual fallback the UI
 *     surfaces as copyable text; it is intentionally NOT run by this route to
 *     keep the allow-list to a single command per agent.)
 *
 * Output is captured (stdout + stderr) and capped so a chatty updater can never
 * grow the buffer unbounded; the exit code is reported honestly. After a
 * successful update the caller re-runs health detection so the modal shows the
 * fresh version.
 *
 * `node:child_process` lives here so it never reaches the client bundle.
 */

import { execFile } from "node:child_process"

import type { AgentKey } from "@/lib/agents-health-types"

/** One allow-listed, argument-locked update command. */
export interface UpdateCommand {
  /** The executable to run (resolved on PATH). */
  cmd: string
  /** The FIXED argument vector — never derived from request input. */
  args: readonly string[]
}

/**
 * The ONLY commands this route may ever run, keyed by agent. Each agent's own
 * built-in self-updater, verified present via `<cli> --help`. There is exactly
 * one entry per agent and no template/interpolation, so the surface is closed.
 */
export const AGENT_UPDATE_COMMANDS: Record<AgentKey, UpdateCommand> = {
  claude: { cmd: "claude", args: ["update"] },
  codex: { cmd: "codex", args: ["update"] },
}

/** Cap on captured output (bytes) so a verbose updater never grows unbounded. */
export const MAX_UPDATE_OUTPUT_BYTES = 64 * 1024

/** Hard timeout (ms) for an update run — generous, but never hangs the route. */
const UPDATE_TIMEOUT_MS = 5 * 60_000

/** Result of running one allow-listed update command. */
export interface UpdateRunResult {
  /** The process exit code, or null when killed by a signal/timeout. */
  code: number | null
  /** Captured, capped combined stdout. */
  stdout: string
  /** Captured, capped combined stderr. */
  stderr: string
  /** True only when the process exited 0. */
  ok: boolean
}

/**
 * Injectable exec seam. The real implementation ({@link nodeExec}) spawns the
 * command with a fixed argv via `execFile` (NO shell); tests inject a fake so the
 * allow-list and re-detection are exercised without touching a real CLI.
 */
export type AgentExec = (cmd: string, args: readonly string[]) => Promise<UpdateRunResult>

/** Thrown for an unrecognised agent name — the request never reaches exec. */
export class UnknownAgentError extends Error {
  constructor(public readonly agent: string) {
    super(`Unknown agent: ${JSON.stringify(agent)}`)
    this.name = "UnknownAgentError"
  }
}

/** True when `value` is one of the allow-listed agent keys. */
export function isAgentKey(value: unknown): value is AgentKey {
  return value === "claude" || value === "codex"
}

/**
 * Cap a string to at most `max` UTF-8 bytes WITHOUT splitting a multi-byte code
 * point (a naive byte-slice would corrupt the last character into U+FFFD).
 * Accumulates whole code points until the next one would exceed the budget.
 * Exported for direct unit coverage of the truncation boundary.
 */
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text
  let used = 0
  let out = ""
  // Iterating the string yields whole code points (surrogate pairs intact).
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > max) break
    out += ch
    used += size
  }
  return out
}

/**
 * The real exec: spawn `cmd` with the FIXED `args` via `execFile` — no shell, so
 * no interpolation and no injection. Captures stdout/stderr (capped) and the exit
 * code; a non-zero exit or a spawn error resolves with `ok: false` rather than
 * throwing, so the route always returns a structured result.
 */
export const nodeExec: AgentExec = (cmd, args) =>
  new Promise<UpdateRunResult>((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: MAX_UPDATE_OUTPUT_BYTES * 2,
        // Inherit PATH etc. but never a shell — argv is passed directly.
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const out = capBytes(stdout ?? "", MAX_UPDATE_OUTPUT_BYTES)
        const err = capBytes(stderr ?? "", MAX_UPDATE_OUTPUT_BYTES)
        if (error) {
          const code = typeof error.code === "number" ? error.code : null
          resolve({
            code,
            stdout: out,
            stderr: err || error.message,
            ok: false,
          })
          return
        }
        resolve({ code: 0, stdout: out, stderr: err, ok: true })
      }
    )
  })

/**
 * Run the allow-listed self-update for `agent`. Validates the agent name against
 * {@link AGENT_UPDATE_COMMANDS} (throwing {@link UnknownAgentError} for anything
 * else) and runs ONLY that fixed command through the injected `exec`. Never
 * interpolates request input into a command.
 */
export async function runAgentUpdate(
  agent: unknown,
  exec: AgentExec = nodeExec
): Promise<UpdateRunResult & { agent: AgentKey; command: string }> {
  if (!isAgentKey(agent)) throw new UnknownAgentError(String(agent))
  const { cmd, args } = AGENT_UPDATE_COMMANDS[agent]
  const result = await exec(cmd, args)
  return { ...result, agent, command: [cmd, ...args].join(" ") }
}
