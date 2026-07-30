import { AGENT_SKILLS_DIR } from "../lib/spec-kind.ts"

export interface SkillRef {
  id: string
  owner: string
  source: string
  skill: string
}

// The ONE segment rule every part of a skill id passes: a plain path segment, never `.` or `..`. Ids arrive from LLM output and from chat text, and the skill part becomes a directory name, a symlink path, a git pathspec and a URL path element — `a/b@..` admitted here is a recursive delete of every installed bundle at the removal fallback.
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

// The skill part of an id is the on-disk PRIMARY KEY: one bundle directory per name, whatever vendor published it. Every reader and writer of that layout derives its path here, so the installer, the removal fallback, the skills block's bullet and the preflight all name one location.
export function skillBundleRel(skill: string): string {
  return `${AGENT_SKILLS_DIR}/${skill}`
}

// The one file that makes a bundle a skill: the preflight's presence probe and the pin's own sanity check ask for it by this name.
export const SKILL_DOC_FILE = "SKILL.md"

export function skillDocRel(skill: string): string {
  return `${skillBundleRel(skill)}/${SKILL_DOC_FILE}`
}

// The vivicy.json `skills` declaration is hand-editable by the owner, so both shapes they can legitimately write resolve to the bundle they mean: a full id names it by the part after `@`, a bare name IS the name. Anything else names no bundle and can only be reported missing — never quietly treated as satisfied.
export function declaredSkillName(entry: string): string | null {
  const ref = parseSkillId(entry)
  return ref === null ? skillSegment(entry) : ref.skill
}
