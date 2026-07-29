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
  buildProofsByIssue,
} from "@/lib/map-data"
import { transcriptName } from "@/lib/transcript"
import type { ArchitectureMapData, MapEdge, MapNode } from "@/lib/types"
import type { SelectedItem } from "@/components/map/architecture-map"

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
  const graphRef = node.graph_ref
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
      <RefBadges label={t("evidenceRefsLabel")} refs={state?.evidence_refs} />
      <CoveredBy issues={issues.map((i) => i.id)} />
      <Proofs issues={issues.map((i) => i.id)} data={data} />
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
  const graphRef = edge.graph_ref
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
      <Proofs issues={issues.map((i) => i.id)} data={data} />
      <TranscriptRefs refs={transcripts} />
    </div>
  )
}

function Proofs({ issues, data }: { issues: string[]; data: ArchitectureMapData }) {
  const t = useTranslations("sidebar.details")
  const byIssue = buildProofsByIssue(data.development?.proofs)
  const rows = issues.flatMap((issueId) =>
    (byIssue.get(issueId) ?? []).map((proof) => ({ issueId, proof }))
  )
  if (rows.length === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t("proofsLabel")}</p>
      <ul className="flex flex-col gap-2">
        {rows.map(({ issueId, proof }) => (
          <li key={`${issueId}:${proof.id}`} className="flex flex-col gap-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 font-mono break-all text-foreground">{proof.id}</span>
              <Badge variant={proof.produced ? "secondary" : "outline"} className="shrink-0">
                {proof.class.replace(/_/g, " ")}
              </Badge>
            </div>
            <p className="text-muted-foreground">
              {proof.produced
                ? t("proofProduced", { issue: issueId })
                : t("proofPending", { issue: issueId })}
            </p>
            <ProofPaths label={t("proofEvidencesLabel")} paths={proof.evidences} />
            <ProofPaths label={t("proofHomeLabel")} paths={[proof.path]} />
          </li>
        ))}
      </ul>
    </div>
  )
}

// Plain mono lines, never Badge chips: a Badge is a fixed-height single-line pill, so a long proof path would be clipped instead of wrapped.
function ProofPaths({ label, paths }: { label: string; paths: string[] }) {
  if (paths.length === 0) return null
  return (
    <div className="flex flex-col gap-0.5">
      <p className="leading-snug text-muted-foreground">{label}</p>
      {paths.map((path) => (
        <p key={path} className="font-mono text-[11px] leading-snug break-all text-foreground/80">
          {path}
        </p>
      ))}
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
      <ul className="flex flex-col items-start gap-1">
        {refs.map((ref) => (
          <li key={ref} className="max-w-full">
            <Badge
              variant="outline"
              title={ref}
              className="h-auto max-w-full py-0.5 font-mono break-all whitespace-normal"
            >
              {ref}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  )
}

const TRANSCRIPT_TAIL_CHARS = 12

// Sibling transcripts of one graph item differ only by the run id ending the name, so the elision must land in the middle — which CSS gives only as a truncating head plus an unshrinkable tail. Split on code points, never code units: the name is agent-written and a mid-surrogate cut renders replacement characters.
function splitTranscriptName(name: string): { head: string; tail: string } {
  const chars = [...name]
  if (chars.length <= TRANSCRIPT_TAIL_CHARS) return { head: "", tail: name }
  const cut = chars.length - TRANSCRIPT_TAIL_CHARS
  return { head: chars.slice(0, cut).join(""), tail: chars.slice(cut).join("") }
}

export function TranscriptRefs({ refs }: { refs: string[] }) {
  const t = useTranslations("sidebar.details")
  const { open } = useTranscript()
  if (!refs.length) return null
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t("transcriptsLabel")}</p>
      <div className="flex flex-col gap-1">
        {refs.map((ref) => {
          const name = transcriptName(ref)
          const { head, tail } = splitTranscriptName(name)
          return (
            <Button
              key={ref}
              type="button"
              variant="outline"
              size="sm"
              className="w-full justify-start gap-0 overflow-hidden text-left font-mono"
              title={ref}
              aria-label={name}
              onClick={() => open(ref, name)}
            >
              <span className="truncate">{head}</span>
              <span className="shrink-0">{tail}</span>
            </Button>
          )
        })}
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
