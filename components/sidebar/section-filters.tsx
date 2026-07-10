"use client"

import { Search } from "lucide-react"
import { useTranslations } from "next-intl"

import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { ArchitectureMapData, ViewMode } from "@/lib/types"

const SCOPES = [
  { value: "all", labelKey: "scopeAll" },
  { value: "mvp", labelKey: "scopeMvp" },
  { value: "present", labelKey: "scopePresent" },
  { value: "future", labelKey: "scopeFuture" },
] as const

export function SectionFilters({
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
}) {
  const t = useTranslations("sidebar.filters")
  const lanes = data.lanes ?? []
  const statuses = Object.keys(data.statusLegend ?? {})

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex flex-col gap-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t("viewLabel")}</p>
        <ToggleGroup
          type="single"
          value={view}
          onValueChange={(value) => {
            if (value === "target" || value === "progress") onViewChange(value)
          }}
          variant="outline"
          size="sm"
          spacing={0}
          aria-label={t("viewAriaLabel")}
          className="w-full"
        >
          <ToggleGroupItem value="target" className="flex-1">
            {t("viewTarget")}
          </ToggleGroupItem>
          <ToggleGroupItem value="progress" className="flex-1">
            {t("viewProgress")}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="map-search"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("searchLabel")}
        </Label>
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            id="map-search"
            type="search"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="pr-2 pl-7"
          />
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="filter-lane"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("laneLabel")}
        </Label>
        <Select value={laneFilter} onValueChange={onLaneFilterChange}>
          <SelectTrigger id="filter-lane" size="sm" className="w-full">
            <SelectValue placeholder={t("laneAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("laneAll")}</SelectItem>
            {lanes.map((lane) => (
              <SelectItem key={lane.id} value={lane.id}>
                {lane.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="filter-status"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("statusLabel")}
        </Label>
        <Select value={statusFilter} onValueChange={onStatusFilterChange}>
          <SelectTrigger id="filter-status" size="sm" className="w-full">
            <SelectValue placeholder={t("statusAll")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("statusAll")}</SelectItem>
            {statuses.map((status) => (
              <SelectItem key={status} value={status}>
                {status.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label
          htmlFor="filter-scope"
          className="text-xs font-medium text-muted-foreground"
        >
          {t("scopeLabel")}
        </Label>
        <Select value={scopeFilter} onValueChange={onScopeFilterChange}>
          <SelectTrigger id="filter-scope" size="sm" className="w-full">
            <SelectValue placeholder={t("scopeAll")} />
          </SelectTrigger>
          <SelectContent>
            {SCOPES.map((scope) => (
              <SelectItem key={scope.value} value={scope.value}>
                {t(scope.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  )
}
