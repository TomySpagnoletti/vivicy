"use client"

import { useEffect, useId, useRef, useState } from "react"
import { CircleAlert, CornerDownLeft, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import { MAX_OTHER_ANSWER_LENGTH, type ViviQuestion, type ViviQuestionStack } from "@/lib/vivi-questions"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { MenuCard, MenuCardActions, MenuCardPile, MenuCardTitle } from "@/components/chat/menu-card"

export interface QuestionAnswerOutcome {
  remaining: number
  takeFocus: boolean
}

const OTHER_KEY = "other"

export function QuestionStack({
  sessionId,
  stack,
  remaining,
  onAnswered,
}: {
  sessionId: string
  stack: ViviQuestionStack
  remaining: ViviQuestion[]
  onAnswered?: (outcome: QuestionAnswerOutcome) => void
}) {
  const t = useTranslations("chat")
  const titleId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const firstOptionRef = useRef<HTMLButtonElement>(null)
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState("")

  const active = remaining[0]
  const total = stack.questions.length
  const index = total - remaining.length + 1

  // Never latch a take-focus flag at click time: read where the focus IS when the pile advances, or a stale latch yanks it back long after it legitimately moved.
  const previousIdRef = useRef(active?.id)
  useEffect(() => {
    const previous = previousIdRef.current
    previousIdRef.current = active?.id
    if (previous === undefined || previous === active?.id) return
    const dropped = document.activeElement === null || document.activeElement === document.body
    if (dropped) firstOptionRef.current?.focus({ preventScroll: true })
  }, [active?.id])

  const answer = async (key: string, payload: { optionIndex?: number; other?: string }) => {
    if (pending !== null || active === undefined) return
    const held = document.activeElement === document.body || rootRef.current?.contains(document.activeElement) === true
    setPending(key)
    setError(null)
    try {
      const res = await fetch("/api/vivi/questions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          stackId: stack.id,
          questionId: active.id,
          ...payload,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        remaining?: number
        error?: string
      }
      // A 409 means this card already carries its line: resync, never surface an error.
      if (!res.ok && res.status !== 409) {
        setError(body.error ?? t("questionFailed"))
        return
      }
      setDraft("")
      onAnswered?.({ remaining: body.remaining ?? remaining.length - 1, takeFocus: held })
    } catch (err) {
      setError(err instanceof Error ? err.message : t("networkError"))
    } finally {
      setPending(null)
    }
  }

  if (active === undefined) return null

  const busy = pending !== null

  return (
    <div ref={rootRef} className="flex flex-col gap-2">
      <MenuCardPile depth={remaining.length - 1}>
        <MenuCard
          key={active.id}
          eyebrow={t("questionCounter", { index, total })}
          className="motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
        >
          <MenuCardTitle id={titleId}>{active.question}</MenuCardTitle>

          <MenuCardActions className="gap-1.5">
            <ul role="list" aria-labelledby={titleId} className="flex w-full flex-col gap-1.5">
              {active.options.map((option, optionIndex) => (
                <li key={option.label}>
                  <Button
                    ref={optionIndex === 0 ? firstOptionRef : undefined}
                    type="button"
                    variant="outline"
                    aria-disabled={busy}
                    onClick={() => void answer(`option-${optionIndex}`, { optionIndex })}
                    className={cn(
                      "h-auto w-full justify-start gap-2 py-2 text-left whitespace-normal",
                      option.recommended && "border-primary/40",
                      busy && "opacity-60"
                    )}
                  >
                    {pending === `option-${optionIndex}` ? <Loader2 className="animate-spin" /> : null}
                    <span className="min-w-0 flex-1">{option.label}</span>
                    {option.recommended ? (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[10px] font-medium">
                        {t("questionRecommended")}
                      </Badge>
                    ) : null}
                  </Button>
                </li>
              ))}
            </ul>

            <form
              className="flex w-full items-center gap-1.5 pt-2.5"
              onSubmit={(event) => {
                event.preventDefault()
                const other = draft.trim()
                if (other.length === 0) return
                void answer(OTHER_KEY, { other })
              }}
            >
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={MAX_OTHER_ANSWER_LENGTH}
                placeholder={t("questionOtherPlaceholder")}
                aria-label={t("questionOtherAriaLabel")}
              />
              <Button
                type="submit"
                size="icon-sm"
                variant="ghost"
                aria-disabled={busy || draft.trim().length === 0}
                aria-label={t("questionOtherSubmit")}
                className={cn("shrink-0 text-muted-foreground", (busy || draft.trim().length === 0) && "opacity-60")}
              >
                {pending === OTHER_KEY ? <Loader2 className="animate-spin" /> : <CornerDownLeft />}
              </Button>
            </form>
          </MenuCardActions>
        </MenuCard>
      </MenuCardPile>

      {error ? (
        <Marker role="status" className="text-destructive">
          <MarkerIcon>
            <CircleAlert />
          </MarkerIcon>
          <MarkerContent>{error}</MarkerContent>
        </Marker>
      ) : null}
    </div>
  )
}
