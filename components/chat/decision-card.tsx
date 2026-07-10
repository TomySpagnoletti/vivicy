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

export function DecisionCard({
  sessionId,
  card,
  decided,
  onDecided,
}: {
  sessionId: string
  card: ViviCard
  decided?: ViviCardDecision
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
      // body.decided is populated on any decided outcome (success, executed-but-failed, already-decided) and absent only when nothing was recorded — trust its presence to lock the buttons.
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
          {/* aria-disabled + a guarded onClick, never the native disabled: disabling the focused button on activation would drop keyboard focus to <body> (the panel is DOM-last, so Tab would restart behind the overlay). */}
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
