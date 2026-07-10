import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { readSkillsReport, startSkillsInstall } = vi.hoisted(() => ({
  readSkillsReport: vi.fn(),
  startSkillsInstall: vi.fn(),
}))

vi.mock("@/lib/control", async () => {
  const actual = await vi.importActual<typeof import("@/lib/control")>("@/lib/control")
  return { ...actual, readSkillsReport, startSkillsInstall }
})

vi.mock("@/lib/spawner", () => ({ getSpawner: () => ({}) }))

import { ControlError } from "@/lib/control"

import { GET, POST } from "./route"

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/control/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

// lib/notifications is unmocked and writes real files; isolate via a temp VIVICY_RUNTIME_DIR.
let runtimeDir: string
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  vi.clearAllMocks()
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-skills-route-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
})

describe("GET /api/control/skills", () => {
  it("returns the report verbatim, and null when no install has run", async () => {
    readSkillsReport.mockReturnValue(null)
    let body = await (await GET()).json()
    expect(body).toEqual({ ok: true, report: null })

    const report = { phase: "green", mode: "auto", installed: [], rejected: [], summary: "ok" }
    readSkillsReport.mockReturnValue(report)
    body = await (await GET()).json()
    expect(body).toEqual({ ok: true, report })
  })

  it("maps a ControlError (no target) to 422 with its code", async () => {
    readSkillsReport.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    const res = await GET()
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("missing_target")
  })
})

describe("POST /api/control/skills", () => {
  it("starts an auto-mode install when ids are absent (empty body too)", async () => {
    startSkillsInstall.mockReturnValue({ pid: 4242, mode: "auto", ids: [] })

    const res = await POST(postJson({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, pid: 4242, mode: "auto", ids: [] })
    expect(startSkillsInstall).toHaveBeenCalledWith(expect.anything(), { ids: undefined })
  })

  it("passes explicit ids through (explicit mode)", async () => {
    startSkillsInstall.mockReturnValue({ pid: 4243, mode: "explicit", ids: ["acme/a@x"] })

    const res = await POST(postJson({ ids: ["acme/a@x"] }))
    expect(res.status).toBe(200)
    expect((await res.json()).mode).toBe("explicit")
    expect(startSkillsInstall).toHaveBeenCalledWith(expect.anything(), { ids: ["acme/a@x"] })
  })

  it("rejects a non-array ids with 400 before touching the control plane", async () => {
    const res = await POST(postJson({ ids: "acme/a@x" }))
    expect(res.status).toBe(400)
    expect(startSkillsInstall).not.toHaveBeenCalled()
  })

  it("maps an already_running refusal to 409", async () => {
    startSkillsInstall.mockImplementation(() => {
      throw new ControlError("a skills install is already in flight", "already_running")
    })
    const res = await POST(postJson({}))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("already_running")
  })

  it("maps other ControlErrors (missing target/script) to 422", async () => {
    startSkillsInstall.mockImplementation(() => {
      throw new ControlError("no project selected", "missing_target")
    })
    const res = await POST(postJson({}))
    expect(res.status).toBe(422)
    expect((await res.json()).code).toBe("missing_target")
  })
})
