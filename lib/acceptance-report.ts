// Dependency-free: client components import this directly, and factory/acceptance.ts imports it too — keep it free of node/@ imports so both reach it.

export const ACCEPTANCE_REPORT_FILE = ".vivicy/development/reports/acceptance-report.json"

export const ACCEPTANCE_IN_FLIGHT_PHASES = ["checking"] as const

export type AcceptancePhase = "checking" | "green" | "findings" | "failed"

export type ScenarioResult = "pass" | "fail" | "unverifiable_without_run_story"

export type FindingVerification = "executed" | "read_only"

export interface AcceptanceScenario {
  id?: string
  verification?: FindingVerification | string
  result?: ScenarioResult | string
}

export interface AcceptanceFinding {
  obligation?: string
  gap?: string
  verification?: FindingVerification | string
  title?: string
  classification?: string
  cr_id?: string
}

export interface AcceptanceReport {
  phase?: AcceptancePhase | string
  baseline_id?: string | null
  done_set_hash?: string
  scenarios?: AcceptanceScenario[]
  findings?: AcceptanceFinding[]
  drafted_crs?: string[]
  read_only_scenarios?: number
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
