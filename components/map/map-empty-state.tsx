"use client"

import { useState } from "react"
import { FileUp, FolderSearch, MapPin, TriangleAlert, Workflow } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ImportDocsDialog } from "@/components/project/import-docs-dialog"
import type { MapEmptyReason } from "@/lib/types"

/**
 * Onboarding state shown in the map area when there is no graph to render.
 * Three distinct cases, all from the same sober shadcn family:
 *
 *   no_target  — no project resolved yet (folder picker arrives later).
 *   no_map     — project present but no architecture map generated yet.
 *   empty_map  — a map exists on disk but has zero nodes.
 *
 * `no_map`/`empty_map` both offer two actions side by side: Extract (reads the
 * frozen canonical) and Import docs (G1 — stages, checks, then places a corpus
 * into `.vivicy/`) — a target already exists in these states, so importing then
 * extracting is the natural path when the canonical is thin or empty.
 *
 * `extractError` surfaces the guard error from a failed extract (G11's
 * empty-canonical check: `{ ok:false, error, code:"empty_canonical" }`) — its
 * message is shown inline and the Import action is highlighted as the fix,
 * rather than leaving the user to guess from the ephemeral toast alone.
 *
 * Pure shadcn primitives (Card, Button, muted text, a lucide icon); centered in
 * the map area. No raw colors, no arbitrary values, light-only.
 */
export function MapEmptyState({
  reason,
  onExtract,
  extracting = false,
  onImported,
  extractError = null,
}: {
  reason: MapEmptyReason
  /** Re-run extraction (only meaningful when a target is set). */
  onExtract?: () => void
  extracting?: boolean
  /** Fires after Import docs successfully places a corpus (refresh the map). */
  onImported?: () => void
  /** The last extract failure, if any — highlights Import when it's empty-canonical. */
  extractError?: { message: string; code?: string } | null
}) {
  const copy = COPY[reason]
  const Icon = copy.icon
  // Extract and Import both only make sense once a target is resolved.
  const showExtract = reason !== "no_target" && onExtract
  const showImport = reason !== "no_target"
  const emptyCanonical = extractError?.code === "empty_canonical"

  const [importOpen, setImportOpen] = useState(false)

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
        {showExtract || showImport ? (
          <CardContent className="flex flex-col items-center gap-3">
            {extractError ? (
              <p className="flex items-start gap-1.5 text-left text-xs text-destructive">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>{extractError.message}</span>
              </p>
            ) : null}
            <div className="flex flex-wrap items-center justify-center gap-2">
              {showExtract ? (
                <Button variant="outline" size="sm" onClick={onExtract} disabled={extracting}>
                  {extracting ? "Extracting…" : "Extract from docs"}
                </Button>
              ) : null}
              {showImport ? (
                <Button
                  variant={emptyCanonical ? "default" : "outline"}
                  size="sm"
                  onClick={() => setImportOpen(true)}
                >
                  <FileUp />
                  Import docs
                </Button>
              ) : null}
            </div>
          </CardContent>
        ) : null}
      </Card>

      <ImportDocsDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onProjectChanged={() => onImported?.()}
      />
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
    body: "Extract reads the frozen canonical spec in docs/ and authors the full plan — requirements, vertical issues, and the architecture map. Import docs first if the canonical is still empty, or run Extract to generate the graph.",
  },
  empty_map: {
    icon: MapPin,
    title: "Architecture map is empty",
    body: "A map was generated but it has no nodes yet. Import docs that describe at least one component, then re-run Extract.",
  },
}
