import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ArchitectureMapData } from "@/lib/types"

// Mock the two server-only collaborators so the route is exercised without
// touching a real filesystem. `@/lib/target` resolves whether a usable project
// exists and where its map JSON lives; `@/lib/map-data` normalizes the parsed
// payload. `readFile` is mocked at the node:fs/promises level so the route's own
// try/catch around a missing map is exercised faithfully.
const { isTargetResolved, getTargetRoot, getArchitectureDataPath, normalizeMapData, readFile } =
  vi.hoisted(() => ({
    isTargetResolved: vi.fn(),
    getTargetRoot: vi.fn(),
    getArchitectureDataPath: vi.fn(),
    normalizeMapData: vi.fn(),
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
}))
vi.mock("@/lib/map-data", () => ({ normalizeMapData }))

import { GET } from "./route"

const TARGET_ROOT = "/abs/target"
const MAP_PATH = "/abs/target/docs/architecture-map/viewer/src/architecture-data.json"

/** A minimal, already-normalized map the route should return verbatim. */
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
})

describe("GET /api/map", () => {
  it("returns the no_target empty state when no project is resolved (200)", async () => {
    isTargetResolved.mockReturnValue(false)

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "no_target", targetRoot: TARGET_ROOT })
    // It never tries to read a file when there is no target.
    expect(readFile).not.toHaveBeenCalled()
    expect(normalizeMapData).not.toHaveBeenCalled()
  })

  it("returns the no_map empty state when the map file cannot be read (200)", async () => {
    isTargetResolved.mockReturnValue(true)
    readFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))

    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toEqual({ empty: true, reason: "no_map", targetRoot: TARGET_ROOT })
    expect(readFile).toHaveBeenCalledWith(MAP_PATH, "utf8")
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
    // Normalization is never reached when JSON.parse already failed.
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

    // The full normalized data is returned, NOT an empty-state envelope.
    expect(body.empty).toBeUndefined()
    expect(body.name).toBe("Example")
    expect(body.nodes).toHaveLength(1)
    expect(body.nodes[0].graph_ref).toBe("node:n1")
  })
})
