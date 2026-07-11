"use client"

import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, FileUp, FolderOpen, FolderPlus, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { BRAND } from "@/lib/brand"
import { errorText } from "@/lib/i18n-errors"
import type { CurrentProject, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderBrowser } from "@/components/project/folder-browser"
import { ImportDocsFlow } from "@/components/project/import-docs-flow"
import { OpenProjectForm } from "@/components/project/open-project-form"

type OnboardingView = "choices" | "open" | "scaffold" | "import"

export function ViviOnboarding({
  onAcquired,
  onScaffolded,
}: {
  onAcquired: (project: CurrentProject) => void
  onScaffolded: (project: CurrentProject) => void
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
            title={t("choices.scaffold.title")}
            description={t("choices.scaffold.description", { brandName: BRAND.name })}
            onClick={() => setView("scaffold")}
          />
          <ChoiceButton
            icon={<FileUp className="size-4" />}
            title={t("choices.import.title")}
            description={t("choices.import.description", { brandName: BRAND.name })}
            onClick={() => setView("import")}
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
          {view === "open"
            ? t("choices.open.title")
            : view === "scaffold"
              ? t("choices.scaffold.title")
              : t("choices.import.title")}
        </h3>
      </div>

      {view === "open" ? <OpenProjectForm active onChanged={onAcquired} /> : null}

      {view === "scaffold" ? <ScaffoldForm onScaffolded={onScaffolded} /> : null}

      {view === "import" ? <ImportDocsFlow active onImported={onAcquired} /> : null}
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

function ScaffoldForm({ onScaffolded }: { onScaffolded: (project: CurrentProject) => void }) {
  const t = useTranslations("project.scaffoldForm")
  const tErrors = useTranslations("errors")
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [folderName, setFolderName] = useState("")

  useEffect(() => {
    void (async () => {
      setProjectName("")
      setFolderName("")
    })()
  }, [])

  const targetDir = (() => {
    const folder = folderName.trim()
    if (!listing || folder.length === 0) return ""
    return `${listing.path.replace(/\/$/, "")}/${folder}`
  })()

  const name = projectName.trim()
  const canScaffold = name.length > 0 && targetDir.length > 0 && !scaffolding && !browserBusy

  const scaffold = useCallback(async () => {
    if (!canScaffold) return
    setScaffolding(true)
    try {
      const res = await fetch("/api/project/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDir, projectName: name }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        code?: string
        project?: CurrentProject
      }
      if (!res.ok || body.ok === false || !body.project) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.errorTitle"), {
          description: body.code ? errorText(tErrors, `scaffold.${body.code}`, fallback) : fallback,
        })
        return
      }
      toast.success(t("toast.successTitle"), {
        description: t("toast.successDescription", { root: body.project.root }),
      })
      onScaffolded(body.project)
    } catch (error) {
      toast.error(t("toast.errorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setScaffolding(false)
    }
  }, [canScaffold, targetDir, name, onScaffolded, t, tErrors])

  const busy = browserBusy || scaffolding

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void scaffold()
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scaffold-name">{t("nameLabel")}</Label>
        <Input
          id="scaffold-name"
          value={projectName}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("namePlaceholder")}
          disabled={busy}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>{t("locationLabel")}</Label>
        <FolderBrowser
          open
          disabled={scaffolding}
          onListingChange={setListing}
          onBusyChange={setBrowserBusy}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scaffold-folder">{t("folderLabel")}</Label>
        <Input
          id="scaffold-folder"
          value={folderName}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("folderPlaceholder")}
          disabled={busy}
          onChange={(event) => setFolderName(event.target.value)}
        />
      </div>

      {targetDir.length > 0 ? (
        <p className="text-xs break-all text-muted-foreground">
          {t.rich("targetPreview", {
            target: (chunks) => <span className="text-foreground">{chunks}</span>,
            targetDir,
          })}
        </p>
      ) : null}

      <Button type="submit" variant="default" disabled={!canScaffold} className="w-full">
        <FolderPlus />
        {scaffolding ? t("submit.scaffolding") : t("submit.idle")}
      </Button>
    </form>
  )
}
