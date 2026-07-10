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

/** Mirrors `lib/vivi.ts`'s `ViviTurn`. */
export interface ChatMessage {
  role: "user" | "vivi"
  text: string
  wrote?: string[]
  rejected?: string
}

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
