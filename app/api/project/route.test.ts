import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { CurrentProject } from "@/lib/project-types"

const { getCurrentProject, setCurrentProject } = vi.hoisted(() => ({
  getCurrentProject: vi.fn(),
  setCurrentProject: vi.fn(),
}))

vi.mock("@/lib/project", async () => {
  const actual = await vi.importActual<typeof import("@/lib/project")>("@/lib/project")
  return { ...actual, getCurrentProject, setCurrentProject }
})

const { renormalizeManagedFiles } = vi.hoisted(() => ({ renormalizeManagedFiles: vi.fn() }))

vi.mock("@/lib/scaffold", async () => {
  const actual = await vi.importActual<typeof import("@/lib/scaffold")>("@/lib/scaffold")
  renormalizeManagedFiles.mockImplementation(actual.renormalizeManagedFiles)
  return { ...actual, renormalizeManagedFiles }
})

import { METHOD_MARKERS } from "@/lib/managed-block"
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

    expect(setCurrentProject).toHaveBeenCalledWith("/abs/proj/../proj", { requireGoverned: false })
    expect(body).toEqual({ ok: true, project: PROJECT })
  })

  it("renormalizes the DESCRIBED root, and only after the selection is persisted", async () => {
    setCurrentProject.mockReturnValue(PROJECT)

    await POST(postJson({ root: "/abs/proj/../proj" }))

    expect(renormalizeManagedFiles).toHaveBeenCalledWith(PROJECT.root)
    expect(renormalizeManagedFiles).toHaveBeenCalledTimes(1)
    expect(
      setCurrentProject.mock.invocationCallOrder[0],
      "the renormalization's notifications resolve through the ambient current project"
    ).toBeLessThan(renormalizeManagedFiles.mock.invocationCallOrder[0])
  })

  it("still answers 200 with the project when the renormalization reports a failure — an open is never blocked", async () => {
    setCurrentProject.mockReturnValue(PROJECT)
    renormalizeManagedFiles.mockReturnValueOnce({
      written: [],
      failures: [{ file: "/abs/proj/AGENTS.md", reason: "EACCES: permission denied" }],
    })

    const res = await POST(postJson({ root: "/abs/proj" }))
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual({ ok: true, project: PROJECT })
  })

  it("still answers 200 when the renormalization THROWS — the selection is already on disk, so the open cannot be answered as an error", async () => {
    setCurrentProject.mockReturnValue(PROJECT)
    renormalizeManagedFiles.mockImplementationOnce(() => {
      throw new Error("EROFS: read-only file system")
    })

    const res = await POST(postJson({ root: "/abs/proj" }))
    expect(res.status).toBe(200)

    expect(await res.json()).toEqual({ ok: true, project: PROJECT })
  })

  it("forwards requireGoverned and maps a not_governed rejection to 400", async () => {
    setCurrentProject.mockImplementation(() => {
      throw new ProjectError("no .vivicy directory in /bare", "not_governed")
    })

    const res = await POST(postJson({ root: "/bare", requireGoverned: true }))
    expect(res.status).toBe(400)
    const body = await res.json()

    expect(setCurrentProject).toHaveBeenCalledWith("/bare", { requireGoverned: true })
    expect(body.ok).toBe(false)
    expect(body.code).toBe("not_governed")
    expect(renormalizeManagedFiles, "a refused open touches nothing in the folder").not.toHaveBeenCalled()
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

describe("POST /api/project — opening a governed repo brings its managed block to the current definition", () => {
  let workDir: string
  let prevRuntime: string | undefined
  let prevFactoryRoot: string | undefined

  beforeEach(async () => {
    workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-open-")))
    prevRuntime = process.env.VIVICY_RUNTIME_DIR
    prevFactoryRoot = process.env.VIVICY_FACTORY_ROOT
    process.env.VIVICY_RUNTIME_DIR = path.join(workDir, ".runtime")
    process.env.VIVICY_FACTORY_ROOT = path.resolve(process.cwd(), "factory")
    const actual = await vi.importActual<typeof import("@/lib/project")>("@/lib/project")
    setCurrentProject.mockImplementation(actual.setCurrentProject)
  })

  afterEach(() => {
    setCurrentProject.mockReset()
    if (prevRuntime === undefined) delete process.env.VIVICY_RUNTIME_DIR
    else process.env.VIVICY_RUNTIME_DIR = prevRuntime
    if (prevFactoryRoot === undefined) delete process.env.VIVICY_FACTORY_ROOT
    else process.env.VIVICY_FACTORY_ROOT = prevFactoryRoot
    rmSync(workDir, { recursive: true, force: true })
  })

  it("replaces the block the repo was governed with, keeps the owner's own bytes, and reports the project", async () => {
    const target = path.join(workDir, "governed-before-the-block-moved")
    mkdirSync(path.join(target, ".vivicy"), { recursive: true })
    const ownerHead = "# Owner guide\n\nHouse rules above the managed block.\n\n"
    writeFileSync(
      path.join(target, "AGENTS.md"),
      `${ownerHead}${METHOD_MARKERS.begin}\nA thinner method contract from the pass that governed this repo.\n${METHOD_MARKERS.end}\n`
    )

    const res = await POST(postJson({ root: target, requireGoverned: true }))
    expect(res.status).toBe(200)
    expect((await res.json()).project.root).toBe(target)

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents.startsWith(ownerHead)).toBe(true)
    expect(agents).not.toContain("A thinner method contract")
    expect(agents).toContain("A test must discriminate")
    expect(agents).toContain("smallest verified increments")
  })
})
