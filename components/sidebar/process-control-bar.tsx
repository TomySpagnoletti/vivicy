"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Download, Pause, Play, RotateCcw } from "lucide-react"
import { toast } from "sonner"

import {
  isResumable,
  PHASE_LABELS,
  resolveRunPhase,
  type RunPhase,
  type StatusResponse,
} from "@/lib/run-status"
import type { DevelopmentBlock } from "@/lib/types"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

type Action = "start" | "stop" | "resume" | "extract"

/**
 * The honest reason Extract is greyed out once extraction has produced issues
 * for the current target. Pure + exported so the tooltip copy is asserted in a
 * unit test without depending on portal rendering, and so the count's
 * singular/plural wording stays in one place.
 */
export function extractedGateMessage(issueCount: number): string {
  const noun = issueCount === 1 ? "issue" : "issues"
  return `Already extracted — ${issueCount} ${noun}. Re-extraction isn't available yet.`
}

/** Phase -> badge dot color token. All from theme tokens; no inline color. */
const PHASE_DOT: Record<RunPhase, string> = {
  idle: "bg-muted-foreground",
  running: "bg-primary",
  done: "bg-primary",
  blocked: "bg-destructive",
  stalled: "bg-destructive",
}

/**
 * Live process-control bar. Subscribes to the SSE status stream and drives the
 * dev-factory: Run (start), Pause/Stop, Resume, and Extract. Each action posts
 * to its control endpoint and toasts the result; status changes (done count or
 * gate failures moving) re-fetch the map via `onMapRefresh`.
 */
export function ProcessControlBar({
  development,
  onMapRefresh,
}: {
  /**
   * The current map's development block. Extraction is gated on its issue set:
   * once extraction has produced issues for this target, Extract is disabled
   * (re-extraction isn't supported yet). Derived from the existing `/api/map`
   * payload — not a parallel data source.
   */
  development?: DevelopmentBlock
  onMapRefresh?: () => void
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [streamError, setStreamError] = useState(false)
  const [pending, setPending] = useState<Action | null>(null)

  // Track the values that should trigger a map refresh when they change.
  const lastSignatureRef = useRef<string | null>(null)
  const onMapRefreshRef = useRef(onMapRefresh)
  useEffect(() => {
    onMapRefreshRef.current = onMapRefresh
  }, [onMapRefresh])

  useEffect(() => {
    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as StatusResponse & { error?: string }
        if (next.error) {
          setStreamError(true)
          return
        }
        setStreamError(false)
        setStatus(next)

        // Refresh the map when progress or gate state moves.
        const signature = `${next.issues_done}/${next.issues_total}:${next.gates?.fail ?? 0}:${next.run_active}`
        if (lastSignatureRef.current !== null && lastSignatureRef.current !== signature) {
          onMapRefreshRef.current?.()
        }
        lastSignatureRef.current = signature
      } catch {
        setStreamError(true)
      }
    }
    source.onerror = () => setStreamError(true)
    return () => source.close()
  }, [])

  const phase: RunPhase = status ? resolveRunPhase(status) : "idle"
  const running = phase === "running" || phase === "stalled"
  // Resume is offered only when stopped part-way; a completed run shows Run so
  // the loop can be re-launched.
  const resumable = status ? isResumable(status) : false
  const total = status?.issues_total ?? 0
  const done = status?.issues_done ?? 0
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  // Extraction is one-shot for now: once it has produced issues for this target,
  // re-extraction isn't available, so Extract is greyed out and explains why. The
  // signal is the map's own development.issues (the same payload the Tasks panel
  // renders) — no parallel data source.
  const issueCount = development?.issues?.length ?? 0
  const alreadyExtracted = issueCount > 0

  const act = useCallback(
    async (action: Action, endpoint: string, label: string) => {
      setPending(action)
      try {
        const res = await fetch(endpoint, { method: "POST" })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          steps?: Array<{ name: string; code: number | null; lastLine: string }>
        }
        if (!res.ok || body.ok === false) {
          toast.error(`${label} failed`, { description: body.error ?? `HTTP ${res.status}` })
          return
        }
        if (action === "extract" && body.steps) {
          const failed = body.steps.filter((s) => s.code !== 0)
          if (failed.length > 0) {
            toast.warning("Extraction finished with issues", {
              description: failed.map((s) => `${s.name}: exit ${s.code}`).join(", "),
            })
          } else {
            toast.success("Extraction complete", {
              description: body.steps.map((s) => s.name).join(" -> "),
            })
          }
          onMapRefreshRef.current?.()
        } else {
          toast.success(`${label} ok`)
        }
      } catch (error) {
        toast.error(`${label} failed`, {
          description: error instanceof Error ? error.message : "network error",
        })
      } finally {
        setPending(null)
      }
    },
    []
  )

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="gap-1.5" aria-label={`status: ${PHASE_LABELS[phase]}`}>
          <span aria-hidden className={`size-1.5 rounded-full ${PHASE_DOT[phase]}`} />
          {streamError ? "offline" : PHASE_LABELS[phase]}
        </Badge>

        <div className="flex items-center gap-1">
          {running ? (
            <StopControl
              pending={pending === "stop"}
              disabled={pending !== null}
              onConfirm={() => act("stop", "/api/control/stop", "Stop")}
            />
          ) : resumable ? (
            <IconControl
              label="Resume"
              icon={<RotateCcw />}
              pending={pending === "resume"}
              disabled={pending !== null}
              onClick={() => act("resume", "/api/control/resume", "Resume")}
            />
          ) : (
            <IconControl
              label="Run"
              icon={<Play />}
              pending={pending === "start"}
              disabled={pending !== null}
              onClick={() => act("start", "/api/control/start", "Run")}
            />
          )}

          {alreadyExtracted ? (
            // Already extracted: keep the button focusable (so it's still a real
            // tooltip trigger on hover AND keyboard focus and never a focus hole),
            // but mark it aria-disabled and greyed, and make its click a guarded
            // no-op. Enter/Space/click all do nothing — no re-extraction POST.
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Extract"
                  aria-disabled
                  className="opacity-50"
                  onClick={(event) => event.preventDefault()}
                >
                  <Download />
                  Extract
                </Button>
              </TooltipTrigger>
              <TooltipContent>{extractedGateMessage(issueCount)}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              aria-label="Extract"
              onClick={() => act("extract", "/api/control/extract", "Extract")}
            >
              <Download />
              Extract
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Progress value={percent} className="flex-1" aria-label="issues verified" />
        <span className="text-xs tabular-nums text-muted-foreground" aria-label="progress">
          {done}/{total || "?"}
        </span>
      </div>
    </div>
  )
}

function IconControl({
  label,
  icon,
  onClick,
  pending,
  disabled,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  pending: boolean
  disabled: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{pending ? `${label}…` : label}</TooltipContent>
    </Tooltip>
  )
}

function StopControl({
  onConfirm,
  pending,
  disabled,
}: {
  onConfirm: () => void
  pending: boolean
  disabled: boolean
}) {
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Stop" disabled={disabled}>
              <Pause />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{pending ? "Stopping…" : "Stop"}</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Stop the dev-loop?</AlertDialogTitle>
          <AlertDialogDescription>
            This terminates the running supervisor. Completed issues are kept; you can resume later.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            Stop
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
