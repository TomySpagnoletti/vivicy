/**
 * Pure, framework-free helpers for the architecture map.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested directly and reused by both the API normalization step and the React
 * rendering layer. No source-of-truth duplication: the data types live in
 * `lib/types.ts`.
 */

import {
  deriveDevelopmentOverlay,
  edgeGraphRef as canonicalEdgeGraphRef,
  nodeGraphRef as canonicalNodeGraphRef,
  type OverlayIssue,
} from "@/lib/development-overlay"
import type {
  ActiveItem,
  ArchitectureMapData,
  CoverageSummary,
  DevelopmentBlock,
  DevelopmentIssue,
  GraphItemState,
  MapEdge,
  MapNode,
  NodeStatus,
  ResolvedNode,
  ViewMode,
} from "@/lib/types"

/** The development statuses the viewer understands, in display order. */
export const NODE_STATUSES: NodeStatus[] = [
  "not_started",
  "in_progress",
  "reviewing",
  "implemented",
  "verified",
  "blocked",
]

const NODE_STATUS_SET = new Set<string>(NODE_STATUSES)

/** Narrow an arbitrary string to a known status, or `null` when unknown. */
export function asNodeStatus(value: unknown): NodeStatus | null {
  return typeof value === "string" && NODE_STATUS_SET.has(value)
    ? (value as NodeStatus)
    : null
}

/**
 * Per-status accent color, expressed as a reference to the corresponding
 * `--status-*` design token defined in `app/globals.css`. There are no raw
 * color literals here: the single source of truth for each status hue is the
 * token. `not_started` resolves (through its token) to the neutral `--border`
 * so untouched nodes recede.
 *
 * Returning a `var(...)` keeps React Flow's canvas-rendered surfaces (edges,
 * minimap) and the inline node accent on the same token palette as the
 * Tailwind `*-status-*` utilities used elsewhere.
 */
export function statusColor(status: NodeStatus | null | undefined): string {
  switch (status) {
    case "in_progress":
      return "var(--status-in-progress)"
    case "reviewing":
      return "var(--status-reviewing)"
    case "implemented":
      return "var(--status-implemented)"
    case "verified":
      return "var(--status-verified)"
    case "blocked":
      return "var(--status-blocked)"
    case "not_started":
    default:
      return "var(--border)" // neutral
  }
}

/** Build a `graph_ref -> status` overlay from the development block. */
export function buildStatusOverlay(
  graphItemStates: GraphItemState[] | undefined
): Map<string, NodeStatus> {
  const overlay = new Map<string, NodeStatus>()
  if (!graphItemStates) {
    return overlay
  }
  for (const state of graphItemStates) {
    const status = asNodeStatus(state.status)
    if (state.graph_ref && status) {
      overlay.set(state.graph_ref, status)
    }
  }
  return overlay
}

/**
 * Resolve the status a node should be colored by for a given view.
 *
 * - `target` view: always neutral (`null`) — the target architecture has no
 *   progress meaning.
 * - `progress` view: prefer the live overlay keyed by `graph_ref`; otherwise
 *   fall back to the node's own `status`. An unknown/missing status is `null`.
 */
export function resolveNodeStatus(
  node: MapNode,
  view: ViewMode,
  overlay: Map<string, NodeStatus>
): NodeStatus | null {
  if (view === "target") {
    return null
  }
  const fromOverlay = overlay.get(node.graph_ref)
  if (fromOverlay) {
    return fromOverlay
  }
  return asNodeStatus(node.status)
}

/**
 * Normalize raw, untrusted JSON (the parsed API payload) into a safe
 * `ArchitectureMapData`. Drops malformed nodes/edges and guarantees arrays
 * exist so the rendering layer never has to defensively guard.
 *
 * Returns `null` when the payload cannot be a map at all (missing name or a
 * non-array nodes field), which the caller surfaces as an error state.
 */
export function normalizeMapData(raw: unknown): ArchitectureMapData | null {
  if (!raw || typeof raw !== "object") {
    return null
  }
  const data = raw as Record<string, unknown>
  if (typeof data.name !== "string" || !Array.isArray(data.nodes)) {
    return null
  }

  const nodes: MapNode[] = (data.nodes as unknown[]).flatMap((n) => {
    if (!n || typeof n !== "object") return []
    const node = n as Record<string, unknown>
    if (typeof node.id !== "string" || typeof node.graph_ref !== "string") {
      return []
    }
    return [
      {
        id: node.id,
        label: typeof node.label === "string" ? node.label : node.id,
        kind: typeof node.kind === "string" ? node.kind : "unknown",
        lane: typeof node.lane === "string" ? node.lane : "",
        order: typeof node.order === "number" ? node.order : undefined,
        layout_x: toNumber(node.layout_x),
        layout_y: toNumber(node.layout_y),
        layout_cluster:
          typeof node.layout_cluster === "string" ? node.layout_cluster : undefined,
        layout_role:
          typeof node.layout_role === "string" ? node.layout_role : undefined,
        scope: typeof node.scope === "string" ? node.scope : undefined,
        status: asNodeStatus(node.status) ?? undefined,
        tech: typeof node.tech === "string" ? node.tech : undefined,
        owns_data: toStringArray(node.owns_data),
        source_refs: toStringArray(node.source_refs),
        evidence_refs: toStringArray(node.evidence_refs),
        graph_ref: node.graph_ref,
      },
    ]
  })

  const validNodeIds = new Set(nodes.map((n) => n.id))

  const rawEdges = Array.isArray(data.edges) ? (data.edges as unknown[]) : []
  const edges = rawEdges.flatMap((e) => {
    if (!e || typeof e !== "object") return []
    const edge = e as Record<string, unknown>
    if (typeof edge.from !== "string" || typeof edge.to !== "string") {
      return []
    }
    // Drop dangling edges so React Flow never references a missing node.
    if (!validNodeIds.has(edge.from) || !validNodeIds.has(edge.to)) {
      return []
    }
    return [
      {
        from: edge.from,
        to: edge.to,
        relation: typeof edge.relation === "string" ? edge.relation : undefined,
        protocol: typeof edge.protocol === "string" ? edge.protocol : undefined,
        layout_label_ratio:
          typeof edge.layout_label_ratio === "number" &&
          Number.isFinite(edge.layout_label_ratio)
            ? edge.layout_label_ratio
            : undefined,
        data: toStringArray(edge.data),
        source_refs: toStringArray(edge.source_refs),
        graph_ref:
          typeof edge.graph_ref === "string"
            ? edge.graph_ref
            : `edge:${edge.from}->${edge.to}`,
      },
    ]
  })

  return {
    name: data.name,
    version: typeof data.version === "number" ? data.version : undefined,
    updated: typeof data.updated === "string" ? data.updated : undefined,
    purpose: typeof data.purpose === "string" ? data.purpose : undefined,
    views:
      data.views && typeof data.views === "object" && !Array.isArray(data.views)
        ? (data.views as ArchitectureMapData["views"])
        : undefined,
    statusLegend: isStringRecord(data.statusLegend)
      ? (data.statusLegend as Record<string, string>)
      : undefined,
    lanes: Array.isArray(data.lanes)
      ? (data.lanes as unknown[]).flatMap((l) => {
          if (!l || typeof l !== "object") return []
          const lane = l as Record<string, unknown>
          if (typeof lane.id !== "string") return []
          return [
            {
              id: lane.id,
              label: typeof lane.label === "string" ? lane.label : lane.id,
            },
          ]
        })
      : undefined,
    nodes,
    edges,
    development:
      data.development && typeof data.development === "object"
        ? (data.development as ArchitectureMapData["development"])
        : undefined,
  }
}

/**
 * Overlay the LIVE progress ledger onto the STATIC architecture-map data at read
 * time.
 *
 * The architecture-map JSON is a static graph generated once at extraction; the
 * progress ledger is the single source of truth for live progress. This DERIVES
 * `graph_item_states` and `active_items` from the ledger (using the ONE shared
 * `deriveDevelopmentOverlay`, the same function the extraction generator runs)
 * and returns a copy of `data` with those two fields replaced — so the map always
 * reflects current progress with zero regeneration of the data file.
 *
 * Tolerant by design: a missing/`null`/`undefined` ledger yields an empty overlay
 * (the static graph renders as `not_started`), and the verification-gate check is
 * permissive on read (a verified item was already gate-validated when the dev-loop
 * committed the ledger), so a stale on-disk evidence file never 500s the viewer.
 * The static `issues`, `coverage_summary`, and path pointers are preserved as-is.
 *
 * `applyLiveOverlay` never mutates its input.
 */
export function applyLiveOverlay(
  data: ArchitectureMapData,
  ledger: unknown
): ArchitectureMapData {
  const graphRefs = new Set<string>()
  for (const node of data.nodes) graphRefs.add(canonicalNodeGraphRef(node.id))
  for (const edge of data.edges) {
    graphRefs.add(edge.graph_ref || canonicalEdgeGraphRef(edge))
  }

  // The static issue list scopes which issues a ledger entry may reference. It is
  // authored at extraction and travels in the static data; the live overlay only
  // changes the per-graph-item state, never the issue set.
  const issues: OverlayIssue[] = (data.development?.issues ?? []).map((issue) => ({
    id: issue.id,
    graph_refs: issue.graph_refs ?? [],
  }))

  const { graph_item_states, active_items } = deriveDevelopmentOverlay({
    graphRefs,
    issues,
    ledger,
    // Read path is tolerant: a verified item was gate-validated at write time, so
    // accept any evidence_ref here rather than re-enforcing the grammar on read.
    verificationGateMatcher: /.*/,
    // No on-disk evidence check on read — a stale evidence file must not 500.
  })

  return {
    ...data,
    development: {
      ...(data.development ?? {}),
      graph_item_states,
      active_items,
    },
  }
}

/** Resolve all nodes for a view in one pass, attaching `effectiveStatus`. */
export function resolveNodes(
  data: ArchitectureMapData,
  view: ViewMode
): ResolvedNode[] {
  const overlay = buildStatusOverlay(data.development?.graph_item_states)
  return data.nodes.map((node) => ({
    ...node,
    effectiveStatus: resolveNodeStatus(node, view, overlay),
  }))
}

/**
 * Case-insensitive match of a node against a search query. Empty query matches
 * everything. Matches the same broad field set as the original viewer: id,
 * label, kind, tech, scope, status, lane, owns_data, source_refs, and graph_ref.
 */
export function nodeMatchesQuery(node: MapNode, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return [
    node.id,
    node.label,
    node.kind,
    node.tech ?? "",
    node.scope ?? "",
    node.status ?? "",
    node.lane,
    node.graph_ref,
    ...(node.owns_data ?? []),
    ...(node.source_refs ?? []),
  ]
    .join(" ")
    .toLowerCase()
    .includes(q)
}

/** A point in the map's flow coordinate space. */
export interface XY {
  x: number
  y: number
}

/** The snap step used when committing edited node positions (matches the grid). */
export const LAYOUT_SNAP_GRID = 20

/** Snap a single coordinate to the layout grid. */
export function snapCoordinate(value: number, grid = LAYOUT_SNAP_GRID): number {
  return Math.round(value / grid) * grid
}

/** Snap a point to the layout grid. */
export function snapXY(point: XY, grid = LAYOUT_SNAP_GRID): XY {
  return { x: snapCoordinate(point.x, grid), y: snapCoordinate(point.y, grid) }
}

/**
 * Cluster-drag math: apply a (snapped) drag delta to every member node's drag
 * START position, returning the moved positions keyed by node id. Pure and
 * snap-aware so it can be unit tested and reused by the map's cluster handle —
 * a faithful port of the original viewer's `moveCluster`, which shifted every
 * member of a cluster by the same snapped delta from where the drag began.
 */
export function clusterMovedPositions(
  startPositions: Map<string, XY>,
  memberIds: string[],
  delta: XY,
  grid = LAYOUT_SNAP_GRID
): Map<string, XY> {
  const snapped = snapXY(delta, grid)
  const moved = new Map<string, XY>()
  for (const id of memberIds) {
    const start = startPositions.get(id)
    if (!start) continue
    moved.set(id, { x: start.x + snapped.x, y: start.y + snapped.y })
  }
  return moved
}

/** The active map filters that decide node/edge visibility. */
export interface MapFilters {
  view: ViewMode
  query: string
  laneFilter: string
  statusFilter: string
  scopeFilter: string
}

/**
 * Count the nodes and edges that survive the active filters, mirroring exactly
 * what the map renders. Used by the Information panel's "visible" count. The
 * status filter keeps the endpoints of status-matching edges (same rule as the
 * map), and the search query hides non-matching nodes (pruning their edges).
 */
export function computeVisibleCounts(
  data: ArchitectureMapData,
  filters: MapFilters
): { nodes: number; edges: number } {
  const overlay = buildStatusOverlay(data.development?.graph_item_states)
  const statesByRef = buildGraphStatesByRef(data.development?.graph_item_states)
  const status = (node: MapNode): NodeStatus =>
    overlay.get(node.graph_ref) ?? asNodeStatus(node.status) ?? "not_started"

  const statusMatchedEndpoints = new Set<string>()
  if (filters.statusFilter !== "all") {
    for (const edge of data.edges) {
      const s = statesByRef.get(edgeGraphRef(edge))?.status ?? "not_started"
      if (s === filters.statusFilter) {
        statusMatchedEndpoints.add(edge.from)
        statusMatchedEndpoints.add(edge.to)
      }
    }
  }

  const visible = new Set(
    data.nodes
      .filter((n) => filters.laneFilter === "all" || n.lane === filters.laneFilter)
      .filter(
        (n) =>
          filters.statusFilter === "all" ||
          status(n) === filters.statusFilter ||
          statusMatchedEndpoints.has(n.id)
      )
      .filter((n) => filters.scopeFilter === "all" || n.scope === filters.scopeFilter)
      .filter((n) => nodeMatchesQuery(n, filters.query))
      .map((n) => n.id)
  )

  let edgeCount = 0
  data.edges.forEach((edge) => {
    if (!visible.has(edge.from) || !visible.has(edge.to)) return
    if (filters.statusFilter !== "all") {
      const s = statesByRef.get(edgeGraphRef(edge))?.status ?? "not_started"
      if (s !== filters.statusFilter) return
    }
    edgeCount += 1
  })

  return { nodes: visible.size, edges: edgeCount }
}

/**
 * Stable graph_ref for an edge. Prefers the ref baked into the static graph at
 * extraction; otherwise derives it from the ONE canonical formula shared with the
 * generator and the overlay derivation (`@/lib/development-overlay`). There is no
 * second copy of the edge-ref formula that could drift from the generator's keys.
 */
export function edgeGraphRef(edge: MapEdge): string {
  return edge.graph_ref || canonicalEdgeGraphRef(edge)
}

/** Count the edges incident to each node id (both directions). */
export function buildEdgeCounts(edges: MapEdge[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const edge of edges) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
  }
  return counts
}

/** Map every graph_ref an issue touches to the issues that reference it. */
export function buildIssuesByGraphRef(
  issues: DevelopmentIssue[] | undefined
): Map<string, DevelopmentIssue[]> {
  const byRef = new Map<string, DevelopmentIssue[]>()
  for (const issue of issues ?? []) {
    for (const ref of issue.graph_refs ?? []) {
      const bucket = byRef.get(ref) ?? []
      bucket.push(issue)
      byRef.set(ref, bucket)
    }
  }
  return byRef
}

/** Set of every graph_ref currently being worked on by an active agent. */
export function buildActiveGraphRefs(
  activeItems: ActiveItem[] | undefined
): Set<string> {
  const refs = new Set<string>()
  for (const item of activeItems ?? []) {
    for (const ref of item.graph_refs ?? []) refs.add(ref)
  }
  return refs
}

/** Index graph item states by graph_ref for O(1) lookup. */
export function buildGraphStatesByRef(
  states: GraphItemState[] | undefined
): Map<string, GraphItemState> {
  const byRef = new Map<string, GraphItemState>()
  for (const state of states ?? []) {
    if (state.graph_ref) byRef.set(state.graph_ref, state)
  }
  return byRef
}

/**
 * Display status for an issue, mirroring the original viewer: an active item's
 * live state wins; otherwise the aggregate of its graph items' statuses.
 */
export function issueDisplayStatus(
  issue: DevelopmentIssue,
  development: DevelopmentBlock | undefined
): string {
  const active = (development?.active_items ?? []).find(
    (item) => item.issue_id === issue.id
  )
  if (active?.state) return active.state
  const statesByRef = buildGraphStatesByRef(development?.graph_item_states)
  const statuses = (issue.graph_refs ?? []).map(
    (ref) => statesByRef.get(ref)?.status ?? "not_started"
  )
  if (statuses.includes("blocked")) return "blocked"
  if (statuses.includes("in_progress")) return "in_progress"
  if (statuses.includes("reviewing")) return "reviewing"
  if (statuses.length > 0 && statuses.every((s) => s === "verified"))
    return "verified"
  if (statuses.includes("implemented")) return "implemented"
  return "not_started"
}

/**
 * Transcript refs belonging to a single issue. Aggregated across the issue's
 * graph items and any active item, then filtered to the ones whose path encodes
 * this issue id (transcripts live under `.../transcripts/<ISSUE-ID>/...`).
 */
export function issueTranscriptRefs(
  issue: DevelopmentIssue,
  development: DevelopmentBlock | undefined
): string[] {
  const refs = new Set<string>()
  const statesByRef = buildGraphStatesByRef(development?.graph_item_states)
  for (const ref of issue.graph_refs ?? []) {
    for (const t of statesByRef.get(ref)?.transcript_refs ?? []) refs.add(t)
  }
  for (const item of development?.active_items ?? []) {
    if (item.issue_id === issue.id) {
      for (const t of item.transcript_refs ?? []) refs.add(t)
    }
  }
  return [...refs].filter((ref) => ref.includes(`/${issue.id}/`))
}

/** Percentage of doc lines linked to issues, formatted like "37.0%". */
export function formatLineCoverage(
  summary: CoverageSummary | undefined
): string {
  const total = summary?.total_doc_lines ?? 0
  if (!summary || total === 0) return "0%"
  return `${(((summary.issue_linked_doc_lines ?? 0) / total) * 100).toFixed(1)}%`
}

function toNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
}

function isStringRecord(value: unknown): boolean {
  return !!value && typeof value === "object" && !Array.isArray(value)
}
