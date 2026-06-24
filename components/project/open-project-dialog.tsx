"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderOpen,
  Loader2,
} from "lucide-react"
import { toast } from "sonner"

import type { CurrentProject, DirEntry, DirListing } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"

/**
 * Web project picker (R10): a shadcn Dialog that browses the LOCAL filesystem via
 * the Next server (`GET /api/fs/list`) and persists the chosen folder via
 * `POST /api/project`. Until the Tauri native dialog lands, this is the way to
 * choose the project Vivicy develops.
 *
 * Layout: a breadcrumb of the current path, a parent-up row, a scrollable list of
 * subdirectories to navigate, a "Select this folder" action for the directory
 * currently open, and a manual absolute-path Input fallback. Pure shadcn,
 * light-only, no arbitrary values.
 *
 * Controlled by the parent so the sidebar affordance owns open/close. `onChanged`
 * fires with the persisted project so the app can re-fetch the map.
 */
export function OpenProjectDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onChanged: (project: CurrentProject) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [manualPath, setManualPath] = useState("")

  // Browse a path (null => the server's default root, the user's home dir). On
  // failure, keep the previous listing and toast — never strand the dialog empty.
  const browse = useCallback(async (path: string | null) => {
    setLoading(true)
    try {
      const url = path ? `/api/fs/list?path=${encodeURIComponent(path)}` : "/api/fs/list"
      const res = await fetch(url, { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as
        | (DirListing & { ok: true })
        | { ok: false; error?: string }
      if (!res.ok || body.ok === false) {
        toast.error("Cannot open folder", {
          description: ("error" in body && body.error) || `HTTP ${res.status}`,
        })
        return
      }
      setListing(body)
    } catch (error) {
      toast.error("Cannot open folder", {
        description: error instanceof Error ? error.message : "network error",
      })
    } finally {
      setLoading(false)
    }
  }, [])

  // Browse the default root each time the dialog opens, so it always starts from
  // a known place rather than a stale prior listing. State writes live inside the
  // async closure (not the effect body) so they don't fire synchronously on mount.
  useEffect(() => {
    if (!open) return
    void (async () => {
      setManualPath("")
      await browse(null)
    })()
  }, [open, browse])

  // Persist a chosen folder, then hand the described project back to the parent.
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
          project?: CurrentProject
        }
        if (!res.ok || body.ok === false || !body.project) {
          toast.error("Cannot select project", { description: body.error ?? `HTTP ${res.status}` })
          return
        }
        toast.success("Project selected", {
          description: body.project.hasDocs
            ? body.project.root
            : `${body.project.root} (no docs/ — extract has no spec to read yet)`,
        })
        onChanged(body.project)
        onOpenChange(false)
      } catch (error) {
        toast.error("Cannot select project", {
          description: error instanceof Error ? error.message : "network error",
        })
      } finally {
        setSelecting(false)
      }
    },
    [onChanged, onOpenChange]
  )

  const busy = loading || selecting
  const crumbs = listing ? toCrumbs(listing.path) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Open project</DialogTitle>
          <DialogDescription>
            Choose the local repository Vivicy should develop. Navigate to a folder
            and select it, or paste an absolute path.
          </DialogDescription>
        </DialogHeader>

        {/* Breadcrumb of the current directory; each segment navigates to it. */}
        <nav aria-label="Current path" className="min-w-0">
          <ol className="flex flex-wrap items-center gap-0.5 text-xs text-muted-foreground">
            {crumbs.map((crumb, i) => (
              <li key={crumb.path} className="flex items-center gap-0.5">
                {i > 0 ? <ChevronRight aria-hidden className="size-3" /> : null}
                <Button
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

        {/* The folder list: parent-up entry, then immediate subdirectories. */}
        <ScrollArea className="h-64 border border-border">
          <div
            className="flex flex-col p-1"
            role="group"
            aria-label="Folders"
            aria-busy={loading}
          >
            {listing?.parent ? (
              <FolderRow
                icon={<CornerLeftUp className="size-4" />}
                label=".."
                disabled={busy}
                onClick={() => void browse(listing.parent)}
              />
            ) : null}

            {loading && !listing ? (
              <div className="flex items-center gap-2 px-2 py-4 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            ) : null}

            {listing && listing.entries.length === 0 && !loading ? (
              <p className="px-2 py-4 text-xs text-muted-foreground">
                No subfolders here.
              </p>
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

        {/* Select the folder currently open in the browser. */}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !listing}
          onClick={() => listing && void select(listing.path)}
          className="justify-start"
        >
          <FolderOpen />
          {selecting ? "Selecting…" : "Select this folder"}
          {listing ? (
            <span className="truncate text-muted-foreground">· {listing.path}</span>
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
          <Label htmlFor="project-manual-path">Or paste an absolute path</Label>
          <div className="flex items-center gap-2">
            <Input
              id="project-manual-path"
              value={manualPath}
              spellCheck={false}
              autoComplete="off"
              placeholder="/Users/you/code/your-project"
              disabled={busy}
              onChange={(event) => setManualPath(event.target.value)}
            />
            <Button
              type="submit"
              variant="secondary"
              size="sm"
              disabled={busy || manualPath.trim().length === 0}
            >
              Use
            </Button>
          </div>
        </form>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" disabled={selecting}>
              Cancel
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
