"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { Bell } from "lucide-react"

import type { Notification } from "@/lib/notifications"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { NotificationCenter, visibleNotifications } from "@/components/notifications/notification-center"

const POLL_INTERVAL_MS = 10_000

interface NotificationsResponse {
  ok?: boolean
  notifications?: Notification[]
}

/**
 * G9's bell: mounted in the top bar next to the other setup controls (Agents,
 * project picker). Shows the unread (= un-dismissed) count and opens the
 * NotificationCenter sheet. Refetches when the SSE status stream's signature
 * changes (the SAME signature the process control bar keys map refreshes on —
 * issues done/total, gate failures, run liveness — so a pipeline transition
 * that emitted a notification shows up promptly, P9) plus a 10s poll as the
 * fallback for app-side emissions the dev-status frame cannot reflect (upload
 * verify/apply, CR decisions). Owning a second EventSource here mirrors the
 * control bar / pipeline widget pattern: each surface subscribes independently.
 */
export function NotificationBell() {
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [open, setOpen] = useState(false)
  const mountedRef = useRef(true)
  const lastSignatureRef = useRef<string | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/control/notifications", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as NotificationsResponse
      if (mountedRef.current && body.notifications) setNotifications(body.notifications)
    } catch {
      // Best-effort: keep the last known list on a transient fetch failure.
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await load()
    })()
    const timer = setInterval(() => void load(), POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
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
        // A malformed frame never breaks the bell; the poll still covers it.
      }
    }
    return () => source.close()
  }, [load])

  const unread = visibleNotifications(notifications).length

  return (
    <>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label="Notifications"
        className="relative"
        onClick={() => setOpen(true)}
      >
        <Bell />
        {unread > 0 ? (
          <Badge
            variant="destructive"
            className="absolute -top-1.5 -right-1.5 h-4 min-w-4 justify-center px-1 text-[10px]"
            aria-label={`${unread} unread notification${unread === 1 ? "" : "s"}`}
          >
            {unread > 99 ? "99+" : unread}
          </Badge>
        ) : null}
      </Button>

      <NotificationCenter
        open={open}
        onOpenChange={setOpen}
        notifications={notifications}
        onDismissed={() => void load()}
      />
    </>
  )
}
