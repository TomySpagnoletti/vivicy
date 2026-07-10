"use client"

import { Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import { InsiemeIllustration } from "@/components/brand/insieme-illustration"
import { Button } from "@/components/ui/button"
import { useViviPanel } from "@/components/chat/vivi-panel-context"

export function OnboardingEmptyState() {
  const t = useTranslations("project.onboardingEmptyState")
  const { openPanel } = useViviPanel()

  return (
    <div
      data-empty-reason="no_target"
      className="flex h-svh w-full flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <InsiemeIllustration />
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
