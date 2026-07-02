"use client"

import { CircleAlert, FileText } from "lucide-react"

import {
  Attachment,
  AttachmentContent,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageFooter } from "@/components/ui/message"

/** One message in the Vivi conversation, mirroring `lib/vivi.ts` `ViviTurn`. */
export interface ChatMessage {
  role: "user" | "vivi"
  text: string
  /** Repo-relative `.md` paths a Vivi turn wrote (rendered as attachments). */
  wrote?: string[]
  /** Set on a Vivi turn whose writes were rejected + rolled back. */
  rejected?: string
}

/**
 * A single chat turn built from the dedicated shadcn chat primitives: a
 * `Message` (alignment), a `Bubble` (muted for the user, outline for Vivi), and a
 * `MessageFooter` carrying the turn's outcome — the `.md` files Vivi wrote as
 * `Attachment` chips, or a destructive `Marker` when the writes were rejected and
 * rolled back. No raw Tailwind design, no hand-rolled bubbles.
 */
export function MessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"
  const align = isUser ? "end" : "start"
  const wrote = message.wrote ?? []
  const hasFooter = Boolean(message.rejected) || (!isUser && wrote.length > 0)

  return (
    <Message align={align}>
      <MessageContent>
        <Bubble variant={isUser ? "muted" : "outline"} align={align}>
          <BubbleContent className="whitespace-pre-wrap">{message.text}</BubbleContent>
        </Bubble>

        {hasFooter ? (
          <MessageFooter className="flex-col items-start gap-1.5">
            {message.rejected ? (
              <Marker className="text-destructive">
                <MarkerIcon>
                  <CircleAlert />
                </MarkerIcon>
                <MarkerContent>{message.rejected}</MarkerContent>
              </Marker>
            ) : null}

            {!isUser && wrote.length > 0 ? (
              <AttachmentGroup>
                {wrote.map((file) => (
                  <Attachment key={file} size="sm" title={file}>
                    <AttachmentMedia>
                      <FileText />
                    </AttachmentMedia>
                    <AttachmentContent>
                      <AttachmentTitle className="font-mono">{file}</AttachmentTitle>
                    </AttachmentContent>
                  </Attachment>
                ))}
              </AttachmentGroup>
            ) : null}
          </MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  )
}
