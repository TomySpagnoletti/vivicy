import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the reader/writer so the route test does not touch a real log file; the
// read CONTRACT (missing/empty => [], malformed lines skipped) and the
// append/dismiss round-trip are covered directly in lib/notifications.test.ts.
const { readNotifications, dismissNotifications } = vi.hoisted(() => ({
  readNotifications: vi.fn(),
  dismissNotifications: vi.fn(),
}))

vi.mock("@/lib/notifications", () => ({ readNotifications, dismissNotifications }))

import { GET, POST } from "./route"

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/control/notifications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/control/notifications", () => {
  it("returns the reader's notifications (200)", async () => {
    const rows = [{ ts: "2026-07-02T10:00:00Z", level: "info", stage: "extract", event: "green", message: "done" }]
    readNotifications.mockReturnValue(rows)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, notifications: rows })
  })

  it("returns an empty list when the log is empty (200)", async () => {
    readNotifications.mockReturnValue([])

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, notifications: [] })
  })

  it("maps an unexpected reader failure to 500", async () => {
    readNotifications.mockImplementation(() => {
      throw new Error("disk gone")
    })

    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})

describe("POST /api/control/notifications (dismiss)", () => {
  it("dismisses a single notification by id", async () => {
    dismissNotifications.mockReturnValue(1)

    const res = await POST(postJson({ id: "abc-x1-1" }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, dismissed: 1 })
    expect(dismissNotifications).toHaveBeenCalledWith(["abc-x1-1"])
  })

  it("clears all when { all: true }", async () => {
    dismissNotifications.mockReturnValue(5)

    const res = await POST(postJson({ all: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, dismissed: 5 })
    expect(dismissNotifications).toHaveBeenCalledWith()
  })

  it("rejects a body with neither id nor all (400)", async () => {
    const res = await POST(postJson({}))
    expect(res.status).toBe(400)
    expect(dismissNotifications).not.toHaveBeenCalled()
  })

  it("rejects invalid JSON (400)", async () => {
    const res = await POST(
      new Request("http://localhost/api/control/notifications", { method: "POST", body: "not json" })
    )
    expect(res.status).toBe(400)
  })

  it("maps an unexpected writer failure to 500", async () => {
    dismissNotifications.mockImplementation(() => {
      throw new Error("disk gone")
    })

    const res = await POST(postJson({ id: "abc-x1-1" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
  })
})
