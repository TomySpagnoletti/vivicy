import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CurrentProject } from "@/lib/project-types"

// ProjectError stays the real class (not mocked) so the route's instanceof check still holds.
const { getCurrentProject, setCurrentProject } = vi.hoisted(() => ({
  getCurrentProject: vi.fn(),
  setCurrentProject: vi.fn(),
}))

vi.mock("@/lib/project", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project")>("@/lib/project")
  return { ...actual, getCurrentProject, setCurrentProject }
})

import { ProjectError } from "@/lib/project"

import { GET, POST } from "./route"

const PROJECT: CurrentProject = { root: "/abs/proj", name: "proj", hasCanonicalSpec: true }

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("GET /api/project", () => {
  it("returns the current project (200)", async () => {
    getCurrentProject.mockReturnValue(PROJECT)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, project: PROJECT })
  })

  it("returns ok:true with a null project when none is set (200)", async () => {
    getCurrentProject.mockReturnValue(null)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, project: null })
  })
})

describe("POST /api/project", () => {
  it("rejects a missing root with 400 code not_absolute", async () => {
    const res = await POST(postJson({}))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.code).toBe("not_absolute")
    expect(setCurrentProject).not.toHaveBeenCalled()
  })

  it("rejects an empty/whitespace root with 400 code not_absolute", async () => {
    const res = await POST(postJson({ root: "   " }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.code).toBe("not_absolute")
    expect(setCurrentProject).not.toHaveBeenCalled()
  })

  it("echoes the DESCRIBED project written, not the raw input (200)", async () => {
    setCurrentProject.mockReturnValue(PROJECT)

    const res = await POST(postJson({ root: "/abs/proj/../proj" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(setCurrentProject).toHaveBeenCalledWith("/abs/proj/../proj")
    expect(body).toEqual({ ok: true, project: PROJECT })
  })

  it("maps a ProjectError to 400 with its typed code", async () => {
    setCurrentProject.mockImplementation(() => {
      throw new ProjectError("path does not exist: /nope", "not_found")
    })

    const res = await POST(postJson({ root: "/nope" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.code).toBe("not_found")
    expect(body.error).toContain("/nope")
  })

  it("maps an unexpected Error to 500 (no code field)", async () => {
    setCurrentProject.mockImplementation(() => {
      throw new Error("disk on fire")
    })

    const res = await POST(postJson({ root: "/abs/proj" }))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("disk on fire")
    expect(body.code).toBeUndefined()
  })
})
