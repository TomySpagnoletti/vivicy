"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
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
  useEdgesState,
  useNodesState,
  useReactFlow,
  useViewport,
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
  clusterMovedPositions,
  edgeGraphRef,
  edgeIndexFromId,
  LAYOUT_SNAP_GRID,
  nodeMatchesQuery,
  snapXY,
  type XY,
} from "@/lib/map-data"
import {
  CLUSTER_TONES,
  kindColor,
  progressStatusColor,
  UNKNOWN_KIND_COLOR,
  type ColorToken,
} from "@/lib/map-palette"
import { errorText } from "@/lib/i18n-errors"
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
const MIN_LABEL_RATIO = 0.08
const MAX_LABEL_RATIO = 0.92
const EDGE_LABEL_DRAG_THRESHOLD_PX = 4
const SNAP_GRID: [number, number] = [LAYOUT_SNAP_GRID, LAYOUT_SNAP_GRID]

type SaveStatus = "idle" | "saving" | "saved" | "error"

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
  editable: boolean
  onMoveEdgeLabel: (edgeId: string, ratio: number) => void
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
  const t = useTranslations("map")
  const tErrors = useTranslations("errors")
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

  const [editMode, setEditMode] = useState(false)
  const [nodePositions, setNodePositions] = useState<Record<string, XY>>({})
  const [edgeLabelRatios, setEdgeLabelRatios] = useState<Record<string, number>>({})
  const [layoutDirty, setLayoutDirty] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle")
  const [saveError, setSaveError] = useState("")
  const dirtyNodeIdsRef = useRef<Set<string>>(new Set())
  const dirtyEdgeLabelIdsRef = useRef<Set<string>>(new Set())
  const clusterDragStartPositionsRef = useRef<Map<string, XY> | null>(null)

  const nodesById = useMemo(() => new Map(data.nodes.map((n) => [n.id, n])), [data.nodes])
  const edgesById = useMemo(() => {
    const map = new Map<string, { edge: MapEdge; index: number }>()
    data.edges.forEach((edge, i) => map.set(edgeId(edge, i), { edge, index: i }))
    return map
  }, [data.edges])
  const initialNodePositions = useMemo(
    () => new Map(data.nodes.map((n) => [n.id, { x: n.layout_x, y: n.layout_y }])),
    [data.nodes]
  )
  const initialEdgeRatios = useMemo(
    () =>
      new Map(
        data.edges.map((e, i) => [
          edgeId(e, i),
          clampRatio(e.layout_label_ratio ?? DEFAULT_LABEL_RATIO),
        ])
      ),
    [data.edges]
  )

  const nodeGraphRef = useCallback(
    (node: MapNode) => node.graph_ref ?? `node:${node.id}`,
    []
  )

  const effectiveStatus = useCallback(
    (node: MapNode): NodeStatus =>
      statesByRef.get(nodeGraphRef(node))?.status ?? node.status ?? "not_started",
    [nodeGraphRef, statesByRef]
  )

  const refreshLayoutDirty = useCallback(() => {
    setLayoutDirty(dirtyNodeIdsRef.current.size > 0 || dirtyEdgeLabelIdsRef.current.size > 0)
    setSaveStatus("idle")
    setSaveError("")
  }, [])

  const markNodePositionDirty = useCallback(
    (nodeId: string, position: XY) => {
      const initial = initialNodePositions.get(nodeId)
      if (initial && samePosition(initial, position)) {
        dirtyNodeIdsRef.current.delete(nodeId)
      } else {
        dirtyNodeIdsRef.current.add(nodeId)
      }
      refreshLayoutDirty()
    },
    [initialNodePositions, refreshLayoutDirty]
  )

  const markEdgeLabelDirty = useCallback(
    (edgeIdValue: string, ratio: number) => {
      const initial = initialEdgeRatios.get(edgeIdValue) ?? DEFAULT_LABEL_RATIO
      if (almostEqual(initial, ratio)) {
        dirtyEdgeLabelIdsRef.current.delete(edgeIdValue)
      } else {
        dirtyEdgeLabelIdsRef.current.add(edgeIdValue)
      }
      refreshLayoutDirty()
    },
    [initialEdgeRatios, refreshLayoutDirty]
  )

  const moveEdgeLabel = useCallback(
    (edgeIdValue: string, ratio: number) => {
      const next = clampRatio(ratio)
      setEdgeLabelRatios((current) => {
        if (almostEqual(current[edgeIdValue] ?? DEFAULT_LABEL_RATIO, next)) return current
        markEdgeLabelDirty(edgeIdValue, next)
        return { ...current, [edgeIdValue]: next }
      })
    },
    [markEdgeLabelDirty]
  )

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
        const position = nodePositions[node.id] ?? { x: node.layout_x, y: node.layout_y }
        return {
          id: node.id,
          type: "mapNode",
          position,
          selected: selectedNodeId === node.id,
          selectable: true,
          draggable: editMode,
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
            // MapNodeCard reads this field for the dim affordance.
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
    editMode,
    effectiveStatus,
    issuesByRef,
    nodeGraphRef,
    nodePositions,
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
            labelRatio: clampRatio(
              edgeLabelRatios[id] ?? edge.layout_label_ratio ?? DEFAULT_LABEL_RATIO
            ),
            editable: editMode,
            onMoveEdgeLabel: moveEdgeLabel,
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
    edgeLabelRatios,
    editMode,
    moveEdgeLabel,
    selected,
    statesByRef,
    statusFilter,
    statusMatchedEdgeIds,
    view,
    visibleNodeIds,
  ])

  // The sync below preserves in-flight drag position, or a background refresh mid-drag would snap the node back.
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<MapNodeData>>(flowNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge<EdgeData>>(flowEdges)

  useEffect(() => {
    setNodes((current) => {
      const byId = new Map(current.map((n) => [n.id, n]))
      return flowNodes.map((node) => {
        const existing = byId.get(node.id)
        return existing?.dragging ? { ...node, position: existing.position, dragging: true } : node
      })
    })
  }, [flowNodes, setNodes])

  useEffect(() => {
    setEdges(flowEdges)
  }, [flowEdges, setEdges])

  const commitNodePosition = useCallback(
    (_event: React.MouseEvent | MouseEvent | TouchEvent, node: Node<MapNodeData>) => {
      const snapped = snapXY(node.position)
      setNodes((current) =>
        current.map((n) => (n.id === node.id ? { ...n, position: snapped, dragging: false } : n))
      )
      const current = nodePositions[node.id]
      if (current && samePosition(current, snapped)) return
      setNodePositions((positions) => ({ ...positions, [node.id]: snapped }))
      markNodePositionDirty(node.id, snapped)
    },
    [markNodePositionDirty, nodePositions, setNodes]
  )

  const moveCluster = useCallback(
    (clusterId: string, delta: XY, commit: boolean) => {
      const memberIds = data.nodes
        .filter((n) => visibleNodeIds.has(n.id) && (n.layout_cluster ?? "ungrouped") === clusterId)
        .map((n) => n.id)
      if (memberIds.length === 0) return

      if (!clusterDragStartPositionsRef.current) {
        clusterDragStartPositionsRef.current = new Map(
          nodes.map((n) => [n.id, { ...n.position }])
        )
      }
      const moved = clusterMovedPositions(
        clusterDragStartPositionsRef.current,
        memberIds,
        delta
      )

      setNodes((current) =>
        current.map((n) => {
          const next = moved.get(n.id)
          return next ? { ...n, position: next } : n
        })
      )

      if (!commit) return
      clusterDragStartPositionsRef.current = null

      const changed = [...moved.entries()].some(([id, pos]) => {
        const current = nodePositions[id]
        return !current || !samePosition(current, pos)
      })
      if (!changed) return

      for (const [id, pos] of moved) markNodePositionDirty(id, pos)
      setNodePositions((positions) => {
        const next = { ...positions }
        for (const [id, pos] of moved) next[id] = pos
        return next
      })
    },
    [data.nodes, markNodePositionDirty, nodePositions, nodes, setNodes, visibleNodeIds]
  )

  const saveLayout = useCallback(async () => {
    setSaveStatus("saving")
    setSaveError("")
    const nodeIds = [...dirtyNodeIdsRef.current]
    const labelIds = [...dirtyEdgeLabelIdsRef.current]
    if (nodeIds.length === 0 && labelIds.length === 0) {
      setLayoutDirty(false)
      setSaveStatus("saved")
      return
    }
    try {
      const payload = {
        nodes: nodeIds.map((id) => {
          const node = nodesById.get(id)
          if (!node) throw new Error(t("editToolbar.saveFailedUnknownNode", { id }))
          const pos = nodePositions[id] ?? { x: node.layout_x, y: node.layout_y }
          return { id, layout_x: round2(pos.x), layout_y: round2(pos.y) }
        }),
        edgeLabels: labelIds.map((id) => {
          const entry = edgesById.get(id)
          if (!entry) throw new Error(t("editToolbar.saveFailedUnknownEdge", { id }))
          const { edge, index } = entry
          return {
            index,
            from: edge.from,
            to: edge.to,
            relation: edge.relation ?? "",
            protocol: edge.protocol ?? "",
            layout_label_ratio: round4(
              clampRatio(edgeLabelRatios[id] ?? edge.layout_label_ratio ?? DEFAULT_LABEL_RATIO)
            ),
          }
        }),
      }
      const response = await fetch("/api/architecture-map/layout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        throw new Error(
          await readErrorMessage(
            response,
            t("editToolbar.saveFailedHttpStatus", { status: response.status }),
            tErrors
          )
        )
      }
      dirtyNodeIdsRef.current.clear()
      dirtyEdgeLabelIdsRef.current.clear()
      setLayoutDirty(false)
      setSaveStatus("saved")
    } catch (error) {
      setLayoutDirty(true)
      setSaveStatus("error")
      setSaveError(error instanceof Error ? error.message : t("editToolbar.saveFailedFallback"))
    }
  }, [edgeLabelRatios, edgesById, nodePositions, nodesById, t, tErrors])

  // Resolved from the immutable data prop, not local nodes/edges, so selection survives background refreshes that replace those objects.
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

  const showSave = editMode && (layoutDirty || saveStatus === "saving" || saveStatus === "error")

  return (
    <div className="architecture-map-root">
      <ReactFlow
        colorMode="light"
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={selectNode}
        onNodeDragStop={commitNodePosition}
        onEdgeClick={selectEdgeFromFlow}
        onPaneClick={clearSelection}
        proOptions={{ hideAttribution: true }}
        fitView
        fitViewOptions={{ padding: 0.24 }}
        minZoom={0.08}
        maxZoom={1.8}
        nodesDraggable={editMode}
        nodesConnectable={false}
        snapToGrid={editMode}
        snapGrid={SNAP_GRID}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />
        <ClusterBackdrops nodes={nodes} editMode={editMode} onClusterMove={moveCluster} />
        <MiniMap
          position="bottom-right"
          style={{ width: 140, height: 100 }}
          pannable
          zoomable
          nodeBorderRadius={8}
          nodeStrokeWidth={3}
          // nodeStrokeColor is set too: some status bg tones (e.g. not_started) are near-white and would vanish on the minimap's white backdrop otherwise.
          nodeColor={(n) => nodeMinimapColor(n).bg}
          nodeStrokeColor={(n) => nodeMinimapColor(n).border}
        />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>

      <div className="absolute top-14 left-2 z-10">
        <div className="map-edit-toolbar">
          <button
            type="button"
            className={`map-edit-toggle${editMode ? " active" : ""}`}
            aria-pressed={editMode}
            onClick={() => setEditMode((on) => !on)}
            title={editMode ? t("editToolbar.editingTitle") : t("editToolbar.editTitle")}
          >
            {editMode ? t("editToolbar.editingLabel") : t("editToolbar.editLabel")}
          </button>
          {showSave ? (
            <button
              type="button"
              className="map-save-button"
              onClick={saveLayout}
              disabled={saveStatus === "saving" || !layoutDirty}
            >
              {saveStatus === "saving"
                ? t("editToolbar.savingButton")
                : saveStatus === "error"
                  ? t("editToolbar.saveFailedButton")
                  : t("editToolbar.saveButton")}
            </button>
          ) : null}
          {editMode && saveStatus === "saved" ? (
            <span className="map-save-status">{t("editToolbar.savedStatus")}</span>
          ) : null}
          {saveStatus === "error" && saveError ? (
            <p className="map-save-error">{saveError}</p>
          ) : null}
        </div>
      </div>

    </div>
  )
}

function nodeMinimapColor(node: { data?: unknown }): ColorToken {
  const data = node.data as MapNodeData | undefined
  return data?.color ?? UNKNOWN_KIND_COLOR
}

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
  const t = useTranslations("map")
  const { screenToFlowPosition } = useReactFlow()
  const edgeData = data as EdgeData | undefined
  const protocol = edgeData?.protocol ?? ""
  const progressStatus = edgeData?.progressStatus ?? "not_started"
  const showProgress = edgeData?.showProgress ?? false
  const isDimmed = edgeData?.isDimmed ?? true
  const isSelected = edgeData?.isSelected ?? false
  const isConnected = edgeData?.isConnected ?? false
  const isActive = edgeData?.isActive ?? false
  const editable = edgeData?.editable ?? false
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

  const startLabelDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!editable || !edgeData) return
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events (tests) may not own an active pointer.
    }
    const startX = event.clientX
    const startY = event.clientY
    let didDrag = false

    const moveTo = (clientX: number, clientY: number) => {
      const point = screenToFlowPosition({ x: clientX, y: clientY })
      edgeData.onMoveEdgeLabel(
        id,
        projectedEdgeRatio(point, { x: sourceX, y: sourceY }, { x: targetX, y: targetY })
      )
    }
    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      if (!didDrag) {
        didDrag =
          Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) >=
          EDGE_LABEL_DRAG_THRESHOLD_PX
      }
      if (didDrag) moveTo(moveEvent.clientX, moveEvent.clientY)
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

  const resetLabel = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (!editable || !edgeData) return
    event.preventDefault()
    event.stopPropagation()
    edgeData.onMoveEdgeLabel(id, DEFAULT_LABEL_RATIO)
  }

  const labelClassSuffix = editable ? " editable nodrag nopan" : " nodrag nopan"
  const labelTitle = editable ? t("edgeLabel.editableTitle") : t("edgeLabel.selectTitle")

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
            className={`map-edge-label map-edge-label-overlay${labelClassSuffix}${floatingClass}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              zIndex: isSelected ? 1002 : 1001,
            }}
            onPointerDown={editable ? startLabelDrag : undefined}
            onDoubleClick={editable ? resetLabel : undefined}
            title={labelTitle}
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
            <button
              type="button"
              className={`map-edge-label${labelClassSuffix}${foreignClass}`}
              onPointerDown={startLabelDrag}
              onDoubleClick={resetLabel}
              title={labelTitle}
            >
              {protocol}
            </button>
          </div>
        </foreignObject>
      ) : null}
    </>
  )
}

function ClusterBackdrops({
  nodes,
  editMode,
  onClusterMove,
}: {
  nodes: Node<MapNodeData>[]
  editMode: boolean
  onClusterMove: (clusterId: string, delta: XY, commit: boolean) => void
}) {
  const t = useTranslations("map")
  const { zoom } = useViewport()
  const [draggingClusterId, setDraggingClusterId] = useState<string | null>(null)

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

  const startClusterDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    clusterId: string
  ) => {
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointer events (tests) may not own an active pointer.
    }
    setDraggingClusterId(clusterId)

    const dragZoom = zoom || 1
    const startX = event.clientX
    const startY = event.clientY
    let lastDelta: XY = { x: 0, y: 0 }

    const onMove = (moveEvent: PointerEvent) => {
      moveEvent.preventDefault()
      lastDelta = {
        x: (moveEvent.clientX - startX) / dragZoom,
        y: (moveEvent.clientY - startY) / dragZoom,
      }
      onClusterMove(clusterId, lastDelta, false)
    }
    const onUp = () => {
      onClusterMove(clusterId, lastDelta, true)
      setDraggingClusterId(null)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }

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
            {editMode ? (
              <button
                type="button"
                className={`map-cluster-handle nodrag nopan${
                  draggingClusterId === group.id ? " dragging" : ""
                }`}
                onPointerDown={(event) => startClusterDrag(event, group.id)}
                title={t("editToolbar.moveClusterTitle", { clusterLabel: group.label })}
              >
                {group.label}
              </button>
            ) : (
              <span className="map-cluster-label">{group.label}</span>
            )}
          </div>
        )
      })}
    </ViewportPortal>
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

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_LABEL_RATIO
  return Math.min(MAX_LABEL_RATIO, Math.max(MIN_LABEL_RATIO, ratio))
}

function projectedEdgeRatio(point: XY, source: XY, target: XY): number {
  const edgeX = target.x - source.x
  const edgeY = target.y - source.y
  const lengthSquared = edgeX * edgeX + edgeY * edgeY
  if (lengthSquared === 0) return DEFAULT_LABEL_RATIO
  const pointX = point.x - source.x
  const pointY = point.y - source.y
  return clampRatio((pointX * edgeX + pointY * edgeY) / lengthSquared)
}

function almostEqual(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.001
}

function samePosition(a: XY, b: XY): boolean {
  return almostEqual(a.x, b.x) && almostEqual(a.y, b.y)
}

function round2(value: number): number {
  return Number(value.toFixed(2))
}

function round4(value: number): number {
  return Number(clampRatio(value).toFixed(4))
}

async function readErrorMessage(
  response: Response,
  httpStatusFallback: string,
  tErrors: ReturnType<typeof useTranslations<"errors">>
): Promise<string> {
  const text = await response.text()
  try {
    const parsed = JSON.parse(text) as { error?: string; code?: string }
    if (parsed && typeof parsed.error === "string") {
      return parsed.code ? errorText(tErrors, `layoutSave.${parsed.code}`, parsed.error) : parsed.error
    }
  } catch {}
  return text || httpStatusFallback
}
