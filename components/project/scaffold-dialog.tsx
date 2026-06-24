"use client"

import { useCallback, useEffect, useState } from "react"
import {
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderPlus,
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
 * Mode B — "Start from scratch" (R9). A shadcn Dialog that scaffolds a brand-new
 * project: the user gives a NEW (empty or non-existent) folder plus a project
 * name, and Vivicy writes the generic governance/method skeleton into it (via
 * `POST /api/project/scaffold`), then sets it as the current target so the app
 * lands on the freshly-scaffolded project (which shows the "no architecture map
 * yet" empty state until docs are written + extracted).
 *
 * The folder is chosen by browsing a PARENT directory (reusing the same
 * `GET /api/fs/list` browser as the picker) and typing the new folder's name; the
 * target is the parent path joined with that name. A direct absolute-path Input is
 * the fallback. Pure shadcn, light-only, no arbitrary values.
 */
export function ScaffoldDialog({
  open,
  onOpenChange,
  onScaffolded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onScaffolded: (project: CurrentProject) => void
}) {
  const [listing, setListing] = useState<DirListing | null>(null)
  const [loading, setLoading] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [folderName, setFolderName] = useState("")
  const [absoluteOverride, setAbsoluteOverride] = useState("")

  // Browse a parent directory to place the new project under (null => home).
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

  // Reset and browse the default root each time the dialog opens.
  useEffect(() => {
    if (!open) return
    void (async () => {
      setProjectName("")
      setFolderName("")
      setAbsoluteOverride("")
      await browse(null)
    })()
  }, [open, browse])

  // The resolved target directory: an explicit absolute override wins; otherwise
  // the browsed parent joined with the new folder name.
  const targetDir = (() => {
    const override = absoluteOverride.trim()
    if (override.length > 0) return override
    const folder = folderName.trim()
    if (!listing || folder.length === 0) return ""
    return `${listing.path.replace(/\/$/, "")}/${folder}`
  })()

  const name = projectName.trim()
  const canScaffold = name.length > 0 && targetDir.length > 0 && !scaffolding && !loading

  const scaffold = useCallback(async () => {
    if (!canScaffold) return
    setScaffolding(true)
    try {
      const res = await fetch("/api/project/scaffold", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetDir, projectName: name }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        project?: CurrentProject
      }
      if (!res.ok || body.ok === false || !body.project) {
        toast.error("Cannot scaffold project", { description: body.error ?? `HTTP ${res.status}` })
        return
      }
      toast.success("Project scaffolded", {
        description: `${body.project.root} — write your canonical docs, then extract.`,
      })
      onScaffolded(body.project)
      onOpenChange(false)
    } catch (error) {
      toast.error("Cannot scaffold project", {
        description: error instanceof Error ? error.message : "network error",
      })
    } finally {
      setScaffolding(false)
    }
  }, [canScaffold, targetDir, name, onScaffolded, onOpenChange])

  const busy = loading || scaffolding
  const crumbs = listing ? toCrumbs(listing.path) : []

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start from scratch</DialogTitle>
          <DialogDescription>
            Vivicy scaffolds a new project with the full development method — you
            write the canonical product spec afterwards.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault()
            void scaffold()
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scaffold-name">Project name</Label>
            <Input
              id="scaffold-name"
              value={projectName}
              spellCheck={false}
              autoComplete="off"
              placeholder="Acme App"
              disabled={busy}
              onChange={(event) => setProjectName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Location</Label>
            {/* Breadcrumb of the chosen PARENT directory. */}
            <nav aria-label="Parent directory" className="min-w-0">
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

            <ScrollArea className="h-40 border border-border">
              <div className="flex flex-col p-1" role="group" aria-label="Folders" aria-busy={loading}>
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
                  <p className="px-2 py-4 text-xs text-muted-foreground">No subfolders here.</p>
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

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scaffold-folder">New folder name</Label>
            <Input
              id="scaffold-folder"
              value={folderName}
              spellCheck={false}
              autoComplete="off"
              placeholder="acme-app"
              disabled={busy || absoluteOverride.trim().length > 0}
              onChange={(event) => setFolderName(event.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="scaffold-abs">Or an absolute target path</Label>
            <Input
              id="scaffold-abs"
              value={absoluteOverride}
              spellCheck={false}
              autoComplete="off"
              placeholder="/Users/you/code/acme-app"
              disabled={busy}
              onChange={(event) => setAbsoluteOverride(event.target.value)}
            />
          </div>

          {targetDir.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              Scaffolds into <span className="text-foreground">{targetDir}</span>
            </p>
          ) : null}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="ghost" size="sm" disabled={scaffolding}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" size="sm" disabled={!canScaffold}>
              <FolderPlus />
              {scaffolding ? "Scaffolding…" : "Scaffold project"}
            </Button>
          </DialogFooter>
        </form>
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
