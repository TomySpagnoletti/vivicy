"use client"

import { StatusDot } from "@/components/map/status-dot"
import { TranscriptRefs } from "@/components/sidebar/section-details"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  asNodeStatus,
  formatLineCoverage,
  issueDisplayStatus,
  issueTranscriptRefs,
} from "@/lib/map-data"
import type { DevelopmentBlock, DevelopmentIssue } from "@/lib/types"
import { cn } from "@/lib/utils"

/**
 * Tasks section: the development issue list with full info (id, title, status,
 * requirement / graph / gate / source refs, and clickable transcript refs), a
 * three-metric summary header, and the doc-line coverage counters. Pure shadcn.
 */
export function SectionTasks({
  development,
}: {
  development: DevelopmentBlock | undefined
}) {
  const issues = development?.issues ?? []
  const activeItems = development?.active_items ?? []
  const activeIssueIds = new Set(activeItems.map((item) => item.issue_id))
  const coverage = development?.coverage_summary

  return (
    <div className="flex flex-col gap-3 text-xs">
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Issues" value={String(issues.length)} />
        <Metric label="Active" value={String(activeItems.length)} />
        <Metric label="Lines → issues" value={formatLineCoverage(coverage)} />
      </div>

      {issues.length === 0 ? (
        <p className="text-muted-foreground">
          No generated issues yet. After issue generation, the semantic
          extraction pipeline fills this from the issue index.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {issues.map((issue) => (
            <IssueCard
              key={issue.id}
              issue={issue}
              development={development}
              active={activeIssueIds.has(issue.id)}
            />
          ))}
        </ul>
      )}

      {coverage ? (
        <div className="flex flex-col gap-2 text-xs text-muted-foreground">
          <Separator />
          <div className="flex flex-col gap-1">
            <CoverageRow label="Doc lines" value={coverage.total_doc_lines} />
            <CoverageRow
              label="Classified"
              value={coverage.classified_doc_lines}
              of={coverage.total_doc_lines}
            />
            <CoverageRow
              label="Requirement-linked"
              value={coverage.requirement_linked_doc_lines}
              of={coverage.total_doc_lines}
            />
            <CoverageRow
              label="Issue-linked"
              value={coverage.issue_linked_doc_lines}
              of={coverage.total_doc_lines}
            />
          </div>
        </div>
      ) : null}
    </div>
  )
}

function IssueCard({
  issue,
  development,
  active,
}: {
  issue: DevelopmentIssue
  development: DevelopmentBlock | undefined
  active: boolean
}) {
  const status = issueDisplayStatus(issue, development)
  const transcripts = issueTranscriptRefs(issue, development)

  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-card p-2.5",
        active ? "border-status-verified" : "border-border"
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot status={asNodeStatus(status)} />
        <span className="font-mono text-xs text-foreground">{issue.id}</span>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {status.replace(/_/g, " ")}
        </Badge>
      </div>
      <p className="font-medium break-words text-foreground">
        {issue.title ?? "Untitled issue"}
      </p>
      {issue.issue_path ? (
        <p className="font-mono break-all text-muted-foreground">
          {issue.issue_path}
        </p>
      ) : null}

      <dl className="flex flex-col gap-1">
        <RefRow label="Requirements" refs={issue.requirement_ids} />
        <RefRow label="Graph" refs={issue.graph_refs} />
        <RefRow label="Gates" refs={issue.verification_gate_ids} />
        <RefRow label="Sources" refs={issue.source_line_refs} />
      </dl>

      <TranscriptRefs refs={transcripts} />
    </li>
  )
}

function RefRow({
  label,
  refs,
}: {
  label: string
  refs: string[] | undefined
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="font-mono break-words text-foreground">
        {refs && refs.length > 0 ? refs.join(", ") : "None"}
      </dd>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-md border border-border bg-card p-2">
      <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {label}
      </span>
      <strong className="truncate text-sm text-foreground">{value}</strong>
    </div>
  )
}

function CoverageRow({
  label,
  value,
  of,
}: {
  label: string
  value: number | undefined
  of?: number | undefined
}) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span>{label}</span>
      <span className="font-mono text-foreground">
        {value ?? 0}
        {of != null ? ` / ${of}` : ""}
      </span>
    </div>
  )
}
