import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GovernanceResult } from "@/lib/import-docs"

const { startGovernance, seedViviWelcome, appendCardTurn, WELCOME_IMPORT_CARD } = vi.hoisted(() => ({
  startGovernance: vi.fn(),
  seedViviWelcome: vi.fn(),
  appendCardTurn: vi.fn(),
  WELCOME_IMPORT_CARD: { id: "welcome-import-docs", title: "T", actions: [] },
}))

vi.mock("@/lib/import-docs", async () => {
  const actual = await vi.importActual<typeof import("@/lib/import-docs")>("@/lib/import-docs")
  return { ...actual, startGovernance }
})

vi.mock("@/lib/vivi", () => ({ seedViviWelcome, appendCardTurn, WELCOME_IMPORT_CARD }))

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
  },
}

// The route only calls request.formData(); a real multipart round-trip is fragile across the jsdom/undici global split, so stub the parsed form directly.
function postForm(
  fields: Record<string, string>,
  files: Array<{ name: string; content: string }> = []
): Request {
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
    expect(appendCardTurn).toHaveBeenCalledWith(WELCOME_IMPORT_CARD, "session-1")
  })

  it("with docs: uploads become entries, the batch is returned, and the import card does NOT ride the welcome", async () => {
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
    expect(appendCardTurn).not.toHaveBeenCalled()
  })

  it("maps already_governed to 409 and never seeds the welcome", async () => {
    startGovernance.mockRejectedValue(new ImportError("already governed", "already_governed"))

    const res = await POST(postForm({ targetDir: "/abs/new" }))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("already_governed")
    expect(seedViviWelcome).not.toHaveBeenCalled()
  })

  it("maps ScaffoldError codes: not_absolute → 400, templates_missing → 500", async () => {
    startGovernance.mockRejectedValueOnce(new ScaffoldError("nope", "not_absolute"))
    expect((await POST(postForm({ targetDir: "x" }))).status).toBe(400)

    startGovernance.mockRejectedValueOnce(new ScaffoldError("gone", "templates_missing"))
    expect((await POST(postForm({ targetDir: "/abs" }))).status).toBe(500)
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
