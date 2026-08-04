"use client"

import { useCallback, useState } from "react"
import { FileUp, Loader2 } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"

import { errorTextAcrossFamilies } from "@/lib/i18n-errors"
import { languageName } from "@/lib/i18n-language"
import { Button } from "@/components/ui/button"
import { DocPicker, type DocSelection } from "@/components/project/doc-picker"
import { useViviPanel } from "@/components/chat/vivi-panel-context"

const EMPTY_SELECTION: DocSelection = { accepted: [], rejectedCount: 0 }

// The batch must land in the thread the panel WILL show — the newest session — or its acknowledgement and its reading turn are written where nothing ever looks.
async function newestSessionId(): Promise<string | undefined> {
  try {
    const res = await fetch("/api/vivi/sessions", { cache: "no-store" })
    const body = (await res.json().catch(() => ({}))) as { sessions?: { sessionId?: string }[] }
    const newest = body.sessions?.[0]?.sessionId
    return typeof newest === "string" && newest.length > 0 ? newest : undefined
  } catch {
    return undefined
  }
}

// There is no folder to choose: the docs land in the project THIS server governs, through the same seam Vivi's paperclip uses.
export function ImportDocsFlow({ active, onImported }: { active: boolean; onImported: () => void }) {
  const t = useTranslations("project.importDocsDialog")
  const tErrors = useTranslations("errors")
  const locale = useLocale()
  const { openPanel } = useViviPanel()
  const [selection, setSelection] = useState<DocSelection>(EMPTY_SELECTION)
  const [importing, setImporting] = useState(false)

  const canImport = selection.accepted.length > 0 && !importing

  const submit = useCallback(async () => {
    if (!canImport) return
    setImporting(true)
    try {
      const form = new FormData()
      const sessionId = await newestSessionId()
      if (sessionId) form.append("sessionId", sessionId)
      for (const { file, rel } of selection.accepted) {
        form.append("files", file)
        form.append("paths", rel)
      }
      const res = await fetch("/api/vivi/import", { method: "POST", body: form })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        language?: string
        accepted?: unknown[]
        rejected?: unknown[]
        error?: string
        code?: string
      }
      if (!res.ok || body.ok === false) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.importErrorTitle"), {
          description: body.code ? errorTextAcrossFamilies(tErrors, ["import", "control"], body.code, fallback) : fallback,
        })
        return
      }
      const langName = languageName(body.language, locale)
      const skipped = selection.rejectedCount + (body.rejected?.length ?? 0)
      const parts = [t("toast.importedCount", { count: body.accepted?.length ?? 0 })]
      if (langName) parts.push(t("toast.importedLang", { language: langName }))
      if (skipped > 0) parts.push(t("toast.importedSkipped", { count: skipped }))
      toast.success(t("toast.importedTitle"), { description: parts.join(" ") })
      // Vivi acknowledges the batch and reads it in the thread: take the owner there, exactly as the govern flow does.
      openPanel()
      onImported()
    } catch (error) {
      toast.error(t("toast.importErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setImporting(false)
    }
  }, [canImport, locale, onImported, openPanel, selection, t, tErrors])

  return (
    <div className="flex flex-col gap-4">
      <DocPicker active={active} disabled={importing} onChange={setSelection} />

      <Button
        type="button"
        variant="default"
        aria-disabled={!canImport}
        onClick={() => void submit()}
        className={canImport ? "w-full" : "w-full opacity-60"}
      >
        {importing ? <Loader2 className="animate-spin" /> : <FileUp />}
        {importing ? t("submit.importing") : t("submit.idle")}
      </Button>
    </div>
  )
}
