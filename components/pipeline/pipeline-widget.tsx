"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronRight, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { RunStatus } from "@/lib/run-status"
import type { SkillsReport } from "@/lib/skills-report"
import { errorText } from "@/lib/i18n-errors"
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

const POLL_INTERVAL_MS = 10_000

interface ExtractStatusResponse {
  ok?: boolean
  status?: ExtractionStatusLike | null
}

interface SkillsReportResponse {
  ok?: boolean
  report?: SkillsReport | null
}

type RetryableStage = NonNullable<(typeof PIPELINE_STAGES)[number]["retryStage"]>

// Polls /api/control/extract and /api/control/skills — a second read of already-existing state files, never a new source of truth.
export function PipelineWidget({ open = false }: { open?: boolean } = {}) {
  const t = useTranslations("pipeline")
  const tErrors = useTranslations("errors")
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [extraction, setExtraction] = useState<ExtractionStatusLike | null>(null)
  const [skills, setSkills] = useState<SkillsReport | null>(null)
  const [retryPending, setRetryPending] = useState<RetryableStage | null>(null)

  const fetchReports = useCallback(async () => {
    try {
      const res = await fetch("/api/control/extract", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as ExtractStatusResponse
      if (res.ok && body.ok !== false) setExtraction(body.status ?? null)
    } catch {}
    try {
      const res = await fetch("/api/control/skills", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as SkillsReportResponse
      if (res.ok && body.ok !== false) setSkills(body.report ?? null)
    } catch {}
  }, [])

  useEffect(() => {
    if (!open) return
    void (async () => {
      await fetchReports()
    })()
    const timer = setInterval(() => void fetchReports(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [open, fetchReports])

  useEffect(() => {
    if (!open) return
    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as RunStatus & { error?: string }
        if (next.error) return
        setStatus(next)
        void fetchReports()
      } catch {}
    }
    return () => source.close()
  }, [open, fetchReports])

  const runRetry = useCallback(async (stage: RetryableStage) => {
    setRetryPending(stage)
    try {
      const res = await fetch("/api/control/retry-stage", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stage }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        code?: string
        summary?: string
      }
      if (!res.ok || body.ok === false) {
        const fallback = body.error ?? body.summary ?? `HTTP ${res.status}`
        toast.error(t("widget.retryFailedToastTitle", { stageId: stage }), {
          description: body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback,
        })
        return
      }
      toast.success(t("widget.retrySucceededToastTitle", { stageId: stage }), { description: body.summary })
    } catch (error) {
      toast.error(t("widget.retryFailedToastTitle", { stageId: stage }), {
        description: error instanceof Error ? error.message : t("widget.networkErrorDescription"),
      })
    } finally {
      setRetryPending(null)
    }
  }, [t, tErrors])

  if (!open) return null

  const states = deriveStageStates(status, extraction, skills)

  return (
    <div
      className="pointer-events-auto absolute top-2 left-1/2 z-10 w-fit max-w-[calc(100%-1rem)] -translate-x-1/2"
      data-pipeline-widget
    >
      <div className="flex flex-col items-center gap-1 rounded-md border border-border bg-card/95 px-2 py-1.5 shadow-sm backdrop-blur-sm">
        {/* max-w-full is load-bearing: the shrink-0 chips' ~1100px min-content width would otherwise size this flex item past the card (intrinsic sizing ignores descendants' max-width), and on mobile Chromium that overflow expands the layout viewport (412->768), flipping md: into desktop mode. */}
        <div className="max-w-full">
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
                    label={t(`stages.${stage.id}`)}
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
            <span>{t("sides.nonLoop")}</span>
            <span>{t("sides.devLoop")}</span>
          </div>
        </div>
      </div>
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
  retryStage?: RetryableStage
  retryPending: boolean
  onRetry?: () => void
}) {
  const t = useTranslations("pipeline")
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
        <TooltipContent>{t("widget.drivenAutomatically", { label })}</TooltipContent>
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
                aria-label={t("widget.retryButtonLabel", { stageId })}
                disabled={retryPending}
                className="size-4"
              >
                <RotateCcw className="size-3" />
              </Button>
            </AlertDialogTrigger>
          </TooltipTrigger>
          <TooltipContent>
            {retryPending ? t("widget.retryPendingTooltip") : t("widget.retryTooltip", { label })}
          </TooltipContent>
        </Tooltip>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("widget.retryDialogTitle", { label })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t(`widget.retryDialogDescription.${retryStage}`)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("widget.cancelButton")}</AlertDialogCancel>
            <AlertDialogAction onClick={onRetry}>{t("widget.confirmRetryButton")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
