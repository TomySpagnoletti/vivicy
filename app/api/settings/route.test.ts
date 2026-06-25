import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentsSettings } from "@/lib/settings"

// Mock the server-only settings store so the route never touches the runtime
// dir / filesystem. `readSettings` backs GET; `writeSettings` backs PUT and is
// the normalization+validation seam — the route must echo what it RETURNS, not
// the raw request body.
const { readSettings, writeSettings } = vi.hoisted(() => ({
  readSettings: vi.fn(),
  writeSettings: vi.fn(),
}))

vi.mock("@/lib/settings-store", () => ({ readSettings, writeSettings }))

import { GET, PUT } from "./route"

/** A complete, already-validated settings document the store would return. */
const NORMALIZED: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
  reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
  maxParallel: 1,
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
    // The route forwards the raw body to writeSettings, which normalizes it; the
    // response must reflect the normalized result, never the unsanitized request.
    const rawInput = { implementer: { effort: "bogus" }, maxParallel: 9999 }
    writeSettings.mockReturnValue(NORMALIZED)

    const res = await PUT(putJson(rawInput))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(writeSettings).toHaveBeenCalledWith(rawInput)
    expect(body).toEqual({ ok: true, settings: NORMALIZED })
    // Proof the echoed doc is the normalized one, not the raw clamp-busting input.
    expect(body.settings.maxParallel).toBe(1)
    expect(body.settings.implementer.effort).toBe("xhigh")
  })

  it("forwards a null body to the store (which normalizes to defaults)", async () => {
    writeSettings.mockReturnValue(NORMALIZED)

    // A non-JSON body is caught by the route's `.catch(() => null)` and passed as
    // null; the store normalizes null to a complete document.
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
