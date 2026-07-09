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

/**
 * The open-existing-project flow (R10), dialog-free so two surfaces share it: the
 * {@link file://./open-project-dialog OpenProjectDialog} (the setup bar's project
 * switcher) and the Vivi panel's onboarding view (W4b). Browses the LOCAL
 * filesystem via {@link FolderBrowser}, persists the chosen folder via
 * `POST /api/project`, and hands the described project back through `onChanged`.
 *
 * Layout: the shared folder browser (breadcrumbs, parent-up, subdirectory list,
 * inline New-folder), a "Select this folder" action for the directory currently
 * open, and a manual absolute-path Input fallback.
 */
export function OpenProjectForm({
  active,
  disabled = false,
  onChanged,
  onSelectingChange,
}: {
  /** Resets the manual path and re-browses the default root whenever this flips true. */
  active: boolean
  /** External busy state (e.g. a wrapping dialog mid-teardown) that freezes the form. */
  disabled?: boolean
  onChanged: (project: CurrentProject) => void
  /** Fires when a selection POST starts/ends (wrappers freeze their Cancel on it). */
  onSelectingChange?: (selecting: boolean) => void
}) {
  const t = useTranslations("project.openProjectDialog")
  const tErrors = useTranslations("errors")
  const manualPathId = useId()
  const [listing, setListing] = useState<DirListing | null>(null)
  const [browserBusy, setBrowserBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [manualPath, setManualPath] = useState("")

  // Reset the manual-path fallback each time the form re-activates; the browser
  // resets and re-browses itself from its own `open` prop. The state write lives
  // inside the async closure (not the effect body) so it doesn't fire
  // synchronously during the render commit.
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

  // Persist a chosen folder, then hand the described project back to the caller.
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

      {/* Select the folder currently open in the browser. Full-width with a
          truncating path so a long absolute path never pushes the button (or
          its siblings) past the container edge — the icon + action label stay
          fixed and only the path clips, with the full value in the title. */}
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

      {/* Manual absolute-path fallback. */}
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
