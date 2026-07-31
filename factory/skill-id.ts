import { AGENT_SKILLS_DIR } from "../lib/spec-kind.ts"

export interface SkillRef {
  id: string
  owner: string
  source: string
  skill: string
}

// Security boundary: ids arrive from LLM output and chat text and become directory names, symlink targets and git pathspecs — admitting `.` or `..` here is a recursive delete at the removal fallback.
function skillSegment(value: string): string | null {
  return /^[\w.-]+$/.test(value) && value !== "." && value !== ".." ? value : null
}

export function parseSkillId(id: string): SkillRef | null {
  const at = id.lastIndexOf("@")
  if (at <= 0) return null
  const source = id.slice(0, at)
  const slash = source.indexOf("/")
  if (slash <= 0) return null
  const owner = skillSegment(source.slice(0, slash))
  const repo = skillSegment(source.slice(slash + 1))
  const skill = skillSegment(id.slice(at + 1))
  if (owner === null || repo === null || skill === null) return null
  return { id, owner, source: `${owner}/${repo}`, skill }
}

export function normalizeSkillId(raw: string): SkillRef | null {
  const trimmed = raw.trim()
  const url = /^https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/?$/.exec(trimmed)
  return url ? parseSkillId(`${url[1]}/${url[2]}@${url[3]}`) : parseSkillId(trimmed)
}

export function skillBundleRel(skill: string): string {
  return `${AGENT_SKILLS_DIR}/${skill}`
}

export const SKILL_DOC_FILE = "SKILL.md"

export function skillDocRel(skill: string): string {
  return `${skillBundleRel(skill)}/${SKILL_DOC_FILE}`
}

export function declaredSkillName(entry: string): string | null {
  const ref = parseSkillId(entry)
  return ref === null ? skillSegment(entry) : ref.skill
}
