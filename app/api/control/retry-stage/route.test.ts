import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the control plane so the route never spawns a factory script. `runExtract`
// backs the `extract` stage; `startSkillsInstall` backs the `skills` stage;
// `startSupervisor` backs the `dev` (resume) stage. `ControlError` stays real so
// the route's `instanceof` check holds.
const { runExtract, startSkillsInstall, startSupervisor } = vi.hoisted(() => ({
  runExtract: vi.fn(),
  startSkillsInstall: vi.fn(),
  startSupervisor: vi.fn(),
}))

vi.mock("@/lib/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/control")>("@/lib/control")
  return { ...actual, runExtract, startSkillsInstall, startSupervisor }
})

vi.mock("@/lib/spawner", () => ({ getSpawner: () => ({}) }))

import { ControlError } from "@/lib/control"

import { POST } from "./route"

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/control/retry-stage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// The route appends real notifications (lib/notifications, unmocked) on every
// retry — isolate the log to a temp runtime dir so the test suite never writes
// into the developer's real .vivicy-runtime.
let runtimeDir: string
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-retry-stage-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
})

describe("POST /api/control/retry-stage", () => {
  it("dispatches stage=extract to runExtract and returns its result (200 on green)", async () => {
    runExtract.mockResolvedValue({ ok: true, blocked: false, status: "green", summary: "green" })

    const res = await POST(postJson({ stage: "extract" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, stage: "extract", blocked: false, status: "green", summary: "green" })
    expect(runExtract).toHaveBeenCalledOnce()
    expect(startSupervisor).not.toHaveBeenCalled()
  })

  it("surfaces a blocked extraction honestly (422, blocked:true) — parity with the extract route", async () => {
    runExtract.mockResolvedValue({
      ok: false,
      blocked: true,
      status: "extraction_blocked",
      summary: "still red",
    })

    const res = await POST(postJson({ stage: "extract" }))
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.blocked).toBe(true)
  })

  it("dispatches stage=dev to a resume (startSupervisor 'resume')", async () => {
    startSupervisor.mockReturnValue({ pid: 4242, mode: "resume" })

    const res = await POST(postJson({ stage: "dev" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, stage: "dev", run: { pid: 4242, mode: "resume" } })
    expect(startSupervisor).toHaveBeenCalledWith(expect.anything(), "resume")
    expect(runExtract).not.toHaveBeenCalled()
  })

  it("dispatches stage=skills to a detached auto-mode skills install", async () => {
    startSkillsInstall.mockReturnValue({ pid: 777, mode: "auto", ids: [] })

    const res = await POST(postJson({ stage: "skills" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, stage: "skills", run: { pid: 777, mode: "auto", ids: [] } })
    expect(startSkillsInstall).toHaveBeenCalledOnce()
    expect(runExtract).not.toHaveBeenCalled()
    expect(startSupervisor).not.toHaveBeenCalled()
  })

  it("maps an already_running skills install to 409", async () => {
    startSkillsInstall.mockImplementation(() => {
      throw new ControlError("a skills install is already in flight", "already_running")
    })

    const res = await POST(postJson({ stage: "skills" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_running")
  })

  it("rejects an unsupported stage with 400 and the supported list (no fake generality)", async () => {
    const res = await POST(postJson({ stage: "S6" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.supported).toEqual(["extract", "skills", "dev"])
    expect(runExtract).not.toHaveBeenCalled()
    expect(startSkillsInstall).not.toHaveBeenCalled()
    expect(startSupervisor).not.toHaveBeenCalled()
  })

  it("rejects a missing/invalid body with 400", async () => {
    const res = await POST(
      new Request("http://localhost/api/control/retry-stage", { method: "POST", body: "not json" })
    )
    expect(res.status).toBe(400)
  })

  it("maps an already_running ControlError from a resume to 409", async () => {
    startSupervisor.mockImplementation(() => {
      throw new ControlError("a supervised run is already active", "already_running")
    })

    const res = await POST(postJson({ stage: "dev" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_running")
  })
})
