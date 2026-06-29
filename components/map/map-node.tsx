import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"

import type { ColorToken } from "@/lib/map-palette"

export interface MapNodeData {
  id: string
  label: string
  kind: string
  scope: string
  tech: string
  ownsData: string[]
  edgeCount: number
  linkedIssueCount: number
  isActive: boolean
  /** Slate palette token for the current view (kind in target, status in progress). */
  color: ColorToken
  /** Whether this node matches the current search query (dim when false). */
  matched: boolean
  selected: boolean
  isFuture: boolean
  /** Cluster id, used by the cluster-backdrop layer. */
  cluster: string
  [key: string]: unknown
}

// The map surface is intentionally allowed a custom (non-shadcn) style; colors
// come from the slate palette tokens rather than the design system.
function MapNodeComponent({ data }: NodeProps) {
  const node = data as MapNodeData
  const { color } = node
  const dataLine =
    node.ownsData.slice(0, 3).join(", ") +
    (node.linkedIssueCount > 0
      ? ` • ${node.linkedIssueCount} task${node.linkedIssueCount === 1 ? "" : "s"}`
      : "")

  return (
    <div
      className="architecture-node-card"
      data-selected={node.selected || undefined}
      data-future={node.isFuture || undefined}
      data-active={node.isActive || undefined}
      data-dimmed={!node.matched || undefined}
      style={{
        background: color.bg,
        borderColor: color.border,
        color: color.text,
      }}
    >
      <Handle id="target" type="target" position={Position.Left} className="map-node-handle" />
      <div className="architecture-node-topline">
        <span className="architecture-node-id">
          {node.id} • {node.edgeCount} {node.edgeCount === 1 ? "edge" : "edges"}
        </span>
        {node.isActive ? (
          <span
            className="map-work-pulse"
            title="The development agent is working on this graph item"
          />
        ) : null}
        <span
          className="architecture-node-pill"
          style={{ background: color.pill, borderColor: color.border }}
        >
          {node.kind} · {node.scope}
        </span>
      </div>
      <strong className="architecture-node-label">{node.label}</strong>
      {node.tech ? <span className="architecture-node-tech">{node.tech}</span> : null}
      {dataLine ? <span className="architecture-node-data">{dataLine}</span> : null}
      <Handle id="source" type="source" position={Position.Right} className="map-node-handle" />
    </div>
  )
}

export const MapNode = memo(MapNodeComponent)
