import type { OverlayStatus } from "@/lib/development-overlay"

export type NodeStatus = OverlayStatus

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
  layout_cluster?: string
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

export type MapEmptyReason = "no_target" | "no_map" | "empty_map"

export interface MapEmptyState {
  empty: true
  reason: MapEmptyReason
  targetRoot: string | null
}

export interface ResolvedNode extends MapNode {
  effectiveStatus: NodeStatus | null
}
