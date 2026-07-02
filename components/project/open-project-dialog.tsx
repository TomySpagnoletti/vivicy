"use client"

import { useCallback, useEffect, useState } from "react"
import { FolderOpen } from "lucide-react"
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
 * Web project picker (R10): a shadcn Dialog that browses the LOCAL filesystem
 * (via {@link FolderBrowser}) and persists the chosen folder via
 * `POST /api/project`. This is the way to choose the project Vivicy develops.
 *
 * Layout: the shared folder browser (breadcrumbs, parent-up, subdirectory list,
 * inline New-folder), a "Select this folder" action for the directory currently
 * open, and a manual absolute-path Input fallback. Pure shadcn, light-only, no
 * arbitrary values.
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
  const [browserBusy, setBrowserBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [manualPath, setManualPath] = useState("")

  // Reset the manual-path fallback each time the dialog opens; the browser
  // resets and re-browses itself from its own `open` prop. The state write lives
  // inside the async closure (not the effect body) so it doesn't fire
  // synchronously during the render commit.
  useEffect(() => {
    if (!open) return
    void (async () => {
      setManualPath("")
    })()
  }, [open])

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
          description: body.project.hasCanonicalSpec
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

  const busy = browserBusy || selecting

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

        <FolderBrowser
          open={open}
          allowCreate
          disabled={selecting}
          onListingChange={setListing}
          onBusyChange={setBrowserBusy}
        />

        {/* Select the folder currently open in the browser. Full-width with a
            truncating path so a long absolute path never pushes the button (or
            its siblings) past the dialog edge — the icon + action label stay
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
            {selecting ? "Selecting…" : "Select this folder"}
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
