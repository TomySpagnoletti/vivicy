"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import {
  CircleAlert,
  Loader2,
  Plus,
  SendHorizontal,
  TerminalSquare,
  X,
} from "lucide-react"
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
import { DecisionCard } from "@/components/chat/decision-card"
import { MessageBubble } from "@/components/chat/message-bubble"
import { NonnaIcon } from "@/components/chat/nonna-icon"
import { useViviPanel } from "@/components/chat/vivi-panel-context"
import { ViviOnboarding } from "@/components/chat/vivi-onboarding"
import {
  NotificationsFeed,
  pendingCrs,
  useNotificationsFeed,
  visibleNotifications,
} from "@/components/chat/vivi-notifications"

/** The read-only agent engine Vivi runs on, from `GET /api/vivi` (implementer role). */
interface ViviEngine {
  provider: string
  providerLabel: string
  model: string
}

type PanelTab = "chat" | "notifications"

/** Mid-turn resume poll (F4): after a reload lands on a thread whose last turn is
 *  still the user's, poll the transcript until the reply appears — bounded so a
 *  turn the server silently dropped stops polling after ~10 minutes. */
const RESUME_POLL_MS = 5_000
const RESUME_POLL_MAX = 120

/** GET one session's persisted turns; null when the fetch or shape fails. */
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

/**
 * Vivi's persistent home (W3): an Intercom-style launcher bubble (bottom-left,
 * visible in every app state) toggling a left-side NON-MODAL overlay panel (owner
 * decision D2) — no backdrop, the map behind stays interactive. Two tabs (W5, D3):
 * Chat (the thread) and Notifications (the ONLY notification surface — the old
 * bell/center are retired). An attention badge — undismissed notifications plus
 * pending CRs — rides both the tab (while open) and the launcher bubble (while
 * closed), the two fed from the same always-running feed so they never disagree.
 *
 * The Chat tab hosts three mutually exclusive contents:
 *   - `agentsMissing` — a quiet hint that the CLIs must be installed first (Vivi
 *     runs on them); the prerequisite gate behind carries the commands.
 *   - `hasTarget === false` — the deterministic onboarding view (W4b): three
 *     user-driven acquisition choices instead of a chat that could do nothing.
 *   - otherwise — the thread, rendering the full `ViviTurn` union: user/vivi
 *     bubbles, compact "action" tool-result blocks, and decision cards (D6).
 *
 * The persisted transcript is the single source of truth: on first open the panel
 * rehydrates from the newest session, and after every turn it RE-FETCHES the
 * session — the server may have appended intermediate vivi/action turns during
 * multi-round action execution, so trusting only the returned reply would drop
 * them. Sessions are per-project on the server (W8), so when `projectRoot`
 * changes — a switch or the first acquisition — the panel drops its thread state
 * and rehydrates against the NEW project's sessions. Turns that changed project
 * state (`wrote`/`actions`) bubble up through `onActivity` so the page refreshes.
 */
export function ViviPanel({
  onActivity,
  hasTarget,
  projectRoot,
  agentsMissing = false,
}: {
  onActivity?: () => void
  /** False when the map reports `no_target` (drives the onboarding view); undefined while unknown. */
  hasTarget?: boolean
  /** The current project root (reset key for the per-project thread); null = none, undefined while unknown. */
  projectRoot?: string | null
  /** True while the prerequisite gate is up (either CLI binary missing). */
  agentsMissing?: boolean
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
  const [engine, setEngine] = useState<ViviEngine | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)

  const bubbleRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const hydratedRef = useRef(false)

  // The thread "era". It bumps whenever the thread identity resets — a project
  // switch (per-project sessions on the server) or a "New conversation" — so any
  // in-flight response captured before the bump is DISCARDED instead of writing
  // itself into the wrong thread (a stale reply blanking a rehydrated one, or a
  // foreign session id leaking into the new project's namespace).
  const epochRef = useRef(0)
  // The live sessionId, readable inside post-await callbacks whose closed-over
  // `sessionId` is stale (e.g. a card resync racing "New conversation").
  const sessionIdRef = useRef(sessionId)
  useEffect(() => {
    sessionIdRef.current = sessionId
  }, [sessionId])

  // Composer focus across mounts: the composer often does not EXIST yet when a
  // flow decides it should be focused (a tab switch or the onboarding→chat flip
  // commits the new content one render later), so the request is remembered and
  // honoured by the callback ref the moment the textarea mounts.
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

  // The feed runs ALWAYS (open or closed) so the launcher can carry a closed-panel
  // attention badge. The count = undismissed notifications + pending CRs, the same
  // total the in-panel tab badge shows, so the two can never disagree.
  const { notifications, crs, reload: reloadFeed } = useNotificationsFeed()
  const attentionCount =
    visibleNotifications(notifications).length + pendingCrs(crs).length

  const chatUsable = !agentsMissing && hasTarget !== false

  // Load the read-only engine (which CLI/model Vivi runs on) whenever the panel
  // opens, so the badge always reflects the current settings.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/vivi", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as {
          engine?: ViviEngine
        }
        if (!cancelled && body.engine) setEngine(body.engine)
      } catch {
        // Non-fatal: the chat works without the badge.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // PROJECT-SWITCH RESET (W4b): sessions are per-project on the server, so when
  // the project root changes — including the first acquisition — the thread
  // state belongs to the OLD project and must be dropped before rehydrating.
  // The initial undefined→known transition is a resolution, not a switch.
  const prevRootRef = useRef(projectRoot)
  useEffect(() => {
    if (prevRootRef.current === projectRoot) return
    const prev = prevRootRef.current
    prevRootRef.current = projectRoot
    // A new project namespace: discard any response still in flight from the old one.
    epochRef.current += 1
    if (prev === undefined) return
    hydratedRef.current = false
    setSessionId(undefined)
    setTurns([])
    setSendError(null)
    // The old send's `finally` is epoch-guarded and will NOT clear this, so reset
    // it here — otherwise the new project would be stuck "thinking" behind a stale
    // in-flight turn (and its composer blocked).
    setSending(false)
  }, [projectRoot])

  // Rehydrate once per (open, project): resume the newest persisted session so
  // the conversation survives reloads (and decided cards render decided). Skipped
  // while there is no target — the onboarding view owns the thread area then.
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
        // A failed index fetch is NOT a completion: leave hydratedRef false so the
        // next effect run retries, rather than latching on a transient error that
        // happened to parse to an empty body.
        if (!res.ok || body.ok === false) return
        const newest = body.sessions?.[0]
        if (!newest) {
          // The index resolved to no prior session: nothing to restore, but the
          // attempt COMPLETED — latch so we don't refetch the empty index each render.
          hydratedRef.current = true
          return
        }
        const restored = await fetchSessionTurns(newest.sessionId)
        if (cancelled || restored === null) return
        setSessionId(newest.sessionId)
        setTurns(restored)
        // Latch ONLY here, on a successful non-cancelled restore. A dep that flips
        // mid-fetch cancels this attempt and leaves the ref false, so the next
        // effect run retries instead of being permanently stuck "hydrated".
        hydratedRef.current = true
      } catch {
        // Non-fatal: leave hydratedRef false so the next effect run retries.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open, projectRoot, hasTarget])

  // Move focus with the panel: into the composer on open, back to the launcher on
  // close (the panel goes inert, so focus would otherwise fall to <body>). The
  // composer does not exist in the onboarding and agents-missing states — the
  // header close button is the fallback target, so keyboard focus ALWAYS enters
  // the panel on open (the launcher goes inert on the same render, force-blurring
  // whatever was focused).
  const prevOpenRef = useRef(open)
  useEffect(() => {
    if (open) (textareaRef.current ?? closeRef.current)?.focus()
    else if (prevOpenRef.current) bubbleRef.current?.focus()
    prevOpenRef.current = open
  }, [open])

  // First acquisition while the panel is open: the onboarding view just became
  // the chat — land on the Chat tab with the composer focused, its empty-state
  // hint ("tell Vivi what you want to build") doing the guiding.
  const prevHasTargetRef = useRef(hasTarget)
  useEffect(() => {
    const prev = prevHasTargetRef.current
    prevHasTargetRef.current = hasTarget
    if (prev === false && hasTarget === true && open) {
      setTab("chat")
      focusComposer()
    }
  }, [hasTarget, open, focusComposer])

  // Restore composer focus when a turn completes (F3): the composer stays enabled
  // during sending so the user can keep typing, but focus can drift; on the
  // sending true→false edge, if the panel is open on the Chat tab, put the caret
  // back in the composer so the next message flows without a manual click.
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
      // The thread reset (project switch / New conversation) while this was in
      // flight: this response belongs to a retired era — drop it silently so it
      // can neither blank the new thread nor leak a foreign session id into it.
      if (epoch !== epochRef.current) return
      if (!res.ok || body.ok === false || typeof body.reply !== "string") {
        // Inline, never a crash: the user bubble stays visible for a retry.
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
        // Re-fetch failed: fall back to appending the returned reply so the turn
        // is never invisible; the next successful re-fetch re-syncs the thread.
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
      // Only the send that still owns the era clears the flag — a stale send whose
      // era was retired must not unblock (or clobber) the current turn.
      if (epoch === epochRef.current) setSending(false)
    }
  }, [draft, sending, sessionId, onActivity, t, tErrors])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter inserts a newline (standard chat idiom).
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    },
    [send]
  )

  const startNewConversation = useCallback(() => {
    // A fresh thread era: invalidate any in-flight send/card resync so its late
    // response can't resurrect the conversation we just cleared. Resetting
    // `sending` keeps the invariant here (not solely on the button's disabled
    // prop): the retired send's epoch-guarded finally won't clear it.
    epochRef.current += 1
    setSessionId(undefined)
    setTurns([])
    setSendError(null)
    setSending(false)
    textareaRef.current?.focus()
  }, [])

  // A decided card usually DID something (a control action, a CR decision, a Vivi
  // message) — re-sync the thread from the transcript (the decided stamp + any
  // appended turns live there) and refresh the page state unless it was a dismiss.
  const onCardDecided = useCallback(
    (action: ViviCardAction) => {
      const cardSession = sessionId
      if (cardSession) {
        const epoch = epochRef.current
        void (async () => {
          const restored = await fetchSessionTurns(cardSession)
          // Discard if the thread moved on while the resync was in flight: a
          // project switch (epoch) or a "New conversation"/switch that changed the
          // live sessionId out from under the card this decision belonged to.
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

  // Mid-turn resume (F4): reloading while a turn is being generated rehydrates a
  // thread whose LAST turn is the user's message with no reply yet. Surface the
  // pending marker (in the render below) and poll the transcript until the reply
  // lands, so the answer appears without the user having to resend.
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
        // Commit only once the reply (any non-user turn) has landed: an unchanged
        // still-pending transcript would needlessly re-render on every poll.
        const next = restored[restored.length - 1]
        if (next && next.role !== "user") setTurns(restored)
      })()
    }, RESUME_POLL_MS)
    return () => clearInterval(timer)
  }, [awaitingReply, sessionId])

  // A notification's "Ask Vivi": land on the Chat tab with the composer
  // PRE-FILLED about the displayed text — the user presses send, never the app.
  const askVivi = useCallback(
    (text: string) => {
      setTab("chat")
      setDraft(t("askViviTemplate", { message: text }))
      focusComposer()
    },
    [t, focusComposer]
  )

  // An in-panel acquisition (open/scaffold/import) changed the current project —
  // same page-refresh path as any project change; the flip to chat mode follows
  // from the page's re-fetched `hasTarget`/`projectRoot` coming back down.
  const onAcquired = useCallback(() => {
    onActivity?.()
  }, [onActivity])

  return (
    <>
      {/* The launcher yields while the panel is open: the panel is full-height, so
          a persistent bubble would sit on top of the composer — the header X is the
          close affordance instead. The wrapper is inert to pointer events so the
          map behind stays clickable when the bubble is hidden; the button re-enables
          them for itself while closed. */}
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
            "size-12 rounded-full shadow-lg transition-all duration-200",
            open
              ? "pointer-events-none scale-75 opacity-0"
              : "pointer-events-auto scale-100 opacity-100"
          )}
        >
          <NonnaIcon className="size-6" />
        </Button>
        {/* Closed-panel attention signal (F6): undismissed notifications + pending
            CRs, capped at 9+. Hidden at zero and while the panel is open (the tab
            badge carries the count then). The count is announced via aria-label. */}
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
        <header className="flex items-center gap-1.5 border-b border-border p-3">
          <NonnaIcon className="size-5" />
          <h2 id={titleId} className="font-heading text-sm font-medium">
            {t("panelHeading")}
          </h2>
          {engine ? (
            <Badge
              variant="outline"
              className="ml-1"
              title={t("engineBadgeTitle")}
            >
              {engine.providerLabel} · {engine.model}
            </Badge>
          ) : null}
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
            {agentsMissing ? (
              <div className="flex items-start gap-2 p-4 text-xs/relaxed text-muted-foreground">
                <TerminalSquare className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>{t("agentsMissingHint")}</p>
              </div>
            ) : hasTarget === false ? (
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
                  {/* Enabled through the whole turn (F3): a Vivi turn can run for
                      minutes, so locking the composer would strand the user — they
                      keep drafting the next message while this one runs. */}
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
                  {/* aria-disabled + a guarded send, never the native `disabled`:
                      a natively-disabled button drops keyboard focus to <body> the
                      instant the turn starts. `send()` itself no-ops while sending
                      or on an empty draft, so the gate is honoured either way. */}
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

/** Route one persisted turn to its rendering: bubbles, action block, or card. */
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

/** The turn-based pending state — a shadcn Marker with a spinner while the exec runs. */
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
