"use client"

import { useEffect, useState } from "react"

import { BRAND } from "@/lib/brand"
import { DEFAULT_SETTINGS, type AgentsSettings } from "@/lib/settings"
import type { ArchitectureMapData, ViewMode } from "@/lib/types"
import type { SelectedItem } from "@/components/map/architecture-map"
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion"
import { Separator } from "@/components/ui/separator"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { ProcessControlBar } from "@/components/sidebar/process-control-bar"
import { QuotaFooter } from "@/components/sidebar/quota-footer"
import { SectionDetails } from "@/components/sidebar/section-details"
import { SectionFilters } from "@/components/sidebar/section-filters"
import { SectionInformation } from "@/components/sidebar/section-information"
import { SectionLegend } from "@/components/sidebar/section-legend"
import { SectionTasks } from "@/components/sidebar/section-tasks"
import { SettingsDialog } from "@/components/sidebar/settings-dialog"

export function VivicySidebar({
  data,
  view,
  onViewChange,
  query,
  onQueryChange,
  laneFilter,
  onLaneFilterChange,
  statusFilter,
  onStatusFilterChange,
  scopeFilter,
  onScopeFilterChange,
  selected,
  onMapRefresh,
}: {
  data: ArchitectureMapData
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  query: string
  onQueryChange: (query: string) => void
  laneFilter: string
  onLaneFilterChange: (lane: string) => void
  statusFilter: string
  onStatusFilterChange: (status: string) => void
  scopeFilter: string
  onScopeFilterChange: (scope: string) => void
  selected: SelectedItem
  onMapRefresh?: () => void
}) {
  // Shared by the Settings dialog and the quota footer, so settings are owned
  // here: loaded once on mount and updated in place when the dialog saves.
  const [settings, setSettings] = useState<AgentsSettings>(DEFAULT_SETTINGS)
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch("/api/settings", { cache: "no-store" })
        const body = (await res.json()) as { settings?: AgentsSettings }
        if (!cancelled && body.settings) setSettings(body.settings)
      } catch {
        // Keep the defaults if settings can't be loaded; never block the UI.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Sidebar
      side="right"
      collapsible="offcanvas"
      role="complementary"
      aria-label="Vivicy panel"
    >
      <SidebarHeader className="flex-row items-start justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-semibold tracking-tight text-foreground">
            {BRAND.name}
          </p>
          <p className="text-xs text-muted-foreground">{BRAND.tagline}</p>
        </div>
        <SettingsDialog onSaved={setSettings} />
      </SidebarHeader>

      <Separator />
      <ProcessControlBar development={data.development} onMapRefresh={onMapRefresh} />
      <Separator />

      <SidebarContent>
        <Accordion type="multiple" defaultValue={["tasks"]} className="px-3">
          <AccordionItem value="information">
            <AccordionTrigger>Information</AccordionTrigger>
            <AccordionContent>
              <SectionInformation
                data={data}
                filters={{
                  view,
                  query,
                  laneFilter,
                  statusFilter,
                  scopeFilter,
                }}
              />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="filters">
            <AccordionTrigger>Filters</AccordionTrigger>
            <AccordionContent>
              <SectionFilters
                data={data}
                view={view}
                onViewChange={onViewChange}
                query={query}
                onQueryChange={onQueryChange}
                laneFilter={laneFilter}
                onLaneFilterChange={onLaneFilterChange}
                statusFilter={statusFilter}
                onStatusFilterChange={onStatusFilterChange}
                scopeFilter={scopeFilter}
                onScopeFilterChange={onScopeFilterChange}
              />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="details">
            <AccordionTrigger>Details</AccordionTrigger>
            <AccordionContent>
              <SectionDetails selected={selected} data={data} />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="tasks">
            <AccordionTrigger>Tasks</AccordionTrigger>
            <AccordionContent>
              <SectionTasks development={data.development} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </SidebarContent>

      <SidebarFooter className="p-0">
        <SectionLegend
          view={view}
          nodes={data.nodes}
          statusLegend={data.statusLegend}
        />
        <QuotaFooter settings={settings} />
      </SidebarFooter>
    </Sidebar>
  )
}
