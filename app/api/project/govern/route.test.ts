import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GovernanceResult } from "@/lib/import-docs"

const { startGovernance, seedViviWelcome, appendCardTurn, dispatchImportRead, getSpawner, WELCOME_IMPORT_CARD, SPAWNER } = vi.hoisted(
  () => {
    const SPAWNER = { id: "fake-spawner" }
    return {
      startGovernance: vi.fn(),
      seedViviWelcome: vi.fn(),
      appendCardTurn: vi.fn(),
      dispatchImportRead: vi.fn(async () => true),
      getSpawner: vi.fn(() => SPAWNER),
      WELCOME_IMPORT_CARD: { id: "welcome-import-docs", title: "T", actions: [] },
      SPAWNER,
    }
  }
)

vi.mock("@/lib/import-docs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/import-docs")>("@/lib/import-docs")
  return { ...actual, startGovernance }
})

vi.mock("@/lib/spawner", () => ({ getSpawner }))

vi.mock("@/lib/vivi", () => ({ seedViviWelcome, appendCardTurn, dispatchImportRead, WELCOME_IMPORT_CARD }))

import { ImportError } from "@/lib/import-docs"
import { ScaffoldError } from "@/lib/scaffold"

import { POST } from "./route"

const PROJECT = { root: "/abs/new", name: "My App", hasCanonicalSpec: false }
const GOVERN_ONLY: GovernanceResult = { mode: "from_scratch", project: PROJECT, batch: null }
const WITH_DOCS: GovernanceResult = {
  mode: "from_scratch",
  project: PROJECT,
  batch: {
    batchId: "2026-07-11T00-00-00-000Z",
    targetPath: PROJECT.root,
    language: "eng",
    cycle: { binding: "active", id: "project" },
    accepted: [{ path: "spec.md", size: 12, sha256: "x" }],
    rejected: [],
    findings: [],
  },
}

// Never swap this stub for a real multipart Request: FormData does not round-trip across the jsdom/undici global split.
function postForm(fields: Record<string, string>, files: Array<{ name: string; content: string }> = []): Request {
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  for (const file of files) {
    form.append("files", new File([file.content], file.name))
    form.append("paths", file.name)
  }
  return { formData: async () => form } as unknown as Request
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("POST /api/project/govern", () => {
  it("govern-only: returns the project with a null batch, seeds the welcome, and rides the import card on it", async () => {
    startGovernance.mockResolvedValue(GOVERN_ONLY)
    seedViviWelcome.mockReturnValue("session-1")

    const res = await POST(postForm({ targetDir: "/abs/new", projectName: "My App" }))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(startGovernance).toHaveBeenCalledWith({ targetDir: "/abs/new", projectName: "My App", entries: [] })
    expect(body).toEqual({ ok: true, project: PROJECT, mode: "from_scratch", batch: null })
    expect(seedViviWelcome).toHaveBeenCalledTimes(1)
    expect(seedViviWelcome).toHaveBeenCalledWith(null)
    expect(appendCardTurn).toHaveBeenCalledWith(WELCOME_IMPORT_CARD, "session-1")
    expect(dispatchImportRead).not.toHaveBeenCalled()
  })

  it("with docs: uploads become entries, the batch is returned, the welcome carries it, and its reading turn is dispatched instead of the import card", async () => {
    startGovernance.mockResolvedValue(WITH_DOCS)
    seedViviWelcome.mockReturnValue("session-2")

    const res = await POST(postForm({ targetDir: "/abs/new" }, [{ name: "spec.md", content: "hello" }]))
    expect(res.status).toBe(200)
    const body = await res.json()

    const call = startGovernance.mock.calls[0][0]
    expect(call.targetDir).toBe("/abs/new")
    expect(call.projectName).toBeUndefined()
    expect(call.entries).toHaveLength(1)
    expect(call.entries[0].name).toBe("spec.md")
    expect(body.batch).toEqual(WITH_DOCS.batch)
    expect(seedViviWelcome).toHaveBeenCalledTimes(1)
    expect(seedViviWelcome).toHaveBeenCalledWith(WITH_DOCS.batch)
    expect(appendCardTurn).not.toHaveBeenCalled()
    expect(dispatchImportRead).toHaveBeenCalledTimes(1)
    expect(dispatchImportRead).toHaveBeenCalledWith(SPAWNER, { sessionId: "session-2", batch: WITH_DOCS.batch })
  })

  it("still answers the moment the batch is written — the response never waits on the reading turn", async () => {
    startGovernance.mockResolvedValue(WITH_DOCS)
    seedViviWelcome.mockReturnValue("session-3")
    let settle: () => void = () => {}
    dispatchImportRead.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          settle = () => resolve(true)
        })
    )

    const res = await POST(postForm({ targetDir: "/abs/new" }, [{ name: "spec.md", content: "hello" }]))

    expect(res.status).toBe(200)
    expect((await res.json()).batch).toEqual(WITH_DOCS.batch)
    settle()
  })

  it("maps already_governed to 409 and never seeds the welcome", async () => {
    startGovernance.mockRejectedValue(new ImportError("already governed", "already_governed"))

    const res = await POST(postForm({ targetDir: "/abs/new" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_governed")
    expect(seedViviWelcome).not.toHaveBeenCalled()
  })

  it("only non-default statuses are mapped: templates_missing → 500, everything else typed falls through to the 400 default", async () => {
    startGovernance.mockRejectedValueOnce(new ScaffoldError("gone", "templates_missing"))
    const res = await POST(postForm({ targetDir: "/abs" }))
    expect(res.status).toBe(500)
    expect((await res.json()).code).toBe("templates_missing")

    for (const code of ["not_absolute", "not_a_directory", "invalid_name"] as const) {
      startGovernance.mockRejectedValueOnce(new ScaffoldError("nope", code))
      const fallen = await POST(postForm({ targetDir: "x" }))
      expect(fallen.status, code).toBe(400)
      expect((await fallen.json()).code).toBe(code)
    }
  })

  it("an unmapped typed code still answers 400 with its code — the fallback is the contract, not an accident", async () => {
    startGovernance.mockRejectedValueOnce(new ImportError("nothing usable", "no_supported_files"))
    const res = await POST(postForm({ targetDir: "/abs" }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("no_supported_files")
  })

  it("still returns the governed project when seeding the welcome throws (best-effort)", async () => {
    startGovernance.mockResolvedValue(GOVERN_ONLY)
    seedViviWelcome.mockImplementationOnce(() => {
      throw new Error("no runtime dir")
    })

    const res = await POST(postForm({ targetDir: "/abs/new", projectName: "My App" }))
    expect(res.status).toBe(200)
    expect((await res.json()).project).toEqual(PROJECT)
  })

  it("maps an unexpected (non-typed) error to 500 (no code)", async () => {
    startGovernance.mockRejectedValue(new Error("ENOSPC: no space left"))

    const res = await POST(postForm({ targetDir: "/abs/new" }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("ENOSPC: no space left")
    expect(body.code).toBeUndefined()
  })
})
