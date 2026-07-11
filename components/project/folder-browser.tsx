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

export function FolderBrowser({
  open,
  allowCreate = false,
  disabled = false,
  className,
  onListingChange,
  onBusyChange,
}: {
  open: boolean
  allowCreate?: boolean
  disabled?: boolean
  className?: string
  onListingChange?: (listing: DirListing) => void
  onBusyChange?: (busy: boolean) => void
}) {
  const t = useTranslations("project.folderBrowser")
  const tErrors = useTranslations("errors")
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [newFolderOpen, setNewFolderOpen] = useState(false)
  const [newFolderName, setNewFolderName] = useState("")
  const [creatingFolder, setCreatingFolder] = useState(false)

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

  useEffect(() => {
    if (!open) return
    void (async () => {
      setNewFolderOpen(false)
      setNewFolderName("")
      await browse(null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-browse only on open edge, not on every browse() identity change
  }, [open])

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
      await browse(body.path)
    } catch (error) {
      toast.error(t("toast.createErrorTitle"), {
        description: error instanceof Error ? error.message : t("toast.networkError"),
      })
    } finally {
      setCreatingFolder(false)
    }
  }, [browse, listing, newFolderName, t, tErrors])

  // onBusyChange reports ownBusy, not busy — folding in the parent's own disabled would echo it back as a useless round-trip.
  const ownBusy = loading || creatingFolder
  useEffect(() => {
    onBusyChange?.(ownBusy)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- report only on the browser's own busy transitions
  }, [ownBusy])

  const busy = disabled || ownBusy

  const crumbs = listing?.crumbs ?? []

  return (
    <div className={className}>
      <div className="flex items-start justify-between gap-2">
        <nav aria-label={t("currentPathLabel")} className="min-w-0 flex-1">
          <ol className="flex flex-wrap items-center text-xs text-muted-foreground">
            {crumbs.map((crumb, i) => (
              <li key={crumb.path} className="flex items-center">
                {i > 0 ? (
                  <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => void browse(crumb.path)}
                  className="px-1 font-normal text-muted-foreground hover:text-foreground"
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
