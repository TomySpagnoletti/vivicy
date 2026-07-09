import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentsHealth } from "@/lib/agents-health-types"

// Mock the server-only detector so the route is exercised without probing the
// real PATH/Keychain. The memo is module-scoped, so each test re-imports the
// route through a fresh module graph to start from an empty cache.
const { getAgentsHealth } = vi.hoisted(() => ({ getAgentsHealth: vi.fn() }))

vi.mock("@/lib/agents-health", () => ({ getAgentsHealth }))

function health(claudePresent: boolean): AgentsHealth {
  const agent = (present: boolean) => ({
    present,
    version: present ? "1.0.0" : null,
    authenticated: present,
    authMethod: null,
    plan: null,
  })
  return { claude: agent(claudePresent), codex: agent(true) }
}

async function freshRoute() {
  vi.resetModules()
  return await import("./route")
}

function request(url: string): Request {
  return new Request(url)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/agents/health — once-per-process memo (W4a)", () => {
  it("probes on the first call and serves the memo on the second", async () => {
    const { GET } = await freshRoute()
    getAgentsHealth.mockReturnValue(health(false))

    const first = await GET(request("http://localhost/api/agents/health"))
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ ok: true, agents: health(false) })
    expect(getAgentsHealth).toHaveBeenCalledTimes(1)

    // The CLI landscape "changed" — but without ?fresh=1 the memo is served.
    getAgentsHealth.mockReturnValue(health(true))
    const second = await GET(request("http://localhost/api/agents/health"))
    expect(await second.json()).toEqual({ ok: true, agents: health(false) })
    expect(getAgentsHealth).toHaveBeenCalledTimes(1)
  })

  it("?fresh=1 re-probes and replaces the memo for later plain GETs", async () => {
    const { GET } = await freshRoute()
    getAgentsHealth.mockReturnValue(health(false))
    await GET(request("http://localhost/api/agents/health"))

    getAgentsHealth.mockReturnValue(health(true))
    const fresh = await GET(request("http://localhost/api/agents/health?fresh=1"))
    expect(await fresh.json()).toEqual({ ok: true, agents: health(true) })
    expect(getAgentsHealth).toHaveBeenCalledTimes(2)

    // The re-probe result IS the new memo.
    const after = await GET(request("http://localhost/api/agents/health"))
    expect(await after.json()).toEqual({ ok: true, agents: health(true) })
    expect(getAgentsHealth).toHaveBeenCalledTimes(2)
  })

  it("the first call re-probes even when fresh is not requested (empty memo)", async () => {
    const { GET } = await freshRoute()
    getAgentsHealth.mockReturnValue(health(true))
    const res = await GET(request("http://localhost/api/agents/health"))
    expect(await res.json()).toEqual({ ok: true, agents: health(true) })
    expect(getAgentsHealth).toHaveBeenCalledTimes(1)
  })
})
