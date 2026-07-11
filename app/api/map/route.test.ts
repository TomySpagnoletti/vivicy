import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ArchitectureMapData } from "@/lib/types"

const {
  isTargetResolved,
  getTargetRoot,
  getArchitectureDataPath,
  getProgressLedgerPath,
  canonicalHasSpecDoc,
  normalizeMapData,
  applyLiveOverlay,
  readFile,
} = vi.hoisted(() => ({
  isTargetResolved: vi.fn(),
  getTargetRoot: vi.fn(),
  getArchitectureDataPath: vi.fn(),
  getProgressLedgerPath: vi.fn(),
  canonicalHasSpecDoc: vi.fn(),
  normalizeMapData: vi.fn(),
  applyLiveOverlay: vi.fn(),
  readFile: vi.fn(),
}))

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
  return { ...actual, default: { ...actual, readFile }, readFile }
})
vi.mock("@/lib/target", () => ({
  isTargetResolved,
  getTargetRoot,
  getArchitectureDataPath,
  getProgressLedgerPath,
  canonicalHasSpecDoc,
}))
vi.mock("@/lib/map-data", () => ({ normalizeMapData, applyLiveOverlay }))

import { GET } from "./route"

const TARGET_ROOT = "/abs/target"
const MAP_PATH = "/abs/target/.vivicy/architecture-map/architecture-data.json"
const LEDGER_PATH = "/abs/target/.vivicy/development/progress-ledger.json"

const NORMALIZED: ArchitectureMapData = {
  name: "Example",
  nodes: [
    {
      id: "n1",
      label: "Node 1",
      kind: "service",
      lane: "core",
      layout_x: 0,
      layout_y: 0,
      graph_ref: "node:n1",
    },
  ],
  edges: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  getTargetRoot.mockReturnValue(TARGET_ROOT)
  getArchitectureDataPath.mockReturnValue(MAP_PATH)
  getProgressLedgerPath.mockReturnValue(LEDGER_PATH)
  canonicalHasSpecDoc.mockReturnValue(true)
  applyLiveOverlay.mockImplementation((data: ArchitectureMapData) => data)
})

describe("GET /api/map", () => {
  it("returns the no_target empty state when no project is resolved (200)", async () => {
    isTargetResolved.mockReturnValue(false)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "no_target", targetRoot: TARGET_ROOT })
    expect(readFile).not.toHaveBeenCalled()
    expect(normalizeMapData).not.toHaveBeenCalled()
  })

  it("returns the no_map empty state when the map is absent but the canonical holds a spec (200)", async () => {
    isTargetResolved.mockReturnValue(true)
    canonicalHasSpecDoc.mockReturnValue(true)
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "no_map", targetRoot: TARGET_ROOT })
    expect(canonicalHasSpecDoc).toHaveBeenCalledWith(TARGET_ROOT)
    expect(readFile).toHaveBeenCalledWith(MAP_PATH, "utf8")
    expect(normalizeMapData).not.toHaveBeenCalled()
  })

  it("returns the empty_canonical empty state when the map is absent and the canonical has no spec (fresh scaffold, 200)", async () => {
    isTargetResolved.mockReturnValue(true)
    canonicalHasSpecDoc.mockReturnValue(false)
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "empty_canonical", targetRoot: TARGET_ROOT })
    expect(canonicalHasSpecDoc).toHaveBeenCalledWith(TARGET_ROOT)
    expect(normalizeMapData).not.toHaveBeenCalled()
  })

  it("returns the empty_map empty state when the map has zero nodes (200)", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockResolvedValue(JSON.stringify({ name: "Empty", nodes: [] }))
    normalizeMapData.mockReturnValue({ name: "Empty", nodes: [], edges: [] })

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "empty_map", targetRoot: TARGET_ROOT })
  })

  it("returns 422 when the map file is not valid JSON", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockResolvedValue("{ not json")

    const res = await GET()
    expect(res.status).toBe(422)
    const body = await res.json()

    expect(body.error).toBe("architecture map is not valid JSON")
    expect(body.detail).toContain(MAP_PATH)
    expect(normalizeMapData).not.toHaveBeenCalled()
  })

  it("returns 422 when the map has an unexpected shape (normalize -> null)", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockResolvedValue(JSON.stringify({ nope: true }))
    normalizeMapData.mockReturnValue(null)

    const res = await GET()
    expect(res.status).toBe(422)
    const body = await res.json()

    expect(body.error).toBe("architecture map has an unexpected shape")
    expect(body.detail).toContain(MAP_PATH)
    expect(normalizeMapData).toHaveBeenCalledWith({ nope: true })
  })

  it("returns the normalized map on the happy path (200)", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockResolvedValue(JSON.stringify({ name: "Example", nodes: [{}] }))
    normalizeMapData.mockReturnValue(NORMALIZED)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.empty).toBeUndefined()
    expect(body.name).toBe("Example")
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].graph_ref).toBe("node:n1")
  })

  it("overlays the LIVE ledger at read time and returns the overlaid data", async () => {
    isTargetResolved.mockReturnValue(true)
    const ledgerJson = JSON.stringify({ graph_item_states: [], active_items: [] })
    readFile.mockImplementation(async (path: string) =>
      path === LEDGER_PATH ? ledgerJson : JSON.stringify({ name: "Example", nodes: [{}] })
    )
    normalizeMapData.mockReturnValue(NORMALIZED)
    const OVERLAID: ArchitectureMapData = {
      ...NORMALIZED,
      development: { graph_item_states: [{ graph_ref: "node:n1", status: "verified" }] },
    }
    applyLiveOverlay.mockReturnValue(OVERLAID)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(readFile).toHaveBeenCalledWith(MAP_PATH, "utf8")
    expect(readFile).toHaveBeenCalledWith(LEDGER_PATH, "utf8")
    expect(applyLiveOverlay).toHaveBeenCalledWith(NORMALIZED, { graph_item_states: [], active_items: [] })
    expect(body.development.graph_item_states[0]).toEqual({ graph_ref: "node:n1", status: "verified" })
  })

  it("tolerates a missing/unreadable ledger (overlay gets undefined, never 500s)", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockImplementation(async (path: string) => {
      if (path === LEDGER_PATH) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" })
      return JSON.stringify({ name: "Example", nodes: [{}] })
    })
    normalizeMapData.mockReturnValue(NORMALIZED)

    const res = await GET()
    expect(res.status).toBe(200)
    expect(applyLiveOverlay).toHaveBeenCalledWith(NORMALIZED, undefined)
  })
})
