import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentsHealth } from "@/lib/agents-health-types"

const { runAgentUpdate, getAgentsHealth } = vi.hoisted(() => ({
  runAgentUpdate: vi.fn(),
  getAgentsHealth: vi.fn(),
}))

vi.mock("@/lib/agents-update", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agents-update")>(
    "@/lib/agents-update"
  )
  return { ...actual, runAgentUpdate }
})
vi.mock("@/lib/agents-health", () => ({ getAgentsHealth }))

import { UnknownAgentError } from "@/lib/agents-update"

import { POST } from "./route"

const FRESH_HEALTH: AgentsHealth = {
  claude: {
    present: true,
    version: "2.1.192",
    authenticated: true,
    authMethod: "subscription",
    plan: "max",
  },
  codex: {
    present: true,
    version: "0.142.0",
    authenticated: true,
    authMethod: "subscription",
    plan: "ChatGPT",
  },
}

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/agents/update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getAgentsHealth.mockReturnValue(FRESH_HEALTH)
})

describe("POST /api/agents/update", () => {
  it("runs the allow-listed update and returns the RE-DETECTED health", async () => {
    runAgentUpdate.mockResolvedValue({
      agent: "claude",
      command: "claude update",
      code: 0,
      stdout: "Updated to 2.1.192",
      stderr: "",
      ok: true,
    })

    const res = await POST(postJson({ agent: "claude" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(runAgentUpdate).toHaveBeenCalledWith("claude")
    expect(body.ok).toBe(true)
    expect(body.command).toBe("claude update")
    expect(body.stdout).toContain("2.1.192")
    expect(getAgentsHealth).toHaveBeenCalledTimes(1)
    expect(body.agents.claude.version).toBe("2.1.192")
  })

  it("rejects an unknown agent with 400 and never re-detects", async () => {
    const res = await POST(postJson({ agent: "gemini" }))
    expect(res.status).toBe(400)
    expect(runAgentUpdate).not.toHaveBeenCalled()
    expect(getAgentsHealth).not.toHaveBeenCalled()
  })

  it("rejects a missing/garbage body with 400", async () => {
    const res = await POST(postJson({}))
    expect(res.status).toBe(400)
    expect(runAgentUpdate).not.toHaveBeenCalled()
  })

  it("maps a deeper UnknownAgentError (runner-level) to 400", async () => {
    runAgentUpdate.mockRejectedValue(new UnknownAgentError("claude; rm -rf /"))
    const res = await POST(postJson({ agent: "codex" }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })

  it("reports a failed update honestly (ok=false, exit code) with 200 transport", async () => {
    runAgentUpdate.mockResolvedValue({
      agent: "codex",
      command: "codex update",
      code: 1,
      stdout: "",
      stderr: "network error",
      ok: false,
    })
    const res = await POST(postJson({ agent: "codex" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.code).toBe(1)
    expect(body.stderr).toBe("network error")
    expect(body.agents).toBeTruthy()
  })

  it("returns 500 on an unexpected runner error", async () => {
    runAgentUpdate.mockRejectedValue(new Error("spawn EACCES"))
    const res = await POST(postJson({ agent: "claude" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})
