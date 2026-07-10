import {
  deriveDevelopmentOverlay,
  edgeGraphRef as canonicalEdgeGraphRef,
  nodeGraphRef as canonicalNodeGraphRef,
  OVERLAY_STATUSES,
  type OverlayIssue,
} from "@/lib/development-overlay"
import { isRecord } from "@/lib/type-guards"
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
  ViewMode,
} from "@/lib/types"

const NODE_STATUSES: NodeStatus[] = [...OVERLAY_STATUSES]

const NODE_STATUS_SET = new Set<string>(NODE_STATUSES)

export function asNodeStatus(value: unknown): NodeStatus | null {
  return typeof value === "string" && NODE_STATUS_SET.has(value)
    ? (value as NodeStatus)
    : null
}

function buildStatusOverlay(
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
    // React Flow errors if an edge references a missing node.
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
    statusLegend: isRecord(data.statusLegend)
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

// Shares deriveDevelopmentOverlay with the extraction generator — do not fork it, or read-time and generation-time overlays will diverge.
export function applyLiveOverlay(
  data: ArchitectureMapData,
  ledger: unknown
): ArchitectureMapData {
  const graphRefs = new Set<string>()
  for (const node of data.nodes) graphRefs.add(canonicalNodeGraphRef(node.id))
  for (const edge of data.edges) {
    graphRefs.add(edge.graph_ref || canonicalEdgeGraphRef(edge))
  }

  const issues: OverlayIssue[] = (data.development?.issues ?? []).map((issue) => ({
    id: issue.id,
    graph_refs: issue.graph_refs ?? [],
  }))

  const { graph_item_states, active_items } = deriveDevelopmentOverlay({
    graphRefs,
    issues,
    ledger,
    // Permissive on purpose: items were already gate-validated at write time; re-checking on read would 500 on stale on-disk evidence.
    verificationGateMatcher: /.*/,
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

export interface XY {
  x: number
  y: number
}

export const LAYOUT_SNAP_GRID = 20

function snapCoordinate(value: number, grid = LAYOUT_SNAP_GRID): number {
  return Math.round(value / grid) * grid
}

export function snapXY(point: XY, grid = LAYOUT_SNAP_GRID): XY {
  return { x: snapCoordinate(point.x, grid), y: snapCoordinate(point.y, grid) }
}

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

export interface MapFilters {
  view: ViewMode
  query: string
  laneFilter: string
  statusFilter: string
  scopeFilter: string
}

// Must mirror the map's actual render-filter logic (including which edge endpoints the status filter keeps), or these counts drift from what's displayed.
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

// The one canonical edge-ref formula, shared with the generator and overlay derivation — do not reimplement, or refs will drift from the generator's keys.
export function edgeGraphRef(edge: MapEdge): string {
  return edge.graph_ref || canonicalEdgeGraphRef(edge)
}

/** Parse the trailing `-<i>` index from a React Flow edge id (`${from}->${to}-${i}`); -1 when absent. */
export function edgeIndexFromId(id: string): number {
  const match = id.match(/-(\d+)$/)
  return match ? Number(match[1]) : -1
}

export function buildEdgeCounts(edges: MapEdge[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const edge of edges) {
    counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1)
    counts.set(edge.to, (counts.get(edge.to) ?? 0) + 1)
  }
  return counts
}

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

export function buildActiveGraphRefs(
  activeItems: ActiveItem[] | undefined
): Set<string> {
  const refs = new Set<string>()
  for (const item of activeItems ?? []) {
    for (const ref of item.graph_refs ?? []) refs.add(ref)
  }
  return refs
}

export function buildGraphStatesByRef(
  states: GraphItemState[] | undefined
): Map<string, GraphItemState> {
  const byRef = new Map<string, GraphItemState>()
  for (const state of states ?? []) {
    if (state.graph_ref) byRef.set(state.graph_ref, state)
  }
  return byRef
}

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
