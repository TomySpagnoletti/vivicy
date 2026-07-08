"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronRight, CornerLeftUp, Folder, FolderPlus, Loader2, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import type { DirEntry, DirListing } from "@/lib/project-types"
import { errorText } from "@/lib/i18n-errors"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"

/**
 * Shared local-filesystem browser (R10) behind `GET /api/fs/list` and
 * `POST /api/fs/mkdir`: breadcrumbs of the current path, a parent-up row, a
 * scrollable subdirectory list, and an optional inline "New folder" affordance.
 * Used by both {@link OpenProjectDialog} (browsing IS the selection) and
 * {@link ScaffoldDialog} (browsing picks the PARENT a new folder is named into) —
 * `onNavigate` reports every path the browser lands on so each dialog derives its
 * own meaning from it.
 *
 * Controlled: the parent owns `open` (when to (re)browse from the root) and
 * receives the live `DirListing` via `onListingChange` for its own "Select this
 * folder" / target-path affordances, which stay outside this component.
 */
export function FolderBrowser({
  open,
  allowCreate = false,
  disabled = false,
  className,
  onListingChange,
  onBusyChange,
}: {
  /** Re-browses the default root whenever this flips true (dialog opening). */
  open: boolean
  /** Show the inline "New folder" affordance (open-project only). */
  allowCreate?: boolean
  /** External busy state (e.g. a parent-level submit) that also disables rows. */
  disabled?: boolean
  className?: string
  /** Fires on every successful browse, so the parent can read the current path. */
  onListingChange?: (listing: DirListing) => void
  /** Fires whenever the browser's own loading/creating state changes. */
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useTranslations("project.folderBrowser")
  const tErrors = useTranslations("errors")
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [creatingFolder, setCreatingFolder] = useState(false)

  // Browse a path (null => the server's default root, the user's home dir). On
  // failure, keep the previous listing and toast — never strand the caller empty.
  const browse = useCallback(
    async (path: string | null) => {
      setLoading(true)
      try {
        const url = path ? `/api/fs/list?path=${encodeURIComponent(path)}` : "/api/fs/list"
        const res = await fetch(url, { cache: "no-store" })
        const body = (await res.json().catch(() => ({}))) as
          | (DirListing & { ok: true })
          | { ok: false; error?: string; code?: string }
        if (!res.ok || body.ok === false) {
          const fallback = ("error" in body && body.error) || t("toast.httpError", { status: res.status })
          toast.error(t("toast.openErrorTitle"), {
            description:
              "code" in body && body.code ? errorText(tErrors, `fsBrowse.${body.code}`, fallback) : fallback,
          })
          return
        }
        setListing(body)
        onListingChange?.(body)
      } catch (error) {
        toast.error(t("toast.openErrorTitle"), {
          description: error instanceof Error ? error.message : t("toast.networkError"),
        })
      } finally {
        setLoading(false)
      }
    },
    [onListingChange, t, tErrors]
  )

  // Browse the default root each time the caller opens, so it always starts from
  // a known place rather than a stale prior listing. State writes live inside the
  // async closure (not the effect body) so they don't fire synchronously on mount.
  useEffect(() => {
    if (!open) return
    void (async () => {
      setNewFolderOpen(false)
      setNewFolderName("")
      await browse(null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-browse only on open edge, not on every browse() identity change
  }, [open])

  // Create a new folder inside the currently-browsed directory, then navigate
  // into it so the user can immediately select it. Errors (already-exists,
  // invalid name) are surfaced honestly via a toast; the browser stays put.
  const createFolder = useCallback(async () => {
    const name = newFolderName.trim()
    if (!listing || name.length === 0) return
    setCreatingFolder(true)
    try {
      const res = await fetch("/api/fs/mkdir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent: listing.path, name }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        code?: string
        path?: string
      }
      if (!res.ok || body.ok === false || !body.path) {
        const fallback = body.error ?? t("toast.httpError", { status: res.status })
        toast.error(t("toast.createErrorTitle"), {
          description: body.code ? errorText(tErrors, `fsBrowse.${body.code}`, fallback) : fallback,
        })
        return
      }
      toast.success(t("toast.createdTitle"), { description: body.path })
      setNewFolderName("")
      setNewFolderOpen(false)
      // Navigate into the freshly-created folder so it is the open directory.
      await browse(body.path)
    } catch (error) {
      toast.error(t("toast.createErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setCreatingFolder(false)
    }
  }, [browse, listing, newFolderName, t, tErrors])

  // `ownBusy` (this browser's own fetch/mkdir activity) is what's reported
  // upward via `onBusyChange` — echoing the parent's `disabled` back to it would
  // be a useless round-trip. `busy` (below) is the local render-disabling flag
  // and DOES fold in `disabled`, since rows must also freeze when the parent
  // (e.g. a dialog mid-submit) says so.
  const ownBusy = loading || creatingFolder
  useEffect(() => {
    onBusyChange?.(ownBusy)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only on the browser's own busy transitions
  }, [ownBusy])

  const busy = disabled || ownBusy

  const crumbs = listing ? toCrumbs(listing.path) : []

  return (
    <div className={className}>
      {/* Breadcrumb of the current directory + the New-folder affordance. The
          breadcrumb wraps within its min-w-0 column so a deep path never pushes
          the New-folder button off the right edge. */}
      <div className="flex items-start justify-between gap-2">
        <nav aria-label={t("currentPathLabel")} className="min-w-0 flex-1">
          <ol className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
            {crumbs.map((crumb, i) => (
              <li key={crumb.path} className="flex items-center gap-0.5">
                {i > 0 ? <ChevronRight aria-hidden className="size-3" /> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void browse(crumb.path)}
                  className="font-normal text-muted-foreground hover:text-foreground"
                >
                  {crumb.label}
                </Button>
              </li>
            ))}
          </ol>
        </nav>
        {allowCreate && !newFolderOpen ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            disabled={busy || !listing}
            onClick={() => setNewFolderOpen(true)}
            className="shrink-0"
          >
            <FolderPlus />
            {t("newFolder")}
          </Button>
        ) : null}
      </div>

      {/* Inline create-folder form: a name input + confirm, shown in place so
          the user names the folder inside the current directory. */}
      {allowCreate && newFolderOpen ? (
        <form
          className="mt-2 flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void createFolder()
          }}
        >
          <Label htmlFor="new-folder-name" className="sr-only">
            {t("newFolderNameLabel")}
          </Label>
          <Input
            id="new-folder-name"
            value={newFolderName}
            spellCheck={false}
            autoComplete="off"
            autoFocus
            placeholder={t("newFolderPlaceholder")}
            disabled={creatingFolder}
            onChange={(event) => setNewFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setNewFolderOpen(false)
                setNewFolderName("")
              }
            }}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={creatingFolder || newFolderName.trim().length === 0}
            className="shrink-0"
          >
            {creatingFolder ? t("create.creating") : t("create.idle")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("cancelNewFolder")}
            disabled={creatingFolder}
            onClick={() => {
              setNewFolderOpen(false)
              setNewFolderName("")
            }}
            className="shrink-0"
          >
            <X />
          </Button>
        </form>
      ) : null}

      {/* The folder list: parent-up entry, then immediate subdirectories. */}
      <ScrollArea className="mt-2 h-64 border border-border">
        <div className="flex flex-col p-1" role="group" aria-label={t("foldersGroupLabel")} aria-busy={loading}>
          {listing?.parent ? (
            <FolderRow
              icon={<CornerLeftUp className="size-4" />}
              label={t("parentDir")}
              disabled={busy}
              onClick={() => void browse(listing.parent)}
            />
          ) : null}

          {loading && !listing ? (
            <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> {t("loading")}
            </div>
          ) : null}

          {listing && listing.entries.length === 0 && !loading ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">{t("empty")}</p>
          ) : null}

          {listing?.entries.map((entry: DirEntry) => (
            <FolderRow
              key={entry.path}
              icon={<Folder className="size-4" />}
              label={entry.name}
              disabled={busy}
              onClick={() => void browse(entry.path)}
            />
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

/** One navigable row in the folder list. */
function FolderRow({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-2 px-2 py-1.5 text-left text-sm text-foreground outline-none hover:bg-muted focus-visible:bg-muted disabled:pointer-events-none disabled:opacity-50"
    >
      <span aria-hidden className="text-muted-foreground">
        {icon}
      </span>
      <span className="truncate">{label}</span>
    </button>
  )
}

/** Split an absolute path into navigable breadcrumb segments (root first). */
function toCrumbs(absolute: string): Array<{ label: string; path: string }> {
  const parts = absolute.split("/").filter((p) => p.length > 0)
  const crumbs: Array<{ label: string; path: string }> = [{ label: "/", path: "/" }]
  let acc = ""
  for (const part of parts) {
    acc += `/${part}`
    crumbs.push({ label: part, path: acc })
  }
  return crumbs
}
