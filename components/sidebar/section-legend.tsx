"use client"

import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"

import { usePersistedBoolean } from "@/hooks/use-persisted-boolean"
import { kindColor, progressStatusColor, STATUS_COLORS } from "@/lib/map-palette"
import type { MapNode, ViewMode } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Separator } from "@/components/ui/separator"

/** Persisted open/closed key for the legend section. Collapsed by default. */
export const LEGEND_OPEN_KEY = "vivicy:legend-open"

interface LegendEntry {
  label: string
  bg: string
  border: string
}

/**
 * Derive the legend rows for the current view — the SAME rule the map used:
 *   - target view   -> one row per distinct node `kind`, kind colors
 *   - progress view -> one row per status, progress/status colors
 */
function legendEntries(
  view: ViewMode,
  nodes: MapNode[],
  statusLegend: Record<string, string> | undefined
): LegendEntry[] {
  if (view === "target") {
    return [...new Set(nodes.map((n) => n.kind))].sort().map((kind) => {
      const color = kindColor(kind)
      return { label: kind, bg: color.bg, border: color.border }
    })
  }
  return Object.keys(statusLegend ?? STATUS_COLORS).map((status) => {
    const color = progressStatusColor(status)
    return { label: status, bg: color.bg, border: color.border }
  })
}

/**
 * The color legend, relocated OUT of the floating map overlay and INTO the
 * sidebar's fixed bottom region (just above the quota footer). A shadcn
 * Collapsible, COLLAPSED BY DEFAULT, whose open/closed choice is persisted.
 *
 * Hydration-safe by construction: the first render is always collapsed (the
 * server-safe default); the persisted "open" choice is applied in a mount
 * effect, so SSR and the first client render agree.
 *
 * Shows the right legend for the current view (kind colors in Target, status
 * colors in Progress), mirroring the map exactly.
 */
export function SectionLegend({
  view,
  nodes,
  statusLegend,
}: {
  view: ViewMode
  nodes: MapNode[]
  statusLegend?: Record<string, string>
}) {
  const t = useTranslations("sidebar.legend")
  // Hydration-safe persisted open state: collapsed by default on the server and
  // the first client render; the stored choice is applied right after hydration.
  const [open, setOpen] = usePersistedBoolean(LEGEND_OPEN_KEY, false)

  const entries = legendEntries(view, nodes, statusLegend)
  const title = view === "target" ? t("kindColorsTitle") : t("progressColorsTitle")

  return (
    <div className="flex flex-col gap-2 px-3 pt-3">
      <Separator />
      <Collapsible
        open={open}
        onOpenChange={setOpen}
        className="flex flex-col gap-2"
      >
        <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 text-xs font-medium text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>{t("triggerLabel", { title })}</span>
          <ChevronRight className="size-4 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {entries.map((entry) => (
              <span
                key={entry.label}
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
              >
                <span
                  className={cn("size-3 shrink-0 rounded-sm border")}
                  style={{ background: entry.bg, borderColor: entry.border }}
                />
                {entry.label}
              </span>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
