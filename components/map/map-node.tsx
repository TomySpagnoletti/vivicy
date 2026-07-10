import { memo } from "react"
import { Handle, Position, type NodeProps } from "@xyflow/react"
import { useTranslations } from "next-intl"

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
  color: ColorToken
  matched: boolean
  selected: boolean
  isFuture: boolean
  cluster: string
  [key: string]: unknown
}

// Deliberately non-shadcn — do not refactor this component's inline colors to design-system tokens.
function MapNodeComponent({ data }: NodeProps) {
  const t = useTranslations("map")
  const node = data as MapNodeData
  const { color } = node
  const dataLine =
    node.ownsData.slice(0, 3).join(", ") +
    (node.linkedIssueCount > 0
      ? ` • ${t("node.linkedIssueCount", { count: node.linkedIssueCount })}`
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
          {node.id} • {t("node.edgeCount", { count: node.edgeCount })}
        </span>
        {node.isActive ? (
          <span className="map-work-pulse" title={t("node.activeWorkTitle")} />
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
