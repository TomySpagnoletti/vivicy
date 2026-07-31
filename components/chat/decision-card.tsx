"use client"

import { useRef, useState } from "react"
import { Check, CircleAlert, Loader2 } from "lucide-react"
import { useTranslations } from "next-intl"

import type { ViviCard, ViviCardAction, ViviCardDecision } from "@/lib/vivi"
import { errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { IMPORT_ACCEPT_ATTR } from "@/lib/supported-extensions"
import { Button } from "@/components/ui/button"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { MenuCard, MenuCardActions, MenuCardBody, MenuCardStamp, MenuCardTitle } from "@/components/chat/menu-card"

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
  const tErrors = useTranslations("errors")
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [localDecision, setLocalDecision] = useState<ViviCardDecision | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const importActionRef = useRef<ViviCardAction | null>(null)

  const decision = decided ?? localDecision
  const disabled = decision !== null || pendingId !== null
  const decidedAction = decision ? card.actions.find((a) => a.id === decision.actionId) : null
  const hasImport = card.actions.some((a) => a.action.kind === "import_docs")
  const hasCr = card.actions.some((a) => a.action.kind === "cr_decide")
  const kind = hasImport ? "documents" : hasCr ? "changeRequest" : "decision"
  const outcome = decision
    ? t("cardDecided", { label: decidedAction?.label ?? decision.actionId }) + (decision.summary ? ` — ${decision.summary}` : "")
    : null

  type Outcome = { ok?: boolean; summary?: string; error?: string; code?: string; decided?: ViviCardDecision }
  // Never widen this family list to `control`: resolution is per family, and that catalogue's copy is false or less informative than the server's own sentence for the codes this card receives.
  const record = (res: Response, body: Outcome, action: ViviCardAction) => {
    const failed = !res.ok || body.ok === false
    if (body.decided) {
      setLocalDecision(body.decided)
      onDecided?.(action)
    }
    if (!failed) return
    const fallback = body.error ?? body.summary ?? t("cardFailed")
    setError(body.code ? errorTextAcrossFamilies(tErrors, ["import"], body.code, fallback) : fallback)
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
        form.append("paths", (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
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
        back={hasImport ? <MenuCardStamp role="status">{decision?.summary ?? outcome}</MenuCardStamp> : undefined}
      >
        <MenuCardTitle>{card.title}</MenuCardTitle>

        {card.body ? <MenuCardBody>{card.body}</MenuCardBody> : null}

        <MenuCardActions>
          <div className="flex flex-wrap gap-2">
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
                {pendingId === action.id ? <Loader2 className="animate-spin" /> : null}
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
