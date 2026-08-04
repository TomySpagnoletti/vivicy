"use client"

import { ArrowRight, Loader2, Power, RotateCw, TriangleAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"

import type { RegisteredProject } from "@/lib/project-types"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export type ProjectAction = "open" | "restart" | "stop" | "forget"

export function ProjectRow({
  project,
  pending,
  disabled,
  onAction,
}: {
  project: RegisteredProject
  pending: ProjectAction | null
  disabled: boolean
  onAction: (action: ProjectAction, project: RegisteredProject) => void
}) {
  const t = useTranslations("launcher")

  return (
    <li
      data-project-root={project.root}
      data-running={project.running}
      className="flex flex-col gap-2 px-4 py-3 not-last:border-b hover:bg-muted/40 sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <span
          aria-hidden
          className={
            project.missing
              ? "size-1.5 shrink-0 rounded-full bg-destructive"
              : project.running
                ? "size-1.5 shrink-0 rounded-full bg-primary"
                : "size-1.5 shrink-0 rounded-full bg-muted-foreground/40"
          }
        />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium text-foreground">{project.name}</span>
          <span className="truncate font-mono text-xs text-muted-foreground" title={project.root}>
            {project.root}
          </span>
        </span>
      </span>

      <span className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <span className="text-xs whitespace-nowrap text-muted-foreground">
          {project.missing ? (
            <span className="flex items-center gap-1 text-destructive">
              <TriangleAlert className="size-3" aria-hidden />
              {t("status.missing")}
            </span>
          ) : project.running ? (
            t("status.running", { port: project.port })
          ) : (
            t("status.stopped")
          )}
        </span>

        <span className="flex shrink-0 items-center gap-1">
          {project.missing ? null : (
            <Button
              size="sm"
              aria-disabled={disabled}
              className={disabled ? "opacity-60" : undefined}
              onClick={() => {
                if (disabled) return
                onAction("open", project)
              }}
            >
              {pending === "open" ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              {project.running ? t("action.focus") : t("action.open")}
            </Button>
          )}
          {project.running && !project.missing ? (
            <IconAction
              label={t("action.restart")}
              disabled={disabled}
              busy={pending === "restart"}
              onClick={() => onAction("restart", project)}
            >
              <RotateCw />
            </IconAction>
          ) : null}
          {project.running ? (
            <IconAction label={t("action.stop")} disabled={disabled} busy={pending === "stop"} onClick={() => onAction("stop", project)}>
              <Power />
            </IconAction>
          ) : null}
          {project.running && !project.missing ? null : (
            <IconAction
              label={t("action.forget")}
              disabled={disabled}
              busy={pending === "forget"}
              onClick={() => onAction("forget", project)}
            >
              <X />
            </IconAction>
          )}
        </span>
      </span>
    </li>
  )
}

function IconAction({
  label,
  busy,
  disabled,
  onClick,
  children,
}: {
  label: string
  busy: boolean
  disabled: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-disabled={disabled}
          className={disabled ? "opacity-60" : undefined}
          onClick={() => {
            if (disabled) return
            onClick()
          }}
        >
          {busy ? <Loader2 className="animate-spin" /> : children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
