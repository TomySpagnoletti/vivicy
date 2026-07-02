"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { SendHorizontal, Sparkles } from "lucide-react"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
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
 * plus the `.md` files Vivi wrote (shown as chips on the bubble). Turn-based: there is
 * no token streaming in v0.5.0, so a pending turn shows a Skeleton placeholder.
 *
 * Agent selection is read-only here (P6): the engine badge shows which CLI + model
 * Vivi runs on, read from settings; it is never editable from the chat.
 * Strictly ShadcnUI primitives.
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

  const scrollRef = useRef<HTMLDivElement>(null)

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

  // Keep the newest message in view as the conversation grows / a turn resolves.
  useEffect(() => {
    const node = scrollRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages, sending])

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
            Vivi grills your idea into a rigorous canonical spec, writing Markdown into{" "}
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

        <ScrollArea className="flex-1">
          <div ref={scrollRef} className="flex flex-col gap-3 p-4">
            {messages.length === 0 && !sending ? (
              <p className="text-xs text-muted-foreground">
                Tell Vivi what you want to build — a sentence is enough to start. Vivi
                will ask the questions that turn it into a complete spec.
              </p>
            ) : null}
            {messages.map((message, i) => (
              <MessageBubble key={i} message={message} />
            ))}
            {sending ? <PendingBubble /> : null}
          </div>
        </ScrollArea>

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

/** The turn-based pending placeholder — a Vivi-side Skeleton while the exec runs. */
function PendingBubble() {
  return (
    <div className="flex w-full justify-start">
      <div className="flex max-w-[85%] flex-col gap-1.5">
        <div className="flex flex-col gap-1.5 border border-border bg-background px-3 py-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-3 w-56" />
          <Skeleton className="h-3 w-32" />
        </div>
        <span className="text-xs text-muted-foreground">Vivi is thinking…</span>
      </div>
    </div>
  )
}
