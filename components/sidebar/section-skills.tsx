"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronRight, Search, ShieldAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { isSkillsPhaseInFlight, type InstalledSkill, type RejectedSkill, type SkillsReport } from "@/lib/skills-report"
import type { SkillUsage } from "@/lib/skill-usage"
import { errorText } from "@/lib/i18n-errors"
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

const POLL_INTERVAL_MS = 10_000

interface SkillsReportResponse {
  ok?: boolean
  report?: SkillsReport | null
  usage?: SkillUsage | null
  error?: string
}

export function SectionSkills() {
  const t = useTranslations("sidebar.skills")
  const tErrors = useTranslations("errors")
  const [report, setReport] = useState<SkillsReport | null>(null)
  const [usage, setUsage] = useState<SkillUsage | null>(null)
  const [starting, setStarting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/control/skills", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as SkillsReportResponse
      if (res.ok && body.ok !== false) {
        setReport(body.report ?? null)
        setUsage(body.usage ?? null)
      }
    } catch {
      // Never clear the last known report on a failed poll.
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  const findSkills = useCallback(async () => {
    setStarting(true)
    try {
      const res = await fetch("/api/control/skills", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; code?: string }
      if (!res.ok || body.ok === false) {
        const fallback = body.error ?? t("toastStartFailedHttpDescription", { status: res.status })
        toast.error(t("toastStartFailedTitle"), {
          description: body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback,
        })
        return
      }
      toast.success(t("toastStartSuccessTitle"), {
        description: t("toastStartSuccessDescription"),
      })
      void load()
    } catch (error) {
      toast.error(t("toastStartFailedTitle"), {
        description: error instanceof Error ? error.message : t("networkError"),
      })
    } finally {
      setStarting(false)
    }
  }, [load, t, tErrors])

  const installed = report?.installed ?? []
  const rejected = report?.rejected ?? []
  const inFlight = isSkillsPhaseInFlight(report?.phase)
  const busy = starting || inFlight

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        {/* min-w-0 + break-words, or a summary carrying one long skill id sets the flex item's min-content width and pushes the shrink-0 action off the panel. */}
        <span className="min-w-0 break-words text-muted-foreground">
          {inFlight ? t("stageInProgress", { phase: report?.phase ?? "" }) : (report?.summary ?? "")}
        </span>
        <AlertDialog open={confirmOpen} onOpenChange={(next) => setConfirmOpen(next && !busy)}>
          <AlertDialogTrigger asChild>
            <Button variant="outline" size="sm" aria-disabled={busy} className={cn("shrink-0", busy && "opacity-60")}>
              <Search aria-hidden />
              {t("findSkills")}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
              <AlertDialogAction onClick={() => void findSkills()}>{t("confirmConfirm")}</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {installed.length === 0 && !inFlight ? (
        <p className="text-muted-foreground">{t("emptyState")}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {installed.map((skill) => (
            <SkillCard key={skill.id} skill={skill} usage={usage} />
          ))}
        </ul>
      )}

      {rejected.length > 0 ? <RejectedList rejected={rejected} /> : null}
    </div>
  )
}

function SkillCard({ skill, usage }: { skill: InstalledSkill; usage: SkillUsage | null }) {
  const t = useTranslations("sidebar.skills")
  const count = usage?.applied.find((entry) => entry.id === skill.id)
  const issues = count?.issues ?? 0
  const applied = count?.applied ?? 0
  return (
    <li data-skill={skill.id} className="flex flex-col gap-1 rounded-md border border-border bg-card p-2">
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{skill.name}</span>
        <Badge className={cn("shrink-0 text-white", skill.official ? "bg-status-verified" : "bg-status-implemented")}>
          {skill.official ? t("official") : t("community")}
        </Badge>
      </div>
      <span className="font-mono break-all text-muted-foreground">{skill.id}</span>
      {issues > 0 ? (
        <span data-skill-usage={skill.id} className={applied > 0 ? "text-foreground" : "text-muted-foreground"}>
          {applied > 0 ? t("appliedOn", { count: applied, issues }) : t("notAppliedYet", { issues })}
        </span>
      ) : null}
      {skill.security_waived ? (
        <span className="flex items-center gap-1 text-status-implemented">
          <ShieldAlert className="size-3.5 shrink-0" aria-hidden />
          {t("securityWaived")}
        </span>
      ) : null}
    </li>
  )
}

function RejectedList({ rejected }: { rejected: RejectedSkill[] }) {
  const t = useTranslations("sidebar.skills")
  return (
    <Collapsible className="flex flex-col gap-1">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ChevronRight className="size-3 transition-transform [[data-state=open]>&]:rotate-90" aria-hidden />
          {t("rejectedCount", { count: rejected.length })}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 pl-4 text-muted-foreground">
          {rejected.map((entry) => (
            <li key={entry.id} data-rejected-skill={entry.id} className="break-words">
              <span className="font-mono">{entry.id}</span>
              {` — ${entry.reason}`}
              {entry.detail ? ` (${entry.detail})` : ""}
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  )
}
