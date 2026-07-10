import { describe, expect, it, vi } from "vitest"

import {
  AGENT_UPDATE_COMMANDS,
  type AgentExec,
  capBytes,
  isAgentKey,
  runAgentUpdate,
  UnknownAgentError,
  type UpdateRunResult,
} from "@/lib/agents-update"

function recordingExec(result: Partial<UpdateRunResult> = {}): {
  exec: AgentExec
  calls: Array<{ cmd: string; args: readonly string[] }>
} {
  const calls: Array<{ cmd: string; args: readonly string[] }> = []
  const exec: AgentExec = vi.fn(async (cmd, args) => {
    calls.push({ cmd, args })
    return { code: 0, stdout: "updated", stderr: "", ok: true, ...result }
  })
  return { exec, calls }
}

describe("agents-update allow-list", () => {
  it("maps each agent to its OWN built-in self-update command", () => {
    expect(AGENT_UPDATE_COMMANDS.claude).toEqual({ cmd: "claude", args: ["update"] })
    expect(AGENT_UPDATE_COMMANDS.codex).toEqual({ cmd: "codex", args: ["update"] })
  })

  it("runs ONLY the fixed claude command for agent=claude", async () => {
    const { exec, calls } = recordingExec()
    const result = await runAgentUpdate("claude", exec)
    expect(calls).toEqual([{ cmd: "claude", args: ["update"] }])
    expect(result).toMatchObject({ agent: "claude", command: "claude update", ok: true })
  })

  it("runs ONLY the fixed codex command for agent=codex", async () => {
    const { exec, calls } = recordingExec()
    const result = await runAgentUpdate("codex", exec)
    expect(calls).toEqual([{ cmd: "codex", args: ["update"] }])
    expect(result.command).toBe("codex update")
  })

  it("rejects an unknown agent BEFORE running anything", async () => {
    const { exec, calls } = recordingExec()
    await expect(runAgentUpdate("rm-rf", exec)).rejects.toBeInstanceOf(UnknownAgentError)
    expect(calls).toEqual([])
    expect(exec).not.toHaveBeenCalled()
  })

  it("rejects an injection-shaped agent string (no shell, no passthrough)", async () => {
    const { exec, calls } = recordingExec()
    await expect(runAgentUpdate("claude; rm -rf /", exec)).rejects.toBeInstanceOf(
      UnknownAgentError
    )
    expect(calls).toEqual([])
  })

  it("rejects non-string / object agents", async () => {
    const { exec } = recordingExec()
    await expect(runAgentUpdate(undefined, exec)).rejects.toBeInstanceOf(UnknownAgentError)
    await expect(runAgentUpdate({ agent: "claude" }, exec)).rejects.toBeInstanceOf(
      UnknownAgentError
    )
  })

  it("surfaces a non-zero exit honestly (ok=false, code, stderr)", async () => {
    const { exec } = recordingExec({ code: 1, ok: false, stderr: "network error", stdout: "" })
    const result = await runAgentUpdate("codex", exec)
    expect(result.ok).toBe(false)
    expect(result.code).toBe(1)
    expect(result.stderr).toBe("network error")
  })

  it("isAgentKey accepts only the two allow-listed keys", () => {
    expect(isAgentKey("claude")).toBe(true)
    expect(isAgentKey("codex")).toBe(true)
    expect(isAgentKey("gemini")).toBe(false)
    expect(isAgentKey("")).toBe(false)
    expect(isAgentKey(null)).toBe(false)
    expect(isAgentKey(42)).toBe(false)
  })
})

describe("capBytes — output cap never splits a UTF-8 code point", () => {
  it("returns short ASCII unchanged", () => {
    expect(capBytes("hello", 64)).toBe("hello")
  })

  it("truncates at a byte budget without producing replacement chars", () => {
    const out = capBytes("hello 你好", 8)
    expect(out).toBe("hello ")
    expect(out).not.toContain("�")
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(8)
  })

  it("keeps a multibyte char only when it fits entirely in the budget", () => {
    const out = capBytes("a你b", 4)
    expect(out).toBe("a你")
    expect(Buffer.byteLength(out, "utf8")).toBe(4)
    expect(out).not.toContain("�")
  })

  it("preserves astral (surrogate-pair) emoji as a whole", () => {
    expect(capBytes("😀", 4)).toBe("😀")
    expect(capBytes("😀", 3)).toBe("")
  })
})
