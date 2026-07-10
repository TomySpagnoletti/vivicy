"use client"

import { useCallback, useEffect, useId, useState } from "react"
import { FolderOpen } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { errorText } from "@/lib/i18n-errors"
import type { CurrentProject, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { FolderBrowser } from "@/components/project/folder-browser"

export function OpenProjectForm({
  active,
  disabled = false,
  onChanged,
  onSelectingChange,
}: {
  active: boolean
  disabled?: boolean
  onChanged: (project: CurrentProject) => void
  onSelectingChange?: (selecting: boolean) => void
}) {
  const t = useTranslations("project.openProjectDialog")
  const tErrors = useTranslations("errors")
  const manualPathId = useId()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [manualPath, setManualPath] = useState("")

  // The setState lives inside an async closure, not the effect body, so it doesn't read as a cascading-render (setState-in-effect) pattern.
  useEffect(() => {
    if (!active) return
    void (async () => {
      setManualPath("")
    })()
  }, [active])

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
          body: JSON.stringify({ root }),
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
    [onChanged, t, tErrors]
  )

  const busy = disabled || browserBusy || selecting

  return (
    <div className="flex flex-col gap-3">
      <FolderBrowser
        open={active}
        allowCreate
        disabled={disabled || selecting}
        onListingChange={setListing}
        onBusyChange={setBrowserBusy}
      />

      {/* min-w-0 + truncate on the path span (with shrink-0 on the icon/label) keeps a long absolute path from pushing the button past the container edge. */}
      <Button
        variant="outline"
        size="sm"
        disabled={busy || !listing}
        onClick={() => listing && void select(listing.path)}
        title={listing ? listing.path : undefined}
        className="w-full min-w-0 justify-start"
      >
        <FolderOpen />
        <span className="shrink-0">
          {selecting ? t("selectFolder.selecting") : t("selectFolder.idle")}
        </span>
        {listing ? (
          <span className="min-w-0 flex-1 truncate text-left text-muted-foreground">
            · {listing.path}
          </span>
        ) : null}
      </Button>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(event) => {
          event.preventDefault()
          const path = manualPath.trim()
          if (path.length > 0) void select(path)
        }}
      >
        <Label htmlFor={manualPathId}>{t("manualPath.label")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={manualPathId}
            value={manualPath}
            spellCheck={false}
            autoComplete="off"
            placeholder={t("manualPath.placeholder")}
            disabled={busy}
            onChange={(event) => setManualPath(event.target.value)}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={busy || manualPath.trim().length === 0}
          >
            {t("manualPath.submit")}
          </Button>
        </div>
      </form>
    </div>
  )
}
