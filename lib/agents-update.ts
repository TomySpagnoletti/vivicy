// Server-only (node:child_process): never import this from a client component.

import { execFile } from "node:child_process"

import type { AgentKey } from "@/lib/agents-health-types"

export interface UpdateCommand {
  cmd: string
  args: readonly string[]
}

// Closed allow-list: exactly one fixed entry per agent, never templated or interpolated.
export const AGENT_UPDATE_COMMANDS: Record<AgentKey, UpdateCommand> = {
  claude: { cmd: "claude", args: ["update"] },
  codex: { cmd: "codex", args: ["update"] },
}

export const MAX_UPDATE_OUTPUT_BYTES = 64 * 1024

const UPDATE_TIMEOUT_MS = 5 * 60_000

export interface UpdateRunResult {
  code: number | null
  stdout: string
  stderr: string
  ok: boolean
}

export type AgentExec = (cmd: string, args: readonly string[]) => Promise<UpdateRunResult>

export class UnknownAgentError extends Error {
  constructor(public readonly agent: string) {
    super(`Unknown agent: ${JSON.stringify(agent)}`)
    this.name = "UnknownAgentError"
  }
}

export function isAgentKey(value: unknown): value is AgentKey {
  return value === "claude" || value === "codex"
}

// Never cap by byte-slicing: it splits a multi-byte code point into U+FFFD.
export function capBytes(text: string, max: number): string {
  if (Buffer.byteLength(text, "utf8") <= max) return text
  let used = 0
  let out = ""
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > max) break
    out += ch
    used += size
  }
  return out
}

export const nodeExec: AgentExec = (cmd, args) =>
  new Promise<UpdateRunResult>((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        timeout: UPDATE_TIMEOUT_MS,
        maxBuffer: MAX_UPDATE_OUTPUT_BYTES * 2,
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

export async function runAgentUpdate(
  agent: unknown,
  exec: AgentExec = nodeExec
): Promise<UpdateRunResult & { agent: AgentKey; command: string }> {
  if (!isAgentKey(agent)) throw new UnknownAgentError(String(agent))
  const { cmd, args } = AGENT_UPDATE_COMMANDS[agent]
  const result = await exec(cmd, args)
  return { ...result, agent, command: [cmd, ...args].join(" ") }
}
