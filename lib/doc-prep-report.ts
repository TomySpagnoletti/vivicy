// Keep filesystem-free: client components import this module directly (server reader: control.ts#readDocPrepReport).
// Every field is optional: a report can be a mid-run snapshot or predate a field.

export const DOC_PREP_REPORT_FILE = ".vivicy/development/reports/doc-prep-report.json"

export const DOC_PREP_IN_FLIGHT_PHASES = ["classifying", "extracting", "placing"] as const

export type DocPrepPhase =
  | "classifying"
  | "extracting"
  | "placing"
  | "green"
  | "failed"
  | "skipped"

export type DocPrepRoute = "canonical" | "explode"

export interface PlacedDoc {
  target?: string
  source?: string
  route?: DocPrepRoute
  translated?: boolean
}

export interface RejectedDoc {
  source?: string
  reason?: string
  detail?: string
}

export interface DocPrepReport {
  phase?: DocPrepPhase | string
  batch_id?: string | null
  language?: string
  placed?: PlacedDoc[]
  rejected?: RejectedDoc[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
