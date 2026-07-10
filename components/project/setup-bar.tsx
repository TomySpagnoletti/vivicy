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

// Fully controlled: project state is owned by the page (the Vivi panel's onboarding/reset logic reads the same state) — this bar only renders `project` and reports changes up.
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
      {/* z-20: must stay above the pipeline widget's z-10, or its wide centered strip intercepts clicks in this corner. */}
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
              {/* break-all: absolute paths have no spaces, so wrapping needs break-all not break-words. */}
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
