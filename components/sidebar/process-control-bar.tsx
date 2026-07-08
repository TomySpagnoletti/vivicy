"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Download, Pause, Play, RotateCcw } from "lucide-react"
import { useTranslations } from "next-intl"
import { createTranslator } from "next-intl"
import { toast } from "sonner"

import {
  isResumable,
  resolveRunPhase,
  type RunPhase,
  type StatusResponse,
} from "@/lib/run-status"
import type { DevelopmentBlock } from "@/lib/types"
import { LOCALE } from "@/lib/i18n"
import { errorText } from "@/lib/i18n-errors"
import sidebarMessages from "@/messages/en/sidebar.json"
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

// Exported and pure so the tooltip copy is unit-tested without portal rendering.
// A standalone translator (not the useTranslations hook) since this runs outside
// component render — it reads the same sidebar.json ICU message the component uses.
const t = createTranslator({ locale: LOCALE, messages: sidebarMessages, namespace: "processControl" })
export function extractedGateMessage(issueCount: number): string {
  return t("extractedGateMessage", { count: issueCount })
}

const PHASE_DOT: Record<RunPhase, string> = {
  idle: "bg-muted-foreground",
  running: "bg-primary",
  done: "bg-primary",
  blocked: "bg-destructive",
  stalled: "bg-destructive",
}

export function ProcessControlBar({
  development,
  onMapRefresh,
}: {
  development?: DevelopmentBlock
  onMapRefresh?: () => void
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [streamError, setStreamError] = useState(false)
  const [pending, setPending] = useState<Action | null>(null)

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

  const t = useTranslations("sidebar.processControl")
  const tErrors = useTranslations("errors")
  const PHASE_LABEL: Record<RunPhase, string> = {
    idle: t("phaseIdle"),
    running: t("phaseRunning"),
    done: t("phaseDone"),
    blocked: t("phaseBlocked"),
    stalled: t("phaseStalled"),
  }

  const phase: RunPhase = status ? resolveRunPhase(status) : "idle"
  const running = phase === "running" || phase === "stalled"
  // Resume is offered only when stopped part-way; a completed run shows Run so
  // the loop can be re-launched.
  const resumable = status ? isResumable(status) : false
  const total = status?.issues_total ?? 0
  const done = status?.issues_done ?? 0
  const percent = total > 0 ? Math.round((done / total) * 100) : 0

  // Extraction is one-shot: once the map's development.issues is non-empty,
  // re-extraction isn't available, so Extract is greyed out and explains why.
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
          code?: string
          steps?: Array<{ name: string; code: number | null; lastLine: string }>
        }
        if (!res.ok || body.ok === false) {
          const fallback = body.error ?? t("toastFailedHttpDescription", { status: res.status })
          toast.error(t("toastFailedTitle", { label }), {
            description: body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback,
          })
          return
        }
        if (action === "extract" && body.steps) {
          const failed = body.steps.filter((s) => s.code !== 0)
          if (failed.length > 0) {
            toast.warning(t("toastExtractionIssuesTitle"), {
              description: failed.map((s) => `${s.name}: exit ${s.code}`).join(", "),
            })
          } else {
            toast.success(t("toastExtractionSuccessTitle"), {
              description: body.steps.map((s) => s.name).join(" -> "),
            })
          }
          onMapRefreshRef.current?.()
        } else {
          toast.success(t("toastOkTitle", { label }))
        }
      } catch (error) {
        toast.error(t("toastFailedTitle", { label }), {
          description: error instanceof Error ? error.message : t("networkError"),
        })
      } finally {
        setPending(null)
      }
    },
    [t, tErrors]
  )

  return (
    <div className="flex flex-col gap-1.5 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="gap-1.5" aria-label={t("statusAriaLabel", { phase: PHASE_LABEL[phase] })}>
          <span aria-hidden className={`size-1.5 rounded-full ${PHASE_DOT[phase]}`} />
          {streamError ? t("offline") : PHASE_LABEL[phase]}
        </Badge>

        <div className="flex items-center gap-1">
          {running ? (
            <StopControl
              pending={pending === "stop"}
              disabled={pending !== null}
              onConfirm={() => act("stop", "/api/control/stop", t("stop"))}
            />
          ) : resumable ? (
            <IconControl
              label={t("resume")}
              icon={<RotateCcw />}
              pending={pending === "resume"}
              disabled={pending !== null}
              onClick={() => act("resume", "/api/control/resume", t("resume"))}
            />
          ) : (
            <IconControl
              label={t("run")}
              icon={<Play />}
              pending={pending === "start"}
              disabled={pending !== null}
              onClick={() => act("start", "/api/control/start", t("run"))}
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
                  aria-label={t("extract")}
                  aria-disabled
                  className="opacity-50"
                  onClick={(event) => event.preventDefault()}
                >
                  <Download />
                  {t("extract")}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{extractedGateMessage(issueCount)}</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending !== null}
              aria-label={t("extract")}
              onClick={() => act("extract", "/api/control/extract", t("extract"))}
            >
              <Download />
              {t("extract")}
            </Button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Progress value={percent} className="flex-1" aria-label={t("issuesVerifiedAriaLabel")} />
        <span className="text-xs tabular-nums text-muted-foreground" aria-label={t("progressAriaLabel")}>
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
  const t = useTranslations("sidebar.processControl")
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
      <TooltipContent>{pending ? t("pendingLabel", { label }) : label}</TooltipContent>
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
  const t = useTranslations("sidebar.processControl")
  return (
    <AlertDialog>
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("stop")} disabled={disabled}>
              <Pause />
            </Button>
          </AlertDialogTrigger>
        </TooltipTrigger>
        <TooltipContent>{pending ? t("stopping") : t("stop")}</TooltipContent>
      </Tooltip>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("stopConfirmTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("stopConfirmDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("stopConfirmCancel")}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onConfirm}>
            {t("stopConfirmConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
