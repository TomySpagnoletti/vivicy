// Keep free of node/@ imports: client components and factory/retro.ts both import this directly.

export const RETRO_REPORT_FILE = ".vivicy/development/reports/retro-report.json"

export type RetroPhase = "checking" | "quiet" | "proposals" | "failed"

export const RETRO_LANDINGS = ["method_block", "skill", "settings", "canonical_clarification"] as const

export type RetroLanding = (typeof RETRO_LANDINGS)[number]

export interface RetroRecurringClass {
  id?: string
  kind?: string
  signature?: string
  occurrences?: number
  evidence?: string[]
}

export interface RetroProposal {
  landing?: RetroLanding | string
  title?: string
  rationale?: string
  detail?: string
  addresses?: string[]
}

export interface RetroReport {
  phase?: RetroPhase | string
  baseline_id?: string | null
  done_set_hash?: string
  recurring_classes?: RetroRecurringClass[]
  proposals?: RetroProposal[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
