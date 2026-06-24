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

/**
 * The always-present setup bar (R10 + R11): the current-project affordance (folder
 * name + a button to change it) and the agent-CLI status chip. Rendered over the
 * map inset in EVERY state — including onboarding — so the user can pick a project
 * and check agent health before any map exists. Selecting a project re-fetches the
 * map via `onProjectChanged`.
 */
export function SetupBar({
  onProjectChanged,
  onAgentsWarning,
}: {
  onProjectChanged: () => void
  onAgentsWarning?: (message: string) => void
}) {
  const [project, setProject] = useState<CurrentProject | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)

  // Load the persisted current project so the affordance shows its name.
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
  }, [loadProject])

  return (
    <div className="pointer-events-auto absolute top-2 left-2 z-10 flex items-center gap-1.5">
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
            <span className="truncate">{project ? project.name : "No project"}</span>
            <ChevronsUpDown className="text-muted-foreground" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          {project ? project.root : "Choose the project to develop"}
        </TooltipContent>
      </Tooltip>

      <AgentsHealthDialog onWarning={onAgentsWarning} />

      <OpenProjectDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onChanged={(next) => {
          setProject(next)
          onProjectChanged()
        }}
      />
    </div>
  )
}
