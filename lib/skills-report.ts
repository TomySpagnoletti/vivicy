// Keep filesystem-free: client components import this module directly (server reader: control.ts#readSkillsReport).
// Every field is optional: a report can be a mid-run snapshot or predate a field.

export const SKILLS_REPORT_FILE = ".vivicy/development/reports/skills-report.json"

export const SKILLS_IN_FLIGHT_PHASES = ["selecting", "auditing", "installing", "removing"] as const

export type SkillsPhase =
  | "selecting"
  | "auditing"
  | "installing"
  | "removing"
  | "green"
  | "failed"
  | "skipped"

export interface SkillAudit {
  provider?: string
  status?: "pass" | "warn" | "fail"
}

export interface InstalledSkill {
  id?: string
  source?: string
  skill?: string
  name?: string
  official?: boolean
  security_waived?: boolean
  audits?: SkillAudit[]
  reason?: string
}

export interface RejectedSkill {
  id?: string
  reason?: string
  detail?: string
}

export interface RemovedSkill {
  id?: string
  detail?: string
}

export interface SkillsReport {
  phase?: SkillsPhase | string
  baseline_id?: string | null
  mode?: "auto" | "explicit" | "remove" | string
  installed?: InstalledSkill[]
  rejected?: RejectedSkill[]
  removed?: RemovedSkill[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
