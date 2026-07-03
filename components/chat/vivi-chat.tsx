"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, SendHorizontal, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import { MessageBubble, type ChatMessage } from "@/components/chat/message-bubble"

/** The read-only agent engine Vivi runs on, from `GET /api/vivi` (implementer role). */
interface ViviEngine {
  provider: string
  providerLabel: string
  model: string
}

/**
 * Vivi chat panel (G2, S1-chat): a full-height right-side Sheet. The user grills
 * their idea into a spec with Vivi; each turn POSTs `{ sessionId?, message }` to
 * `/api/vivi`, which drives ONE agent exec in the target repo and returns the reply
 * plus the `.md` files Vivi wrote (shown as Attachment chips on the bubble). The
 * conversation is a `MessageScroller` (auto-anchors to newest, with a jump-to-latest
 * button); turn-based, so a pending turn shows a `Marker` with a spinner (no token
 * streaming in v0.5.0).
 *
 * Agent selection is read-only here (P6): the engine badge shows which CLI + model
 * Vivi runs on, read from settings; it is never editable from the chat. Built from
 * the dedicated shadcn chat components (Message / Bubble / Marker / MessageScroller /
 * Attachment) — nothing hand-rolled.
 */
export function ViviChat({
  open,
  onOpenChange,
  onWrote,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fires after a turn wrote at least one file, so the caller can refresh state. */
  onWrote?: (files: string[]) => void
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sessionId, setSessionId] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [engine, setEngine] = useState<ViviEngine | null>(null)

  // Load the read-only engine (which CLI/model Vivi runs on) whenever the panel
  // opens, so it always reflects the current settings.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/vivi", { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as { engine?: ViviEngine }
        if (!cancelled && body.engine) setEngine(body.engine)
      } catch {
        // Non-fatal: the chat works without the badge.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  const send = useCallback(async () => {
    const message = draft.trim()
    if (message.length === 0 || sending) return
    setDraft("")
    setMessages((prev) => [...prev, { role: "user", text: message }])
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
        error?: string
      }
      if (!res.ok || body.ok === false || typeof body.reply !== "string") {
        toast.error("Vivi could not respond", { description: body.error ?? `HTTP ${res.status}` })
        // Drop the optimistic user bubble's turn state back to idle; the message
        // stays visible so the user can retry with the same text.
        return
      }
      if (body.sessionId) setSessionId(body.sessionId)
      const wrote = body.wrote ?? []
      setMessages((prev) => [
        ...prev,
        { role: "vivi", text: body.reply as string, wrote, rejected: body.rejected },
      ])
      if (body.rejected) {
        toast.error("Vivi's writes were rejected", { description: body.rejected })
      } else if (wrote.length > 0) {
        onWrote?.(wrote)
      }
    } catch (error) {
      toast.error("Vivi could not respond", {
        description: error instanceof Error ? error.message : "network error",
      })
    } finally {
      setSending(false)
    }
  }, [draft, sending, sessionId, onWrote])

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="flex items-center gap-1.5">
            <Sparkles className="size-4" aria-hidden />
            Build the spec with Vivi
          </SheetTitle>
          <SheetDescription>
            Vivi grills you until your idea is a rigorous canonical spec, writing Markdown into{" "}
            <code className="text-foreground">.vivicy/</code> as areas settle.
          </SheetDescription>
          {engine ? (
            <div className="flex items-center gap-1.5 pt-1">
              <span className="text-xs text-muted-foreground">Engine</span>
              <Badge variant="outline" title="Set in Agent settings — not editable here">
                {engine.providerLabel} · {engine.model}
              </Badge>
            </div>
          ) : null}
        </SheetHeader>

        <MessageScrollerProvider>
          <MessageScroller className="flex-1">
            <MessageScrollerViewport>
              <MessageScrollerContent className="gap-3 p-4">
                {messages.length === 0 && !sending ? (
                  <p className="text-xs text-muted-foreground">
                    Tell Vivi what you want to build — a sentence is enough to start. Vivi
                    will ask the questions that turn it into a complete spec.
                  </p>
                ) : null}
                {messages.map((message, i) => (
                  <MessageScrollerItem key={i}>
                    <MessageBubble message={message} />
                  </MessageScrollerItem>
                ))}
                {sending ? (
                  <MessageScrollerItem scrollAnchor>
                    <PendingMarker />
                  </MessageScrollerItem>
                ) : null}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="flex items-end gap-2 border-t border-border p-3">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Message Vivi…  (Enter to send, Shift+Enter for a new line)"
            disabled={sending}
            rows={2}
            aria-label="Message Vivi"
            className="max-h-40 flex-1 resize-none"
          />
          <Button
            type="button"
            size="icon-sm"
            onClick={() => void send()}
            disabled={sending || draft.trim().length === 0}
            aria-label="Send message"
          >
            <SendHorizontal />
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** The turn-based pending state — a shadcn Marker with a spinner while the exec runs. */
function PendingMarker() {
  return (
    <Marker>
      <MarkerIcon>
        <Loader2 className="animate-spin" />
      </MarkerIcon>
      <MarkerContent>Vivi is thinking…</MarkerContent>
    </Marker>
  )
}
