import { StatusDot } from "@/components/map/status-dot"
import {
  asNodeStatus,
  computeVisibleCounts,
  type MapFilters,
} from "@/lib/map-data"
import type { ArchitectureMapData } from "@/lib/types"

/**
 * Information section: map metadata (name, version, updated, purpose), the
 * active view's subtitle, total + filtered ("visible") node/edge counts, the
 * lane count, and the full status legend. Pure shadcn — design tokens and
 * primitives only, no raw colors or arbitrary values.
 */
export function SectionInformation({
  data,
  filters,
}: {
  data: ArchitectureMapData
  filters: MapFilters
}) {
  const legendEntries = Object.entries(data.statusLegend ?? {})
  const subtitle = data.views?.[filters.view]?.subtitle
  const visible = computeVisibleCounts(data, filters)
  const filtered =
    visible.nodes !== data.nodes.length || visible.edges !== data.edges.length

  return (
    <div className="flex flex-col gap-3 text-xs">
      {subtitle ? <p className="text-muted-foreground">{subtitle}</p> : null}

      <dl className="flex flex-col gap-1.5">
        <Field label="Name" value={data.name} />
        {data.version != null ? (
          <Field label="Version" value={String(data.version)} />
        ) : null}
        <Field label="Updated" value={data.updated ?? "—"} />
        <Field
          label="Nodes / edges"
          value={`${data.nodes.length} / ${data.edges.length}`}
        />
        <Field
          label="Visible"
          value={
            filtered
              ? `${visible.nodes} / ${visible.edges}`
              : "all nodes / edges"
          }
        />
        {data.lanes && data.lanes.length > 0 ? (
          <Field label="Lanes" value={String(data.lanes.length)} />
        ) : null}
      </dl>

      {data.purpose ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium text-muted-foreground">Purpose</p>
          <p className="leading-relaxed text-foreground">{data.purpose}</p>
        </div>
      ) : null}

      {legendEntries.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Status legend
          </p>
          <ul className="flex flex-col gap-1.5">
            {legendEntries.map(([status, description]) => (
              <li key={status} className="flex items-start gap-2">
                <StatusDot status={asNodeStatus(status)} className="mt-1" />
                <div className="min-w-0">
                  <p className="font-medium text-foreground">
                    {status.replace(/_/g, " ")}
                  </p>
                  <p className="text-muted-foreground">{description}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium break-words text-foreground">
        {value}
      </dd>
    </div>
  )
}
