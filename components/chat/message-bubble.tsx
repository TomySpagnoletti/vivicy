"use client"

import { CircleAlert, FileText } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { cn } from "@/lib/utils"

/** One message in the Vivi conversation, mirroring `lib/vivi.ts` `ViviTurn`. */
export interface ChatMessage {
  role: "user" | "vivi"
  text: string
  /** Repo-relative `.md` paths a Vivi turn wrote (rendered as chips). */
  wrote?: string[]
  /** Set on a Vivi turn whose writes were rejected + rolled back. */
  rejected?: string
}

/**
 * A single chat bubble: a right-aligned muted Card for the user, a left-aligned
 * bordered Card for Vivi. A Vivi turn that wrote files shows one "wrote" Badge per
 * path; a rejected turn shows a destructive notice (the writes were rolled back).
 * Pure shadcn primitives (Card, Badge) — no raw colors.
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"
  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div className={cn("flex max-w-[85%] flex-col gap-1.5", isUser ? "items-end" : "items-start")}>
        <Card
          data-role={message.role}
          className={cn(
            "px-3 py-2 text-xs/relaxed whitespace-pre-wrap",
            isUser ? "bg-muted text-foreground" : "bg-background text-foreground"
          )}
        >
          {message.text}
        </Card>

        {message.rejected ? (
          <p className="flex items-start gap-1.5 text-left text-xs text-destructive">
            <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{message.rejected}</span>
          </p>
        ) : null}

        {!isUser && message.wrote && message.wrote.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">wrote</span>
            {message.wrote.map((file) => (
              <Badge key={file} variant="secondary" className="gap-1 font-mono" title={file}>
                <FileText className="size-3" aria-hidden />
                {file}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
