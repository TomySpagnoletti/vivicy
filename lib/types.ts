/**
 * Typed contract for the architecture-map data consumed by the Vivicy viewer.
 *
 * The shape mirrors the committed
 * `<target>/docs/architecture-map/viewer/src/architecture-data.json` produced by
 * the Naight architecture-map tooling. This file is the single source of truth
 * for the data types used across the app; do not redeclare these shapes inline.
 */

/** Development progress statuses, ordered from untouched to verified. */
export type NodeStatus =
  | "not_started"
  | "in_progress"
  | "reviewing"
  | "implemented"
  | "verified"
  | "blocked"

/** Which projection of the graph is currently shown. */
export type ViewMode = "target" | "progress"

export interface MapLane {
  id: string
  label: string
}

export interface MapNode {
  id: string
  label: string
  kind: string
  lane: string
  order?: number
  layout_x: number
  layout_y: number
  /** Cluster id used to group nodes under a labeled backdrop on the map. */
  layout_cluster?: string
  /** Layout role hint from the source map (primary_flow, support, etc.). */
  layout_role?: string
  scope?: string
  status?: NodeStatus
  tech?: string
  owns_data?: string[]
  source_refs?: string[]
  evidence_refs?: string[]
  graph_ref: string
}

export interface MapEdge {
  from: string
  to: string
  relation?: string
  protocol?: string
  /** Position of the protocol label along the edge (0..1). */
  layout_label_ratio?: number
  data?: string[]
  source_refs?: string[]
  graph_ref: string
}

export interface DevelopmentIssue {
  id: string
  title?: string
  status?: NodeStatus
  issue_path?: string
  requirement_ids?: string[]
  graph_refs?: string[]
  verification_gate_ids?: string[]
  source_line_refs?: string[]
  [key: string]: unknown
}

export interface GraphItemState {
  graph_ref: string
  status?: NodeStatus
  issue_ids?: string[]
  evidence_refs?: string[]
  transcript_refs?: string[]
}

/** A development agent actively working on one or more graph items. */
export interface ActiveItem {
  id: string
  actor?: string
  issue_id?: string
  graph_refs?: string[]
  state?: string
  role?: string
  transcript_refs?: string[]
  [key: string]: unknown
}

export interface CoverageSummary {
  total_doc_lines?: number
  classified_doc_lines?: number
  requirement_linked_doc_lines?: number
  issue_linked_doc_lines?: number
  [key: string]: unknown
}

export interface DevelopmentBlock {
  issue_index_path?: string
  progress_ledger_path?: string
  issues?: DevelopmentIssue[]
  graph_item_states?: GraphItemState[]
  active_items?: ActiveItem[]
  coverage_summary?: CoverageSummary
  [key: string]: unknown
}

export interface ViewMeta {
  title?: string
  subtitle?: string
}

export interface ArchitectureMapData {
  name: string
  version?: number
  updated?: string
  purpose?: string
  views?: Partial<Record<ViewMode, ViewMeta>>
  statusLegend?: Record<string, string>
  lanes?: MapLane[]
  nodes: MapNode[]
  edges: MapEdge[]
  development?: DevelopmentBlock
}

/**
 * The reason the viewer has no graph to render, used to pick the right
 * onboarding guidance. A discriminated value so the client never has to parse
 * prose or HTTP status codes to decide what to show:
 *
 * - `no_target`  — no usable project resolved (root missing, or no `docs/`).
 * - `no_map`     — the project exists but no architecture map was generated yet.
 * - `empty_map`  — a map is present on disk but contains zero nodes.
 */
export type MapEmptyReason = "no_target" | "no_map" | "empty_map"

/** The onboarding payload `/api/map` returns instead of a graph. */
export interface MapEmptyState {
  empty: true
  reason: MapEmptyReason
  /** Absolute target root the viewer resolved, for operator-facing detail. */
  targetRoot: string
}

/** A node enriched with its effective, view-aware status for rendering. */
export interface ResolvedNode extends MapNode {
  /**
   * The status the map should color by in the current view. `null` means
   * "render neutral" (always true in the target view, and in the progress view
   * when there is no overlay and no node status).
   */
  effectiveStatus: NodeStatus | null
}
