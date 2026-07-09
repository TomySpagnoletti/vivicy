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

/**
 * The panel-hosted onboarding view (W4b, owner point 7): when no target project
 * is resolved, the Vivi panel's thread area hosts this deterministic chooser
 * instead of the chat — three user-driven choices (P7: S0/S1 are buttons, zero
 * automatism), each expanding IN-PANEL with a back affordance:
 *
 *   - Open an existing project — the shared {@link OpenProjectForm} (same form
 *     the setup bar's switcher dialog wraps).
 *   - Start a new project — the scaffold form (name + browsed parent + folder
 *     name, or an absolute override), `POST /api/project/scaffold`.
 *   - Import documents — acquisition FIRST (imports need a target to land in),
 *     then the staged {@link ImportDocsFlow} (stage → verify → apply).
 *
 * `onAcquired` fires the moment a project is persisted — for ALL three legs,
 * including import (as soon as the target is chosen). The import view then stays
 * open to keep staging: a freshly acquired import target has no `.vivicy/` map yet,
 * so the page keeps reporting `no_target` and the panel stays in this onboarding
 * view until the applied docs produce a spec. Reporting immediately is what makes
 * closing the panel mid-import safe — the acquisition is already on record instead
 * of being deferred to Apply/Back and lost on an early close.
 */
export function ViviOnboarding({
  onAcquired,
}: {
  onAcquired: (project: CurrentProject) => void
}) {
  const t = useTranslations("project.viviOnboarding")
  const [view, setView] = useState<OnboardingView>("choices")
  const [importTarget, setImportTarget] = useState<CurrentProject | null>(null)

  const back = useCallback(() => setView("choices"), [])

  if (view === "choices") {
    return (
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-1">
          <h3 className="font-heading text-sm font-medium text-foreground">{t("heading")}</h3>
          <p className="text-xs text-muted-foreground">
            {t("description", { brandName: BRAND.name })}
          </p>
        </div>
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

      {view === "scaffold" ? <ScaffoldForm onScaffolded={onAcquired} /> : null}

      {view === "import" && importTarget === null ? (
        <>
          <p className="text-xs text-muted-foreground">{t("importPickTargetHint")}</p>
          {/* Report the acquisition the instant the target is persisted (parity
              with open/scaffold), then advance to staging in the same view. */}
          <OpenProjectForm
            active
            onChanged={(project) => {
              setImportTarget(project)
              onAcquired(project)
            }}
          />
        </>
      ) : null}

      {view === "import" && importTarget !== null ? (
        <ImportDocsFlow active onApplied={() => onAcquired(importTarget)} />
      ) : null}
    </div>
  )
}

/** One full-width onboarding choice: icon + title + one-line description. */
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

/**
 * The scaffold (start-from-scratch, R9) form, ported from the retired
 * ScaffoldDialog: a project name plus a target folder — browsed PARENT joined
 * with a new folder name, or a direct absolute path — POSTed to
 * `POST /api/project/scaffold`. An empty or non-existent folder gets the full
 * lean skeleton; a populated folder gets only the MISSING Vivicy files, never
 * clobbering existing ones (add-to-existing-repo).
 */
function ScaffoldForm({ onScaffolded }: { onScaffolded: (project: CurrentProject) => void }) {
  const t = useTranslations("project.scaffoldForm")
  const tErrors = useTranslations("errors")
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [folderName, setFolderName] = useState("")
  const [absoluteOverride, setAbsoluteOverride] = useState("")

  // Reset the fields on mount; the browser re-browses itself from its `open`
  // prop. The state writes live inside the async closure (not the effect body)
  // so they don't fire synchronously during the render commit.
  useEffect(() => {
    void (async () => {
      setProjectName("")
      setFolderName("")
      setAbsoluteOverride("")
    })()
  }, [])

  // The resolved target directory: an explicit absolute override wins; otherwise
  // the browsed parent joined with the new folder name.
  const targetDir = (() => {
    const override = absoluteOverride.trim()
    if (override.length > 0) return override
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
          disabled={busy || absoluteOverride.trim().length > 0}
          onChange={(event) => setFolderName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="scaffold-abs">{t("absoluteLabel")}</Label>
        <Input
          id="scaffold-abs"
          value={absoluteOverride}
          spellCheck={false}
          autoComplete="off"
          placeholder={t("absolutePlaceholder")}
          disabled={busy}
          onChange={(event) => setAbsoluteOverride(event.target.value)}
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

      <Button type="submit" size="sm" disabled={!canScaffold} className="self-end">
        <FolderPlus />
        {scaffolding ? t("submit.scaffolding") : t("submit.idle")}
      </Button>
    </form>
  )
}
