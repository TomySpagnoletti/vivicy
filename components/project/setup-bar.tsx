"use client"

import { useCallback, useEffect, useState } from "react"
import { ChevronsUpDown, FolderGit2, Sparkles } from "lucide-react"

import type { CurrentProject } from "@/lib/project-types"
import { AgentsHealthDialog } from "@/components/agents/agents-health-dialog"
import { ViviChat } from "@/components/chat/vivi-chat"
import { NotificationBell } from "@/components/notifications/notification-bell"
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
  const [viviOpen, setViviOpen] = useState(false)

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
    <div className="pointer-events-auto absolute top-2 left-2 z-20 flex items-center gap-1.5">
      {/* z-20 keeps these controls (project switcher, agents, notification bell)
          clickable ABOVE the pipeline widget (z-10), whose wide centered strip
          would otherwise intercept clicks over the top-left corner. */}
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

          {/* Reach Vivi anytime a project is active — not only during onboarding. This
              bar is always mounted (even while the dev-loop runs), so the chat is the
              standing channel for mid-run intention changes (B8.1): post-freeze a turn
              drafts a Change Request instead of editing the locked canonical. */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                aria-label="Talk to Vivi"
                onClick={() => setViviOpen(true)}
              >
                <Sparkles />
                <span>Talk to Vivi</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">
              Talk to Vivi about the spec — a change after the freeze becomes a Change Request.
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

          {/* Same ViviChat panel the onboarding chooser uses; here it stays available
              for the whole life of the project. A turn that wrote (a canonical doc, or a
              CR post-freeze) bubbles up so the map re-fetches and a drafted CR surfaces
              in the notification center's review section. */}
          <ViviChat open={viviOpen} onOpenChange={setViviOpen} onWrote={() => onProjectChanged()} />
        </>
      ) : null}

      <AgentsHealthDialog onWarning={onAgentsWarning} />
      <NotificationBell />
    </div>
  )
}
