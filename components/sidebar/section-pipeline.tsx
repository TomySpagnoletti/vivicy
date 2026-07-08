"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"

import {
  deriveStageStates,
  MARKER_GLYPH,
  PIPELINE_STAGES,
  type ExtractionStatusLike,
  type StageState,
} from "@/components/pipeline/pipeline-stages"
import { Badge } from "@/components/ui/badge"
import type { RunStatus } from "@/lib/run-status"
import type { SkillsReport } from "@/lib/skills-report"
import { cn } from "@/lib/utils"

const STATE_BADGE_VARIANT: Record<StageState, "outline" | "secondary" | "default" | "destructive"> = {
  pending: "outline",
  running: "secondary",
  green: "default",
  red: "destructive",
}

const STATE_LABEL_KEY: Record<StageState, "statePending" | "stateRunning" | "stateDone" | "stateBlocked"> = {
  pending: "statePending",
  running: "stateRunning",
  green: "stateDone",
  red: "stateBlocked",
}

interface ExtractStatusResponse {
  ok?: boolean
  status?: ExtractionStatusLike | null
}

interface SkillsReportResponse {
  ok?: boolean
  report?: SkillsReport | null
}

/**
 * G8's "full process view": the complete S0–S12 state, one row per stage, with
 * the last status line and timestamp when the extraction orchestrator recorded
 * one. Subscribes to the same SSE status stream + extraction poll the
 * PipelineWidget does (each surface owns its own subscription — the same
 * pattern ProcessControlBar already uses — rather than threading live status
 * through props from page.tsx). Read-honest: a stage with no observed data
 * shows only its pending badge, never a fabricated timestamp or summary.
 */
export function SectionPipeline() {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [extraction, setExtraction] = useState<ExtractionStatusLike | null>(null)
  const [skills, setSkills] = useState<SkillsReport | null>(null)

  useEffect(() => {
    let cancelled = false
    const loadReports = async () => {
      try {
        const res = await fetch("/api/control/extract", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as ExtractStatusResponse
        if (!cancelled && res.ok && body.ok !== false) setExtraction(body.status ?? null)
      } catch {
        // Best-effort: leave the last known extraction status in place.
      }
      try {
        const res = await fetch("/api/control/skills", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as SkillsReportResponse
        if (!cancelled && res.ok && body.ok !== false) setSkills(body.report ?? null)
      } catch {
        // Best-effort: leave the last known skills report in place.
      }
    }
    void (async () => {
      await loadReports()
    })()

    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as RunStatus & { error?: string }
        if (next.error) return
        setStatus(next)
        void loadReports()
      } catch {
        // A malformed frame just keeps the last known status.
      }
    }
    return () => {
      cancelled = true
      source.close()
    }
  }, [])

  const t = useTranslations("sidebar.pipeline")
  const tPipeline = useTranslations("pipeline")
  const states = deriveStageStates(status, extraction, skills)

  return (
    <ul className="flex flex-col gap-2 text-xs">
      {PIPELINE_STAGES.map((stage) => (
        <li
          key={stage.id}
          data-stage={stage.id}
          className="flex flex-col gap-1 rounded-md border border-border bg-card p-2"
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono font-semibold text-foreground">{stage.id}</span>
            <span aria-hidden>{MARKER_GLYPH[stage.marker]}</span>
            <span className="min-w-0 flex-1 truncate text-foreground">
              {tPipeline(`stages.${stage.id}`)}
            </span>
            <Badge
              variant={STATE_BADGE_VARIANT[states[stage.id]]}
              className={cn(states[stage.id] === "green" && "bg-status-verified text-white")}
            >
              {t(STATE_LABEL_KEY[states[stage.id]])}
            </Badge>
          </div>
          <StageEvidence stageId={stage.id} extraction={extraction} skills={skills} status={status} />
        </li>
      ))}
    </ul>
  )
}

/** Evidence pointers as plain text — only what actually exists on the read
 *  models, never a placeholder. S2–S6 read from the extraction status file
 *  (phase/summary/updated_at); SK reads the skills report the same way;
 *  S7–S12 read from the dev-status gate counts. */
function StageEvidence({
  stageId,
  extraction,
  skills,
  status,
}: {
  stageId: string
  extraction: ExtractionStatusLike | null
  skills: SkillsReport | null
  status: RunStatus | null
}) {
  const t = useTranslations("sidebar.pipeline")
  const lines: string[] = []

  if (["S2", "S3", "S4", "S5", "S6"].includes(stageId) && extraction) {
    if (extraction.phase) lines.push(t("phaseEvidence", { phase: extraction.phase }))
    if (typeof extraction.summary === "string" && extraction.summary) lines.push(extraction.summary)
    if (typeof extraction.updated_at === "string") lines.push(extraction.updated_at)
  }

  if (stageId === "SK" && skills) {
    if (skills.phase) lines.push(t("phaseEvidence", { phase: skills.phase }))
    if (typeof skills.summary === "string" && skills.summary) lines.push(skills.summary)
    if (typeof skills.updated_at === "string") lines.push(skills.updated_at)
  }

  if (stageId === "S9" && status) {
    lines.push(t("issuesVerified", { done: status.issues_done, total: status.issues_total || "?" }))
    if (status.gates.fail > 0) lines.push(t("gatesFailing", { count: status.gates.fail }))
  }

  if (lines.length === 0) return null

  return (
    <dl className="flex flex-col gap-0.5 pl-6 text-[11px] text-muted-foreground">
      {lines.map((line, i) => (
        <dd key={i} className="break-words">
          {line}
        </dd>
      ))}
    </dl>
  )
}
