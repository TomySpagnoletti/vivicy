import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { readDocPrepReport, startDocPrep } = vi.hoisted(() => ({
  readDocPrepReport: vi.fn(),
  startDocPrep: vi.fn(),
}))

vi.mock("@/lib/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/control")>("@/lib/control")
  return { ...actual, readDocPrepReport, startDocPrep }
})

vi.mock("@/lib/spawner", () => ({ getSpawner: () => ({}) }))

import { ControlError } from "@/lib/control"

import { GET, POST } from "./route"

// lib/notifications is unmocked and writes real files; isolate via a temp VIVICY_RUNTIME_DIR.
let runtimeDir: string
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-prepare-route-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
})

describe("GET /api/control/prepare", () => {
  it("returns the report verbatim, and null when the stage has not run", async () => {
    readDocPrepReport.mockReturnValue(null)
    let body = await (await GET()).json()
    expect(body).toEqual({ ok: true, report: null })

    const report = { phase: "green", cycle_id: "project", batches_consumed: ["b1"], batches_pending: [], language: "eng", placed: [], rejected: [], summary: "ok" }
    readDocPrepReport.mockReturnValue(report)
    body = await (await GET()).json()
    expect(body).toEqual({ ok: true, report })
  })

  it("maps a ControlError (no target) to 422 with its code", async () => {
    readDocPrepReport.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    const res = await GET()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("missing_target")
  })
})

describe("POST /api/control/prepare", () => {
  it("starts document preparation and returns the pid", async () => {
    startDocPrep.mockReturnValue({ pid: 5252 })
    const res = await POST()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pid: 5252 })
    expect(startDocPrep).toHaveBeenCalledOnce()
  })

  it("maps an already_running refusal to 409", async () => {
    startDocPrep.mockImplementation(() => {
      throw new ControlError("document preparation is already in flight", "already_running")
    })
    const res = await POST()
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("already_running")
  })

  it("maps other ControlErrors (missing target/script) to 422", async () => {
    startDocPrep.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    const res = await POST()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("missing_target")
  })
})
