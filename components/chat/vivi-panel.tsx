"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { CircleAlert, Loader2, Plus, SendHorizontal, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ViviCardAction, ViviTurn } from "@/lib/vivi"
import { errorText } from "@/lib/i18n-errors"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageHeader } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ViviAvatar } from "@/components/brand/vivi-avatar"
import { DecisionCard } from "@/components/chat/decision-card"
import { MessageBubble } from "@/components/chat/message-bubble"
import { useViviPanel } from "@/components/chat/vivi-panel-context"
import { ViviOnboarding } from "@/components/chat/vivi-onboarding"
import {
  NotificationsFeed,
  pendingCrs,
  useNotificationsFeed,
  visibleNotifications,
} from "@/components/chat/vivi-notifications"

type PanelTab = "chat" | "notifications"

// Capped so a turn the server silently dropped doesn't poll forever.
const RESUME_POLL_MS = 5_000
const RESUME_POLL_MAX = 120

async function fetchSessionTurns(
  sessionId: string
): Promise<ViviTurn[] | null> {
  try {
    const res = await fetch(`/api/vivi/sessions/${sessionId}`, {
      cache: "no-store",
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      turns?: ViviTurn[]
    }
    if (!res.ok || body.ok === false || !Array.isArray(body.turns)) return null
    return body.turns
  } catch {
    return null
  }
}

export function ViviPanel({
  onActivity,
  hasTarget,
  projectRoot,
}: {
  onActivity?: () => void
  hasTarget?: boolean
  projectRoot?: string | null
}) {
  const t = useTranslations("chat")
  const tNotifications = useTranslations("notifications")
  const tErrors = useTranslations("errors")
  const { open, togglePanel, closePanel } = useViviPanel()
  const titleId = useId()

  const [tab, setTab] = useState<PanelTab>("chat")
  const [turns, setTurns] = useState<ViviTurn[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const bubbleRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const hydratedRef = useRef(false)

  // Bumps on thread-identity reset (project switch / New conversation); an in-flight response captured before the bump is discarded instead of written into the wrong thread.
  const epochRef = useRef(0)
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  const pendingFocusRef = useRef(false)
  const composerRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
    if (node && pendingFocusRef.current) {
      pendingFocusRef.current = false
      node.focus()
    }
  }, [])
  const focusComposer = useCallback(() => {
    if (textareaRef.current) textareaRef.current.focus()
    else pendingFocusRef.current = true
  }, [])

  // Deliberately unconditional (not gated on `open`) so the closed-panel launcher badge stays live.
  const { notifications, crs, reload: reloadFeed } = useNotificationsFeed()
  const attentionCount =
    visibleNotifications(notifications).length + pendingCrs(crs).length

  const chatUsable = hasTarget !== false

  // Sessions are per-project on the server; the initial undefined→known transition is a resolution, not a switch, so it skips the reset below.
  const prevRootRef = useRef(projectRoot)
  useEffect(() => {
    if (prevRootRef.current === projectRoot) return
    const prev = prevRootRef.current
    prevRootRef.current = projectRoot
    epochRef.current += 1
    if (prev === undefined) return
    hydratedRef.current = false
    setSessionId(undefined)
    setTurns([])
    setSendError(null)
    // Reset here too: the old send's epoch-guarded finally won't clear it, and skipping this would strand the new project "thinking" behind a stale in-flight turn.
    setSending(false)
  }, [projectRoot])

  useEffect(() => {
    if (!open || hydratedRef.current || hasTarget === false) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/vivi/sessions", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          sessions?: { sessionId: string }[]
        }
        if (cancelled) return
        // A failed fetch leaves hydratedRef false so the next effect run retries, instead of latching on a transient error.
        if (!res.ok || body.ok === false) return
        const newest = body.sessions?.[0]
        if (!newest) {
          // No prior session is still a completed attempt — latch so the empty index isn't refetched every render.
          hydratedRef.current = true
          return
        }
        const restored = await fetchSessionTurns(newest.sessionId)
        if (cancelled || restored === null) return
        setSessionId(newest.sessionId)
        setTurns(restored)
        // Latches only on a successful, non-cancelled restore, so a mid-fetch cancellation retries next run instead of getting stuck unhydrated.
        hydratedRef.current = true
      } catch {
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, projectRoot, hasTarget])

  // Focus follows the panel (inert would otherwise drop it to body on close); falls back to the close button when the composer doesn't exist yet (onboarding).
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (open) (textareaRef.current ?? closeRef.current)?.focus()
    else if (prevOpenRef.current) bubbleRef.current?.focus()
    prevOpenRef.current = open
  }, [open])

  const prevHasTargetRef = useRef(hasTarget)
  useEffect(() => {
    const prev = prevHasTargetRef.current
    prevHasTargetRef.current = hasTarget
    if (prev === false && hasTarget === true && open) {
      setTab("chat")
      focusComposer()
    }
  }, [hasTarget, open, focusComposer])

  const prevSendingRef = useRef(sending)
  useEffect(() => {
    const was = prevSendingRef.current
    prevSendingRef.current = sending
    if (was && !sending && open && tab === "chat") focusComposer()
  }, [sending, open, tab, focusComposer])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (message.length === 0 || sending) return
    // Capture the era before the awaits; every post-await write is guarded on it.
    const epoch = epochRef.current
    setDraft("")
    setSendError(null)
    setTurns((prev) => [
      ...prev,
      { role: "user", text: message, ts: new Date().toISOString() },
    ])
    setSending(true)
    try {
      const res = await fetch("/api/vivi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, message }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        sessionId?: string
        reply?: string
        wrote?: string[]
        rejected?: string
        actions?: unknown[]
        error?: string
        code?: string
      }
      if (epoch !== epochRef.current) return
      if (!res.ok || body.ok === false || typeof body.reply !== "string") {
        const fallback =
          body.error ?? t("requestFailed", { status: res.status })
        setSendError(
          body.code
            ? errorText(tErrors, `control.${body.code}`, fallback)
            : fallback
        )
        return
      }
      if (body.sessionId) setSessionId(body.sessionId)
      const restored = body.sessionId
        ? await fetchSessionTurns(body.sessionId)
        : null
      if (epoch !== epochRef.current) return
      if (restored !== null) {
        setTurns(restored)
      } else {
        setTurns((prev) => [
          ...prev,
          {
            role: "vivi",
            text: body.reply as string,
            ts: new Date().toISOString(),
            wrote: body.wrote ?? [],
            rejected: body.rejected,
          },
        ])
      }
      if ((body.wrote?.length ?? 0) > 0 || (body.actions?.length ?? 0) > 0)
        onActivity?.()
    } catch (error) {
      if (epoch !== epochRef.current) return
      setSendError(error instanceof Error ? error.message : t("networkError"))
    } finally {
      if (epoch === epochRef.current) setSending(false)
    }
  }, [draft, sending, sessionId, onActivity, t, tErrors])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    },
    [send]
  )

  const startNewConversation = useCallback(() => {
    // Bumps the era (invalidates any in-flight send/resync); sending is reset here too since the stale send's epoch-guarded finally won't clear it.
    epochRef.current += 1
    setSessionId(undefined)
    setTurns([])
    setSendError(null)
    setSending(false)
    textareaRef.current?.focus()
  }, [])

  // A decided card re-syncs the thread from the transcript (the decided stamp and any appended turns live there); a dismiss doesn't count as activity.
  const onCardDecided = useCallback(
    (action: ViviCardAction) => {
      const cardSession = sessionId
      if (cardSession) {
        const epoch = epochRef.current
        void (async () => {
          const restored = await fetchSessionTurns(cardSession)
          // Discard if the thread moved on mid-resync: an epoch bump (project switch) or the live sessionId changed underneath this card (New conversation).
          if (
            epoch !== epochRef.current ||
            sessionIdRef.current !== cardSession ||
            restored === null
          )
            return
          setTurns(restored)
        })()
      }
      if (action.action.kind !== "dismiss") onActivity?.()
    },
    [sessionId, onActivity]
  )

  const lastTurn = turns[turns.length - 1]
  const awaitingReply = !sending && !!sessionId && lastTurn?.role === "user"
  useEffect(() => {
    if (!awaitingReply || !sessionId) return
    const epoch = epochRef.current
    let polls = 0
    const timer = setInterval(() => {
      polls += 1
      if (polls > RESUME_POLL_MAX) {
        clearInterval(timer)
        return
      }
      void (async () => {
        const restored = await fetchSessionTurns(sessionId)
        if (epoch !== epochRef.current || restored === null) return
        const next = restored[restored.length - 1]
        if (next && next.role !== "user") setTurns(restored)
      })()
    }, RESUME_POLL_MS)
    return () => clearInterval(timer)
  }, [awaitingReply, sessionId])

  const askVivi = useCallback(
    (text: string) => {
      setTab("chat")
      setDraft(t("askViviTemplate", { message: text }))
      focusComposer()
    },
    [t, focusComposer]
  )

  const onAcquired = useCallback(() => {
    onActivity?.()
  }, [onActivity])

  return (
    <>
      {hasTarget !== false ? (
        <div className="pointer-events-none fixed bottom-4 left-4 z-50">
          <Button
            ref={bubbleRef}
            type="button"
            size="icon"
            onClick={togglePanel}
            inert={open}
            aria-hidden={open}
            aria-expanded={open}
            aria-label={t("openAriaLabel")}
            className={cn(
              "size-12 overflow-hidden rounded-full p-1.5 shadow-lg transition-all duration-200",
              open
                ? "pointer-events-none scale-75 opacity-0"
                : "pointer-events-auto scale-100 opacity-100"
            )}
          >
            <ViviAvatar className="size-full" />
          </Button>
          {!open && attentionCount > 0 ? (
            <Badge
              variant="destructive"
              aria-label={t("launcherBadgeAriaLabel", { count: attentionCount })}
              className="pointer-events-none absolute -top-1 -right-1 h-5 min-w-5 justify-center rounded-full px-1 text-[10px]"
            >
              {attentionCount > 9 ? t("launcherBadgeOverflow") : attentionCount}
            </Badge>
          ) : null}
        </div>
      ) : null}

      <aside
        role="complementary"
        aria-labelledby={titleId}
        aria-hidden={!open}
        inert={!open}
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-dvh w-[clamp(380px,25vw,480px)] flex-col border-r border-border bg-background shadow-xl transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <header className="flex items-center gap-2 border-b border-border p-3">
          <ViviAvatar className="size-6" />
          <h2 id={titleId} className="font-heading text-sm font-medium">
            {t("panelHeading")}
          </h2>
          <div className="ml-auto flex items-center">
            {chatUsable ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={startNewConversation}
                disabled={sending}
                aria-label={t("newConversation")}
              >
                <Plus />
              </Button>
            ) : null}
            <Button
              ref={closeRef}
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={closePanel}
              aria-label={t("closeAriaLabel")}
            >
              <X />
            </Button>
          </div>
        </header>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as PanelTab)}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <div className="border-b border-border px-3 py-2">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="chat">{t("tabChat")}</TabsTrigger>
              <TabsTrigger value="notifications">
                {t("tabNotifications")}
                {attentionCount > 0 ? (
                  <Badge
                    variant="destructive"
                    className="h-4 min-w-4 justify-center px-1 text-[10px]"
                    aria-label={tNotifications("unreadAriaLabel", {
                      count: attentionCount,
                    })}
                  >
                    {attentionCount > 99
                      ? tNotifications("unreadOverflow")
                      : attentionCount}
                  </Badge>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="chat" className="flex min-h-0 flex-1 flex-col">
            {hasTarget === false ? (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ViviOnboarding onAcquired={onAcquired} />
              </div>
            ) : (
              <>
                <MessageScrollerProvider>
                  <MessageScroller className="flex-1">
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="gap-3 p-4">
                        {turns.length === 0 && !sending ? (
                          <p className="text-xs text-muted-foreground">
                            {t("emptyState")}
                          </p>
                        ) : null}
                        {turns.map((turn, i) => (
                          <MessageScrollerItem key={i}>
                            <TurnView
                              turn={turn}
                              sessionId={sessionId}
                              onDecided={onCardDecided}
                            />
                          </MessageScrollerItem>
                        ))}
                        {sending || awaitingReply ? (
                          <MessageScrollerItem scrollAnchor>
                            <PendingMarker />
                          </MessageScrollerItem>
                        ) : null}
                        {sendError ? (
                          <MessageScrollerItem scrollAnchor>
                            <Marker className="text-destructive">
                              <MarkerIcon>
                                <CircleAlert />
                              </MarkerIcon>
                              <MarkerContent>{sendError}</MarkerContent>
                            </Marker>
                          </MessageScrollerItem>
                        ) : null}
                      </MessageScrollerContent>
                    </MessageScrollerViewport>
                    <MessageScrollerButton />
                  </MessageScroller>
                </MessageScrollerProvider>

                <div className="flex items-end gap-2 border-t border-border p-3">
                  {/* Not disabled while sending: a turn can run minutes, so locking the composer would strand the user mid-draft. */}
                  <Textarea
                    ref={composerRef}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={onKeyDown}
                    placeholder={t("inputPlaceholder")}
                    rows={2}
                    aria-label={t("inputAriaLabel")}
                    className="max-h-40 flex-1 resize-none"
                  />
                  {/* aria-disabled, not native disabled: a natively-disabled button would drop focus to body the instant sending starts. send() itself no-ops when sending or empty either way. */}
                  <Button
                    type="button"
                    size="icon-sm"
                    onClick={() => void send()}
                    aria-disabled={sending || draft.trim().length === 0}
                    className={cn(
                      (sending || draft.trim().length === 0) && "opacity-60"
                    )}
                    aria-label={t("sendAriaLabel")}
                  >
                    <SendHorizontal />
                  </Button>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent
            value="notifications"
            className="min-h-0 flex-1 overflow-y-auto"
          >
            <NotificationsFeed
              notifications={notifications}
              crs={crs}
              onReload={() => void reloadFeed()}
              onAskVivi={askVivi}
              onDecided={onActivity}
            />
          </TabsContent>
        </Tabs>
      </aside>
    </>
  )
}

function TurnView({
  turn,
  sessionId,
  onDecided,
}: {
  turn: ViviTurn
  sessionId?: string
  onDecided?: (action: ViviCardAction) => void
}) {
  const t = useTranslations("chat")

  if (turn.role === "user" || turn.role === "vivi") {
    return (
      <MessageBubble
        message={{
          role: turn.role,
          text: turn.text,
          wrote: turn.wrote,
          rejected: turn.rejected,
        }}
      />
    )
  }

  if (turn.role === "action") {
    return (
      <Message align="start">
        <MessageContent>
          <MessageHeader>{t("actionsTitle")}</MessageHeader>
          <Bubble variant="muted" className="max-w-full">
            <BubbleContent className="font-mono whitespace-pre-wrap text-muted-foreground">
              {turn.text}
            </BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    )
  }

  if (turn.card && sessionId) {
    return (
      <DecisionCard
        sessionId={sessionId}
        card={turn.card}
        decided={turn.decided}
        onDecided={onDecided}
      />
    )
  }

  return null
}

function PendingMarker() {
  const t = useTranslations("chat")
  return (
    <Marker>
      <MarkerIcon>
        <Loader2 className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>{t("pending")}</MarkerContent>
    </Marker>
  )
}
