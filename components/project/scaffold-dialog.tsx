"use client"

import { useCallback, useEffect, useState } from "react"
import { FolderPlus } from "lucide-react"
import { toast } from "sonner"

import type { CurrentProject, DirListing } from "@/lib/project-types"
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
import { FolderBrowser } from "@/components/project/folder-browser"

/**
 * "Start from scratch / add Vivicy" (R9). A shadcn Dialog that scaffolds Vivicy
 * into a project: the user gives a folder plus a project name, and Vivicy writes
 * the LEAN method skeleton into it (via `POST /api/project/scaffold`), then sets it
 * as the current target so the app lands on the project (which shows the "no
 * architecture map yet" empty state until docs are written + extracted). An empty
 * or non-existent folder gets the full lean skeleton; a populated folder gets only
 * the MISSING Vivicy files, never clobbering existing ones (add-to-existing-repo).
 *
 * The folder is chosen by browsing a PARENT directory (the shared
 * {@link FolderBrowser}, same as the open-project picker) and typing the new
 * folder's name; the target is the parent path joined with that name. A direct
 * absolute-path Input is the fallback. Pure shadcn, light-only, no arbitrary values.
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
  const [browserBusy, setBrowserBusy] = useState(false)
  const [scaffolding, setScaffolding] = useState(false)
  const [projectName, setProjectName] = useState("")
  const [folderName, setFolderName] = useState("")
  const [absoluteOverride, setAbsoluteOverride] = useState("")

  // Reset the scaffold-specific fields each time the dialog opens; the browser
  // resets and re-browses itself from its own `open` prop. The state writes live
  // inside the async closure (not the effect body) so they don't fire
  // synchronously during the render commit.
  useEffect(() => {
    if (!open) return
    void (async () => {
      setProjectName("")
      setFolderName("")
      setAbsoluteOverride("")
    })()
  }, [open])

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
  const canScaffold = name.length > 0 && targetDir.length > 0 && !scaffolding && !browserBusy

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

  const busy = browserBusy || scaffolding

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
            <FolderBrowser
              open={open}
              disabled={scaffolding}
              onListingChange={setListing}
              onBusyChange={setBrowserBusy}
            />
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
            <p className="text-xs break-all text-muted-foreground">
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
