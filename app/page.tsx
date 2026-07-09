"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, TriangleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type {
  ArchitectureMapData,
  MapEmptyReason,
  MapEmptyState as MapEmptyStatePayload,
  ViewMode,
} from "@/lib/types"
import type { AgentsHealth } from "@/lib/agents-health-types"
import type { CurrentProject } from "@/lib/project-types"
import { edgeIndexFromId } from "@/lib/map-data"
import { errorText } from "@/lib/i18n-errors"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import {
  AgentsAuthBanner,
  AgentsGate,
  agentsGateBlocked,
} from "@/components/agents/agents-gate"
import { ViviPanel } from "@/components/chat/vivi-panel"
import { ViviPanelProvider } from "@/components/chat/vivi-panel-context"
import {
  ArchitectureMap,
  type SelectedItem,
} from "@/components/map/architecture-map"
import { MapEmptyState } from "@/components/map/map-empty-state"
import { PipelineWidget } from "@/components/pipeline/pipeline-widget"
import { OnboardingEmptyState } from "@/components/project/onboarding-empty-state"
import { SetupBar } from "@/components/project/setup-bar"
import { PanelToggle } from "@/components/sidebar/panel-toggle"
import { VivicySidebar } from "@/components/sidebar/sidebar"
import { TranscriptProvider } from "@/components/transcript/transcript-modal"
import { usePanelState } from "@/hooks/use-panel-state"

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "empty"; reason: MapEmptyReason }
  | { kind: "ready"; data: ArchitectureMapData }

export default function Page() {
  const t = useTranslations("app")
  const tErrors = useTranslations("errors")
  const [state, setState] = useState<LoadState>({ kind: "loading" })
  const [view, setView] = useState<ViewMode>("target")
  const [query, setQuery] = useState("")
  const [laneFilter, setLaneFilter] = useState("all")
  const [statusFilter, setStatusFilter] = useState("all")
  const [scopeFilter, setScopeFilter] = useState("all")
  const [selectedRef, setSelectedRef] = useState<SelectedRef | null>(null)
  const [projectSignal, setProjectSignal] = useState(0)
  const panel = usePanelState()

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // The prerequisite gate's data (W4a): probed ONCE up front (the route memoizes
  // per server process). `undefined` = probe in flight (keep the loading skeleton,
  // never flash the gate); `null` = probe unreachable (fail OPEN — the app worked
  // before the gate existed, and every agent leg still reports honestly).
  const [agentsHealth, setAgentsHealth] = useState<AgentsHealth | null | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // fresh=1: a page load re-probes so installing a CLI + reloading clears the
        // gate honestly; the memo keeps serving the banner/dialog's follow-up GETs.
        const res = await fetch("/api/agents/health?fresh=1", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as { agents?: AgentsHealth }
        if (!cancelled) setAgentsHealth(body.agents ?? null)
      } catch {
        if (!cancelled) setAgentsHealth(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  const gateBlocked = agentsHealth ? agentsGateBlocked(agentsHealth) : false

  // The current project, lifted here (single source of truth): the setup bar's
  // switcher affordance and the Vivi panel's onboarding/reset logic both derive
  // from it. `undefined` = first fetch still in flight (so the panel never
  // mistakes "unknown yet" for a project switch).
  const [project, setProject] = useState<CurrentProject | null | undefined>(undefined)
  const loadProject = useCallback(async () => {
    try {
      const res = await fetch("/api/project", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as {
        project?: CurrentProject | null
      }
      if (mountedRef.current) setProject(body.project ?? null)
    } catch {
      // Keep the last known project on a transient fetch failure.
    }
  }, [])
  // `projectSignal` is intentionally a dependency: any project change (setup bar,
  // panel onboarding, Vivi activity) bumps it, re-running this load.
  useEffect(() => {
    void (async () => {
      await loadProject()
    })()
  }, [loadProject, projectSignal])

  const loadMap = useCallback(
    async (foreground = false) => {
      try {
        const res = await fetch("/api/map", { cache: "no-store" })
        const body = await res.json()
        if (!mountedRef.current) return
        if (!res.ok) {
          if (foreground) {
            const fallback =
              body?.detail ??
              body?.error ??
              t("loadError.requestFailed", { status: res.status })
            setState({
              kind: "error",
              message: body?.code
                ? errorText(tErrors, `route.${body.code}`, fallback)
                : fallback,
            })
          }
          return
        }
        if (isEmptyPayload(body)) {
          setState({ kind: "empty", reason: body.reason })
          return
        }
        setState({ kind: "ready", data: body as ArchitectureMapData })
      } catch (err) {
        if (!mountedRef.current || !foreground) return
        setState({
          kind: "error",
          message:
            err instanceof Error ? err.message : t("loadError.genericFailure"),
        })
      }
    },
    [t, tErrors]
  )

  // Extract from the onboarding state: runs the deterministic extraction +
  // map-regeneration chain, then reloads the map so a freshly generated graph
  // replaces the empty state. The panel's Extract drives the same endpoint.
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<{
    message: string
    code?: string
  } | null>(null)
  const runExtract = useCallback(async () => {
    setExtracting(true)
    setExtractError(null)
    try {
      const res = await fetch("/api/control/extract", { method: "POST" })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        blocked?: boolean
        summary?: string
        error?: string
        code?: string
      }
      if (!res.ok || body.ok === false) {
        // The pre-flight guard refusals (no/empty canonical) are onboarding
        // signals, not failures: surface them inline in the empty state, where
        // the Import button is the fix, instead of a transient toast.
        if (body.code === "empty_canonical") {
          const fallback = body.error ?? t("extract.emptyCanonical")
          setExtractError({
            message: errorText(tErrors, `control.${body.code}`, fallback),
            code: body.code,
          })
          return
        }
        // Distinguish "blocked for a human" (the deterministic checks stayed red
        // after the bounded retries) from a transient failure, so the operator
        // knows whether to look at the corpus or just retry.
        if (body.blocked) {
          toast.error(t("extract.blockedTitle"), {
            description: body.summary ?? t("extract.blockedDefaultDescription"),
          })
        } else {
          const fallback =
            body.summary ??
            body.error ??
            t("extract.failedHttpDescription", { status: res.status })
          toast.error(t("extract.failedTitle"), {
            description: body.code
              ? errorText(tErrors, `control.${body.code}`, fallback)
              : fallback,
          })
        }
        return
      }
      toast.success(t("extract.completeTitle"), { description: body.summary })
      await loadMap(true)
    } catch (err) {
      toast.error(t("extract.failedTitle"), {
        description:
          err instanceof Error
            ? err.message
            : t("extract.failedNetworkDescription"),
      })
    } finally {
      if (mountedRef.current) setExtracting(false)
    }
  }, [loadMap, t, tErrors])

  useEffect(() => {
    async function initialLoad() {
      await loadMap(true)
    }
    void initialLoad()
  }, [loadMap])

  const onProjectChanged = useCallback(() => {
    setProjectSignal((n) => n + 1)
    void loadMap(true)
  }, [loadMap])

  // A Vivi turn that wrote files or executed actions (including an in-panel
  // acquisition or CR decision) changed project state behind the map's back —
  // same refresh path as a project change.
  const onViviActivity = onProjectChanged

  const lastAgentsWarningRef = useRef<string | null>(null)
  const onAgentsWarning = useCallback(
    (message: string) => {
      if (lastAgentsWarningRef.current === message) return
      lastAgentsWarningRef.current = message
      toast.warning(t("agentsWarningTitle"), { description: message })
    },
    [t]
  )

  const selected = useMemo<SelectedItem>(() => {
    if (state.kind !== "ready" || !selectedRef) return null
    if (selectedRef.type === "node") {
      const node = state.data.nodes.find((n) => n.id === selectedRef.id)
      return node ? { type: "node", item: node } : null
    }
    const index = edgeIndexFromId(selectedRef.id)
    const edge = state.data.edges[index]
    return edge ? { type: "edge", id: selectedRef.id, item: edge } : null
  }, [state, selectedRef])

  // False exactly when the map says `no_target` (drives the panel's onboarding
  // view); unknown while the map is still loading or errored.
  const hasTarget =
    state.kind === "ready" || state.kind === "empty"
      ? !(state.kind === "empty" && state.reason === "no_target")
      : undefined

  return (
    <TranscriptProvider>
      <ViviPanelProvider>
        {agentsHealth === undefined ? (
          <CenteredMessage>
            <Loader2 className="size-4 animate-spin" />
            {t("loading")}
          </CenteredMessage>
        ) : gateBlocked && agentsHealth ? (
          // W4a: a missing CLI binary blocks the WHOLE app — only the gate (and
          // the Vivi launcher below, which shows its own install hint) render.
          <AgentsGate health={agentsHealth} onHealth={setAgentsHealth} />
        ) : (
          <SidebarProvider
            open={panel.open}
            onOpenChange={panel.setOpen}
            // Drive the open width (peek vs wide) into the shadcn Sidebar via its
            // own CSS var, so width is the sidebar's own state, not a custom layout.
            style={{ "--sidebar-width": panel.width } as React.CSSProperties}
          >
            <SidebarInset className="relative min-w-0">
              <SetupBar
                project={project ?? null}
                onProjectChanged={onProjectChanged}
                onAgentsWarning={onAgentsWarning}
              />

              {state.kind === "ready" ? (
                <PanelToggle
                  next={panel.next}
                  open={panel.open}
                  onCycle={panel.cycle}
                />
              ) : null}

              {state.kind === "loading" ? (
                <CenteredMessage>
                  <Loader2 className="size-4 animate-spin" />
                  {t("loading")}
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

              {state.kind === "empty" && state.reason === "no_target" ? (
                // W4b: onboarding lives in the Vivi panel — this state only says
                // so and auto-opens the panel once.
                <OnboardingEmptyState />
              ) : null}

              {state.kind === "empty" && state.reason !== "no_target" ? (
                <>
                  <MapEmptyState
                    reason={state.reason}
                    onExtract={runExtract}
                    extracting={extracting}
                    extractError={extractError}
                    onImported={() => {
                      setExtractError(null)
                      void loadMap(true)
                    }}
                  />
                  {/* The pipeline widget must be visible BEFORE a map exists too — the
                  first extraction (S2–S6) is exactly what it should show, and there
                  is no map yet at that point. It renders whenever a project is
                  resolved, not only in the ready state. */}
                  <PipelineWidget />
                </>
              ) : null}

              {state.kind === "ready" ? (
                <>
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
                  {/* Absolutely positioned OVER the map viewport (not a ViewportPortal —
                  the widget must stay fixed to the screen, never pan/zoom with the
                  graph), matching the SetupBar overlay pattern above. */}
                  <PipelineWidget />
                </>
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
        )}

        {/* Present-but-unauthenticated is NOT blocking (W4a): a dismissible amber
          banner over the normal app, with the exact auth command. */}
        {agentsHealth && !gateBlocked ? (
          <AgentsAuthBanner health={agentsHealth} />
        ) : null}

        {/* Rendered once, OUTSIDE the load-state branches: the launcher bubble and
          the panel exist in every state (loading/error/empty/ready — and on the
          prerequisite gate), so Vivi is reachable even before a project or map
          exists. */}
        <ViviPanel
          onActivity={onViviActivity}
          hasTarget={hasTarget}
          projectRoot={project === undefined ? undefined : (project?.root ?? null)}
          agentsMissing={gateBlocked}
        />
      </ViviPanelProvider>
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

function CenteredMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-2 p-6 text-sm text-foreground">
      {children}
    </div>
  )
}
