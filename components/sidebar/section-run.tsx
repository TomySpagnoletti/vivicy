"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronRight, ExternalLink, Play, Square } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { ProductRunPhase, ProductRunView } from "@/lib/product-run"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

const POLL_INTERVAL_MS = 2500

const PHASE_DOT: Record<ProductRunPhase, string> = {
  not_established: "bg-muted-foreground",
  stopped: "bg-muted-foreground",
  running: "bg-primary",
  exited: "bg-destructive",
}

interface RunResponse {
  ok?: boolean
  run?: ProductRunView | null
  error?: string
}

export function SectionRun() {
  const t = useTranslations("sidebar.run")
  const [run, setRun] = useState<ProductRunView | null>(null)
  const [offline, setOffline] = useState(false)
  const [pending, setPending] = useState<"start" | "stop" | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/control/run", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as RunResponse
      if (res.ok && body.ok !== false && body.run) {
        setRun(body.run)
        setOffline(false)
      } else {
        setOffline(true)
      }
    } catch {
      setOffline(true)
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  const act = useCallback(
    async (action: "start" | "stop", endpoint: string, label: string) => {
      setPending(action)
      try {
        const res = await fetch(endpoint, { method: "POST" })
        const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string }
        if (!res.ok || body.ok === false) {
          toast.error(t("toastFailedTitle", { label }), {
            description: body.error ?? t("toastFailedHttpDescription", { status: res.status }),
          })
          return
        }
        toast.success(action === "start" ? t("toastStartedTitle") : t("toastStoppedTitle"))
        await load()
      } catch (error) {
        toast.error(t("toastFailedTitle", { label }), {
          description: error instanceof Error ? error.message : t("networkError"),
        })
      } finally {
        setPending(null)
      }
    },
    [load, t]
  )

  const phase: ProductRunPhase = run?.phase ?? "not_established"

  if (phase === "not_established") {
    return <p className="text-xs text-muted-foreground">{t("notEstablished")}</p>
  }

  const PHASE_LABEL: Record<Exclude<ProductRunPhase, "not_established">, string> = {
    stopped: t("phaseStopped"),
    running: t("phaseRunning"),
    exited: t("phaseExited"),
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <Badge variant="outline" className="gap-1.5" aria-label={t("statusAriaLabel", { phase: PHASE_LABEL[phase] })}>
          <span aria-hidden className={`size-1.5 rounded-full ${PHASE_DOT[phase]}`} />
          {offline ? t("offline") : PHASE_LABEL[phase]}
        </Badge>

        {phase === "running" ? (
          <Button
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => void act("stop", "/api/control/run/stop", t("stop"))}
          >
            <Square aria-hidden />
            {pending === "stop" ? t("stopping") : t("stop")}
          </Button>
        ) : (
          <Button size="sm" disabled={pending !== null} onClick={() => void act("start", "/api/control/run/start", t("run"))}>
            <Play aria-hidden />
            {pending === "start" ? t("starting") : t("run")}
          </Button>
        )}
      </div>

      {phase === "stopped" ? <p className="text-muted-foreground">{t("stoppedHint")}</p> : null}

      {phase === "exited" ? <p className="font-medium text-destructive">{t("exitedTitle")}</p> : null}

      {phase === "running" ? (
        <>
          <UrlBlock run={run!} />
          {run!.started_at ? (
            <span className="text-[11px] text-muted-foreground">{t("startedAt", { time: formatStartTime(run!.started_at) })}</span>
          ) : null}
        </>
      ) : null}

      {run?.command ? (
        <div className="flex flex-col gap-0.5">
          <span className="font-medium tracking-wide text-muted-foreground uppercase">{t("commandLabel")}</span>
          <code className="rounded bg-muted px-1.5 py-1 font-mono break-all text-foreground">{run.command}</code>
        </div>
      ) : null}

      {run?.log_tail ? <LogBlock key={phase} tail={run.log_tail} defaultOpen={phase === "exited"} /> : null}
    </div>
  )
}

function formatStartTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function UrlBlock({ run }: { run: ProductRunView }) {
  const t = useTranslations("sidebar.run")
  if (!run.url) {
    return <p className="text-muted-foreground">{t("noUrl")}</p>
  }
  return (
    <div className="flex flex-col gap-1">
      <Button asChild variant="outline" size="sm" className="justify-start">
        <a href={run.url} target="_blank" rel="noreferrer">
          <ExternalLink aria-hidden />
          <span className="min-w-0 flex-1 truncate text-left font-mono">{run.url}</span>
        </a>
      </Button>
      <span className="sr-only">{t("openUrl")}</span>
      {run.url_source === "command" ? <span className="text-[11px] text-muted-foreground">{t("urlGuessNote")}</span> : null}
    </div>
  )
}

function LogBlock({ tail, defaultOpen }: { tail: string; defaultOpen?: boolean }) {
  const t = useTranslations("sidebar.run")
  return (
    <Collapsible defaultOpen={defaultOpen} className="flex flex-col gap-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-3 transition-transform [[data-state=open]>&]:rotate-90" aria-hidden />
          {t("logLabel")}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="max-h-48 overflow-auto rounded-md border border-border bg-muted/40 p-2 font-mono text-[11px] leading-relaxed break-words whitespace-pre-wrap text-muted-foreground">
          {tail}
        </pre>
      </CollapsibleContent>
    </Collapsible>
  )
}
