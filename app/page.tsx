"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { toast } from "sonner"

import type {
  ArchitectureMapData,
  MapEmptyReason,
  MapEmptyState as MapEmptyStatePayload,
  ViewMode,
} from "@/lib/types"
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar"
import {
  ArchitectureMap,
  type SelectedItem,
} from "@/components/map/architecture-map"
import { MapEmptyState } from "@/components/map/map-empty-state"
import { VivicySidebar } from "@/components/sidebar/sidebar"
import { TranscriptProvider } from "@/components/transcript/transcript-modal"

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; reason: MapEmptyReason }
  | { kind: "ready"; data: ArchitectureMapData }

export default function Page() {
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [view, setView] = useState<ViewMode>("target")
  const [query, setQuery] = useState("")
  const [laneFilter, setLaneFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [scopeFilter, setScopeFilter] = useState("all")
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null)
  const [sidebarOpen, setSidebarOpen] = useState(true)

  // Track mount so background refreshes don't flash the loading state or apply
  // after unmount.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // `foreground` loads surface loading/error states (initial load, manual
  // reload); background refreshes (after Extract / status changes) update the
  // map silently and keep the current view on failure.
  const loadMap = useCallback(async (foreground = false) => {
    try {
      const res = await fetch("/api/map", { cache: "no-store" })
      const body = await res.json()
      if (!mountedRef.current) return
      if (!res.ok) {
        if (foreground) {
          setState({
            kind: "error",
            message: body?.detail ?? body?.error ?? `Request failed (${res.status}).`,
          })
        }
        return
      }
      // The route returns a structured onboarding payload (HTTP 200) when there
      // is no graph to render: no target, no generated map, or an empty map.
      if (isEmptyPayload(body)) {
        setState({ kind: "empty", reason: body.reason })
        return
      }
      setState({ kind: "ready", data: body as ArchitectureMapData })
    } catch (err) {
      if (!mountedRef.current || !foreground) return
      setState({
        kind: "error",
        message: err instanceof Error ? err.message : "Failed to load the architecture map.",
      })
    }
  }, [])

  // Extract from the onboarding state: runs the deterministic extraction +
  // map-regeneration chain, then reloads the map so a freshly generated graph
  // replaces the empty state. The panel's Extract drives the same endpoint.
  const [extracting, setExtracting] = useState(false)
  const runExtract = useCallback(async () => {
    setExtracting(true)
    try {
      const res = await fetch("/api/control/extract", { method: "POST" })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
      }
      if (!res.ok || body.ok === false) {
        toast.error("Extract failed", { description: body.error ?? `HTTP ${res.status}` })
        return
      }
      toast.success("Extraction complete")
      await loadMap(true)
    } catch (err) {
      toast.error("Extract failed", {
        description: err instanceof Error ? err.message : "network error",
      })
    } finally {
      if (mountedRef.current) setExtracting(false)
    }
  }, [loadMap])

  // Initial load. State starts as `loading`, so the effect only kicks off the
  // fetch via a nested async call — no synchronous setState in the effect body.
  useEffect(() => {
    async function initialLoad() {
      await loadMap(true)
    }
    void initialLoad()
  }, [loadMap])

  // Keep the selected item in sync with the latest data: a background refresh
  // can replace the node/edge object, so re-resolve it by identity.
  const selected = useMemo<SelectedItem>(() => {
    if (state.kind !== "ready" || !selectedRef) return null
    if (selectedRef.type === "node") {
      const node = state.data.nodes.find((n) => n.id === selectedRef.id)
      return node ? { type: "node", item: node } : null
    }
    const index = edgeIndex(selectedRef.id)
    const edge = state.data.edges[index]
    return edge ? { type: "edge", id: selectedRef.id, item: edge } : null
  }, [state, selectedRef])

  return (
    <TranscriptProvider>
      <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
        {/* Map fills the inset; reclaims width when the right sidebar collapses. */}
        <SidebarInset className="relative min-w-0">
          {/* Discreet sidebar toggle, top-left of the page. Only meaningful once
              the panel is rendered (i.e. when a graph is present). */}
          {state.kind === "ready" ? (
            <div className="absolute top-3 left-3 z-20">
              <SidebarTrigger
                variant="outline"
                aria-label={sidebarOpen ? "Collapse panel" : "Expand panel"}
              />
            </div>
          ) : null}

          {state.kind === "loading" ? (
            <CenteredMessage>
              <Loader2 className="size-4 animate-spin" />
              Loading architecture map…
            </CenteredMessage>
          ) : null}

          {state.kind === "error" ? (
            <CenteredMessage>
              <TriangleAlert className="size-4 text-destructive" />
              <span className="max-w-md text-center text-muted-foreground">
                {state.message}
              </span>
            </CenteredMessage>
          ) : null}

          {state.kind === "empty" ? (
            <MapEmptyState
              reason={state.reason}
              onExtract={runExtract}
              extracting={extracting}
            />
          ) : null}

          {state.kind === "ready" ? (
            <ArchitectureMap
              data={state.data}
              view={view}
              query={query}
              laneFilter={laneFilter}
              statusFilter={statusFilter}
              scopeFilter={scopeFilter}
              selected={selected}
              onSelect={(next) => {
                if (!next) setSelectedRef(null)
                else if (next.type === "node")
                  setSelectedRef({ type: "node", id: next.item.id })
                else setSelectedRef({ type: "edge", id: next.id })
              }}
            />
          ) : null}
        </SidebarInset>

        {state.kind === "ready" ? (
          <VivicySidebar
            data={state.data}
            view={view}
            onViewChange={setView}
            query={query}
            onQueryChange={setQuery}
            laneFilter={laneFilter}
            onLaneFilterChange={setLaneFilter}
            statusFilter={statusFilter}
            onStatusFilterChange={setStatusFilter}
            scopeFilter={scopeFilter}
            onScopeFilterChange={setScopeFilter}
            selected={selected}
            onMapRefresh={() => void loadMap(false)}
          />
        ) : null}
      </SidebarProvider>
    </TranscriptProvider>
  )
}

/** Narrow the `/api/map` JSON to the onboarding payload (vs. a real graph). */
function isEmptyPayload(body: unknown): body is MapEmptyStatePayload {
  return (
    !!body &&
    typeof body === "object" &&
    (body as { empty?: unknown }).empty === true
  )
}

/** Lightweight identity for the selected item, kept stable across refreshes. */
type SelectedRef = { type: "node"; id: string } | { type: "edge"; id: string }

function edgeIndex(id: string): number {
  const match = id.match(/-(\d+)$/)
  return match ? Number(match[1]) : -1
}

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-2 p-6 text-sm text-foreground">
      {children}
    </div>
  )
}
