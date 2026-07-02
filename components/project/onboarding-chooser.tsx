"use client"

import { useCallback, useState } from "react"
import { FileUp, FolderOpen, Sparkles } from "lucide-react"

import type { CurrentProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ImportDocsDialog } from "@/components/project/import-docs-dialog"
import { OpenProjectDialog } from "@/components/project/open-project-dialog"
import { ScaffoldDialog } from "@/components/project/scaffold-dialog"

/**
 * Three-start onboarding chooser (G10) shown when no project is resolved yet.
 * Target acquisition (how the repo lands on disk) stays a separate axis from
 * spec intake (what's in it): cards 1 and 2 are pure acquisition — open an
 * existing repo, or scaffold a lean empty one — while card 3 composes
 * acquisition with intake: it opens the SAME open-project dialog first (there is
 * no target yet in this state), then chains into the import dialog once a
 * target exists. The two dialogs it reuses never need to know about each other.
 */
export function OnboardingChooser({
  onProjectChanged,
}: {
  onProjectChanged: (project: CurrentProject) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [scaffoldOpen, setScaffoldOpen] = useState(false)

  // Card 3's own acquire-then-import orchestration: opens the open-project
  // dialog same as card 1, but on success chains straight into the import
  // dialog instead of notifying the parent right away. Notifying immediately
  // would bubble up to `page.tsx`'s map re-fetch, which — once a target exists —
  // flips its onboarding reason off "no_target" and UNMOUNTS this whole chooser
  // (see app/page.tsx's `state.reason === "no_target"` branch), killing the
  // import dialog mid-flow before the user ever gets to stage/verify/apply. So
  // the parent is only told once this dialog is done with the target, whether
  // that's via a successful Apply or the user closing/cancelling it.
  const [importAcquireOpen, setImportAcquireOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [importTarget, setImportTarget] = useState<CurrentProject | null>(null)

  const onImportTargetAcquired = useCallback((project: CurrentProject) => {
    setImportTarget(project)
    setImportOpen(true)
  }, [])

  const reportImportTarget = useCallback(() => {
    if (importTarget) onProjectChanged(importTarget)
  }, [importTarget, onProjectChanged])

  return (
    <div className="flex h-svh w-full items-center justify-center p-6">
      <div className="flex w-full max-w-4xl flex-col gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-lg font-medium text-foreground">Start a project</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Vivicy develops a project from its canonical spec. Open an existing repo,
            start from scratch, or import docs you already have.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="flex flex-col">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <FolderOpen className="size-5" />
              </span>
              <CardTitle>Open a project</CardTitle>
              <CardDescription className="text-balance">
                Pick a repository that already carries a{" "}
                <code className="text-foreground">.vivicy/</code>. Vivicy runs the
                method against it and adds only development output.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setPickerOpen(true)}
              >
                <FolderOpen />
                Open existing folder
              </Button>
            </CardFooter>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <Sparkles className="size-5" />
              </span>
              <CardTitle>Start from scratch</CardTitle>
              <CardDescription className="text-balance">
                Give a new empty folder and a name. Vivicy scaffolds a lean
                skeleton — you write the canonical spec afterwards.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <Button size="sm" className="w-full" onClick={() => setScaffoldOpen(true)}>
                <Sparkles />
                Scaffold a new project
              </Button>
            </CardFooter>
          </Card>

          <Card className="flex flex-col">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <FileUp className="size-5" />
              </span>
              <CardTitle>Import your docs</CardTitle>
              <CardDescription className="text-balance">
                Drop existing spec files, a folder, or a .zip. Vivicy checks them
                for drift, then places the canonical, spikes, and map for you.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setImportAcquireOpen(true)}
              >
                <FileUp />
                Import docs
              </Button>
            </CardFooter>
          </Card>
        </div>
      </div>

      <OpenProjectDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onChanged={onProjectChanged}
      />
      <ScaffoldDialog
        open={scaffoldOpen}
        onOpenChange={setScaffoldOpen}
        onScaffolded={onProjectChanged}
      />

      {/* Card 3's acquisition leg: identical open-project dialog, but success
          chains into the import dialog rather than just reporting up. */}
      <OpenProjectDialog
        open={importAcquireOpen}
        onOpenChange={setImportAcquireOpen}
        onChanged={onImportTargetAcquired}
      />
      <ImportDocsDialog
        open={importOpen}
        onOpenChange={(next) => {
          setImportOpen(next)
          // Report the acquired target once this dialog is done with it —
          // closing (Cancel or Close) is the single point that covers both "the
          // user imported something" and "the user picked a target then backed
          // out of importing" (the target itself is already persisted either way).
          // `onProjectChanged` below is intentionally a no-op: reporting THERE
          // too (Apply succeeds but the dialog stays open showing its result)
          // would double-fire the parent's map re-fetch for no benefit.
          if (!next) reportImportTarget()
        }}
        onProjectChanged={() => {}}
      />
    </div>
  )
}
