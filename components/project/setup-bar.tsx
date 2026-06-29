"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronsUpDown, FolderGit2 } from "lucide-react"

import type { CurrentProject } from "@/lib/project-types"
import { AgentsHealthDialog } from "@/components/agents/agents-health-dialog"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { OpenProjectDialog } from "@/components/project/open-project-dialog"

export function SetupBar({
  onProjectChanged,
  onAgentsWarning,
  reloadSignal,
}: {
  onProjectChanged: () => void
  onAgentsWarning?: (message: string) => void
  // Bumped by the parent when the project changes from outside the setup bar
  // (e.g. the onboarding chooser), triggering a re-fetch of the name affordance.
  reloadSignal?: number
}) {
  const [project, setProject] = useState<CurrentProject | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  const loadProject = useCallback(async () => {
    try {
      const res = await fetch("/api/project", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as { project?: CurrentProject | null }
      setProject(body.project ?? null)
    } catch {
      // Leave the affordance in its "No project" state on a failed load.
    }
  }, [])

  useEffect(() => {
    void (async () => {
      await loadProject()
    })()
    // `reloadSignal` is intentionally a dependency: an external project change
    // bumps it, re-running this load so the affordance reflects the new project.
  }, [loadProject, reloadSignal])

  return (
    <div className="pointer-events-auto absolute top-2 left-2 z-10 flex items-center gap-1.5">
      {/* The project picker lives here only once a project is selected — changing
          projects, with no duplicate selector. Before any project exists the
          onboarding chooser is the sole entry point, so this affordance is absent. */}
      {project ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="max-w-56"
                aria-label="Change project"
                onClick={() => setPickerOpen(true)}
              >
                <FolderGit2 />
                <span className="truncate">{project.name}</span>
                <ChevronsUpDown className="text-muted-foreground" />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              {/* break-all so a long absolute path wraps inside the capped width. */}
              <span className="block break-all">{project.root}</span>
            </TooltipContent>
          </Tooltip>

          <OpenProjectDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onChanged={(next) => {
              setProject(next)
              onProjectChanged()
            }}
          />
        </>
      ) : null}

      <AgentsHealthDialog onWarning={onAgentsWarning} />
    </div>
  )
}
