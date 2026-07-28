"use client"

import { useRef, useState } from "react"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ViviCard, ViviCardAction, ViviCardDecision } from "@/lib/vivi"
import { IMPORT_ACCEPT_ATTR } from "@/lib/supported-extensions"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import {
  MenuCard,
  MenuCardActions,
  MenuCardBody,
  MenuCardStamp,
  MenuCardTitle,
} from "@/components/chat/menu-card"

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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importActionRef = useRef<ViviCardAction | null>(null)

  const decision = decided ?? localDecision
  const disabled = decision !== null || pendingId !== null
  const decidedAction = decision
    ? card.actions.find((a) => a.id === decision.actionId)
    : null
  const hasImport = card.actions.some((a) => a.action.kind === "import_docs")
  const hasCr = card.actions.some((a) => a.action.kind === "cr_decide")
  const kind = hasImport ? "documents" : hasCr ? "changeRequest" : "decision"
  const outcome = decision
    ? t("cardDecided", { label: decidedAction?.label ?? decision.actionId }) +
      (decision.summary ? ` — ${decision.summary}` : "")
    : null

  type Outcome = { ok?: boolean; summary?: string; error?: string; decided?: ViviCardDecision }
  // body.decided is populated on any decided outcome (success, executed-but-failed, already-decided) and absent only when nothing was recorded — trust its presence to lock the buttons.
  const record = (res: Response, body: Outcome, action: ViviCardAction) => {
    const failed = !res.ok || body.ok === false
    const recorded =
      body.decided ??
      (failed
        ? null
        : { actionId: action.id, at: new Date().toISOString(), summary: body.summary })
    if (recorded) setLocalDecision(recorded)
    if (failed) setError(body.error ?? body.summary ?? t("cardFailed"))
    if (recorded) onDecided?.(action)
  }

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
      const body = (await res.json().catch(() => ({}))) as Outcome
      record(res, body, action)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("networkError"))
    } finally {
      setPendingId(null)
    }
  }

  const importDocs = async (action: ViviCardAction, files: File[]) => {
    setPendingId(action.id)
    setError(null)
    try {
      const form = new FormData()
      form.append("sessionId", sessionId)
      form.append("cardId", card.id)
      form.append("actionId", action.id)
      for (const file of files) {
        form.append("files", file)
        form.append(
          "paths",
          (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
        )
      }
      const res = await fetch("/api/vivi/card/import", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as Outcome
      record(res, body, action)
    } catch (err) {
      setError(err instanceof Error ? err.message : t("networkError"))
    } finally {
      setPendingId(null)
    }
  }

  // import_docs is a two-phase decision: the click opens a native picker, and the upload — not the click — is what decides the card. Cancelling the picker leaves the card untouched.
  const onActionClick = (action: ViviCardAction) => {
    if (disabled) return
    if (action.action.kind === "import_docs") {
      importActionRef.current = action
      fileInputRef.current?.click()
      return
    }
    void decide(action)
  }

  return (
    <div className="flex flex-col gap-2">
      <MenuCard
        eyebrow={t(`cardKind.${kind}`)}
        turned={hasImport && decision !== null}
        back={
          hasImport ? (
            <MenuCardStamp role="status">
              {decision?.summary ?? outcome}
            </MenuCardStamp>
          ) : undefined
        }
      >
        <MenuCardTitle>{card.title}</MenuCardTitle>

        {card.body ? <MenuCardBody>{card.body}</MenuCardBody> : null}

        <MenuCardActions>
          <div className="flex flex-wrap gap-2">
            {/* aria-disabled + a guarded onClick, never the native disabled: disabling the focused button on activation would drop keyboard focus to <body> (the panel is DOM-last, so Tab would restart behind the overlay). */}
            {card.actions.map((action) => (
              <Button
                key={action.id}
                type="button"
                variant={action.variant ?? "default"}
                size="sm"
                aria-disabled={disabled}
                onClick={() => onActionClick(action)}
                className={disabled ? "opacity-60" : undefined}
              >
                {pendingId === action.id ? (
                  <Loader2 className="animate-spin" />
                ) : null}
                {action.label}
              </Button>
            ))}
          </div>

          {hasImport ? (
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={IMPORT_ACCEPT_ATTR}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? [])
                const action = importActionRef.current
                importActionRef.current = null
                event.target.value = ""
                if (action && files.length > 0) void importDocs(action, files)
              }}
            />
          ) : null}

          {outcome && !hasImport ? (
            <Marker role="status">
              <MarkerIcon>
                <Check />
              </MarkerIcon>
              <MarkerContent>{outcome}</MarkerContent>
            </Marker>
          ) : null}
        </MenuCardActions>
      </MenuCard>

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
