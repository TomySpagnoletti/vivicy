import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the control plane so the route never spawns a factory script.
// `ControlError` stays real so the route's `instanceof` check holds.
const { runExtract, getExtractionStatus } = vi.hoisted(() => ({
  runExtract: vi.fn(),
  getExtractionStatus: vi.fn(),
}))

vi.mock("@/lib/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/control")>("@/lib/control")
  return { ...actual, runExtract, getExtractionStatus }
})

vi.mock("@/lib/spawner", () => ({ getSpawner: () => ({}) }))

import { ControlError } from "@/lib/control"
import { readNotifications } from "@/lib/notifications"

import { GET, POST } from "./route"

// The route appends real notifications (lib/notifications, unmocked) — isolate
// the log to a temp runtime dir so the test suite never writes into the
// developer's real .vivicy-runtime.
let runtimeDir: string
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-extract-route-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
})

describe("GET /api/control/extract", () => {
  it("echoes the orchestrator's status (including null when never run)", async () => {
    getExtractionStatus.mockReturnValue(null)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, status: null })
  })

  it("echoes an in-flight status verbatim", async () => {
    getExtractionStatus.mockReturnValue({ phase: "authoring", attempt: 1 })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toEqual({ phase: "authoring", attempt: 1 })
  })

  it("maps a ControlError (e.g. missing_target) to 422", async () => {
    getExtractionStatus.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    const res = await GET()
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.code).toBe("missing_target")
  })
})

describe("POST /api/control/extract — notification emissions", () => {
  it("always appends a 'started' notification before the run", async () => {
    runExtract.mockResolvedValue({ ok: true, blocked: false, status: "green", summary: "8 issues" })
    await POST()
    const events = readNotifications().map((n) => n.event)
    expect(events[0]).toBe("started")
  })

  it("appends 'green' on a clean success", async () => {
    runExtract.mockResolvedValue({ ok: true, blocked: false, status: "green", summary: "extraction green: 8 issues" })
    const res = await POST()
    expect(res.status).toBe(200)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["started", "green"])
    expect(rows[1].message).toMatch(/8 issues/)
  })

  it("appends 'blocked' when the checks stayed red after retries", async () => {
    runExtract.mockResolvedValue({ ok: false, blocked: true, status: "extraction_blocked", summary: "still red" })
    const res = await POST()
    expect(res.status).toBe(422)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["started", "blocked"])
    expect(rows[1].level).toBe("error")
  })

  it("appends 'blocked_on_unverified_spikes' by name, carrying the gate ids in the message", async () => {
    runExtract.mockResolvedValue({
      ok: false,
      blocked: false,
      status: "blocked_on_unverified_spikes",
      summary: "blocked_on_unverified_spikes: SPIKE-01, SPIKE-02",
    })
    await POST()
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["started", "blocked_on_unverified_spikes"])
    expect(rows[1].message).toMatch(/SPIKE-01/)
  })

  it("appends 'refused_empty_canonical' distinctly from a generic error (G11 guard)", async () => {
    runExtract.mockRejectedValue(new ControlError("canonical is empty", "empty_canonical"))
    const res = await POST()
    expect(res.status).toBe(422)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["started", "refused_empty_canonical"])
  })

  it("appends a generic 'error' event for an unexpected throw", async () => {
    runExtract.mockRejectedValue(new Error("spawn exploded"))
    const res = await POST()
    expect(res.status).toBe(500)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["started", "error"])
    expect(rows[1].message).toBe("spawn exploded")
  })
})
