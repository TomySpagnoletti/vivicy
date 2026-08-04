import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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

let targetRoot: string
let prevTargetEnv: string | undefined
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivicy-extract-route-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  prevTargetEnv = process.env.VIVICY_TARGET_ROOT
  // The notification log is per-project: pin both the project and its runtime home, or a real selection on this machine would decide where these rows land.
  process.env.VIVICY_RUNTIME_DIR = path.join(targetRoot, ".vivicy", "runtime")
  process.env.VIVICY_TARGET_ROOT = targetRoot
})

afterEach(() => {
  rmSync(targetRoot, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
  if (prevTargetEnv === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevTargetEnv
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
  it("says nothing at all on a clean success — the owner has nothing to do about it", async () => {
    runExtract.mockResolvedValue({ ok: true, blocked: false, status: "green", summary: "extraction green: 8 issues" })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(readNotifications()).toEqual([])
  })

  it("appends 'blocked' when the checks stayed red after retries", async () => {
    runExtract.mockResolvedValue({ ok: false, blocked: true, status: "extraction_blocked", summary: "still red" })
    const res = await POST()
    expect(res.status).toBe(422)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["blocked"])
    expect(rows[0].level).toBe("error")
  })

  it("appends 'blocked_on_unverified_spikes' by name, carrying the gate ids in the message", async () => {
    runExtract.mockResolvedValue({
      ok: false,
      blocked: false,
      status: "blocked_on_unverified_spikes",
      summary: "issue extraction refuses to run while 2 required spikes are not transitively verified: SPIKE-01, SPIKE-02.",
    })
    await POST()
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["blocked_on_unverified_spikes"])
    expect(rows[0].message).toMatch(/SPIKE-01/)
  })

  it("appends 'failed' when the run neither reached green nor blocked cleanly", async () => {
    runExtract.mockResolvedValue({ ok: false, blocked: false, status: "authoring", summary: "extractor exited 1" })
    const res = await POST()
    expect(res.status).toBe(422)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["failed"])
    expect(rows[0].message).toBe("extractor exited 1")
  })

  it("appends 'refused_empty_canonical' distinctly from a generic error, the refusal riding as the key's own value", async () => {
    runExtract.mockRejectedValue(new ControlError("canonical is empty", "empty_canonical"))
    const res = await POST()
    expect(res.status).toBe(422)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["refused_empty_canonical"])
    expect(rows[0].params).toEqual({ reason: "canonical is empty" })
  })

  it.each([
    { arm: "blocked", result: { ok: false, blocked: true, status: "extraction_blocked", summary: "" } },
    { arm: "blocked_on_unverified_spikes", result: { ok: false, blocked: false, status: "blocked_on_unverified_spikes", summary: "" } },
    { arm: "failed", result: { ok: false, blocked: false, status: "error", summary: "" } },
  ])("a spawn that dies saying nothing still gives the $arm row a sentence — never an empty body", async ({ result }) => {
    runExtract.mockResolvedValue(result)
    await POST()
    const [row] = readNotifications()
    expect(row.message.trim().length, "an empty row would arm an Ask-Vivi pill that pre-fills nothing").toBeGreaterThan(0)
  })

  it("a throw carrying no message still gives its row a reason — the frame never ends on a dangling dash", async () => {
    runExtract.mockRejectedValue(new Error(""))
    await POST()
    const [row] = readNotifications()
    expect(row.params?.reason).toBe("no reason given")
    expect(row.message).not.toMatch(/—\s*$/)
  })

  it("appends a generic 'error' event for an unexpected throw, framing the reason it also carries as a value", async () => {
    runExtract.mockRejectedValue(new Error("spawn exploded"))
    const res = await POST()
    expect(res.status).toBe(500)
    const rows = readNotifications()
    expect(rows.map((n) => n.event)).toEqual(["error"])
    expect(rows[0].message).toBe("extraction failed — spawn exploded")
    expect(rows[0].params).toEqual({ reason: "spawn exploded" })
  })
})
