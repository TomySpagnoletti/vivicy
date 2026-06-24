"use client"

import { useCallback, useMemo } from "react"
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  getStraightPath,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  type Edge,
  type EdgeProps,
  type Node,
} from "@xyflow/react"

import "@xyflow/react/dist/style.css"
import "@/components/map/map.css"

import {
  buildActiveGraphRefs,
  buildEdgeCounts,
  buildGraphStatesByRef,
  buildIssuesByGraphRef,
  edgeGraphRef,
  nodeMatchesQuery,
} from "@/lib/map-data"
import {
  CLUSTER_TONES,
  kindColor,
  progressStatusColor,
  STATUS_COLORS,
  type ColorToken,
} from "@/lib/map-palette"
import type {
  ArchitectureMapData,
  MapEdge,
  MapNode,
  NodeStatus,
  ViewMode,
} from "@/lib/types"
import { MapNode as MapNodeCard, type MapNodeData } from "@/components/map/map-node"

const NODE_WIDTH = 320
const NODE_HEIGHT_ESTIMATE = 150
const CLUSTER_PADDING_X = 74
const CLUSTER_PADDING_Y = 66
const DEFAULT_LABEL_RATIO = 0.5

export type SelectedItem =
  | { type: "node"; item: MapNode }
  | { type: "edge"; id: string; item: MapEdge }
  | null

interface EdgeData extends Record<string, unknown> {
  protocol: string
  progressStatus: string
  showProgress: boolean
  isActive: boolean
  isDimmed: boolean
  isSelected: boolean
  isConnected: boolean
  labelRatio: number
}

const nodeTypes = { mapNode: MapNodeCard }
const edgeTypes = { architectureEdge: ArchitectureEdge }

const SELECTABLE_TARGET = ".react-flow__node, .react-flow__edge, .map-edge-label"

export function ArchitectureMap(props: ArchitectureMapProps) {
  return (
    <ReactFlowProvider>
      <ArchitectureMapInner {...props} />
    </ReactFlowProvider>
  )
}

interface ArchitectureMapProps {
  data: ArchitectureMapData
  view: ViewMode
  query: string
  laneFilter: string
  statusFilter: string
  scopeFilter: string
  selected: SelectedItem
  onSelect: (selected: SelectedItem) => void
}

function ArchitectureMapInner({
  data,
  view,
  query,
  laneFilter,
  statusFilter,
  scopeFilter,
  selected,
  onSelect,
}: ArchitectureMapProps) {
  // Derived indices over the (immutable) data.
  const edgeCounts = useMemo(() => buildEdgeCounts(data.edges), [data.edges])
  const statesByRef = useMemo(
    () => buildGraphStatesByRef(data.development?.graph_item_states),
    [data.development]
  )
  const issuesByRef = useMemo(
    () => buildIssuesByGraphRef(data.development?.issues),
    [data.development]
  )
  const activeRefs = useMemo(
    () => buildActiveGraphRefs(data.development?.active_items),
    [data.development]
  )

  const nodeGraphRef = useCallback(
    (node: MapNode) => node.graph_ref ?? `node:${node.id}`,
    []
  )

  const effectiveStatus = useCallback(
    (node: MapNode): NodeStatus =>
      (statesByRef.get(nodeGraphRef(node))?.status ?? node.status ?? "not_started"),
    [nodeGraphRef, statesByRef]
  )

  // Status filter also keeps the endpoints of status-matching edges visible,
  // mirroring the original viewer.
  const statusMatchedEdgeIds = useMemo(() => {
    const ids = new Set<string>()
    if (statusFilter === "all") return ids
    data.edges.forEach((edge, i) => {
      const status = statesByRef.get(edgeGraphRef(edge))?.status ?? "not_started"
      if (status === statusFilter) ids.add(edgeId(edge, i))
    })
    return ids
  }, [data.edges, statesByRef, statusFilter])

  const statusMatchedEndpoints = useMemo(() => {
    const ids = new Set<string>()
    data.edges.forEach((edge, i) => {
      if (statusMatchedEdgeIds.has(edgeId(edge, i))) {
        ids.add(edge.from)
        ids.add(edge.to)
      }
    })
    return ids
  }, [data.edges, statusMatchedEdgeIds])

  // A node is visible when it clears every active filter, including the search
  // query — matching the original viewer, which hid (not just dimmed) nodes the
  // query did not match, pruning their edges along with them.
  const visibleNodeIds = useMemo(() => {
    return new Set(
      data.nodes
        .filter((n) => laneFilter === "all" || n.lane === laneFilter)
        .filter(
          (n) =>
            statusFilter === "all" ||
            effectiveStatus(n) === statusFilter ||
            statusMatchedEndpoints.has(n.id)
        )
        .filter((n) => scopeFilter === "all" || n.scope === scopeFilter)
        .filter((n) => nodeMatchesQuery(n, query))
        .map((n) => n.id)
    )
  }, [
    data.nodes,
    effectiveStatus,
    laneFilter,
    query,
    scopeFilter,
    statusFilter,
    statusMatchedEndpoints,
  ])

  const flowNodes = useMemo<Node<MapNodeData>[]>(() => {
    const selectedNodeId = selected?.type === "node" ? selected.item.id : undefined
    return data.nodes
      .filter((n) => visibleNodeIds.has(n.id))
      .map((node) => {
        const status = effectiveStatus(node)
        const color: ColorToken =
          view === "target" ? kindColor(node.kind) : progressStatusColor(status)
        const ref = nodeGraphRef(node)
        return {
          id: node.id,
          type: "mapNode",
          position: { x: node.layout_x, y: node.layout_y },
          selected: selectedNodeId === node.id,
          selectable: true,
          draggable: false,
          style: { width: NODE_WIDTH },
          data: {
            id: node.id,
            label: node.label,
            kind: node.kind,
            scope: node.scope ?? "",
            tech: node.tech ?? "",
            ownsData: node.owns_data ?? [],
            edgeCount: edgeCounts.get(node.id) ?? 0,
            linkedIssueCount: issuesByRef.get(ref)?.length ?? 0,
            isActive: activeRefs.has(ref),
            color,
            // Visible nodes always match (the query now hides non-matches), so
            // this stays true; kept on the data for the dim-affordance hook.
            matched: true,
            selected: selectedNodeId === node.id,
            isFuture: node.scope === "future",
            cluster: node.layout_cluster ?? "ungrouped",
          },
        }
      })
  }, [
    activeRefs,
    data.nodes,
    edgeCounts,
    effectiveStatus,
    issuesByRef,
    nodeGraphRef,
    selected,
    view,
    visibleNodeIds,
  ])

  const flowEdges = useMemo<Edge<EdgeData>[]>(() => {
    const selectedNodeId = selected?.type === "node" ? selected.item.id : undefined
    return data.edges
      .map((edge, i) => ({ edge, id: edgeId(edge, i) }))
      .filter(({ edge }) => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to))
      .filter(({ id }) => statusFilter === "all" || statusMatchedEdgeIds.has(id))
      .map(({ edge, id }) => {
        const isSelected = selected?.type === "edge" && selected.id === id
        const isConnected = Boolean(
          selectedNodeId && (edge.from === selectedNodeId || edge.to === selectedNodeId)
        )
        const isDimmed = !isSelected && !isConnected
        const ref = edgeGraphRef(edge)
        const progressStatus = statesByRef.get(ref)?.status ?? "not_started"
        const progressColor = progressStatusColor(progressStatus)
        return {
          id,
          source: edge.from,
          target: edge.to,
          sourceHandle: "source",
          targetHandle: "target",
          type: "architectureEdge",
          selected: isSelected,
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18 },
          zIndex: isSelected ? 1000 : isConnected ? 900 : 0,
          data: {
            protocol: edge.protocol ?? "",
            progressStatus,
            showProgress: view === "progress",
            isActive: activeRefs.has(ref),
            isDimmed,
            isSelected,
            isConnected,
            labelRatio: clampRatio(edge.layout_label_ratio ?? DEFAULT_LABEL_RATIO),
          },
          style: {
            stroke: isSelected
              ? "#0f172a"
              : view === "progress" && progressStatus !== "not_started"
                ? progressColor.border
                : "#64748b",
            strokeOpacity: isDimmed ? 0.3 : 1,
            strokeWidth: isSelected
              ? 2.2
              : view === "progress" && progressStatus !== "not_started"
                ? 1.9
                : 1.35,
          },
        }
      })
  }, [
    activeRefs,
    data.edges,
    selected,
    statesByRef,
    statusFilter,
    statusMatchedEdgeIds,
    view,
    visibleNodeIds,
  ])

  // The data prop is immutable for a given render, and our nodes/edges are fully
  // derived, so we feed them to ReactFlow directly (read-only, non-draggable).
  const selectNode = useCallback(
    (event: React.MouseEvent, node: Node<MapNodeData>) => {
      event.stopPropagation()
      const found = data.nodes.find((n) => n.id === node.id)
      if (found) onSelect({ type: "node", item: found })
    },
    [data.nodes, onSelect]
  )

  const selectEdgeFromFlow = useCallback(
    (event: React.MouseEvent, edge: Edge) => {
      event.stopPropagation()
      const index = edgeIndexFromId(edge.id)
      const found = data.edges[index]
      if (found) onSelect({ type: "edge", id: edge.id, item: found })
    },
    [data.edges, onSelect]
  )

  const clearSelection = useCallback(
    (event: React.MouseEvent) => {
      const target = event.target
      if (target instanceof Element && target.closest(SELECTABLE_TARGET)) return
      onSelect(null)
    },
    [onSelect]
  )

  return (
    <div className="architecture-map-root">
      <ReactFlow
        colorMode="light"
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeClick={selectNode}
        onEdgeClick={selectEdgeFromFlow}
        onPaneClick={clearSelection}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.08}
        maxZoom={1.8}
        nodesDraggable={false}
        nodesConnectable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />
        <ClusterBackdrops nodes={flowNodes} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeBorderRadius={8}
          nodeStrokeWidth={3}
          nodeColor={(n) => {
            const d = n.data as MapNodeData | undefined
            return d?.color.bg ?? "#e2e8f0"
          }}
        />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
      <div className="absolute top-3 right-3 z-10">
        <Legend view={view} nodes={data.nodes} statusLegend={data.statusLegend} />
      </div>
    </div>
  )
}

/** Render edge label + the selected-edge overlay path. */
function ArchitectureEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  style,
  data,
}: EdgeProps) {
  const edgeData = data as EdgeData | undefined
  const protocol = edgeData?.protocol ?? ""
  const progressStatus = edgeData?.progressStatus ?? "not_started"
  const showProgress = edgeData?.showProgress ?? false
  const isDimmed = edgeData?.isDimmed ?? true
  const isSelected = edgeData?.isSelected ?? false
  const isConnected = edgeData?.isConnected ?? false
  const isActive = edgeData?.isActive ?? false
  const renderFloating = isSelected || isConnected
  const labelRatio = clampRatio(edgeData?.labelRatio ?? DEFAULT_LABEL_RATIO)

  const [edgePath] = getStraightPath({ sourceX, sourceY, targetX, targetY })
  const labelX = sourceX + (targetX - sourceX) * labelRatio
  const labelY = sourceY + (targetY - sourceY) * labelRatio
  const labelWidth = 190
  const labelHeight = 28
  const markerId = `map-selected-edge-marker-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`

  const progressClass = `${
    showProgress && progressStatus !== "not_started" ? ` status-${progressStatus}` : ""
  }${isActive ? " active-work" : ""}`
  const foreignClass = `${isSelected || !isDimmed ? "" : " dimmed"}${progressClass}`
  const floatingClass = `${
    isSelected ? " selected" : isConnected ? " connected" : ""
  }${progressClass}`

  return (
    <>
      <BaseEdge id={id} path={edgePath} markerEnd={markerEnd} style={style} interactionWidth={8} />
      {renderFloating ? (
        <EdgeLabelRenderer>
          {isSelected ? (
            <svg className="map-selected-edge-overlay" aria-hidden="true">
              <defs>
                <marker
                  id={markerId}
                  markerHeight="12"
                  markerUnits="strokeWidth"
                  markerWidth="12"
                  orient="auto"
                  refX="10"
                  refY="6"
                >
                  <path d="M2,2 L10,6 L2,10 Z" fill="#0f172a" />
                </marker>
              </defs>
              <path
                className="map-selected-edge-overlay-path"
                d={edgePath}
                markerEnd={`url(#${markerId})`}
              />
            </svg>
          ) : null}
          <button
            type="button"
            className={`map-edge-label map-edge-label-overlay nodrag nopan${floatingClass}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              zIndex: isSelected ? 1002 : 1001,
            }}
            title="Select edge"
          >
            {protocol}
          </button>
        </EdgeLabelRenderer>
      ) : protocol ? (
        <foreignObject
          className="map-edge-label-foreign"
          x={labelX - labelWidth / 2}
          y={labelY - labelHeight / 2}
          width={labelWidth}
          height={labelHeight}
        >
          <div className="map-edge-label-host">
            <button type="button" className={`map-edge-label nodrag nopan${foreignClass}`} title="Select edge">
              {protocol}
            </button>
          </div>
        </foreignObject>
      ) : null}
    </>
  )
}

function ClusterBackdrops({ nodes }: { nodes: Node<MapNodeData>[] }) {
  const groups = useMemo(() => {
    const bounds = new Map<
      string,
      { minX: number; minY: number; maxX: number; maxY: number }
    >()
    for (const node of nodes) {
      const cluster = (node.data as MapNodeData).cluster as string
      const minX = node.position.x
      const minY = node.position.y
      const maxX = node.position.x + NODE_WIDTH
      const maxY = node.position.y + NODE_HEIGHT_ESTIMATE
      const existing = bounds.get(cluster)
      if (!existing) {
        bounds.set(cluster, { minX, minY, maxX, maxY })
        continue
      }
      existing.minX = Math.min(existing.minX, minX)
      existing.minY = Math.min(existing.minY, minY)
      existing.maxX = Math.max(existing.maxX, maxX)
      existing.maxY = Math.max(existing.maxY, maxY)
    }
    return [...bounds.entries()]
      .map(([id, b], index) => ({
        id,
        label: formatClusterLabel(id),
        x: b.minX - CLUSTER_PADDING_X,
        y: b.minY - CLUSTER_PADDING_Y,
        width: b.maxX - b.minX + CLUSTER_PADDING_X * 2,
        height: b.maxY - b.minY + CLUSTER_PADDING_Y * 2,
        tone: index % CLUSTER_TONES.length,
      }))
      .sort((a, b) => b.width * b.height - a.width * a.height)
  }, [nodes])

  return (
    <ViewportPortal>
      {groups.map((group) => {
        const tone = CLUSTER_TONES[group.tone]
        return (
          <div
            key={group.id}
            className="map-cluster-backdrop"
            style={{
              height: group.height,
              width: group.width,
              transform: `translate(${group.x}px, ${group.y}px)`,
              background: tone.fill,
              borderColor: tone.border,
            }}
          >
            <span className="map-cluster-label">{group.label}</span>
          </div>
        )
      })}
    </ViewportPortal>
  )
}

function Legend({
  view,
  nodes,
  statusLegend,
}: {
  view: ViewMode
  nodes: MapNode[]
  statusLegend: Record<string, string> | undefined
}) {
  const entries =
    view === "target"
      ? [...new Set(nodes.map((n) => n.kind))]
          .sort()
          .map((kind) => ({ label: kind, color: kindColor(kind) }))
      : Object.keys(statusLegend ?? STATUS_COLORS).map((status) => ({
          label: status,
          color: progressStatusColor(status),
        }))
  return (
    <div className="map-legend">
      <span className="map-legend-title">
        {view === "target" ? "Kind colors" : "Progress colors"}
      </span>
      <div className="map-legend-items">
        {entries.map((entry) => (
          <span key={entry.label} className="map-legend-item">
            <span
              className="map-legend-swatch"
              style={{ background: entry.color.bg, borderColor: entry.color.border }}
            />
            {entry.label}
          </span>
        ))}
      </div>
    </div>
  )
}

function formatClusterLabel(clusterId: string): string {
  return clusterId
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function edgeId(edge: MapEdge, index: number): string {
  return `${edge.from}->${edge.to}-${index}`
}

function edgeIndexFromId(id: string): number {
  const match = id.match(/-(\d+)$/)
  return match ? Number(match[1]) : -1
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_LABEL_RATIO
  return Math.min(0.92, Math.max(0.08, ratio))
}
