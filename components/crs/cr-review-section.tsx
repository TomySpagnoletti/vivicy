"use client"

import { useCallback, useEffect, useState } from "react"
import { GitPullRequestArrow, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

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
import { errorText } from "@/lib/i18n-errors"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"

/** One change-request row from GET /api/control/crs (read-only projection). */
interface ChangeRequestSummary {
  id: string
  title: string
  status: string
  classification: string
  created_at: string | null
  source: string | null
}

/** Statuses that still await the owner decision — the only ones we surface with
 *  Approve/Reject. Decided CRs drop off the list (their outcome is a notification). */
const PENDING_STATUSES = new Set(["idea", "under_review"])

/**
 * The owner's single legitimate human touchpoint (P2/B8.2): agent-submitted change
 * requests, surfaced for approval right in the notification block. Approving runs the
 * docs_applied chain (apply → re-freeze → re-extract) server-side; rejecting closes the
 * CR. Both are sensitive, so both confirm. Reachable in ANY app state because it lives
 * in the always-available notification center, not the map-gated sidebar.
 */
export function CrReviewSection({ reloadSignal, onDecided }: { reloadSignal?: unknown; onDecided?: () => void }) {
  const t = useTranslations("crs")
  const tErrors = useTranslations("errors")
  const [crs, setCrs] = useState<ChangeRequestSummary[]>([])
  const [deciding, setDeciding] = useState<string | null>(null)

  const load = useCallback(async (): Promise<ChangeRequestSummary[] | null> => {
    try {
      const res = await fetch("/api/control/crs", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; crs?: ChangeRequestSummary[] }
      if (body.ok && Array.isArray(body.crs)) return body.crs
    } catch {
      // Non-fatal: the CR section just stays empty if the registry can't be read.
    }
    return null
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const next = await load()
      if (!cancelled && next) setCrs(next)
    })()
    return () => {
      cancelled = true
    }
  }, [load, reloadSignal])

  const decide = useCallback(
    async (id: string, decision: "approved" | "rejected") => {
      setDeciding(id)
      try {
        const res = await fetch("/api/control/crs/decide", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, decision }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          summary?: string
          error?: string
          code?: string
        }
        if (!res.ok || body.ok === false) {
          // An approval whose apply chain stayed red is honest news, not a silent pass.
          const title =
            decision === "approved"
              ? t("approveBlockedToastTitle", { id })
              : t("decisionFailedToastTitle", { id })
          const fallback = body.summary ?? body.error ?? `HTTP ${res.status}`
          toast.error(title, {
            description:
              !body.summary && body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback,
          })
        } else {
          const title = decision === "approved" ? t("approvedToastTitle", { id }) : t("rejectedToastTitle", { id })
          toast.success(title, { description: body.summary })
        }
      } catch (error) {
        toast.error(t("decisionFailedToastTitle", { id }), {
          description: error instanceof Error ? error.message : t("networkError"),
        })
      } finally {
        setDeciding(null)
        const next = await load()
        if (next) setCrs(next)
        onDecided?.()
      }
    },
    [load, onDecided, t, tErrors]
  )

  const pending = crs.filter((cr) => PENDING_STATUSES.has(cr.status))
  if (pending.length === 0) return null

  return (
    <div className="border-b border-border px-4 py-3">
      <div className="mb-2 flex items-center gap-1.5">
        <GitPullRequestArrow className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium text-foreground">{t("sectionTitle")}</span>
        <Badge variant="secondary" className="ml-auto">
          {pending.length}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">
        {pending.map((cr) => (
          <li key={cr.id} className="flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-xs">
            <div className="flex items-center gap-1.5">
              <Badge variant="outline" className="shrink-0 font-mono">
                {cr.id}
              </Badge>
              <Badge variant="secondary" className="shrink-0">
                {cr.classification}
              </Badge>
              {cr.source ? (
                <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                  {t("via", { source: cr.source })}
                </span>
              ) : null}
            </div>
            <p className="break-words text-foreground">{cr.title}</p>
            <div className="flex items-center gap-1.5">
              <ConfirmDecision
                id={cr.id}
                decision="approved"
                busy={deciding === cr.id}
                onConfirm={() => void decide(cr.id, "approved")}
              />
              <ConfirmDecision
                id={cr.id}
                decision="rejected"
                busy={deciding === cr.id}
                onConfirm={() => void decide(cr.id, "rejected")}
              />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ConfirmDecision({
  id,
  decision,
  busy,
  onConfirm,
}: {
  id: string
  decision: "approved" | "rejected"
  busy: boolean
  onConfirm: () => void
}) {
  const t = useTranslations("crs")
  const approve = decision === "approved"
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant={approve ? "default" : "outline"} size="xs" disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : null}
          {approve ? t("approve") : t("reject")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {approve ? t("approveDialogTitle", { id }) : t("rejectDialogTitle", { id })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {approve ? t("approveDialogDescription") : t("rejectDialogDescription")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{approve ? t("approve") : t("reject")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
