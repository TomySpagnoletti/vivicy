"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import type { RunStatus } from "@/lib/run-status"
import { cn } from "@/lib/utils"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  deriveStageStates,
  MARKER_GLYPH,
  PIPELINE_STAGES,
  type ExtractionStatusLike,
  type StageState,
} from "@/components/pipeline/pipeline-stages"

const STAGE_STATE_CLASS: Record<StageState, string> = {
  pending: "border-border bg-card text-muted-foreground",
  running: "border-primary bg-card text-foreground ring-2 ring-primary/40 animate-pulse",
  green: "border-status-verified bg-card text-foreground",
  red: "border-destructive bg-card text-destructive",
}

const STAGE_DOT_CLASS: Record<StageState, string> = {
  pending: "bg-muted-foreground",
  running: "bg-primary",
  green: "bg-status-verified",
  red: "bg-destructive",
}

export const PIPELINE_WIDGET_OPEN_KEY = "vivicy:pipeline-widget-open"
const POLL_INTERVAL_MS = 10_000

interface ExtractStatusResponse {
  ok?: boolean
  status?: ExtractionStatusLike | null
}

/**
 * G8's mini-pipeline overlay: a compact horizontal strip of the 13 §3 stages,
 * top-center OVER the map canvas. Derives stage state from the SAME SSE status
 * stream the control bar already subscribes to, plus a lightweight poll of the
 * new GET /api/control/extract for the extraction phase (S2–S6) — no second
 * source of truth, only a second read of already-existing state files.
 *
 * Collapsible: default expanded while a run/extraction is active, collapsed at
 * idle (persisted per the same localStorage pattern as the legend section), so
 * the strip never fights the map when nothing is happening.
 */
export function PipelineWidget() {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [extraction, setExtraction] = useState<ExtractionStatusLike | null>(null)
  const [open, setOpen] = useState<boolean | null>(null) // null = not yet decided
  const [retryPending, setRetryPending] = useState<"extract" | "dev" | null>(null)
  const userToggledRef = useRef(false)

  const fetchExtraction = useCallback(async () => {
    try {
      const res = await fetch("/api/control/extract", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as ExtractStatusResponse
      if (res.ok && body.ok !== false) setExtraction(body.status ?? null)
    } catch {
      // Best-effort: leave the last known extraction status in place.
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await fetchExtraction()
    })()
    const timer = setInterval(() => void fetchExtraction(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [fetchExtraction])

  useEffect(() => {
    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as RunStatus & { error?: string }
        if (next.error) return
        setStatus(next)
        void fetchExtraction()
      } catch {
        // A malformed frame just keeps the last known status.
      }
    }
    return () => source.close()
  }, [fetchExtraction])

  const states = deriveStageStates(status, extraction)
  // "Active" for the default-expanded heuristic means "worth looking at": a live
  // run, a currently-pulsing stage, OR a blocked one — a red stage needs the
  // strip visible exactly as much as a running one does, never less.
  const active =
    Boolean(status?.run_active) ||
    Object.values(states).some((s) => s === "running" || s === "red")

  // Default-expanded-when-active, collapsed-at-idle, UNLESS the user explicitly
  // toggled it — a manual choice always wins over the activity heuristic.
  useEffect(() => {
    if (userToggledRef.current) return
    setOpen(active)
  }, [active])

  const runRetry = useCallback(async (stage: "extract" | "dev") => {
    setRetryPending(stage)
    try {
      const res = await fetch("/api/control/retry-stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage }),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; summary?: string }
      if (!res.ok || body.ok === false) {
        toast.error(`Retry ${stage} failed`, { description: body.error ?? body.summary ?? `HTTP ${res.status}` })
        return
      }
      toast.success(`Retry ${stage} ok`, { description: body.summary })
    } catch (error) {
      toast.error(`Retry ${stage} failed`, {
        description: error instanceof Error ? error.message : "network error",
      })
    } finally {
      setRetryPending(null)
    }
  }, [])

  const isOpen = open ?? active

  return (
    <div
      className="pointer-events-auto absolute top-2 left-1/2 z-10 w-fit max-w-[calc(100%-1rem)] -translate-x-1/2"
      data-pipeline-widget
    >
      <Collapsible
        open={isOpen}
        onOpenChange={(next) => {
          userToggledRef.current = true
          setOpen(next)
        }}
        className="flex flex-col items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1.5 shadow-sm backdrop-blur-sm"
      >
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1 text-xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={isOpen ? "Collapse pipeline" : "Expand pipeline"}
          >
            {isOpen ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
            Pipeline
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex items-center gap-0.5 overflow-x-auto py-1">
            {PIPELINE_STAGES.map((stage, index) => {
              const previousSide = PIPELINE_STAGES[index - 1]?.side
              const boundary = previousSide === "non_loop" && stage.side === "dev_loop"
              return (
                <div key={stage.id} className="flex items-center gap-0.5">
                  {boundary ? (
                    <span
                      aria-hidden
                      data-boundary
                      className="mx-1 h-8 w-0 border-l border-dashed border-border"
                    />
                  ) : null}
                  {index > 0 && !boundary ? (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                  ) : null}
                  <StageNode
                    stageId={stage.id}
                    label={stage.label}
                    marker={stage.marker}
                    state={states[stage.id]}
                    retryStage={stage.retryStage}
                    retryPending={retryPending === stage.retryStage}
                    onRetry={stage.retryStage ? () => void runRetry(stage.retryStage!) : undefined}
                  />
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-between gap-3 px-1 text-[10px] text-muted-foreground">
            <span>Non-loop</span>
            <span>Dev-loop (autonomous)</span>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

function StageNode({
  stageId,
  label,
  marker,
  state,
  retryStage,
  retryPending,
  onRetry,
}: {
  stageId: string
  label: string
  marker: keyof typeof MARKER_GLYPH
  state: StageState
  retryStage?: "extract" | "dev"
  retryPending: boolean
  onRetry?: () => void
}) {
  const node = (
    <div
      data-stage={stageId}
      data-stage-state={state}
      className={cn(
        "flex shrink-0 flex-col items-center gap-0.5 rounded-sm border px-1.5 py-1 text-[10px] leading-none transition-colors",
        STAGE_STATE_CLASS[state]
      )}
    >
      <div className="flex items-center gap-1">
        <span aria-hidden className={cn("size-1.5 rounded-full", STAGE_DOT_CLASS[state])} />
        <span className="font-mono font-semibold">{stageId}</span>
        <span aria-hidden>{MARKER_GLYPH[marker]}</span>
      </div>
      <span className="max-w-16 truncate">{label}</span>
    </div>
  )

  if (!retryStage) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{node}</TooltipTrigger>
        <TooltipContent>
          {label} — driven automatically
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex flex-col items-center gap-0.5">
      {node}
      <AlertDialog>
        <Tooltip>
          <TooltipTrigger asChild>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Retry ${stageId}`}
                disabled={retryPending}
                className="size-4"
              >
                <RotateCcw className="size-3" />
              </Button>
            </AlertDialogTrigger>
          </TooltipTrigger>
          <TooltipContent>{retryPending ? "Retrying…" : `Retry ${label}`}</TooltipContent>
        </Tooltip>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retry {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {retryStage === "extract"
                ? "Re-runs freeze -> author -> validate -> verify from the frozen canonical."
                : "Resumes the dev-loop supervisor from done/ and the progress ledger."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onRetry}>Retry</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
