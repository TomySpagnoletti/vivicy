import { describe, expect, it } from "vitest"

import {
  asNodeStatus,
  buildActiveGraphRefs,
  buildEdgeCounts,
  buildGraphStatesByRef,
  buildIssuesByGraphRef,
  buildStatusOverlay,
  computeVisibleCounts,
  edgeGraphRef,
  formatLineCoverage,
  issueDisplayStatus,
  issueTranscriptRefs,
  nodeMatchesQuery,
  normalizeMapData,
  resolveNodeStatus,
  resolveNodes,
  statusColor,
} from "@/lib/map-data"
import type { DevelopmentBlock, MapEdge, MapNode } from "@/lib/types"

function makeNode(overrides: Partial<MapNode> = {}): MapNode {
  return {
    id: "n1",
    label: "Node One",
    kind: "service",
    lane: "manager_control",
    layout_x: 10,
    layout_y: 20,
    graph_ref: "node:n1",
    ...overrides,
  }
}

describe("statusColor", () => {
  it("maps each known status to a distinct, non-neutral color", () => {
    const colored = (
      ["in_progress", "reviewing", "implemented", "verified", "blocked"] as const
    ).map(statusColor)
    // All distinct.
    expect(new Set(colored).size).toBe(colored.length)
    // None fall through to the neutral border token.
    expect(colored).not.toContain("var(--border)")
  })

  it("treats not_started, null, and undefined as the neutral border token", () => {
    expect(statusColor("not_started")).toBe("var(--border)")
    expect(statusColor(null)).toBe("var(--border)")
    expect(statusColor(undefined)).toBe("var(--border)")
  })

  it("falls back to neutral for an unknown status", () => {
    // @ts-expect-error exercising the runtime guard with a bad value
    expect(statusColor("frobnicated")).toBe("var(--border)")
  })
})

describe("asNodeStatus", () => {
  it("accepts known statuses and rejects everything else", () => {
    expect(asNodeStatus("verified")).toBe("verified")
    expect(asNodeStatus("nope")).toBeNull()
    expect(asNodeStatus(undefined)).toBeNull()
    expect(asNodeStatus(42)).toBeNull()
  })
})

describe("buildStatusOverlay", () => {
  it("indexes valid graph_item_states by graph_ref and drops invalid ones", () => {
    const overlay = buildStatusOverlay([
      { graph_ref: "node:a", status: "verified" },
      { graph_ref: "node:b", status: "bogus" as never },
      { graph_ref: "", status: "verified" },
    ])
    expect(overlay.get("node:a")).toBe("verified")
    expect(overlay.has("node:b")).toBe(false)
    expect(overlay.has("")).toBe(false)
  })

  it("returns an empty map when there are no states", () => {
    expect(buildStatusOverlay(undefined).size).toBe(0)
    expect(buildStatusOverlay([]).size).toBe(0)
  })
})

describe("resolveNodeStatus", () => {
  const overlay = buildStatusOverlay([{ graph_ref: "node:n1", status: "reviewing" }])

  it("is always neutral in the target view, even with a node status", () => {
    const node = makeNode({ status: "verified" })
    expect(resolveNodeStatus(node, "target", overlay)).toBeNull()
  })

  it("prefers the overlay over node.status in the progress view", () => {
    const node = makeNode({ status: "verified" })
    expect(resolveNodeStatus(node, "progress", overlay)).toBe("reviewing")
  })

  it("falls back to node.status in progress view when no overlay entry exists", () => {
    const node = makeNode({ graph_ref: "node:other", status: "in_progress" })
    expect(resolveNodeStatus(node, "progress", overlay)).toBe("in_progress")
  })

  it("returns null in progress view when neither overlay nor status apply", () => {
    const node = makeNode({ graph_ref: "node:other", status: undefined })
    expect(resolveNodeStatus(node, "progress", overlay)).toBeNull()
  })
})

describe("normalizeMapData", () => {
  it("returns null for non-objects and shapes missing name/nodes", () => {
    expect(normalizeMapData(null)).toBeNull()
    expect(normalizeMapData("x")).toBeNull()
    expect(normalizeMapData({ name: "ok" })).toBeNull()
    expect(normalizeMapData({ nodes: [] })).toBeNull()
  })

  it("keeps valid nodes, supplies defaults, and coerces bad fields", () => {
    const data = normalizeMapData({
      name: "Map",
      nodes: [
        {
          id: "a",
          graph_ref: "node:a",
          layout_x: 1,
          layout_y: 2,
          status: "verified",
          owns_data: ["x", 5, "y"],
        },
        { id: "no-graph-ref" }, // dropped: missing graph_ref
        "garbage", // dropped: not an object
      ],
      edges: [],
    })
    expect(data).not.toBeNull()
    expect(data!.nodes).toHaveLength(1)
    const node = data!.nodes[0]
    expect(node.label).toBe("a") // defaults to id
    expect(node.kind).toBe("unknown")
    expect(node.status).toBe("verified")
    expect(node.owns_data).toEqual(["x", "y"]) // non-strings filtered out
  })

  it("drops edges that reference missing nodes (no dangling edges)", () => {
    const data = normalizeMapData({
      name: "Map",
      nodes: [
        { id: "a", graph_ref: "node:a", layout_x: 0, layout_y: 0 },
        { id: "b", graph_ref: "node:b", layout_x: 0, layout_y: 0 },
      ],
      edges: [
        { from: "a", to: "b", graph_ref: "edge:a->b" },
        { from: "a", to: "ghost", graph_ref: "edge:a->ghost" },
        { from: "a" }, // dropped: missing `to`
      ],
    })
    expect(data!.edges).toHaveLength(1)
    expect(data!.edges[0].graph_ref).toBe("edge:a->b")
  })

  it("preserves the development block when present", () => {
    const data = normalizeMapData({
      name: "Map",
      nodes: [{ id: "a", graph_ref: "node:a", layout_x: 0, layout_y: 0 }],
      edges: [],
      development: { issues: [{ id: "i1" }] },
    })
    expect(data!.development?.issues).toHaveLength(1)
  })
})

describe("resolveNodes", () => {
  it("attaches view-aware effectiveStatus across the node set", () => {
    const data = {
      name: "Map",
      nodes: [
        makeNode({ id: "a", graph_ref: "node:a", status: "verified" }),
        makeNode({ id: "b", graph_ref: "node:b", status: "in_progress" }),
      ],
      edges: [],
      development: {
        graph_item_states: [{ graph_ref: "node:b", status: "blocked" as const }],
      },
    }

    const target = resolveNodes(data, "target")
    expect(target.every((n) => n.effectiveStatus === null)).toBe(true)

    const progress = resolveNodes(data, "progress")
    expect(progress.find((n) => n.id === "a")!.effectiveStatus).toBe("verified")
    // Overlay wins over node.status.
    expect(progress.find((n) => n.id === "b")!.effectiveStatus).toBe("blocked")
  })
})

describe("nodeMatchesQuery", () => {
  const node = makeNode({
    label: "Manager Run Loop",
    tech: "NestJS",
    graph_ref: "node:manager_run_loop",
  })

  it("matches everything for an empty/whitespace query", () => {
    expect(nodeMatchesQuery(node, "")).toBe(true)
    expect(nodeMatchesQuery(node, "   ")).toBe(true)
  })

  it("matches label, tech, and graph_ref case-insensitively", () => {
    expect(nodeMatchesQuery(node, "manager")).toBe(true)
    expect(nodeMatchesQuery(node, "nestjs")).toBe(true)
    expect(nodeMatchesQuery(node, "run_loop")).toBe(true)
  })

  it("returns false when nothing matches", () => {
    expect(nodeMatchesQuery(node, "supabase")).toBe(false)
  })

  it("also matches id, kind, lane, scope, status, and owned data", () => {
    const n = makeNode({
      id: "owner",
      kind: "actor",
      lane: "human_trust",
      scope: "mvp",
      status: "verified",
      owns_data: ["intents", "directives"],
    })
    expect(nodeMatchesQuery(n, "owner")).toBe(true)
    expect(nodeMatchesQuery(n, "actor")).toBe(true)
    expect(nodeMatchesQuery(n, "human_trust")).toBe(true)
    expect(nodeMatchesQuery(n, "mvp")).toBe(true)
    expect(nodeMatchesQuery(n, "verified")).toBe(true)
    expect(nodeMatchesQuery(n, "directives")).toBe(true)
  })
})

function makeEdge(overrides: Partial<MapEdge> = {}): MapEdge {
  return {
    from: "a",
    to: "b",
    relation: "calls",
    protocol: "HTTPS",
    graph_ref: "",
    ...overrides,
  }
}

describe("edgeGraphRef", () => {
  it("returns the explicit graph_ref when present", () => {
    expect(edgeGraphRef(makeEdge({ graph_ref: "edge:explicit" }))).toBe(
      "edge:explicit"
    )
  })

  it("derives a slugged graph_ref from endpoints, relation, and protocol", () => {
    expect(edgeGraphRef(makeEdge({ graph_ref: "" }))).toBe(
      "edge:a->b:calls:https"
    )
  })
})

describe("buildEdgeCounts", () => {
  it("counts incidence in both directions", () => {
    const counts = buildEdgeCounts([
      makeEdge({ from: "a", to: "b" }),
      makeEdge({ from: "b", to: "c" }),
    ])
    expect(counts.get("a")).toBe(1)
    expect(counts.get("b")).toBe(2)
    expect(counts.get("c")).toBe(1)
  })
})

describe("buildIssuesByGraphRef / buildActiveGraphRefs / buildGraphStatesByRef", () => {
  const development: DevelopmentBlock = {
    issues: [
      { id: "ISS-1", graph_refs: ["node:a", "node:b"] },
      { id: "ISS-2", graph_refs: ["node:b"] },
    ],
    graph_item_states: [
      { graph_ref: "node:a", status: "verified" },
      { graph_ref: "node:b", status: "in_progress" },
    ],
    active_items: [{ id: "ai-1", issue_id: "ISS-1", graph_refs: ["node:b"] }],
  }

  it("indexes issues by every graph_ref they touch", () => {
    const byRef = buildIssuesByGraphRef(development.issues)
    expect(byRef.get("node:a")?.map((i) => i.id)).toEqual(["ISS-1"])
    expect(byRef.get("node:b")?.map((i) => i.id)).toEqual(["ISS-1", "ISS-2"])
  })

  it("collects the active graph refs", () => {
    expect([...buildActiveGraphRefs(development.active_items)]).toEqual(["node:b"])
  })

  it("indexes graph states by ref", () => {
    const byRef = buildGraphStatesByRef(development.graph_item_states)
    expect(byRef.get("node:a")?.status).toBe("verified")
  })
})

describe("issueDisplayStatus", () => {
  const development: DevelopmentBlock = {
    graph_item_states: [
      { graph_ref: "node:a", status: "verified" },
      { graph_ref: "node:b", status: "blocked" },
      { graph_ref: "node:c", status: "verified" },
    ],
    active_items: [
      { id: "ai", issue_id: "ISS-ACTIVE", graph_refs: ["node:a"], state: "reviewing" },
    ],
  }

  it("uses an active item's live state when present", () => {
    expect(
      issueDisplayStatus({ id: "ISS-ACTIVE", graph_refs: ["node:a"] }, development)
    ).toBe("reviewing")
  })

  it("surfaces blocked over verified across graph items", () => {
    expect(
      issueDisplayStatus({ id: "ISS-1", graph_refs: ["node:a", "node:b"] }, development)
    ).toBe("blocked")
  })

  it("reports verified only when every graph item is verified", () => {
    expect(
      issueDisplayStatus({ id: "ISS-2", graph_refs: ["node:a", "node:c"] }, development)
    ).toBe("verified")
  })

  it("defaults to not_started with no graph items", () => {
    expect(issueDisplayStatus({ id: "ISS-3", graph_refs: [] }, development)).toBe(
      "not_started"
    )
  })
})

describe("issueTranscriptRefs", () => {
  it("aggregates refs and keeps only those encoding the issue id", () => {
    const development: DevelopmentBlock = {
      graph_item_states: [
        {
          graph_ref: "node:a",
          status: "verified",
          transcript_refs: [
            "spec/development/transcripts/ISS-1/claude.jsonl",
            "spec/development/transcripts/ISS-9/other.jsonl",
          ],
        },
      ],
      active_items: [
        {
          id: "ai",
          issue_id: "ISS-1",
          graph_refs: ["node:a"],
          transcript_refs: ["spec/development/transcripts/ISS-1/codex.jsonl"],
        },
      ],
    }
    const refs = issueTranscriptRefs(
      { id: "ISS-1", graph_refs: ["node:a"] },
      development
    )
    expect(refs).toContain("spec/development/transcripts/ISS-1/claude.jsonl")
    expect(refs).toContain("spec/development/transcripts/ISS-1/codex.jsonl")
    expect(refs).not.toContain("spec/development/transcripts/ISS-9/other.jsonl")
  })
})

describe("formatLineCoverage", () => {
  it("formats the issue-linked percentage", () => {
    expect(
      formatLineCoverage({ total_doc_lines: 100, issue_linked_doc_lines: 37 })
    ).toBe("37.0%")
  })

  it("returns 0% for missing or empty totals", () => {
    expect(formatLineCoverage(undefined)).toBe("0%")
    expect(formatLineCoverage({ total_doc_lines: 0 })).toBe("0%")
  })
})

describe("computeVisibleCounts", () => {
  const data = {
    name: "Map",
    nodes: [
      makeNode({ id: "a", graph_ref: "node:a", lane: "x", scope: "mvp", label: "Alpha" }),
      makeNode({ id: "b", graph_ref: "node:b", lane: "y", scope: "future", label: "Beta" }),
      makeNode({ id: "c", graph_ref: "node:c", lane: "x", scope: "mvp", label: "Gamma" }),
    ],
    edges: [
      makeEdge({ from: "a", to: "b", graph_ref: "edge:ab" }),
      makeEdge({ from: "a", to: "c", graph_ref: "edge:ac" }),
    ],
  }
  const base = {
    view: "target" as const,
    query: "",
    laneFilter: "all",
    statusFilter: "all",
    scopeFilter: "all",
  }

  it("counts all nodes and edges with no filters", () => {
    expect(computeVisibleCounts(data, base)).toEqual({ nodes: 3, edges: 2 })
  })

  it("applies the lane filter and prunes edges to hidden nodes", () => {
    // Lane x keeps a and c; edge a->b is pruned (b hidden), a->c survives.
    expect(computeVisibleCounts(data, { ...base, laneFilter: "x" })).toEqual({
      nodes: 2,
      edges: 1,
    })
  })

  it("applies the scope filter", () => {
    expect(computeVisibleCounts(data, { ...base, scopeFilter: "future" })).toEqual({
      nodes: 1,
      edges: 0,
    })
  })

  it("applies the search query, hiding non-matching nodes and their edges", () => {
    // Only "Alpha" matches; both its edges need the other endpoint, which is gone.
    expect(computeVisibleCounts(data, { ...base, query: "alpha" })).toEqual({
      nodes: 1,
      edges: 0,
    })
  })
})
