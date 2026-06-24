"use client"

import { useState } from "react"
import { FolderOpen, Sparkles } from "lucide-react"

import type { CurrentProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { OpenProjectDialog } from "@/components/project/open-project-dialog"
import { ScaffoldDialog } from "@/components/project/scaffold-dialog"

/**
 * The onboarding two-mode chooser (R9), shown in the map area when no project is
 * selected yet. Two ways to begin, each a sober shadcn Card:
 *
 *   Mode A — "Start with an existing folder": pick a repo that ALREADY holds its
 *     canonical spec under docs/. Reuses the R10 project picker; Vivicy then drives
 *     the existing method against it (baseline -> extraction -> issues -> dev-loop)
 *     and adds only dev OUTPUT to the target.
 *
 *   Mode B — "Start from scratch": give a new (empty) folder + a project name;
 *     Vivicy scaffolds the directory architecture and the full governance/method
 *     skeleton (but not the canonical product docs — the user writes those).
 *
 * On success either mode sets the chosen project as current and calls
 * `onProjectChanged`, so the app re-fetches the map and lands on the project (the
 * "no architecture map yet" empty state for a fresh scaffold). Pure shadcn,
 * light-only, no arbitrary values.
 */
export function OnboardingChooser({
  onProjectChanged,
}: {
  onProjectChanged: (project: CurrentProject) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [scaffoldOpen, setScaffoldOpen] = useState(false)

  return (
    <div className="flex h-svh w-full items-center justify-center p-6">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex flex-col items-center gap-1 text-center">
          <h1 className="text-lg font-medium text-foreground">Start a project</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            Vivicy develops a project from its canonical spec. Open an existing repo
            that already has one, or scaffold a new project to write the spec in.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          {/* Mode A — existing folder. */}
          <Card className="flex flex-col">
            <CardHeader className="gap-2">
              <span
                aria-hidden
                className="flex size-9 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <FolderOpen className="size-5" />
              </span>
              <CardTitle>Start with an existing folder</CardTitle>
              <CardDescription className="text-balance">
                Pick a repository that already holds its canonical spec under{" "}
                <code className="text-foreground">docs/</code>. Vivicy runs the
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

          {/* Mode B — start from scratch. */}
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
                Give a new empty folder and a name. Vivicy scaffolds the directory
                architecture and the full method — you write the canonical spec
                afterwards.
              </CardDescription>
            </CardHeader>
            <CardFooter className="mt-auto">
              <Button size="sm" className="w-full" onClick={() => setScaffoldOpen(true)}>
                <Sparkles />
                Scaffold a new project
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
    </div>
  )
}
