// Keep filesystem-free: client components import this module directly (server reader: control.ts#readSkillsReport).

export const SKILLS_REPORT_FILE = ".vivicy/development/reports/skills-report.json"

export type SkillsPhase = "selecting" | "auditing" | "installing" | "removing" | "healing" | "green" | "failed" | "skipped"

// The ONE in-flight set: every reader imports it, never spells its own.
export const SKILLS_IN_FLIGHT_PHASES: readonly SkillsPhase[] = ["selecting", "auditing", "installing", "removing", "healing"]

export function isSkillsPhaseInFlight(phase: unknown): boolean {
  return typeof phase === "string" && (SKILLS_IN_FLIGHT_PHASES as readonly string[]).includes(phase)
}

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
  verdict?: string
  candidate_hash?: string
}

export interface SkillsReport {
  phase?: SkillsPhase | string
  selection_baseline_id?: string | null
  mode?: "auto" | "explicit" | "remove" | "maintain" | string
  installed?: InstalledSkill[]
  added?: string[]
  removed?: string[]
  verified?: string[]
  healed?: string[]
  updated?: string[]
  rejected?: RejectedSkill[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
