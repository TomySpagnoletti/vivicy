import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentsSettings } from "@/lib/settings"

const { readSettings, writeSettings } = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}))

vi.mock("@/lib/settings-store", () => ({ readSettings, writeSettings }))

import { GET, PUT } from "./route"

const NORMALIZED: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
  reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
  maxParallel: 1,
  allowUnsafeSkills: false,
}

function putJson(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/settings", () => {
  it("returns the current settings (200)", async () => {
    readSettings.mockReturnValue(NORMALIZED)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, settings: NORMALIZED })
  })
})

describe("PUT /api/settings", () => {
  it("echoes the VALIDATED document the store returns, not the raw input (200)", async () => {
    const rawInput = { implementer: { effort: "bogus" }, maxParallel: 9999 }
    writeSettings.mockReturnValue(NORMALIZED)

    const res = await PUT(putJson(rawInput))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(writeSettings).toHaveBeenCalledWith(rawInput)
    expect(body).toEqual({ ok: true, settings: NORMALIZED })
    expect(body.settings.maxParallel).toBe(1)
    expect(body.settings.implementer.effort).toBe("xhigh")
  })

  it("forwards a null body to the store (which normalizes to defaults)", async () => {
    writeSettings.mockReturnValue(NORMALIZED)

    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      })
    )
    expect(res.status).toBe(200)
    expect(writeSettings).toHaveBeenCalledWith(null)
    const body = await res.json()
    expect(body).toEqual({ ok: true, settings: NORMALIZED })
  })

  it("rejects a non-object body (array or primitive) as 400 without writing", async () => {
    for (const invalid of [[], 5, "settings", true]) {
      const res = await PUT(putJson(invalid))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
    }
    expect(writeSettings).not.toHaveBeenCalled()
  })

  it("maps a store failure to 500", async () => {
    writeSettings.mockImplementation(() => {
      throw new Error("disk full")
    })

    const res = await PUT(putJson({ maxParallel: 2 }))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("disk full")
  })
})
