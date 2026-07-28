"use client"

import { useCallback, useEffect, useId, useRef, useState } from "react"
import { CircleAlert, Loader2, Paperclip, SendHorizontal, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ViviCardAction, ViviTurn } from "@/lib/vivi"
import {
  readAnsweredLine,
  remainingQuestions,
  threadRenderOrder,
  type ViviQuestion,
} from "@/lib/vivi-questions"
import { errorText } from "@/lib/i18n-errors"
import { VIVI_TURN_CEILING_MS } from "@/lib/leg-budget"
import { IMPORT_ACCEPT_ATTR } from "@/lib/supported-extensions"
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
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ViviAvatar } from "@/components/brand/vivi-avatar"
import { DecisionCard } from "@/components/chat/decision-card"
import { MessageBubble } from "@/components/chat/message-bubble"
import { QuestionStack, type QuestionAnswerOutcome } from "@/components/chat/question-stack"
import { useViviPanel } from "@/components/chat/vivi-panel-context"
import { ViviOnboarding } from "@/components/chat/vivi-onboarding"
import {
  NotificationsFeed,
  pendingCrs,
  useNotificationsFeed,
  visibleNotifications,
} from "@/components/chat/vivi-notifications"

type PanelTab = "chat" | "notifications"

const RESUME_POLL_MS = 5_000
// The backstop, derived from the very timeouts that bound a turn server-side (every round is one leg, each leg dies at the cap) plus a margin — never a hand-tuned literal that would drift from them. The primary signal is the server's own liveness flag below; this only catches a turn that outlives every bound the factory enforces.
const RESUME_POLL_MAX = Math.ceil((VIVI_TURN_CEILING_MS * 1.2) / RESUME_POLL_MS)

// A card answer is a RECORDED line, not a dispatched turn: only the one that empties its pile sends the batch, exactly as pressing Send sends a typed line. Without this the thread would claim Vivi was thinking while the owner is still working through the pile.
function stackComplete(turns: ViviTurn[], stackId: string): boolean {
  const stack = turns.find((turn) => turn.questions?.id === stackId)?.questions
  return stack !== undefined && remainingQuestions(stack, turns).length === 0
}

// A thread is awaiting Vivi when she owes it an answer: the last turn is a message the owner actually sent, or a batch anywhere in the thread is still being read (position-independent — the reading turn's own action rounds, or another turn finishing ahead of it, append after the acknowledgment).
function awaitingVivi(turns: ViviTurn[]): boolean {
  const last = turns[turns.length - 1]
  const sent =
    last?.role === "user" &&
    (last.answered === undefined || stackComplete(turns, last.answered.stackId))
  return sent || turns.some((turn) => turn.imported?.read?.status === "pending")
}

// Identity of what is being waited ON, so a give-up survives the owner's next message instead of being erased by it, and a new wait never inherits an old one's verdict.
function waitIdentity(turns: ViviTurn[]): string | null {
  const reading = turns.find((turn) => turn.imported?.read?.status === "pending")
  if (reading) return `read:${reading.imported!.batchId}`
  const last = turns[turns.length - 1]
  return last?.role === "user" ? `user:${last.ts}` : null
}

interface SessionSnapshot {
  turns: ViviTurn[]
  busy: boolean
}

async function fetchSessionTurns(
  sessionId: string
): Promise<SessionSnapshot | null> {
  try {
    const res = await fetch(`/api/vivi/sessions/${sessionId}`, {
      cache: "no-store",
    })
    const body = (await res.json().catch(() => ({}))) as {
      ok?: boolean
      turns?: ViviTurn[]
      busy?: boolean
    }
    if (!res.ok || body.ok === false || !Array.isArray(body.turns)) return null
    return { turns: body.turns, busy: body.busy === true }
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
  const { open, openPanel, togglePanel, closePanel } = useViviPanel()
  const titleId = useId()

  const [tab, setTab] = useState<PanelTab>("chat")
  const [turns, setTurns] = useState<ViviTurn[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const [importing, setImporting] = useState(false)
  const [importNote, setImportNote] = useState<string | null>(null)
  const [lostWait, setLostWait] = useState<string | null>(null)

  const bubbleRef = useRef<HTMLButtonElement | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const closeRef = useRef<HTMLButtonElement | null>(null)
  const hydratedRef = useRef(false)

  // Bumps on thread-identity reset (project switch); an in-flight response captured before the bump is discarded instead of written into the wrong thread.
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
    setImportNote(null)
    // Reset here too: the old send's/import's epoch-guarded finally won't clear it, and skipping this would strand the new project "thinking" behind a stale in-flight turn.
    setSending(false)
    setImporting(false)
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
        setTurns(restored.turns)
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
    // Gate the action itself, not just the callsites: an in-flight import has no session yet, so a concurrent send would mint a SECOND server session and orphan one of the two (the import ack or the message reply). aria-disabled on the button is only the visual echo of this guard.
    if (message.length === 0 || sending || importing) return
    // Capture the era before the awaits; every post-await write is guarded on it.
    const epoch = epochRef.current
    setDraft("")
    setSendError(null)
    setImportNote(null)
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
        setTurns(restored.turns)
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
  }, [draft, sending, importing, sessionId, onActivity, t, tErrors])

  // The paperclip beside Send: the file pick IS the whole action (P2), so it uploads straight to the current session — no chat message, the server appends Vivi's deterministic acknowledgment. Epoch-guarded exactly like send so a project switch mid-upload discards the stale result. Gated on `sending` too (the symmetric no-session-yet race): a concurrent send + import would each mint their own session.
  const importDocs = useCallback(
    async (files: File[]) => {
      if (files.length === 0 || importing || sending) return
      const epoch = epochRef.current
      setImporting(true)
      setSendError(null)
      setImportNote(null)
      try {
        const form = new FormData()
        if (sessionId) form.append("sessionId", sessionId)
        for (const file of files) {
          form.append("files", file)
          form.append(
            "paths",
            (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
          )
        }
        const res = await fetch("/api/vivi/import", { method: "POST", body: form })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          sessionId?: string
          error?: string
          code?: string
          rejected?: { path: string }[]
        }
        if (epoch !== epochRef.current) return
        if (!res.ok || body.ok === false) {
          const fallback = body.error ?? t("requestFailed", { status: res.status })
          setSendError(
            body.code ? errorText(tErrors, `control.${body.code}`, fallback) : fallback
          )
          return
        }
        if (body.sessionId) setSessionId(body.sessionId)
        const restored = body.sessionId
          ? await fetchSessionTurns(body.sessionId)
          : null
        if (epoch !== epochRef.current) return
        if (restored !== null) setTurns(restored.turns)
        const skipped = body.rejected ?? []
        if (skipped.length > 0) {
          setImportNote(
            t("importSkipped", {
              count: skipped.length,
              files: skipped.map((r) => r.path).join(", "),
            })
          )
        }
        onActivity?.()
      } catch (error) {
        if (epoch !== epochRef.current) return
        setSendError(error instanceof Error ? error.message : t("networkError"))
      } finally {
        if (epoch === epochRef.current) setImporting(false)
      }
    },
    [sessionId, importing, sending, onActivity, t, tErrors]
  )

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault()
        void send()
      }
    },
    [send]
  )

  // A decided card re-syncs the thread from the transcript (the decided stamp and any appended turns live there); a dismiss doesn't count as activity.
  const onCardDecided = useCallback(
    (action: ViviCardAction) => {
      const cardSession = sessionId
      if (cardSession) {
        const epoch = epochRef.current
        void (async () => {
          const restored = await fetchSessionTurns(cardSession)
          // Discard if the thread moved on mid-resync: an epoch bump or the live sessionId changed underneath this card (project switch).
          if (
            epoch !== epochRef.current ||
            sessionIdRef.current !== cardSession ||
            restored === null
          )
            return
          setTurns(restored.turns)
        })()
      }
      if (action.action.kind !== "dismiss") onActivity?.()
    },
    [sessionId, onActivity]
  )

  const awaitingReply = !sending && !!sessionId && awaitingVivi(turns)
  const reading = turns.some((turn) => turn.imported?.read?.status === "pending")
  // Keyed to WHAT is awaited (the pending batch, or the owner's own message by its timestamp), so a verdict cannot be erased by the next message or inherited by the next wait.
  const identity = waitIdentity(turns)
  const waitKey = sessionId && identity ? `${sessionId}:${identity}` : null
  const lostTurn = lostWait !== null && lostWait === waitKey
  useEffect(() => {
    if (!awaitingReply || !sessionId || !waitKey) return
    const epoch = epochRef.current
    let polls = 0
    const timer = setInterval(() => {
      polls += 1
      if (polls > RESUME_POLL_MAX) {
        clearInterval(timer)
        if (epoch === epochRef.current) setLostWait(waitKey)
        return
      }
      void (async () => {
        const restored = await fetchSessionTurns(sessionId)
        if (epoch !== epochRef.current || restored === null) return
        if (restored.turns.length > 0 && !awaitingVivi(restored.turns)) {
          setTurns(restored.turns)
          return
        }
        // The server's own liveness beats any wall-clock guess: still awaiting with no turn running means the turn died with its process.
        if (!restored.busy) {
          clearInterval(timer)
          setLostWait(waitKey)
        }
      })()
    }, RESUME_POLL_MS)
    return () => clearInterval(timer)
  }, [awaitingReply, sessionId, waitKey])

  // An answered card re-syncs the thread from the transcript (the answer line lives there); when the last one empties the pile, the composer takes the focus the card just gave up — but only if the pile still held it.
  const onQuestionAnswered = useCallback(
    ({ remaining, takeFocus }: QuestionAnswerOutcome) => {
      const answerSession = sessionId
      if (!answerSession) return
      const epoch = epochRef.current
      void (async () => {
        const restored = await fetchSessionTurns(answerSession)
        if (
          epoch !== epochRef.current ||
          sessionIdRef.current !== answerSession ||
          restored === null
        )
          return
        setTurns(restored.turns)
        if (remaining === 0 && takeFocus) focusComposer()
      })()
    },
    [sessionId, focusComposer]
  )

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

  const onGoverned = useCallback(() => {
    openPanel()
    onActivity?.()
  }, [openPanel, onActivity])

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
          "fixed inset-y-0 left-0 z-40 flex h-dvh w-[min(100%,clamp(380px,25vw,480px))] flex-col border-r border-border bg-background shadow-xl transition-transform duration-200 ease-out",
          open ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <header className="flex items-center gap-2 border-b border-border p-3">
          <ViviAvatar className="size-6" />
          <h2 id={titleId} className="font-heading text-sm font-medium">
            {t("panelHeading")}
          </h2>
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={closePanel}
            aria-label={t("closeAriaLabel")}
            className="ml-auto"
          >
            <X />
          </Button>
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
                <ViviOnboarding
                  onAcquired={onAcquired}
                  onGoverned={onGoverned}
                />
              </div>
            ) : (
              <>
                <MessageScrollerProvider autoScroll>
                  <MessageScroller className="flex-1">
                    <MessageScrollerViewport>
                      <MessageScrollerContent className="gap-3 p-4">
                        {threadRenderOrder(turns).map((i) => {
                          const turn = turns[i]
                          const remaining = turn.questions
                            ? remainingQuestions(turn.questions, turns)
                            : null
                          // A pile with nothing left on it leaves no trace: the answers are the lines it became.
                          if (remaining?.length === 0) return null
                          return (
                            <MessageScrollerItem key={i} messageId={String(i)}>
                              <TurnView
                                turn={turn}
                                remaining={remaining}
                                answered={readAnsweredLine(turns, turn)}
                                sessionId={sessionId}
                                onDecided={onCardDecided}
                                onAnswered={onQuestionAnswered}
                              />
                            </MessageScrollerItem>
                          )
                        })}
                        {sending || (awaitingReply && !lostTurn) ? (
                          <MessageScrollerItem messageId="pending">
                            <PendingMarker reading={reading} />
                          </MessageScrollerItem>
                        ) : null}
                        {!sending && awaitingReply && lostTurn ? (
                          <MessageScrollerItem messageId="lost">
                            <Marker>
                              <MarkerIcon>
                                <CircleAlert />
                              </MarkerIcon>
                              <MarkerContent>
                                {t(reading ? "readingLost" : "pendingLost")}
                              </MarkerContent>
                            </Marker>
                          </MessageScrollerItem>
                        ) : null}
                        {importing ? (
                          <MessageScrollerItem messageId="importing">
                            <ImportingMarker />
                          </MessageScrollerItem>
                        ) : null}
                        {sendError ? (
                          <MessageScrollerItem messageId="error">
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

                <div className="border-t border-border p-3">
                  <div className="relative rounded-none border border-input bg-transparent transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/50">
                    <Textarea
                      ref={composerRef}
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onKeyDown={onKeyDown}
                      placeholder={t("inputPlaceholder")}
                      aria-label={t("inputAriaLabel")}
                      className="max-h-40 resize-none border-0 bg-transparent pr-11 pl-11 focus-visible:ring-0"
                    />
                    <input
                      ref={importInputRef}
                      type="file"
                      multiple
                      accept={IMPORT_ACCEPT_ATTR}
                      className="hidden"
                      onChange={(event) => {
                        const files = Array.from(event.target.files ?? [])
                        event.target.value = ""
                        if (files.length > 0) void importDocs(files)
                      }}
                    />
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-sm"
                            onClick={() => {
                              if (importing || sending) return
                              importInputRef.current?.click()
                            }}
                            aria-disabled={importing || sending}
                            aria-label={t("attachAriaLabel")}
                            className={cn(
                              "absolute bottom-1.5 left-1.5 text-muted-foreground",
                              (importing || sending) && "opacity-60"
                            )}
                          >
                            {importing ? (
                              <Loader2 className="animate-spin" />
                            ) : (
                              <Paperclip />
                            )}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent>{t("attachTooltip")}</TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                    <Button
                      type="button"
                      size="icon-sm"
                      onClick={() => void send()}
                      aria-disabled={sending || importing || draft.trim().length === 0}
                      aria-label={t("sendAriaLabel")}
                      className={cn(
                        "absolute right-1.5 bottom-1.5",
                        (sending || importing || draft.trim().length === 0) &&
                          "opacity-60"
                      )}
                    >
                      <SendHorizontal />
                    </Button>
                  </div>
                  {importNote ? (
                    <p className="mt-1.5 text-xs text-muted-foreground">
                      {importNote}
                    </p>
                  ) : null}
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
  remaining,
  answered,
  sessionId,
  onDecided,
  onAnswered,
}: {
  turn: ViviTurn
  remaining?: ViviQuestion[] | null
  answered?: { question: string; answer: string } | null
  sessionId?: string
  onDecided?: (action: ViviCardAction) => void
  onAnswered?: (outcome: QuestionAnswerOutcome) => void
}) {
  const t = useTranslations("chat")

  if (turn.role === "questions") {
    if (!turn.questions || !remaining || remaining.length === 0 || !sessionId) return null
    return (
      <QuestionStack
        sessionId={sessionId}
        stack={turn.questions}
        remaining={remaining}
        onAnswered={onAnswered}
      />
    )
  }

  if (answered) return <AnsweredLine question={answered.question} answer={answered.answer} />

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

// The answered card's whole trace in the thread: the question it settled, muted, above the owner's own word. It is an ordinary user turn — the two halves are the one serialized line, split back apart for reading.
function AnsweredLine({ question, answer }: { question: string; answer: string }) {
  return (
    <Message align="end">
      <MessageContent>
        <Bubble variant="muted" align="end">
          <BubbleContent className="flex flex-col gap-0.5">
            <span className="text-[11px]/relaxed text-muted-foreground">{question}</span>
            <span className="font-medium wrap-break-word">{answer}</span>
          </BubbleContent>
        </Bubble>
      </MessageContent>
    </Message>
  )
}

function PendingMarker({ reading }: { reading?: boolean }) {
  const t = useTranslations("chat")
  return (
    <Marker>
      <MarkerIcon>
        <Loader2 className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>{t(reading ? "reading" : "pending")}</MarkerContent>
    </Marker>
  )
}

function ImportingMarker() {
  const t = useTranslations("chat")
  return (
    <Marker>
      <MarkerIcon>
        <Loader2 className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>{t("importing")}</MarkerContent>
    </Marker>
  )
}
