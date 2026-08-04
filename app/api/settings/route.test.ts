import { beforeEach, describe, expect, it, vi } from "vitest"

import { DEFAULT_SETTINGS, type AgentsSettings, type SettingsState } from "@/lib/settings"

const { readSettingsState, saveSettings, getTargetRoot } = vi.hoisted(() => ({
  readSettingsState: vi.fn(),
  saveSettings: vi.fn(),
  getTargetRoot: vi.fn(),
}))

vi.mock("@/lib/settings-store", () => ({ readSettingsState, saveSettings }))
vi.mock("@/lib/target", () => ({ getTargetRoot }))

import { GET, PUT } from "./route"

const NORMALIZED: AgentsSettings = DEFAULT_SETTINGS

const STATE: SettingsState = { settings: NORMALIZED, draft: NORMALIZED, baseline: DEFAULT_SETTINGS, scope: "project" }

function putJson(body: unknown): Request {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getTargetRoot.mockReturnValue("/tmp/target")
})

describe("GET /api/settings", () => {
  it("returns the resolved settings with the scope a save would write and the tier below it (200)", async () => {
    readSettingsState.mockReturnValue(STATE)

    const res = await GET()
    expect(res.status).toBe(200)

    expect(readSettingsState).toHaveBeenCalledWith("/tmp/target")
    expect(await res.json()).toEqual({ ok: true, ...STATE })
  })

  it("passes a null target through, so the machine tier answers on its own", async () => {
    getTargetRoot.mockReturnValue(null)
    readSettingsState.mockReturnValue({ ...STATE, scope: "machine" })

    const body = await (await GET()).json()
    expect(readSettingsState).toHaveBeenCalledWith(null)
    expect(body.scope).toBe("machine")
  })
})

describe("PUT /api/settings", () => {
  it("echoes the VALIDATED state the store returns, not the raw input (200)", async () => {
    const rawInput = { implementer: { effort: "bogus" }, maxParallel: 9999 }
    saveSettings.mockReturnValue(STATE)

    const res = await PUT(putJson(rawInput))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(saveSettings).toHaveBeenCalledWith("/tmp/target", rawInput)
    expect(body).toEqual({ ok: true, ...STATE })
    expect(body.settings.maxParallel).toBe(1)
    expect(body.settings.implementer.effort).toBe("xhigh")
  })

  it("forwards a null body to the store (which normalizes to defaults)", async () => {
    saveSettings.mockReturnValue(STATE)

    const res = await PUT(
      new Request("http://localhost/api/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ not json",
      })
    )
    expect(res.status).toBe(200)
    expect(saveSettings).toHaveBeenCalledWith("/tmp/target", null)
    expect(await res.json()).toEqual({ ok: true, ...STATE })
  })

  it("rejects a non-object body (array or primitive) as 400 without writing", async () => {
    for (const invalid of [[], 5, "settings", true]) {
      const res = await PUT(putJson(invalid))
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.ok).toBe(false)
    }
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it("maps a store failure to 500", async () => {
    saveSettings.mockImplementation(() => {
      throw new Error("disk full")
    })

    const res = await PUT(putJson({ maxParallel: 2 }))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("disk full")
  })
})
