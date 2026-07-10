"use client"

import { useCallback } from "react"
import { CheckCircle2, Copy, HelpCircle, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"

export function AgentStatusBadge({
  ok,
  okLabel,
  badLabel,
  unknown,
  unknownLabel,
}: {
  ok: boolean
  okLabel: string
  badLabel: string
  unknown: boolean
  unknownLabel?: string
}) {
  const t = useTranslations("agents")
  if (unknown) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <HelpCircle className="size-3" />
        {unknownLabel ?? t("unknown")}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1">
      {ok ? (
        <CheckCircle2 className="size-3 text-primary" />
      ) : (
        <XCircle className="size-3 text-destructive" />
      )}
      {ok ? okLabel : badLabel}
    </Badge>
  )
}

export function CopyableCommand({
  hint,
  command,
  label,
}: {
  hint: string
  command: string
  label: string
}) {
  const t = useTranslations("agents")
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success(t("copy"), { description: command })
    } catch {
      toast.error(t("copyFailedTitle"), { description: t("copyFailedDescription") })
    }
  }, [command, t])

  return (
    <div className="flex flex-col gap-1.5">
      <Separator />
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-stretch gap-2">
        {/* tabIndex+aria-label: keyboard users must be able to reach/scroll this overflowing line, not just mouse-scroll it. */}
        <code
          tabIndex={0}
          aria-label={t("commandScrollAriaLabel", { label })}
          className="flex-1 overflow-x-auto border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {command}
        </code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={t("copyAriaLabel", { label })}
          onClick={copy}
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}
