"use client"

import { useCallback, useState } from "react"
import { FileUp, FolderOpen, MessagesSquare, Sparkles } from "lucide-react"

import type { CurrentProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ViviChat } from "@/components/chat/vivi-chat"
import { ImportDocsDialog } from "@/components/project/import-docs-dialog"
import { OpenProjectDialog } from "@/components/project/open-project-dialog"
import { ScaffoldDialog } from "@/components/project/scaffold-dialog"

/**
 * Onboarding chooser (G10) shown when no project is resolved yet. It keeps target
 * ACQUISITION (how the repo lands on disk) strictly separate from spec INTAKE
 * (what's in it): cards 1–2 are pure acquisition — open an existing repo, or
 * scaffold a lean empty one — while cards 3–4 are the two intake paths (§3-S1),
 * each composing acquisition with intake. Both open the SAME open-project dialog
 * first (there is no target yet in this state), then chain into their intake
 * surface once a target exists: card 3 into the import dialog (G1), card 4 into the
 * Vivi chat (G2). The dialogs they reuse never need to know about each other.
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

  // Card 4's own acquire-then-chat orchestration, identical in shape to card 3's:
  // the open-project dialog first, then the Vivi chat once a target exists. The
  // parent is only told once the chat closes (the same unmount hazard card 3
  // guards against: reporting mid-flow flips page.tsx off "no_target" and unmounts
  // this chooser, killing the chat panel before the user is done with it).
  const [viviAcquireOpen, setViviAcquireOpen] = useState(false)
  const [viviOpen, setViviOpen] = useState(false)
  const [viviTarget, setViviTarget] = useState<CurrentProject | null>(null)

  const onViviTargetAcquired = useCallback((project: CurrentProject) => {
    setViviTarget(project)
    setViviOpen(true)
  }, [])

  const reportViviTarget = useCallback(() => {
    if (viviTarget) onProjectChanged(viviTarget)
  }, [viviTarget, onProjectChanged])

  return (
    <div className="flex h-svh w-full items-center justify-center p-6">
      <div className="flex w-full max-w-5xl flex-col gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-lg font-medium text-foreground">Start a project</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            Vivicy develops a project from its canonical spec. Open an existing repo or
            start from scratch, then bring the spec in — import docs you already have, or
            build it from nothing by talking to Vivi.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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

          <Card className="flex flex-col">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <MessagesSquare className="size-5" />
              </span>
              <CardTitle>Build the spec with Vivi</CardTitle>
              <CardDescription className="text-balance">
                No docs yet? Talk to Vivi. She grills you until your idea is a
                rigorous canonical spec and writes it into{" "}
                <code className="text-foreground">.vivicy/</code> for you.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <Button
                variant="outline"
                size="sm"
                className="w-full"
                onClick={() => setViviAcquireOpen(true)}
              >
                <MessagesSquare />
                Talk to Vivi
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

      {/* Card 4's acquisition leg: identical open-project dialog, but success
          chains into the Vivi chat rather than just reporting up. */}
      <OpenProjectDialog
        open={viviAcquireOpen}
        onOpenChange={setViviAcquireOpen}
        onChanged={onViviTargetAcquired}
      />
      <ViviChat
        open={viviOpen}
        onOpenChange={(next) => {
          setViviOpen(next)
          // Same as import: report the acquired target only once the chat closes,
          // so the parent's re-fetch (which unmounts this chooser) never fires
          // mid-conversation. The target is already persisted; a session that
          // wrote canonical docs flips the map onboarding reason off "no_target"
          // on that re-fetch.
          if (!next) reportViviTarget()
        }}
      />
    </div>
  )
}
