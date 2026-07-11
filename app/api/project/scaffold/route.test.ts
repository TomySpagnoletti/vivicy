import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ScaffoldResult } from "@/lib/scaffold"

// ScaffoldError stays the real class (not mocked) so the route's instanceof check still holds.
const { scaffoldProject, seedViviWelcome } = vi.hoisted(() => ({
  scaffoldProject: vi.fn(),
  seedViviWelcome: vi.fn(),
}))

vi.mock("@/lib/scaffold", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scaffold")>("@/lib/scaffold")
  return { ...actual, scaffoldProject }
})

vi.mock("@/lib/vivi", () => ({ seedViviWelcome }))

import { ScaffoldError } from "@/lib/scaffold"

import { POST } from "./route"

const RESULT: ScaffoldResult = {
  project: { root: "/abs/new", name: "My App", hasCanonicalSpec: true },
  mode: "from_scratch",
  written: ["/abs/new/AGENTS.md", "/abs/new/README.md", "/abs/new/vivicy.json"],
  git: { initialized: true, committed: true },
}

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/project/scaffold", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/project/scaffold", () => {
  it("returns the described project + written files on the happy path (200)", async () => {
    scaffoldProject.mockReturnValue(RESULT)

    const res = await POST(postJson({ targetDir: "/abs/new", projectName: "My App" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(scaffoldProject).toHaveBeenCalledWith({
      targetDir: "/abs/new",
      projectName: "My App",
    })
    expect(body).toEqual({
      ok: true,
      project: RESULT.project,
      mode: RESULT.mode,
      written: RESULT.written,
      git: RESULT.git,
    })
    expect(seedViviWelcome).toHaveBeenCalledTimes(1)
  })

  it("does not seed the welcome when scaffolding fails", async () => {
    scaffoldProject.mockImplementation(() => {
      throw new ScaffoldError("rejected", "invalid_name")
    })

    const res = await POST(postJson({ targetDir: "/abs/new", projectName: "" }))
    expect(res.status).toBe(400)
    expect(seedViviWelcome).not.toHaveBeenCalled()
  })

  it("still returns the scaffolded project when seeding the welcome throws (best-effort)", async () => {
    scaffoldProject.mockReturnValue(RESULT)
    seedViviWelcome.mockImplementationOnce(() => {
      throw new Error("no runtime dir")
    })

    const res = await POST(postJson({ targetDir: "/abs/new", projectName: "My App" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.project).toEqual(RESULT.project)
  })

  it("forwards undefined fields verbatim (the lib validates, not the route)", async () => {
    scaffoldProject.mockImplementation(() => {
      throw new ScaffoldError("project name must be 1–64 chars", "invalid_name")
    })

    const res = await POST(postJson({ targetDir: "/abs/new" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(scaffoldProject).toHaveBeenCalledWith({
      targetDir: "/abs/new",
      projectName: undefined,
    })
    expect(body.ok).toBe(false)
    expect(body.code).toBe("invalid_name")
  })

  const codes = [
    "not_absolute",
    "not_a_directory",
    "invalid_name",
    "templates_missing",
  ] as const

  for (const code of codes) {
    it(`maps a ScaffoldError code "${code}" to 400 with its code`, async () => {
      scaffoldProject.mockImplementation(() => {
        throw new ScaffoldError(`rejected: ${code}`, code)
      })

      const res = await POST(postJson({ targetDir: "/abs/x", projectName: "x" }))
      expect(res.status).toBe(400)
      const body = await res.json()

      expect(body.ok).toBe(false)
      expect(body.code).toBe(code)
      expect(body.error).toBe(`rejected: ${code}`)
    })
  }

  it("maps an unexpected (non-ScaffoldError) error to 500 (no code)", async () => {
    scaffoldProject.mockImplementation(() => {
      throw new Error("ENOSPC: no space left")
    })

    const res = await POST(postJson({ targetDir: "/abs/new", projectName: "ok" }))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("ENOSPC: no space left")
    expect(body.code).toBeUndefined()
  })
})
