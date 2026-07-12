"use client"

import { useCallback, useState } from "react"
import { ArrowLeft, FolderOpen, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import type { CurrentProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { OpenProjectForm } from "@/components/project/open-project-form"
import { StartGovernanceForm } from "@/components/project/start-governance-form"

type OnboardingView = "choices" | "open" | "govern"

export function ViviOnboarding({
  onAcquired,
  onGoverned,
}: {
  onAcquired: (project: CurrentProject) => void
  onGoverned: (project: CurrentProject) => void
}) {
  const t = useTranslations("project.viviOnboarding")
  const [view, setView] = useState<OnboardingView>("choices")

  const back = useCallback(() => setView("choices"), [])

  if (view === "choices") {
    return (
      <div className="flex flex-col gap-4 p-4">
        <h3 className="text-center font-heading text-base font-medium text-foreground">
          {t("heading")}
        </h3>
        <div className="flex flex-col gap-2">
          <ChoiceButton
            icon={<FolderOpen className="size-4" />}
            title={t("choices.open.title")}
            description={t("choices.open.description", { brandName: BRAND.name })}
            onClick={() => setView("open")}
          />
          <ChoiceButton
            icon={<Sparkles className="size-4" />}
            title={t("choices.govern.title")}
            description={t("choices.govern.description", { brandName: BRAND.name })}
            onClick={() => setView("govern")}
          />
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-1.5">
        <Button type="button" variant="ghost" size="icon-sm" aria-label={t("back")} onClick={back}>
          <ArrowLeft />
        </Button>
        <h3 className="font-heading text-sm font-medium text-foreground">
          {view === "open" ? t("choices.open.title") : t("choices.govern.title")}
        </h3>
      </div>

      {view === "open" ? <OpenProjectForm active onChanged={onAcquired} /> : null}

      {view === "govern" ? <StartGovernanceForm active onGoverned={onGoverned} /> : null}
    </div>
  )
}

function ChoiceButton({
  icon,
  title,
  description,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  description: string
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      className="h-auto w-full justify-start gap-3 px-3 py-3 text-left whitespace-normal"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
      >
        {icon}
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{title}</span>
        <span className="text-xs font-normal text-muted-foreground">{description}</span>
      </span>
    </Button>
  )
}
