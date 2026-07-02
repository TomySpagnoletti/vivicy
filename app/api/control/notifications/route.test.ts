import { beforeEach, describe, expect, it, vi } from "vitest"

// Mock the reader so the route test does not touch a real log file; the read
// CONTRACT (missing/empty => [], malformed lines skipped) is covered directly in
// lib/notifications.test.ts.
const { readNotifications } = vi.hoisted(() => ({ readNotifications: vi.fn() }))

vi.mock("@/lib/notifications", () => ({ readNotifications }))

import { GET } from "./route"

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
