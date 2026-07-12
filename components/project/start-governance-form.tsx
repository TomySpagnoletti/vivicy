"use client"

import { useCallback, useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { BRAND } from "@/lib/brand"
import { errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { languageName } from "@/lib/i18n-language"
import type { CurrentProject, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DocPicker, type DocSelection } from "@/components/project/doc-picker"
import { FolderBrowser } from "@/components/project/folder-browser"

const EMPTY_SELECTION: DocSelection = { accepted: [], rejectedCount: 0 }

export function StartGovernanceForm({
  active,
  onGoverned,
}: {
  active: boolean
  onGoverned: (project: CurrentProject) => void
}) {
  const t = useTranslations("project.startGovernance")
  const tErrors = useTranslations("errors")
  const locale = useLocale()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [selection, setSelection] = useState<DocSelection>(EMPTY_SELECTION)
  const [submitting, setSubmitting] = useState(false)

  const targetDir = listing?.path ?? ""
  const derivedName = targetDir.split("/").filter(Boolean).pop() ?? ""
  const docCount = selection.accepted.length
  const canSubmit = listing !== null && !submitting && !browserBusy

  const submit = useCallback(async () => {
    if (!canSubmit || listing === null) return
    setSubmitting(true)
    const form = new FormData()
    form.append("targetDir", listing.path)
    const name = projectName.trim()
    if (name.length > 0) form.append("projectName", name)
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
      if (!res.ok || body.ok === false || !body.project) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.errorTitle"), {
          description: body.code
            ? errorTextAcrossFamilies(tErrors, ["import", "scaffold"], body.code, fallback)
            : fallback,
        })
        return
      }
      if (body.batch) {
        const langName = languageName(body.batch.language, locale)
        const skipped = selection.rejectedCount + (body.batch.rejected?.length ?? 0)
        const parts = [t("toast.importedCount", { count: body.batch.accepted?.length ?? 0 })]
        if (langName) parts.push(t("toast.importedLang", { language: langName }))
        if (skipped > 0) parts.push(t("toast.importedSkipped", { count: skipped }))
        toast.success(t("toast.importedTitle"), { description: parts.join(" ") })
      } else {
        toast.success(t("toast.governedTitle"), {
          description: t("toast.governedDescription", { root: body.project.root }),
        })
      }
      onGoverned(body.project)
    } catch (error) {
      toast.error(t("toast.errorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, listing, locale, onGoverned, projectName, selection, t, tErrors])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label>{t("targetLabel")}</Label>
        <p className="text-xs text-muted-foreground">{t("targetHint", { brandName: BRAND.name })}</p>
        <FolderBrowser
          open={active}
          allowCreate
          disabled={submitting}
          onListingChange={setListing}
          onBusyChange={setBrowserBusy}
        />
        {targetDir.length > 0 ? (
          <p className="text-xs break-all text-muted-foreground">
            {t.rich("targetPreview", {
              target: (chunks) => <span className="text-foreground">{chunks}</span>,
              targetDir,
            })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="govern-name" className="flex items-baseline gap-1.5">
          {t("nameLabel")}
          <span className="text-xs font-normal text-muted-foreground">{t("optional")}</span>
        </Label>
        <Input
          id="govern-name"
          value={projectName}
          spellCheck={false}
          autoComplete="off"
          placeholder={derivedName.length > 0 ? derivedName : t("namePlaceholder")}
          disabled={submitting}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="flex items-baseline gap-1.5">
          {t("docsLabel")}
          <span className="text-xs font-normal text-muted-foreground">{t("optional")}</span>
        </Label>
        <p className="text-xs text-muted-foreground">{t("docsHint", { brandName: BRAND.name })}</p>
        <DocPicker active={active} disabled={submitting} onChange={setSelection} />
      </div>

      <Button
        type="button"
        variant="default"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="w-full"
      >
        {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {submitting
          ? t("submit.working")
          : docCount > 0
            ? t("submit.idleWithDocs", { count: docCount })
            : t("submit.idle")}
      </Button>
    </div>
  )
}
