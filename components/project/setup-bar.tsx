"use client"

import { useState } from "react"
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
 * Top-left overlay controls: the project SWITCHER (once a project exists) and the
 * agents health chip. The current project is owned by the page (single source of
 * truth — the Vivi panel's onboarding/reset logic reads the same state), so this
 * bar is fully controlled: it renders `project` and reports changes up. The
 * notification bell that used to live here is retired (W5/D3) — notifications
 * moved into the Vivi panel.
 */
export function SetupBar({
  project,
  onProjectChanged,
  onAgentsWarning,
}: {
  project: CurrentProject | null
  onProjectChanged: () => void
  onAgentsWarning?: (message: string) => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)

  return (
    <div className="pointer-events-auto absolute top-2 left-2 z-20 flex items-center gap-1.5">
      {/* z-20 keeps these controls (project switcher, agents chip) clickable
          ABOVE the pipeline widget (z-10), whose wide centered strip would
          otherwise intercept clicks over the top-left corner. */}
      {/* The project picker lives here only once a project is selected — changing
          projects, with no duplicate selector. Before any project exists the Vivi
          panel's onboarding view is the sole entry point, so this affordance is absent. */}
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
            onChanged={() => onProjectChanged()}
          />
        </>
      ) : null}

      <AgentsHealthDialog onWarning={onAgentsWarning} />
    </div>
  )
}
