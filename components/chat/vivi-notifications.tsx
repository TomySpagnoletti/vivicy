"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  Check,
  CircleAlert,
  CircleCheck,
  GitPullRequestArrow,
  Info,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { errorText, notificationText } from "@/lib/i18n-errors"
import type { Notification } from "@/lib/notifications"
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
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { NonnaIcon } from "@/components/chat/nonna-icon"

const POLL_INTERVAL_MS = 10_000

const LEVEL_ICON: Record<string, React.ReactNode> = {
  error: <CircleAlert className="size-3.5 text-destructive" />,
  warning: <TriangleAlert className="size-3.5 text-warning" />,
  warn: <TriangleAlert className="size-3.5 text-warning" />,
  success: <CircleCheck className="size-3.5 text-primary" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
}

/** Sole visible-list filter; badge counts reuse it too, so it must stay the one source of truth. */
export function visibleNotifications(notifications: Notification[]): Notification[] {
  return notifications
    .filter((n) => !n.dismissed)
    .slice()
    .reverse()
}

/** Always runs, panel open or closed, so the closed-panel launcher badge stays live; CRs ride the same reload triggers as notifications so neither goes stale behind the other. */
export function useNotificationsFeed(): {
  notifications: Notification[]
  crs: ChangeRequestSummary[]
  reload: () => Promise<void>
} {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [crs, setCrs] = useState<ChangeRequestSummary[]>([])
  const mountedRef = useRef(true)
  const lastSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    const [nextNotifications, nextCrs] = await Promise.all([
      fetchNotifications(),
      fetchCrs(),
    ])
    if (!mountedRef.current) return
    if (nextNotifications) setNotifications(nextNotifications)
    if (nextCrs) setCrs(nextCrs)
  }, [])

  useEffect(() => {
    // IIFE keeps the setState out of the effect body itself (cascading-render lint); the interval callback below is deferred the same way.
    void (async () => {
      await load()
    })()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    lastSignatureRef.current = null
    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as {
          error?: string
          issues_done?: number
          issues_total?: number
          gates?: { fail?: number }
          run_active?: boolean
        }
        if (next.error) return
        const signature = `${next.issues_done}/${next.issues_total}:${next.gates?.fail ?? 0}:${next.run_active}`
        if (lastSignatureRef.current !== null && lastSignatureRef.current !== signature) {
          void load()
        }
        lastSignatureRef.current = signature
      } catch {
      }
    }
    return () => source.close()
  }, [load])

  return { notifications, crs, reload: load }
}

async function fetchNotifications(): Promise<Notification[] | null> {
  try {
    const res = await fetch("/api/control/notifications", { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      notifications?: Notification[]
    }
    if (Array.isArray(body.notifications)) return body.notifications
  } catch {
  }
  return null
}

async function fetchCrs(): Promise<ChangeRequestSummary[] | null> {
  try {
    const res = await fetch("/api/control/crs", { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      crs?: ChangeRequestSummary[]
    }
    if (body.ok && Array.isArray(body.crs)) return body.crs
  } catch {
  }
  return null
}

export function NotificationsFeed({
  notifications,
  crs,
  onReload,
  onAskVivi,
  onDecided,
}: {
  notifications: Notification[]
  crs: ChangeRequestSummary[]
  onReload: () => void
  onAskVivi: (text: string) => void
  onDecided?: () => void
}) {
  const t = useTranslations("notifications")
  const [pending, setPending] = useState<string | "all" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = visibleNotifications(notifications)

  const post = useCallback(
    async (key: string | "all", body: Record<string, unknown>) => {
      setPending(key)
      setError(null)
      try {
        const res = await fetch("/api/control/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) {
          setError(t("updateFailed"))
          return
        }
        onReload()
      } catch {
        setError(t("updateFailed"))
      } finally {
        setPending(null)
      }
    },
    [onReload, t]
  )

  const dismiss = useCallback((id: string) => post(id, { id }), [post])
  const clearAll = useCallback(() => post("all", { all: true }), [post])

  return (
    <div className="flex flex-col gap-3 p-4">
      <CrReviewCards
        crs={crs}
        onReload={onReload}
        onDecided={() => onDecided?.()}
      />

      {error ? (
        <Marker role="status" className="text-destructive">
          <MarkerIcon>
            <CircleAlert />
          </MarkerIcon>
          <MarkerContent>{error}</MarkerContent>
        </Marker>
      ) : null}

      {visible.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col gap-2">
            {/* `id` is the writer-guaranteed key; the ts/index fallback only covers legacy log lines from before the id field existed. */}
            {visible.map((n, i) => {
              const key = n.id ?? n.ts ?? String(i)
              const dismissRef = n.id ?? n.ts
              return (
                <NotificationRow
                  key={key}
                  notification={n}
                  pending={pending === dismissRef}
                  onDismiss={dismissRef ? () => void dismiss(dismissRef) : undefined}
                  onAskVivi={onAskVivi}
                />
              )
            })}
          </ul>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={pending !== null} className="self-end">
                {pending === "all" ? t("clearing") : t("clearAll")}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>{t("clearAllDialogTitle")}</AlertDialogTitle>
                <AlertDialogDescription>{t("clearAllDialogDescription")}</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                <AlertDialogAction onClick={() => void clearAll()}>{t("clearAll")}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  )
}

function NotificationRow({
  notification,
  pending,
  onDismiss,
  onAskVivi,
}: {
  notification: Notification
  pending: boolean
  onDismiss?: () => void
  onAskVivi: (text: string) => void
}) {
  const t = useTranslations("notifications")
  const text = notificationText(t, notification.stage, notification.event, notification.message)
  return (
    <li
      className={cn(
        "flex flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 text-xs",
        notification.level === "error" && "border-destructive/40"
      )}
    >
      <div className="flex items-center gap-1.5">
        {LEVEL_ICON[notification.level ?? "info"] ?? LEVEL_ICON.info}
        {notification.stage ? (
          <Badge variant="secondary" className="shrink-0">
            {notification.stage}
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {relativeTime(notification.ts, t)}
        </span>
        {onDismiss ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("dismissAriaLabel")}
            disabled={pending}
            onClick={onDismiss}
            className="size-5 shrink-0"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      <p className="break-words text-foreground">{text}</p>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => onAskVivi(text)}
        className="self-start text-muted-foreground hover:text-foreground"
      >
        <NonnaIcon className="size-4" />
        {t("askVivi")}
      </Button>
    </li>
  )
}

export function relativeTime(ts: string | undefined, t: ReturnType<typeof useTranslations<"notifications">>): string {
  if (!ts) return t("relativeTime.unknown")
  const then = Date.parse(ts)
  if (Number.isNaN(then)) return ts
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (deltaSeconds < 45) return t("relativeTime.justNow")
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return t("relativeTime.minutesAgo", { minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t("relativeTime.hoursAgo", { hours })
  const days = Math.floor(hours / 24)
  return t("relativeTime.daysAgo", { days })
}

interface ChangeRequestSummary {
  id: string
  title: string
  status: string
  classification: string
  created_at: string | null
  source: string | null
}

/** The only statuses shown with Approve/Reject; a decided CR drops out here and surfaces as a notification instead. */
const PENDING_STATUSES = new Set(["idea", "under_review"])

/** CRs still awaiting a decision — shared so the launcher badge, tab badge, and CR cards all count the same set. */
export function pendingCrs(crs: ChangeRequestSummary[]): ChangeRequestSummary[] {
  return crs.filter((cr) => PENDING_STATUSES.has(cr.status))
}

interface DecisionOutcome {
  ok: boolean
  text: string
}

/** Approving a CR runs the server-side docs_applied chain (apply → re-freeze → re-extract) — not visible from this file alone. Both approve and reject require a confirm click since both are sensitive and irreversible. */
function CrReviewCards({
  crs,
  onReload,
  onDecided,
}: {
  crs: ChangeRequestSummary[]
  onReload: () => void
  onDecided: () => void
}) {
  const t = useTranslations("crs")
  const tErrors = useTranslations("errors")
  const [deciding, setDeciding] = useState<string | null>(null)
  const [outcomes, setOutcomes] = useState<Record<string, DecisionOutcome>>({})

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
          const fallback = body.summary ?? body.error ?? `HTTP ${res.status}`
          const text =
            !body.summary && body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback
          setOutcomes((prev) => ({
            ...prev,
            [id]: {
              ok: false,
              text:
                decision === "approved"
                  ? `${t("approveBlockedToastTitle", { id })} — ${text}`
                  : `${t("decisionFailedToastTitle", { id })} — ${text}`,
            },
          }))
        } else {
          const title = decision === "approved" ? t("approvedToastTitle", { id }) : t("rejectedToastTitle", { id })
          setOutcomes((prev) => ({
            ...prev,
            [id]: { ok: true, text: body.summary ? `${title} — ${body.summary}` : title },
          }))
        }
      } catch (error) {
        setOutcomes((prev) => ({
          ...prev,
          [id]: {
            ok: false,
            text: `${t("decisionFailedToastTitle", { id })} — ${error instanceof Error ? error.message : t("networkError")}`,
          },
        }))
      } finally {
        setDeciding(null)
        onReload()
        onDecided()
      }
    },
    [onReload, onDecided, t, tErrors]
  )

  const shown = crs.filter((cr) => PENDING_STATUSES.has(cr.status) || outcomes[cr.id])
  if (shown.length === 0) return null

  return (
    <div className="flex flex-col gap-2 border-b border-border pb-3">
      <div className="flex items-center gap-1.5">
        <GitPullRequestArrow className="size-3.5 text-primary" aria-hidden />
        <span className="text-xs font-medium text-foreground">{t("sectionTitle")}</span>
        <Badge variant="secondary" className="ml-auto">
          {shown.filter((cr) => !outcomes[cr.id]).length}
        </Badge>
      </div>
      {shown.map((cr) => {
        const outcome = outcomes[cr.id]
        return (
          <Card key={cr.id} className="gap-3 [--card-spacing:--spacing(3)]" data-cr-id={cr.id}>
            <CardHeader className="gap-1.5">
              <CardDescription className="flex items-center gap-1.5">
                <Badge variant="outline" className="shrink-0 font-mono">
                  {cr.id}
                </Badge>
                <Badge variant="secondary" className="shrink-0">
                  {cr.classification}
                </Badge>
                {cr.created_at ? (
                  <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                    {cr.created_at}
                  </span>
                ) : null}
              </CardDescription>
              <CardTitle className="text-xs/relaxed break-words">{cr.title}</CardTitle>
            </CardHeader>
            <CardFooter className="flex-col items-start gap-2">
              <div className="flex items-center gap-1.5">
                <ConfirmDecision
                  id={cr.id}
                  decision="approved"
                  busy={deciding === cr.id}
                  disabled={deciding !== null || outcome !== undefined}
                  onConfirm={() => void decide(cr.id, "approved")}
                />
                <ConfirmDecision
                  id={cr.id}
                  decision="rejected"
                  busy={deciding === cr.id}
                  disabled={deciding !== null || outcome !== undefined}
                  onConfirm={() => void decide(cr.id, "rejected")}
                />
              </div>
              {outcome ? (
                <Marker role="status" className={cn(!outcome.ok && "text-destructive")}>
                  <MarkerIcon>{outcome.ok ? <Check /> : <CircleAlert />}</MarkerIcon>
                  <MarkerContent>{outcome.text}</MarkerContent>
                </Marker>
              ) : null}
            </CardFooter>
          </Card>
        )
      })}
    </div>
  )
}

function ConfirmDecision({
  id,
  decision,
  busy,
  disabled,
  onConfirm,
}: {
  id: string
  decision: "approved" | "rejected"
  busy: boolean
  disabled: boolean
  onConfirm: () => void
}) {
  const t = useTranslations("crs")
  const approve = decision === "approved"
  // aria-disabled + guarded open, never native `disabled`: AlertDialog returns focus to its trigger on close, and a natively-disabled trigger can't receive it — focus would drop to <body> after every decision.
  const [dialogOpen, setDialogOpen] = useState(false)
  return (
    <AlertDialog open={dialogOpen} onOpenChange={(next) => setDialogOpen(next && !disabled)}>
      <AlertDialogTrigger asChild>
        <Button
          variant={approve ? "default" : "destructive"}
          size="xs"
          aria-disabled={disabled}
          className={disabled ? "opacity-60" : undefined}
        >
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
