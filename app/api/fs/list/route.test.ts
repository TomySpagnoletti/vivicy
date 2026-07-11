import { beforeEach, describe, expect, it, vi } from "vitest"

import type { DirListing } from "@/lib/project-types"

// listDirectories/getDefaultBrowseRoot are mocked; FsBrowseError stays real so the route's instanceof check still matches.
const { listDirectories, getDefaultBrowseRoot } = vi.hoisted(() => ({
  listDirectories: vi.fn(),
  getDefaultBrowseRoot: vi.fn(),
}))

vi.mock("@/lib/fs-browser", async () => {
  const actual = await vi.importActual<typeof import("@/lib/fs-browser")>("@/lib/fs-browser")
  return { ...actual, listDirectories, getDefaultBrowseRoot }
})

import { FsBrowseError } from "@/lib/fs-browser"

import { GET } from "./route"

const DEFAULT_ROOT = "/home/me"

const LISTING: DirListing = {
  path: "/home/me/projects",
  parent: "/home/me",
  crumbs: [
    { label: "/", path: "/" },
    { label: "home", path: "/home" },
    { label: "me", path: "/home/me" },
    { label: "projects", path: "/home/me/projects" },
  ],
  entries: [
    { name: "alpha", path: "/home/me/projects/alpha" },
    { name: "beta", path: "/home/me/projects/beta" },
  ],
}

function get(url: string): Request {
  return new Request(url, { method: "GET" })
}

beforeEach(() => {
  vi.clearAllMocks()
  getDefaultBrowseRoot.mockReturnValue(DEFAULT_ROOT)
})

describe("GET /api/fs/list", () => {
  it("spreads the listing with ok:true on the happy path (200)", async () => {
    listDirectories.mockReturnValue(LISTING)

    const res = await GET(get("http://localhost/api/fs/list?path=/home/me/projects"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ ok: true, ...LISTING })
    expect(listDirectories).toHaveBeenCalledWith("/home/me/projects")
  })

  it("forwards a null path when ?path is absent (defaults to home)", async () => {
    listDirectories.mockReturnValue({ ...LISTING, path: DEFAULT_ROOT })

    const res = await GET(get("http://localhost/api/fs/list"))
    expect(res.status).toBe(200)
    expect(listDirectories).toHaveBeenCalledWith(null)
  })

  it("maps an FsBrowseError to 400 with code + default", async () => {
    listDirectories.mockImplementation(() => {
      throw new FsBrowseError("browse path must be absolute: rel", "not_absolute")
    })

    const res = await GET(get("http://localhost/api/fs/list?path=rel"))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.code).toBe("not_absolute")
    expect(body.error).toContain("absolute")
    expect(body.default).toBe(DEFAULT_ROOT)
  })

  it("maps a generic error to 500 (no code, no default)", async () => {
    listDirectories.mockImplementation(() => {
      throw new Error("EIO")
    })

    const res = await GET(get("http://localhost/api/fs/list?path=/some/dir"))
    expect(res.status).toBe(500)
    const body = await res.json()

    expect(body.ok).toBe(false)
    expect(body.error).toBe("EIO")
    expect(body.code).toBeUndefined()
    expect(body.default).toBeUndefined()
  })
})
