"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import type { ActiveCycle, CyclePhase, CyclesView, PastCycle } from "@/lib/cycles"
import type { CycleKind } from "@/lib/doc-prep-report"
import { resolveRunPhase, type RunStatus } from "@/lib/run-status"
import { cn } from "@/lib/utils"

interface CyclesResponse {
  ok?: boolean
  cycles?: CyclesView | null
}

const KIND_LABEL: Record<CycleKind, "kindProject" | "kindFeature"> = {
  project: "kindProject",
  feature: "kindFeature",
}

const PHASE_LABEL: Record<CyclePhase, "phaseEditable" | "phaseFrozen" | "phaseBuilding" | "phaseDone"> = {
  editable: "phaseEditable",
  frozen: "phaseFrozen",
  building: "phaseBuilding",
  done: "phaseDone",
}

const PHASE_BADGE: Record<CyclePhase, "outline" | "secondary" | "default"> = {
  editable: "secondary",
  frozen: "outline",
  building: "secondary",
  done: "default",
}

function cyclePhase(active: ActiveCycle, status: RunStatus | null): CyclePhase {
  if (active.editable) return "editable"
  if (!status) return "frozen"
  const phase = resolveRunPhase(status)
  if (phase === "done") return "done"
  if (phase === "running" || phase === "stalled" || phase === "blocked") return "building"
  return status.issues_done > 0 ? "building" : "frozen"
}

export function SectionCycles() {
  const [cycles, setCycles] = useState<CyclesView | null>(null)
  const [status, setStatus] = useState<RunStatus | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadCycles = async () => {
      try {
        const res = await fetch("/api/control/cycles", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as CyclesResponse
        if (!cancelled && res.ok && body.ok !== false) setCycles(body.cycles ?? null)
      } catch {
      }
    }
    void loadCycles()

    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as RunStatus & { error?: string }
        if (next.error) return
        setStatus(next)
        void loadCycles()
      } catch {
      }
    }
    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  const t = useTranslations("sidebar.cycles")
  const active = cycles?.active ?? null
  const history = cycles?.history ?? []

  if (!active && history.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("emptyState")}</p>
  }

  return (
    <div className="flex flex-col gap-3 text-xs">
      {active ? <ActiveCycleCard active={active} status={status} /> : null}
      <HistoryList history={history} />
    </div>
  )
}

function ActiveCycleCard({ active, status }: { active: ActiveCycle; status: RunStatus | null }) {
  const t = useTranslations("sidebar.cycles")
  const phase = cyclePhase(active, status)
  const showSignal = phase === "building" || phase === "done"

  return (
    <div
      data-cycle="active"
      className="flex flex-col gap-2 rounded-md border border-status-verified/50 bg-card p-2.5"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("activeTitle")}
        </span>
        {active.kind ? (
          <Badge variant="secondary" className="ml-auto shrink-0">
            {t(KIND_LABEL[active.kind])}
          </Badge>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant={PHASE_BADGE[phase]}
          className={cn(phase === "done" && "bg-status-verified text-white")}
        >
          {t(PHASE_LABEL[phase])}
        </Badge>
        {active.editable && active.pending_batches > 0 ? (
          <span className="text-muted-foreground">
            {t("pendingBatches", { count: active.pending_batches })}
          </span>
        ) : null}
      </div>

      {active.id ? (
        <p className="font-mono break-all text-[11px] text-muted-foreground">{active.id}</p>
      ) : null}

      {showSignal && status ? (
        <dl className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
          <dd>{t("issuesVerified", { done: status.issues_done, total: status.issues_total || "?" })}</dd>
          {status.gates.fail > 0 ? <dd>{t("gatesFailing", { count: status.gates.fail })}</dd> : null}
        </dl>
      ) : null}
    </div>
  )
}

function HistoryList({ history }: { history: PastCycle[] }) {
  const t = useTranslations("sidebar.cycles")

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("historyTitle")}
      </span>
      {history.length === 0 ? (
        <p className="text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {history.map((cycle) => (
            <li
              key={cycle.baseline_id}
              data-cycle="history"
              className="flex flex-col gap-1 rounded-md border border-border bg-card p-2"
            >
              <div className="flex items-center gap-2">
                {cycle.kind ? (
                  <Badge variant="outline" className="shrink-0">
                    {t(KIND_LABEL[cycle.kind])}
                  </Badge>
                ) : null}
                <span className="font-mono break-all text-foreground">
                  {cycle.version ? `v${cycle.version}` : cycle.baseline_id}
                </span>
                <Badge
                  variant={cycle.superseded ? "outline" : "secondary"}
                  className="ml-auto shrink-0"
                >
                  {t(cycle.superseded ? "outcomeSuperseded" : "outcomeFrozen")}
                </Badge>
              </div>
              {cycle.closed_at ? (
                <span className="text-[11px] text-muted-foreground">
                  {t("closedAt", { date: cycle.closed_at.slice(0, 10) })}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
