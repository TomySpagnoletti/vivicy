"use client"

import { useTranslations } from "next-intl"

import { StatusDot } from "@/components/map/status-dot"
import { useTranscript } from "@/components/transcript/transcript-modal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  asNodeStatus,
  buildEdgeCounts,
  buildGraphStatesByRef,
  buildIssuesByGraphRef,
  edgeGraphRef,
} from "@/lib/map-data"
import { transcriptName } from "@/lib/transcript"
import type { ArchitectureMapData, MapEdge, MapNode } from "@/lib/types"
import type { SelectedItem } from "@/components/map/architecture-map"

/**
 * Details section: the full record of the selected node or edge, plus the
 * issues that cover it and the captured transcript refs (clickable, opening the
 * transcript modal). Pure shadcn — tokens, Badge, and Button only.
 */
export function SectionDetails({
  selected,
  data,
}: {
  selected: SelectedItem
  data: ArchitectureMapData
}) {
  const t = useTranslations("sidebar.details")

  if (!selected) {
    return (
      <p className="text-xs text-muted-foreground">{t("emptyState")}</p>
    )
  }

  return selected.type === "node" ? (
    <NodeDetails node={selected.item} data={data} />
  ) : (
    <EdgeDetails edge={selected.item} data={data} />
  )
}

function NodeDetails({
  node,
  data,
}: {
  node: MapNode
  data: ArchitectureMapData
}) {
  const t = useTranslations("sidebar.details")
  const graphRef = node.graph_ref ?? `node:${node.id}`
  const statesByRef = buildGraphStatesByRef(data.development?.graph_item_states)
  const issuesByRef = buildIssuesByGraphRef(data.development?.issues)
  const edgeCount = buildEdgeCounts(data.edges).get(node.id) ?? 0
  const state = statesByRef.get(graphRef)
  const status = state?.status ?? node.status ?? "not_started"
  const issues = issuesByRef.get(graphRef) ?? []
  const transcripts = state?.transcript_refs ?? []
  const unknown = t("unknownValue")

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="flex items-start gap-2">
        <StatusDot status={asNodeStatus(status)} className="mt-1 shrink-0" />
        <p className="min-w-0 text-sm font-semibold break-words text-foreground">
          {node.label}
        </p>
      </div>

      <dl className="flex flex-col gap-1.5">
        <Field label={t("idLabel")} value={node.id} mono />
        <Field label={t("graphRefLabel")} value={graphRef} mono />
        <Field
          label={t("edgesLabel")}
          value={t("edgesValue", { count: edgeCount })}
        />
        <Field label={t("kindLabel")} value={node.kind} />
        <Field label={t("laneLabel")} value={node.lane || unknown} />
        <Field label={t("scopeLabel")} value={node.scope ?? unknown} />
        <Field label={t("statusLabel")} value={status.replace(/_/g, " ")} />
        <Field label={t("techLabel")} value={node.tech ?? unknown} />
        <Field label={t("ownsDataLabel")} value={(node.owns_data ?? []).join(", ") || unknown} />
      </dl>

      <RefBadges label={t("sourceRefsLabel")} refs={node.source_refs} />
      <RefBadges label={t("evidenceRefsLabel")} refs={node.evidence_refs} />
      <CoveredBy issues={issues.map((i) => i.id)} />
      <TranscriptRefs refs={transcripts} />
    </div>
  )
}

function EdgeDetails({
  edge,
  data,
}: {
  edge: MapEdge
  data: ArchitectureMapData
}) {
  const t = useTranslations("sidebar.details")
  const graphRef = edgeGraphRef(edge)
  const statesByRef = buildGraphStatesByRef(data.development?.graph_item_states)
  const issuesByRef = buildIssuesByGraphRef(data.development?.issues)
  const state = statesByRef.get(graphRef)
  const status = state?.status ?? "not_started"
  const issues = issuesByRef.get(graphRef) ?? []
  const transcripts = state?.transcript_refs ?? []
  const unknown = t("unknownValue")

  return (
    <div className="flex flex-col gap-3 text-xs">
      <p className="text-sm font-semibold break-words text-foreground">
        {edge.from} → {edge.to}
      </p>

      <dl className="flex flex-col gap-1.5">
        <Field label={t("graphRefLabel")} value={graphRef} mono />
        <Field label={t("progressLabel")} value={status.replace(/_/g, " ")} />
        <Field label={t("protocolLabel")} value={edge.protocol ?? unknown} />
        <Field label={t("relationLabel")} value={edge.relation ?? unknown} />
        <Field label={t("dataLabel")} value={(edge.data ?? []).join(", ") || unknown} />
      </dl>

      <RefBadges label={t("sourceRefsLabel")} refs={edge.source_refs} />
      <CoveredBy issues={issues.map((i) => i.id)} />
      <TranscriptRefs refs={transcripts} />
    </div>
  )
}

function CoveredBy({ issues }: { issues: string[] }) {
  const t = useTranslations("sidebar.details")
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t("coveredByLabel")}</p>
      {issues.length === 0 ? (
        <p className="text-muted-foreground">{t("noneYet")}</p>
      ) : (
        <ul className="flex flex-wrap gap-1">
          {issues.map((id) => (
            <li key={id}>
              <Badge variant="secondary" className="font-mono">
                {id}
              </Badge>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RefBadges({
  label,
  refs,
}: {
  label: string
  refs: string[] | undefined
}) {
  if (!refs || refs.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <ul className="flex flex-wrap gap-1">
        {refs.map((ref) => (
          <li key={ref}>
            <Badge variant="outline" className="font-mono break-all">
              {ref}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Clickable transcript refs; each opens the shared transcript modal. */
export function TranscriptRefs({ refs }: { refs: string[] }) {
  const t = useTranslations("sidebar.details")
  const { open } = useTranscript()
  if (!refs.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t("transcriptsLabel")}</p>
      <div className="flex flex-wrap gap-1">
        {refs.map((ref) => (
          <Button
            key={ref}
            type="button"
            variant="outline"
            size="sm"
            className="h-auto px-2 py-1 font-mono text-xs"
            title={ref}
            onClick={() => open(ref, transcriptName(ref))}
          >
            {transcriptName(ref)}
          </Button>
        ))}
      </div>
    </div>
  )
}

function Field({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd
        className={
          mono
            ? "min-w-0 text-right font-mono text-xs break-all text-foreground"
            : "min-w-0 text-right font-medium break-words text-foreground"
        }
      >
        {value}
      </dd>
    </div>
  )
}
