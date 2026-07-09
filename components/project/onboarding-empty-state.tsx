"use client"

import { useEffect, useRef } from "react"
import { Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import { Button } from "@/components/ui/button"
import { useViviPanel } from "@/components/chat/vivi-panel-context"

/**
 * The calm `no_target` state (W4b): the full-screen chooser is retired —
 * onboarding lives INSIDE the Vivi panel now, so the map area only says so and
 * offers one way in. The panel AUTO-OPENS once on the first `no_target` render
 * (this component's mount); if the user closes it, this stays quiet and the
 * button (or the launcher bubble) reopens it — zero further automatism (P7).
 */
export function OnboardingEmptyState() {
  const t = useTranslations("project.onboardingEmptyState")
  const { openPanel } = useViviPanel()

  const autoOpenedRef = useRef(false)
  useEffect(() => {
    if (autoOpenedRef.current) return
    autoOpenedRef.current = true
    openPanel()
  }, [openPanel])

  return (
    <div className="flex h-svh w-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span
        aria-hidden
        className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        <Sparkles className="size-5" />
      </span>
      <p className="max-w-md text-sm text-muted-foreground">
        {t("description", { brandName: BRAND.name })}
      </p>
      <Button size="sm" onClick={openPanel}>
        <Sparkles />
        {t("openVivi")}
      </Button>
    </div>
  )
}
