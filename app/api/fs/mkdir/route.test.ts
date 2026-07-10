import { beforeEach, describe, expect, it, vi } from "vitest"

// createDirectory/getDefaultBrowseRoot are mocked; FsBrowseError stays real so the route's instanceof check still matches.
const { createDirectory, getDefaultBrowseRoot } = vi.hoisted(() => ({
  createDirectory: vi.fn(),
  getDefaultBrowseRoot: vi.fn(),
}))

vi.mock("@/lib/fs-browser", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fs-browser")>("@/lib/fs-browser")
  return { ...actual, createDirectory, getDefaultBrowseRoot }
})

import { FsBrowseError } from "@/lib/fs-browser"

import { POST } from "./route"

const DEFAULT_ROOT = "/home/me"

function postJson(body: unknown): Request {
  return new Request("http://localhost/api/fs/mkdir", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getDefaultBrowseRoot.mockReturnValue(DEFAULT_ROOT)
})

describe("POST /api/fs/mkdir", () => {
  it("returns {ok:true, path} and forwards parent+name on the happy path (200)", async () => {
    createDirectory.mockReturnValue("/home/me/projects/new-app")

    const res = await POST(postJson({ parent: "/home/me/projects", name: "new-app" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, path: "/home/me/projects/new-app" })
    expect(createDirectory).toHaveBeenCalledWith("/home/me/projects", "new-app")
  })

  it("forwards a null parent when parent is not a string", async () => {
    createDirectory.mockReturnValue("/home/me/new-app")

    const res = await POST(postJson({ name: "new-app" }))
    expect(res.status).toBe(200)
    expect(createDirectory).toHaveBeenCalledWith(null, "new-app")
  })

  it("maps an FsBrowseError (invalid_name) to 400 with code + default", async () => {
    createDirectory.mockImplementation(() => {
      throw new FsBrowseError("folder name invalid", "invalid_name")
    })

    const res = await POST(postJson({ parent: "/home/me", name: "../escape" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.code).toBe("invalid_name")
    expect(body.default).toBe(DEFAULT_ROOT)
  })

  it("maps an FsBrowseError (exists) to 400 with code", async () => {
    createDirectory.mockImplementation(() => {
      throw new FsBrowseError('a file or folder named "x" already exists here', "exists")
    })

    const res = await POST(postJson({ parent: "/home/me", name: "x" }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.code).toBe("exists")
  })

  it("maps a generic error to 500 (no code, no default)", async () => {
    createDirectory.mockImplementation(() => {
      throw new Error("EACCES")
    })

    const res = await POST(postJson({ parent: "/home/me", name: "ok" }))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("EACCES")
    expect(body.code).toBeUndefined()
    expect(body.default).toBeUndefined()
  })
})
