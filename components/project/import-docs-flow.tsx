"use client"

import { useCallback, useEffect, useState } from "react"
import { Check, FileUp, Loader2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { BRAND } from "@/lib/brand"
import { errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { languageName } from "@/lib/i18n-language"
import type { CurrentProject, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { DocPicker, type DocSelection } from "@/components/project/doc-picker"
import { FolderBrowser } from "@/components/project/folder-browser"
import { cn } from "@/lib/utils"

const EMPTY_SELECTION: DocSelection = { accepted: [], rejectedCount: 0 }

export function ImportDocsFlow({
  active,
  onImported,
}: {
  active: boolean
  onImported: (project: CurrentProject) => void
}) {
  const t = useTranslations("project.importDocsDialog")
  const tErrors = useTranslations("errors")
  const locale = useLocale()
  const [selection, setSelection] = useState<DocSelection>(EMPTY_SELECTION)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    if (!active) return
    void (async () => {
      setSelection(EMPTY_SELECTION)
      setListing(null)
      setBrowserBusy(false)
      setImporting(false)
    })()
  }, [active])

  const step1Ready = selection.accepted.length > 0
  const canImport = step1Ready && listing !== null && !importing && !browserBusy

  const submit = useCallback(async () => {
    if (!canImport || listing === null) return
    setImporting(true)
    const form = new FormData()
    form.append("targetDir", listing.path)
    for (const { file, rel } of selection.accepted) {
      form.append("files", file)
      form.append("paths", rel)
    }
    try {
      const res = await fetch("/api/project/govern", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        project?: CurrentProject
        batch?: { language?: string; accepted?: unknown[]; rejected?: unknown[] } | null
        error?: string
        code?: string
      }
      if (!res.ok || body.ok === false || !body.project || !body.batch) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.importErrorTitle"), {
          description: body.code
            ? errorTextAcrossFamilies(tErrors, ["import", "scaffold"], body.code, fallback)
            : fallback,
        })
        return
      }
      const langName = languageName(body.batch.language, locale)
      const skipped = selection.rejectedCount + (body.batch.rejected?.length ?? 0)
      const parts = [t("toast.importedCount", { count: body.batch.accepted?.length ?? 0 })]
      if (langName) parts.push(t("toast.importedLang", { language: langName }))
      if (skipped > 0) parts.push(t("toast.importedSkipped", { count: skipped }))
      toast.success(t("toast.importedTitle"), { description: parts.join(" ") })
      onImported(body.project)
    } catch (error) {
      toast.error(t("toast.importErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setImporting(false)
    }
  }, [canImport, listing, locale, onImported, selection, t, tErrors])

  const targetDir = listing?.path ?? ""

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <StepHeader index={1} label={t("step1.label")} state={step1Ready ? "done" : "active"} />
        <DocPicker active={active} disabled={importing} onChange={setSelection} />
      </section>

      <section className="flex flex-col gap-2">
        <StepHeader
          index={2}
          label={t("step2.label")}
          state={!step1Ready ? "locked" : listing ? "done" : "active"}
        />

        {step1Ready ? (
          <p className="text-xs text-muted-foreground">
            {t("step2.hint", { brandName: BRAND.name })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("step2.lockedHint")}</p>
        )}

        <div className={cn(!step1Ready && "pointer-events-none opacity-50")}>
          <FolderBrowser
            open={active}
            allowCreate
            disabled={!step1Ready || importing}
            onListingChange={setListing}
            onBusyChange={setBrowserBusy}
          />
        </div>

        {step1Ready && targetDir.length > 0 ? (
          <p className="text-xs break-all text-muted-foreground">
            {t.rich("step2.targetPreview", {
              target: (chunks) => <span className="text-foreground">{chunks}</span>,
              targetDir,
            })}
          </p>
        ) : null}
      </section>

      <Button
        type="button"
        variant="default"
        disabled={!canImport}
        onClick={() => void submit()}
        title={targetDir || undefined}
        className="w-full"
      >
        {importing ? <Loader2 className="animate-spin" /> : <FileUp />}
        {importing ? t("submit.importing") : t("submit.idle")}
      </Button>
    </div>
  )
}

function StepHeader({
  index,
  label,
  state,
}: {
  index: number
  label: string
  state: "locked" | "active" | "done"
}) {
  return (
    <div className={cn("flex items-center gap-2", state === "locked" && "opacity-50")}>
      <span
        aria-hidden
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium",
          state === "done" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
        )}
      >
        {state === "done" ? <Check className="size-3" /> : index}
      </span>
      <h4 className="text-sm font-medium text-foreground">{label}</h4>
    </div>
  )
}
