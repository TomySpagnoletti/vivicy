// Keep filesystem-free: client components import this module directly (server reader: control.ts#readSkillsReport).
// Top-level fields are optional because the report is written phase by phase; each ENTRY, once present, is written whole by factory/install-skills.ts.

export const SKILLS_REPORT_FILE = ".vivicy/development/reports/skills-report.json"

export const SKILLS_IN_FLIGHT_PHASES = ["selecting", "auditing", "installing", "removing"] as const

export type SkillsPhase = "selecting" | "auditing" | "installing" | "removing" | "green" | "failed" | "skipped"

export interface SkillAudit {
  provider: string
  status: "pass" | "warn" | "fail"
}

export interface InstalledSkill {
  id: string
  source: string
  skill: string
  name: string
  official: boolean
  security_waived: boolean
  audits: SkillAudit[]
  reason: string
}

export interface RejectedSkill {
  id: string
  reason: string
  detail?: string
}

// `installed` is the project's FULL installed set at every phase; `added`/`removed` are this run's own contribution.
export interface SkillsReport {
  phase?: SkillsPhase | string
  selection_baseline_id?: string | null
  mode?: "auto" | "explicit" | "remove" | string
  installed?: InstalledSkill[]
  added?: string[]
  removed?: string[]
  rejected?: RejectedSkill[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
