"use client"

import { useCallback, useEffect, useState } from "react"
import { FolderOpen } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { errorText } from "@/lib/i18n-errors"
import type { CurrentProject, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { FolderBrowser } from "@/components/project/folder-browser"

export function OpenProjectForm({
  active,
  disabled = false,
  allowCreate = false,
  requireGoverned = true,
  onChanged,
  onSelectingChange,
}: {
  active: boolean
  disabled?: boolean
  allowCreate?: boolean
  requireGoverned?: boolean
  onChanged: (project: CurrentProject) => void
  onSelectingChange?: (selecting: boolean) => void
}) {
  const t = useTranslations("project.openProjectDialog")
  const tErrors = useTranslations("errors")
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)

  useEffect(() => {
    onSelectingChange?.(selecting)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only on selecting transitions
  }, [selecting])

  const select = useCallback(
    async (root: string) => {
      setSelecting(true)
      try {
        const res = await fetch("/api/project", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ root, requireGoverned }),
        })
        const body = (await res.json().catch(() => ({}))) as {
          ok?: boolean
          error?: string
          code?: string
          project?: CurrentProject
        }
        if (!res.ok || body.ok === false || !body.project) {
          const fallback = body.error ?? t("toast.httpError", { status: res.status })
          toast.error(t("toast.selectErrorTitle"), {
            description: body.code ? errorText(tErrors, `project.${body.code}`, fallback) : fallback,
          })
          return
        }
        toast.success(t("toast.selectedTitle"), {
          description: body.project.hasCanonicalSpec
            ? body.project.root
            : t("toast.selectedNoSpec", { root: body.project.root }),
        })
        onChanged(body.project)
      } catch (error) {
        toast.error(t("toast.selectErrorTitle"), {
          description: error instanceof Error ? error.message : t("toast.networkError"),
        })
      } finally {
        setSelecting(false)
      }
    },
    [onChanged, requireGoverned, t, tErrors]
  )

  const busy = disabled || browserBusy || selecting

  return (
    <div className="flex flex-col gap-3">
      <FolderBrowser
        open={active}
        allowCreate={allowCreate}
        disabled={disabled || selecting}
        onListingChange={setListing}
        onBusyChange={setBrowserBusy}
      />

      <Button
        variant="default"
        disabled={busy || !listing}
        onClick={() => listing && void select(listing.path)}
        title={listing ? listing.path : undefined}
        className="w-full"
      >
        <FolderOpen />
        {selecting ? t("selectFolder.selecting") : t("selectFolder.idle")}
      </Button>
    </div>
  )
}
