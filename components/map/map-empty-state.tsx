"use client"

import { FolderSearch, MapPin, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { MapEmptyReason } from "@/lib/types"

/**
 * Onboarding state shown in the map area when there is no graph to render.
 * Three distinct cases, all from the same sober shadcn family:
 *
 *   no_target  — no project resolved yet (folder picker arrives later).
 *   no_map     — project present but no architecture map generated yet.
 *   empty_map  — a map exists on disk but has zero nodes.
 *
 * Pure shadcn primitives (Card, Button, muted text, a lucide icon); centered in
 * the map area. No raw colors, no arbitrary values, light-only.
 */
export function MapEmptyState({
  reason,
  onExtract,
  extracting = false,
}: {
  reason: MapEmptyReason
  /** Re-run extraction (only meaningful when a target is set). */
  onExtract?: () => void
  extracting?: boolean
}) {
  const copy = COPY[reason]
  const Icon = copy.icon
  // The Extract action only makes sense once a target is resolved.
  const showExtract = reason !== "no_target" && onExtract

  return (
    <div className="flex h-svh w-full items-center justify-center p-6">
      <Card className="w-full max-w-md text-center" data-empty-reason={reason}>
        <CardHeader className="items-center gap-2">
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <Icon className="size-5" />
          </span>
          <CardTitle>{copy.title}</CardTitle>
          <CardDescription className="text-balance">{copy.body}</CardDescription>
        </CardHeader>
        {showExtract ? (
          <CardContent className="flex flex-col items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onExtract}
              disabled={extracting}
            >
              {extracting ? "Extracting…" : "Extract from docs"}
            </Button>
          </CardContent>
        ) : null}
      </Card>
    </div>
  )
}

const COPY: Record<
  MapEmptyReason,
  { icon: typeof FolderSearch; title: string; body: string }
> = {
  no_target: {
    icon: FolderSearch,
    title: "No project selected",
    body: "Vivicy needs a project whose docs/ folder holds the canonical spec. Use “Open project” in the top-left to choose the local repository to develop.",
  },
  no_map: {
    icon: Workflow,
    title: "No issues extracted yet",
    body: "Extract reads the frozen canonical spec in docs/ and authors the full plan — requirements, vertical issues, and the architecture map. Run it to generate the graph, then it appears here.",
  },
  empty_map: {
    icon: MapPin,
    title: "Architecture map is empty",
    body: "A map was generated but it has no nodes yet. Re-run Extract after the canonical docs describe at least one component.",
  },
}
