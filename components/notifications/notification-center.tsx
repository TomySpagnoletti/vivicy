"use client"

import { useCallback, useState } from "react"
import { CircleAlert, Info, TriangleAlert, X } from "lucide-react"

import type { Notification } from "@/lib/notifications"
import { cn } from "@/lib/utils"
import { CrReviewSection } from "@/components/crs/cr-review-section"
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

const LEVEL_ICON: Record<string, React.ReactNode> = {
  error: <CircleAlert className="size-3.5 text-destructive" />,
  warn: <TriangleAlert className="size-3.5 text-amber-500" />,
  info: <Info className="size-3.5 text-muted-foreground" />,
}

/** Un-dismissed notifications, newest first — the sole visible-list rule so the
 *  bell's unread count and the center's list can never disagree. */
export function visibleNotifications(notifications: Notification[]): Notification[] {
  return notifications
    .filter((n) => !n.dismissed)
    .slice()
    .reverse()
}

/**
 * G9's notification list (Sheet — no Popover primitive is installed in this
 * project's shadcn set, so Sheet is the documented fallback). Newest-first,
 * per-item dismiss, and a confirmed "clear all". Every dismiss/clear POSTs to
 * /api/control/notifications and lets the parent re-fetch (single source of
 * truth: the server log, never a client-only hide).
 */
export function NotificationCenter({
  open,
  onOpenChange,
  notifications,
  onDismissed,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  notifications: Notification[]
  /** Called after a dismiss/clear-all round-trips, so the parent can re-fetch. */
  onDismissed: () => void
}) {
  const [pending, setPending] = useState<string | "all" | null>(null)
  const visible = visibleNotifications(notifications)

  const dismiss = useCallback(
    async (id: string) => {
      setPending(id)
      try {
        await fetch("/api/control/notifications", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id }),
        })
        onDismissed()
      } finally {
        setPending(null)
      }
    },
    [onDismissed]
  )

  const clearAll = useCallback(async () => {
    setPending("all")
    try {
      await fetch("/api/control/notifications", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ all: true }),
      })
      onDismissed()
    } finally {
      setPending(null)
    }
  }, [onDismissed])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" aria-label="Notifications">
        <SheetHeader>
          <SheetTitle>Notifications</SheetTitle>
          <SheetDescription>
            Every pipeline transition: stages starting, passing, blocking, and retrying.
          </SheetDescription>
        </SheetHeader>

        {/* The owner's one human touchpoint (P2): agent-drafted CRs, decided right
            here — reachable in any app state, unlike the map-gated sidebar. */}
        <CrReviewSection reloadSignal={open} onDecided={onDismissed} />

        <div className="flex-1 overflow-y-auto px-4">
          {visible.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              No notifications.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 pb-4">
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
                  />
                )
              })}
            </ul>
          )}
        </div>

        {visible.length > 0 ? (
          <SheetFooter>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={pending !== null}>
                  {pending === "all" ? "Clearing…" : "Clear all"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear all notifications?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Dismisses every notification currently listed. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => void clearAll()}>Clear all</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </SheetFooter>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function NotificationRow({
  notification,
  pending,
  onDismiss,
}: {
  notification: Notification
  pending: boolean
  /** Absent only for a malformed line with neither id nor ts — nothing to key
   *  a dismiss on, so the X is not rendered. */
  onDismiss?: () => void
}) {
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
          {relativeTime(notification.ts)}
        </span>
        {onDismiss ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Dismiss notification"
            disabled={pending}
            onClick={onDismiss}
            className="size-5 shrink-0"
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      <p className="break-words text-foreground">{notification.message}</p>
    </li>
  )
}

/** Coarse relative time ("just now", "5m ago", "3h ago", "2d ago"); falls back
 *  to the raw timestamp when it cannot be parsed — never a blank field. */
export function relativeTime(ts: string | undefined): string {
  if (!ts) return "—"
  const then = Date.parse(ts)
  if (Number.isNaN(then)) return ts
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - then) / 1000))
  if (deltaSeconds < 45) return "just now"
  const minutes = Math.floor(deltaSeconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}
