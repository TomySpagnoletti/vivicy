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

/** Level → icon/color, all theme tokens (`--warning` carries the amber warn hue). */
const LEVEL_ICON: Record<string, React.ReactNode> = {
  error: <CircleAlert className="size-3.5 text-destructive" />,
  warning: <TriangleAlert className="size-3.5 text-warning" />,
  warn: <TriangleAlert className="size-3.5 text-warning" />,
  success: <CircleCheck className="size-3.5 text-primary" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
}

/** Un-dismissed notifications, newest first — the sole visible-list rule so the
 *  tab's unread badge and the feed's list can never disagree. */
export function visibleNotifications(notifications: Notification[]): Notification[] {
  return notifications
    .filter((n) => !n.dismissed)
    .slice()
    .reverse()
}

/**
 * The notification + change-request data feed behind the panel (W5, D3 — the
 * bell/center are retired; the panel is the ONLY notification surface). It runs
 * ALWAYS, panel open or closed, so the launcher bubble can carry a closed-panel
 * attention badge (the retired bell's always-visible unread signal): an initial
 * fetch, a 10s poll (the fallback for app-side emissions the dev-status frame
 * cannot reflect — upload verify/apply, CR decisions), and an immediate refetch
 * when the SSE dev-status signature changes (issues done/total, gate failures,
 * run liveness, P9). Pending change requests ride the SAME triggers so the CR
 * cards and their count never go stale behind the notifications feed. Owning its
 * own EventSource mirrors the control bar / pipeline widget pattern: each surface
 * subscribes independently.
 */
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
    // The IIFE keeps the setState off the synchronous effect body (the linted
    // cascading-render path); the poll's callback is already deferred.
    void (async () => {
      await load()
    })()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    // Each (re)subscription records its own first frame before reacting, so a
    // remount never refetches off a stale signature from the previous stream.
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
        // A malformed frame never breaks the feed; the poll still covers it.
      }
    }
    return () => source.close()
  }, [load])

  return { notifications, crs, reload: load }
}

/** GET the notification log; null on any failure so the caller keeps its last list. */
async function fetchNotifications(): Promise<Notification[] | null> {
  try {
    const res = await fetch("/api/control/notifications", { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      notifications?: Notification[]
    }
    if (Array.isArray(body.notifications)) return body.notifications
  } catch {
    // Best-effort: a transient failure leaves the last known list in place.
  }
  return null
}

/** GET the change-request projection; null on any failure (keep the last list). */
async function fetchCrs(): Promise<ChangeRequestSummary[] | null> {
  try {
    const res = await fetch("/api/control/crs", { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      crs?: ChangeRequestSummary[]
    }
    if (body.ok && Array.isArray(body.crs)) return body.crs
  } catch {
    // Non-fatal: the CR section just stays as-is if the registry can't be read.
  }
  return null
}

/**
 * The Notifications tab content (W5): pending change requests first (the owner's
 * one human touchpoint, P2), then the deterministic notification feed —
 * newest-first, per-level icon, `notificationText` translation with raw-message
 * fallback, relative time, per-item dismiss and a confirmed "Clear all". Every
 * dismiss/clear POSTs to /api/control/notifications and re-fetches (single
 * source of truth: the server log, never a client-only hide). Each row offers a
 * compact "Ask Vivi" that hands the displayed text to the Chat tab's composer —
 * the USER presses send.
 */
export function NotificationsFeed({
  notifications,
  crs,
  onReload,
  onAskVivi,
  onDecided,
}: {
  notifications: Notification[]
  /** Pending change requests from the shared feed hook (P2 touchpoint). */
  crs: ChangeRequestSummary[]
  /** Re-fetch the feed (notifications + CRs) after a dismiss/clear/CR decision. */
  onReload: () => void
  /** Switch to the Chat tab with the composer pre-filled about this text. */
  onAskVivi: (text: string) => void
  /** Fires after a CR decision recorded (the apply chain may have changed state). */
  onDecided?: () => void
}) {
  const t = useTranslations("notifications")
  const [pending, setPending] = useState<string | "all" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const visible = visibleNotifications(notifications)

  // Dismiss/clear POST to the server log (the single source of truth) and reload.
  // A non-ok response or a thrown fetch must NOT silently no-op: the row would
  // reappear on the next poll with no explanation, so the failure is surfaced.
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
            {/* `id` is the writer-guaranteed unique key; the ts+index fallback
                only exists for legacy lines that predate the id field. */}
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
  /** Absent only for a malformed line with neither id nor ts — nothing to key
   *  a dismiss on, so the X is not rendered. */
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

/** Coarse relative time ("just now", "5m ago", "3h ago", "2d ago"); falls back
 *  to the raw timestamp when it cannot be parsed — never a blank field. */
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
 *  Approve/Reject. Decided CRs drop off on the next fetch (their outcome is a
 *  notification, and this session's decision stays visible inline). */
const PENDING_STATUSES = new Set(["idea", "under_review"])

/** The CRs still awaiting the owner's decision — the shared rule so the launcher
 *  badge, the in-panel tab badge, and the CR cards always count the same set. */
export function pendingCrs(crs: ChangeRequestSummary[]): ChangeRequestSummary[] {
  return crs.filter((cr) => PENDING_STATUSES.has(cr.status))
}

/** The recorded outcome of a decision made in THIS mount, rendered inline. */
interface DecisionOutcome {
  ok: boolean
  text: string
}

/**
 * The owner's single legitimate human touchpoint (P2/B8.2), ported from the
 * retired CrReviewSection into the notifications feed: agent-submitted change
 * requests as Cards with Approve/Reject. Approving runs the docs_applied chain
 * (apply → re-freeze → re-extract) server-side; rejecting closes the CR. Both are
 * sensitive, so both confirm — the confirmed CLICK is the owner decision. The
 * apply outcome (ok/blocked) renders inline on the card instead of a toast.
 *
 * Presentational: the CR list comes from the shared feed hook (so it reloads on
 * the same initial/poll/SSE/decision triggers as the notifications and never goes
 * stale), and a decision here calls `onReload` to refresh it.
 */
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
          // An approval whose apply chain stayed red is honest news, not a silent pass.
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
        // The shared reload refetches the CR list (and notifications); the local
        // `outcomes` keeps this card's decision visible even after it drops out of
        // the pending set on the refetch.
        onReload()
        onDecided()
      }
    },
    [onReload, onDecided, t, tErrors]
  )

  // Still-pending CRs plus the ones decided in this mount, so the inline outcome
  // stays readable instead of vanishing with the next list refresh.
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
              {/* role="status": the owner's decision outcome (P2's one human
                  touchpoint) is announced to screen readers, not just painted. */}
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
  // aria-disabled + a guarded open, never the native `disabled`: the AlertDialog
  // returns focus to its trigger on close, and a natively-disabled trigger cannot
  // receive it — keyboard focus would drop to <body> after every owner decision.
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
