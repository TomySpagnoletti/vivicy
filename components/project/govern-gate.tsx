"use client"

import { useCallback, useState } from "react"
import { Loader2, Sparkles } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { BRAND } from "@/lib/brand"
import { errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { languageName } from "@/lib/i18n-language"
import type { BoundProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { DocPicker, type DocSelection } from "@/components/project/doc-picker"

const EMPTY_SELECTION: DocSelection = { accepted: [], rejectedCount: 0 }

// The folder is this server's binding, so there is nothing to browse here: govern it, or go back to the launcher and pick another one.
export function GovernGate({ project }: { project: BoundProject }) {
  const t = useTranslations("project.governGate")
  const tErrors = useTranslations("errors")
  const locale = useLocale()
  const [projectName, setProjectName] = useState("")
  const [selection, setSelection] = useState<DocSelection>(EMPTY_SELECTION)
  const [submitting, setSubmitting] = useState(false)

  const docCount = selection.accepted.length

  const submit = useCallback(async () => {
    if (submitting) return
    setSubmitting(true)
    const form = new FormData()
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
        project?: BoundProject
        batch?: { language?: string; accepted?: unknown[]; rejected?: unknown[] } | null
        error?: string
        code?: string
      }
      if (!res.ok || body.ok === false || !body.project) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.errorTitle"), {
          description: body.code ? errorTextAcrossFamilies(tErrors, ["import", "scaffold", "control"], body.code, fallback) : fallback,
        })
        setSubmitting(false)
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
        toast.success(t("toast.governedTitle"), { description: t("toast.governedDescription") })
      }
      // The workspace is a different server-rendered branch of this same route: reload rather than swap it in on the client.
      window.location.reload()
    } catch (error) {
      toast.error(t("toast.errorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
      setSubmitting(false)
    }
  }, [locale, projectName, selection, submitting, t, tErrors])

  return (
    <main data-empty-reason="not_governed" className="mx-auto flex min-h-svh w-full max-w-lg flex-col justify-center gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="font-heading text-lg font-medium text-foreground">{t("heading")}</h1>
        <p className="text-sm text-balance text-muted-foreground">{t("description", { brandName: BRAND.name })}</p>
        <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs break-all text-foreground">{project.root}</p>
      </header>

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
          placeholder={project.name}
          readOnly={submitting}
          aria-disabled={submitting}
          onChange={(event) => setProjectName(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label className="flex items-baseline gap-1.5">
          {t("docsLabel")}
          <span className="text-xs font-normal text-muted-foreground">{t("optional")}</span>
        </Label>
        <p className="text-xs text-muted-foreground">{t("docsHint", { brandName: BRAND.name })}</p>
        <DocPicker active disabled={submitting} onChange={setSelection} />
      </div>

      <Button
        type="button"
        aria-disabled={submitting}
        onClick={() => void submit()}
        className={submitting ? "w-full opacity-60" : "w-full"}
      >
        {submitting ? <Loader2 className="animate-spin" /> : <Sparkles />}
        {submitting ? t("submit.working") : docCount > 0 ? t("submit.idleWithDocs", { count: docCount }) : t("submit.idle")}
      </Button>
    </main>
  )
}
