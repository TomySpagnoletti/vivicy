/**
 * Project-skills report schema — the JSON `factory/install-skills.ts` writes at
 * `.vivicy/development/reports/skills-report.json` at every phase of a skills
 * install (selecting -> auditing -> installing -> green | failed | skipped).
 *
 * Client-safe (types + constants only, no filesystem access) so client
 * components (the pipeline widget, the sidebar Skills section) can import the
 * shape directly — the same split as {@link file://./settings} vs its store.
 * The server-side reader lives in {@link file://./control#readSkillsReport}.
 * Every field is optional because a report can be a mid-run snapshot or predate
 * a field — mirroring how ExtractionStatus is typed.
 */

/** Repo-relative path of the report file under the target root. */
export const SKILLS_REPORT_FILE = ".vivicy/development/reports/skills-report.json"

/** Phases meaning an install/remove is currently in flight (not terminal). */
export const SKILLS_IN_FLIGHT_PHASES = ["selecting", "auditing", "installing", "removing"] as const

export type SkillsPhase =
  | "selecting"
  | "auditing"
  | "installing"
  | "removing"
  | "green"
  | "failed"
  | "skipped"

/** One security-audit verdict for an installed skill, by auditing provider. */
export interface SkillAudit {
  provider?: string
  status?: "pass" | "warn" | "fail"
}

/** One skill the installer actually installed. */
export interface InstalledSkill {
  id?: string
  source?: string
  skill?: string
  name?: string
  official?: boolean
  /** True when the audit gate was waived (allowUnsafeSkills) for this skill. */
  security_waived?: boolean
  audits?: SkillAudit[]
  reason?: string
}

/** One candidate skill the installer rejected, with its reason. */
export interface RejectedSkill {
  id?: string
  reason?: string
  detail?: string
}

/** One skill a remove run uninstalled. */
export interface RemovedSkill {
  id?: string
  detail?: string
}

export interface SkillsReport {
  phase?: SkillsPhase | string
  baseline_id?: string | null
  /** "auto" = selected from the frozen spec; "explicit" = user-given ids;
   *  "remove" = an uninstall run (W6). */
  mode?: "auto" | "explicit" | "remove" | string
  installed?: InstalledSkill[]
  rejected?: RejectedSkill[]
  /** Present on a remove run: the skills it uninstalled. */
  removed?: RemovedSkill[]
  summary?: string
  updated_at?: string
  [key: string]: unknown
}
