// Keep filesystem-free: client components import this module directly (server reader: control.ts#readSkillsReport).
// Top-level fields are optional because the report is written phase by phase; each ENTRY, once present, is written whole by factory/install-skills.ts.

export const SKILLS_REPORT_FILE = ".vivicy/development/reports/skills-report.json"

export type SkillsPhase = "selecting" | "auditing" | "installing" | "removing" | "healing" | "green" | "failed" | "skipped"

// The ONE in-flight set: every reader — the app's refusal probe, the CLI's, the sidebar's disabled action — imports it instead of spelling its own, or a phase added to the writer silently reads as settled in whichever copy was not updated.
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

// `verdict` and `candidate_hash` are carried by a refused upstream UPDATE alone: the audit verdict its notification names, and the candidate bytes that refusal is about.
export interface RejectedSkill {
  id: string
  reason: string
  detail?: string
  verdict?: string
  candidate_hash?: string
}

// `installed` is the project's FULL installed set at every phase; `added`/`removed`/`verified`/`healed`/`updated` are this run's own contribution.
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
