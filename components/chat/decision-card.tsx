"use client"

import { useState } from "react"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ViviCard, ViviCardAction, ViviCardDecision } from "@/lib/vivi"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"

/**
 * The GENERIC in-chat decision card (D6): deterministic server-authored content
 * rendered as one shadcn Card with one Button per action. The CLICK is the only
 * trigger — it POSTs `/api/vivi/card` and the SERVER validates + records the
 * outcome; this component never interprets the action itself. Buttons disable
 * while the click is in flight and FOREVER once decided (whether the decision
 * came stamped on the rehydrated turn or from this click's response), so a card
 * can never fire twice from the UI either.
 */
export function DecisionCard({
  sessionId,
  card,
  decided,
  onDecided,
}: {
  sessionId: string
  card: ViviCard
  /** The decision persisted on the turn (rehydration) — always wins over local state. */
  decided?: ViviCardDecision
  /** Fires once the server recorded the click, so the caller can re-sync the thread. */
  onDecided?: (action: ViviCardAction) => void
}) {
  const t = useTranslations("chat")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [localDecision, setLocalDecision] = useState<ViviCardDecision | null>(
    null
  )
  const [error, setError] = useState<string | null>(null)

  const decision = decided ?? localDecision
  const disabled = decision !== null || pendingId !== null
  const decidedAction = decision
    ? card.actions.find((a) => a.id === decision.actionId)
    : null

  const decide = async (action: ViviCardAction) => {
    if (disabled) return
    setPendingId(action.id)
    setError(null)
    try {
      const res = await fetch("/api/vivi/card", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          cardId: card.id,
          actionId: action.id,
        }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        summary?: string
        error?: string
        decided?: ViviCardDecision
      }
      const failed = !res.ok || body.ok === false
      // The server stamps `decided` on ANY decided outcome — success, an
      // executed-but-failed action, or an already-decided card — so trust it as
      // the card's permanent decision and lock the buttons. Only a decision-less
      // failure (a validation error that recorded nothing) leaves them open to retry.
      const recorded =
        body.decided ??
        (failed
          ? null
          : {
              actionId: action.id,
              at: new Date().toISOString(),
              summary: body.summary,
            })
      if (recorded) setLocalDecision(recorded)
      if (failed) setError(body.error ?? body.summary ?? t("cardFailed"))
      if (recorded) onDecided?.(action)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("networkError"))
    } finally {
      setPendingId(null)
    }
  }

  return (
    <Card className="gap-3 [--card-spacing:--spacing(3)]">
      <CardHeader className="gap-1">
        <CardTitle>{card.title}</CardTitle>
      </CardHeader>

      {card.body ? (
        <CardContent className="text-xs/relaxed whitespace-pre-wrap text-muted-foreground">
          {card.body}
        </CardContent>
      ) : null}

      <CardFooter className="flex-col items-start gap-2">
        <div className="flex flex-wrap gap-2">
          {/* aria-disabled + a guarded onClick, never the native `disabled`:
              disabling the focused button on activation would drop keyboard focus
              to <body> (the panel is DOM-last, so Tab would restart in the page
              behind the overlay). The button stays focusable; the guard makes it
              inert. */}
          {card.actions.map((action) => (
            <Button
              key={action.id}
              type="button"
              variant={action.variant ?? "default"}
              size="sm"
              aria-disabled={disabled}
              onClick={() => void decide(action)}
              className={disabled ? "opacity-60" : undefined}
            >
              {pendingId === action.id ? (
                <Loader2 className="animate-spin" />
              ) : null}
              {action.label}
            </Button>
          ))}
        </div>

        {/* role="status": the outcome of the click is announced to screen
            readers — without it a keyboard/SR user gets no confirmation at all. */}
        {decision ? (
          <Marker role="status">
            <MarkerIcon>
              <Check />
            </MarkerIcon>
            <MarkerContent>
              {t("cardDecided", {
                label: decidedAction?.label ?? decision.actionId,
              })}
              {decision.summary ? ` — ${decision.summary}` : ""}
            </MarkerContent>
          </Marker>
        ) : null}

        {error ? (
          <Marker role="status" className="text-destructive">
            <MarkerIcon>
              <CircleAlert />
            </MarkerIcon>
            <MarkerContent>{error}</MarkerContent>
          </Marker>
        ) : null}
      </CardFooter>
    </Card>
  )
}
