import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  applyLayoutSave,
  isLayoutWriteEnabled,
  LayoutSaveError,
  MAP_RELATIVE_PATH,
  patchArchitectureMapLayout,
  resolveMapPath,
  validateLayoutSavePayload,
  type LayoutSavePayload,
} from "@/lib/map-layout-save"

// A compact but faithful architecture-map.yml in the exact source style the
// line-oriented patcher depends on (2-space "- " list items, 4-space props).
const SOURCE = `version: 1
updated: "2026-06-22"
name: "Test Map"

nodes:
  - id: alpha
    label: "Alpha"
    kind: "service"
    layout_x: 100
    layout_y: 200
    layout_cluster: "core"

  - id: beta
    label: "Beta"
    kind: "service"
    layout_x: 300
    layout_y: 400
    layout_cluster: "core"

edges:
  - from: alpha
    to: beta
    relation: "calls"
    protocol: "Module call"
    data: ["x"]

  - from: beta
    to: alpha
    relation: "returns"
    protocol: "Module call"
    layout_label_ratio: 0.3
    data: ["y"]
`

function emptyPayload(overrides: Partial<LayoutSavePayload> = {}): LayoutSavePayload {
  return { nodes: [], edgeLabels: [], ...overrides }
}

describe("patchArchitectureMapLayout — nodes", () => {
  it("rewrites only the moved node's coordinates and preserves everything else", () => {
    const next = patchArchitectureMapLayout(
      SOURCE,
      emptyPayload({ nodes: [{ id: "alpha", layout_x: 120, layout_y: 240 }] })
    )
    // alpha moved...
    expect(next).toContain("    layout_x: 120")
    expect(next).toContain("    layout_y: 240")
    // ...its other fields are byte-identical...
    expect(next).toContain('    label: "Alpha"')
    expect(next).toContain('    kind: "service"')
    // ...and beta is untouched.
    expect(next).toContain("    layout_x: 300")
    expect(next).toContain("    layout_y: 400")
    // No stray content was dropped: the line count is unchanged for an in-place
    // coordinate rewrite.
    expect(next.split("\n").length).toBe(SOURCE.split("\n").length)
  })

  it("rounds coordinates to two decimals", () => {
    const next = patchArchitectureMapLayout(
      SOURCE,
      emptyPayload({ nodes: [{ id: "alpha", layout_x: 12.005, layout_y: -7.5 }] })
    )
    expect(next).toContain("    layout_x: 12.01")
    expect(next).toContain("    layout_y: -7.5")
  })

  it("rejects an unknown node id", () => {
    expect(() =>
      patchArchitectureMapLayout(
        SOURCE,
        emptyPayload({ nodes: [{ id: "ghost", layout_x: 1, layout_y: 2 }] })
      )
    ).toThrowError(/Unknown node layout patch: ghost/)
  })

  it("rejects a duplicate node patch", () => {
    expect(() =>
      patchArchitectureMapLayout(
        SOURCE,
        emptyPayload({
          nodes: [
            { id: "alpha", layout_x: 1, layout_y: 2 },
            { id: "alpha", layout_x: 3, layout_y: 4 },
          ],
        })
      )
    ).toThrowError(/Duplicate node layout patch: alpha/)
  })
})

describe("patchArchitectureMapLayout — edge labels", () => {
  it("inserts layout_label_ratio after protocol when the edge has none", () => {
    const next = patchArchitectureMapLayout(
      SOURCE,
      emptyPayload({
        edgeLabels: [
          {
            index: 0,
            from: "alpha",
            to: "beta",
            relation: "calls",
            protocol: "Module call",
            layout_label_ratio: 0.7,
          },
        ],
      })
    )
    const lines = next.split("\n")
    const ratioLine = lines.findIndex((l) => l.trim() === "layout_label_ratio: 0.7")
    const protocolLine = lines.findIndex(
      (l, i) => l.trim() === 'protocol: "Module call"' && i < ratioLine
    )
    expect(ratioLine).toBeGreaterThan(-1)
    expect(ratioLine).toBe(protocolLine + 1)
  })

  it("removes layout_label_ratio when reset to the 0.5 midpoint default", () => {
    const next = patchArchitectureMapLayout(
      SOURCE,
      emptyPayload({
        edgeLabels: [
          {
            index: 1,
            from: "beta",
            to: "alpha",
            relation: "returns",
            protocol: "Module call",
            layout_label_ratio: 0.5,
          },
        ],
      })
    )
    expect(next).not.toContain("layout_label_ratio")
    // The rest of the edge is intact.
    expect(next).toContain("    relation: \"returns\"")
    expect(next).toContain('    data: ["y"]')
  })

  it("refuses to patch an edge whose identity does not match the on-disk map", () => {
    expect(() =>
      patchArchitectureMapLayout(
        SOURCE,
        emptyPayload({
          edgeLabels: [
            {
              index: 0,
              from: "alpha",
              to: "beta",
              relation: "WRONG",
              protocol: "Module call",
              layout_label_ratio: 0.7,
            },
          ],
        })
      )
    ).toThrowError(/does not match architecture-map\.yml/)
  })

  it("rejects an out-of-range edge index", () => {
    expect(() =>
      patchArchitectureMapLayout(
        SOURCE,
        emptyPayload({
          edgeLabels: [
            {
              index: 9,
              from: "alpha",
              to: "beta",
              relation: "calls",
              protocol: "Module call",
              layout_label_ratio: 0.7,
            },
          ],
        })
      )
    ).toThrowError(/Unknown edge label patch index: 9/)
  })
})

describe("validateLayoutSavePayload", () => {
  it("accepts a well-formed payload", () => {
    const payload = validateLayoutSavePayload({
      nodes: [{ id: "alpha", layout_x: 1, layout_y: 2 }],
      edgeLabels: [
        {
          index: 0,
          from: "alpha",
          to: "beta",
          relation: "calls",
          protocol: "Module call",
          layout_label_ratio: 0.4,
        },
      ],
    })
    expect(payload.nodes).toHaveLength(1)
    expect(payload.edgeLabels).toHaveLength(1)
  })

  it("rejects a non-object / missing arrays", () => {
    expect(() => validateLayoutSavePayload(null)).toThrowError(LayoutSaveError)
    expect(() => validateLayoutSavePayload({ nodes: [] })).toThrowError(/edgeLabels/)
  })

  it("rejects a node patch with non-finite coordinates", () => {
    expect(() =>
      validateLayoutSavePayload({
        nodes: [{ id: "alpha", layout_x: Number.NaN, layout_y: 2 }],
        edgeLabels: [],
      })
    ).toThrowError(/layout_x/)
  })

  it("rejects an edge ratio outside [0, 1]", () => {
    expect(() =>
      validateLayoutSavePayload({
        nodes: [],
        edgeLabels: [
          {
            index: 0,
            from: "a",
            to: "b",
            relation: "r",
            protocol: "p",
            layout_label_ratio: 1.4,
          },
        ],
      })
    ).toThrowError(/between 0 and 1/)
  })
})

describe("resolveMapPath", () => {
  it("resolves the fixed in-repo map path under the target root", () => {
    const root = "/tmp/some-target"
    expect(resolveMapPath(root)).toBe(path.join(root, MAP_RELATIVE_PATH))
  })
})

describe("isLayoutWriteEnabled (operator kill-switch)", () => {
  it("defaults to enabled when the env var is unset", () => {
    expect(isLayoutWriteEnabled({})).toBe(true)
  })

  it("locks writes for every falsey spelling", () => {
    for (const value of ["0", "false", "no", "off", "OFF", " false "]) {
      expect(isLayoutWriteEnabled({ VIVICY_MAP_LAYOUT_WRITE: value })).toBe(false)
    }
  })

  it("stays enabled for any other value", () => {
    for (const value of ["1", "true", "yes", "on", ""]) {
      expect(isLayoutWriteEnabled({ VIVICY_MAP_LAYOUT_WRITE: value })).toBe(true)
    }
  })
})

describe("applyLayoutSave", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vivicy-layout-save-"))
  })
  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function seedMap(): string {
    const mapPath = path.join(root, MAP_RELATIVE_PATH)
    mkdirSync(path.dirname(mapPath), { recursive: true })
    writeFileSync(mapPath, SOURCE)
    return mapPath
  }

  it("patches the source map and invokes regeneration with the target root", async () => {
    const mapPath = seedMap()
    const regenerate = vi.fn(async () => {})
    const result = await applyLayoutSave({
      targetRoot: root,
      payload: emptyPayload({ nodes: [{ id: "alpha", layout_x: 140, layout_y: 260 }] }),
      regenerate,
    })

    expect(result.ok).toBe(true)
    expect(result.mapPath).toBe(mapPath)
    expect(regenerate).toHaveBeenCalledWith(root)
    const written = readFileSync(mapPath, "utf8")
    expect(written).toContain("    layout_x: 140")
    expect(written).toContain("    layout_y: 260")
  })

  it("refuses a target root that does not exist", async () => {
    await expect(
      applyLayoutSave({
        targetRoot: path.join(root, "missing"),
        payload: emptyPayload(),
        regenerate: async () => {},
      })
    ).rejects.toMatchObject({ code: "no_target" })
  })

  it("refuses a target with no architecture map", async () => {
    // root exists but no map file was seeded.
    await expect(
      applyLayoutSave({ targetRoot: root, payload: emptyPayload(), regenerate: async () => {} })
    ).rejects.toMatchObject({ code: "no_map" })
  })

  it("refuses to write (and never touches the file) when the kill-switch is off", async () => {
    const mapPath = seedMap()
    const prev = process.env.VIVICY_MAP_LAYOUT_WRITE
    process.env.VIVICY_MAP_LAYOUT_WRITE = "0"
    try {
      await expect(
        applyLayoutSave({
          targetRoot: root,
          payload: emptyPayload({ nodes: [{ id: "alpha", layout_x: 1, layout_y: 2 }] }),
          regenerate: async () => {},
        })
      ).rejects.toMatchObject({ code: "read_only" })
      // The source map is byte-identical — the gate short-circuits before any write.
      expect(readFileSync(mapPath, "utf8")).toBe(SOURCE)
    } finally {
      if (prev === undefined) delete process.env.VIVICY_MAP_LAYOUT_WRITE
      else process.env.VIVICY_MAP_LAYOUT_WRITE = prev
    }
  })

  it("rolls the source map back to its pre-save bytes when regeneration fails", async () => {
    const mapPath = seedMap()
    await expect(
      applyLayoutSave({
        targetRoot: root,
        payload: emptyPayload({ nodes: [{ id: "alpha", layout_x: 999, layout_y: 999 }] }),
        regenerate: async () => {
          throw new Error("generator blew up")
        },
      })
    ).rejects.toMatchObject({ code: "regen_failed" })

    // The file must be byte-identical to the original — no half-written map.
    expect(readFileSync(mapPath, "utf8")).toBe(SOURCE)
  })
})
