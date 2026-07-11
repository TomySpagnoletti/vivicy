"use client"

import { useState } from "react"

import type { CurrentProject } from "@/lib/project-types"
import { AgentsHealthDialog } from "@/components/agents/agents-health-dialog"
import { OpenProjectDialog } from "@/components/project/open-project-dialog"

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
    <>
      {project ? (
        <OpenProjectDialog
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          onChanged={() => onProjectChanged()}
        />
      ) : null}

      <AgentsHealthDialog onWarning={onAgentsWarning} />
    </>
  )
}
