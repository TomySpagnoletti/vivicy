// Leaf by construction: no Next alias, no relative import, nothing from `node:` — the factory loads it by relative `.ts` path and a client component renders it.

export interface SkillUsageEntry {
  issue_id: string
  installed: string[]
  applied: string[]
  not_installed: string[]
}

interface SkillAppliedCount {
  id: string
  applied: number
  issues: number
}

interface SkillClaimCount {
  id: string
  issues: number
}

// Counts stay arrays, never objects keyed by id: an agent-authored id would take `__proto__` as a key.
export interface SkillUsage {
  issues: number
  applied: SkillAppliedCount[]
  not_installed: SkillClaimCount[]
}

export const MAX_SKILL_IDS = 32

const MAX_SKILL_ID_LENGTH = 120

function isCleanSkillId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_SKILL_ID_LENGTH) return false
  for (const char of id) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/.test(char)) return false
  }
  return true
}

// The ONE normalization of an untrusted skill-id list: never loosen the bound or admit interior whitespace or a control character — a claimed id rides verbatim into the retro leg's prompt.
export function normalizeSkillIds(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    if (ids.length >= MAX_SKILL_IDS) break
    if (typeof entry !== "string") continue
    const id = entry.trim()
    if (isCleanSkillId(id) && !ids.includes(id)) ids.push(id)
  }
  return ids
}

function normalizeSkillUsageEntries(value: unknown): SkillUsageEntry[] {
  if (!Array.isArray(value)) return []
  const entries: SkillUsageEntry[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue
    const record = raw as { issue_id?: unknown; installed?: unknown; applied?: unknown; not_installed?: unknown }
    const issueId = typeof record.issue_id === "string" ? record.issue_id.trim() : ""
    if (issueId.length === 0 || seen.has(issueId)) continue
    seen.add(issueId)
    entries.push({
      issue_id: issueId,
      installed: normalizeSkillIds(record.installed),
      applied: normalizeSkillIds(record.applied),
      not_installed: normalizeSkillIds(record.not_installed),
    })
  }
  return entries
}

export function reportedSkillIds(report: { installed?: unknown } | null | undefined): string[] {
  const installed = report && Array.isArray(report.installed) ? report.installed : []
  return normalizeSkillIds(installed.map((entry) => (entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined)))
}

export function deriveSkillUsage({ entries, installed }: { entries: unknown; installed: readonly string[] }): SkillUsage {
  const normalized = normalizeSkillUsageEntries(entries)
  const installedIds = normalizeSkillIds(installed)
  const installedSet = new Set(installedIds)
  const applied = installedIds.map((id) => ({
    id,
    applied: normalized.filter((entry) => entry.applied.includes(id)).length,
    issues: normalized.filter((entry) => entry.installed.includes(id)).length,
  }))
  const claims = new Map<string, number>()
  for (const entry of normalized) {
    for (const id of entry.not_installed) {
      if (installedSet.has(id)) continue
      claims.set(id, (claims.get(id) ?? 0) + 1)
    }
  }
  return {
    issues: normalized.length,
    applied,
    not_installed: [...claims].map(([id, issues]) => ({ id, issues })).sort(byIssuesThenId),
  }
}

function byIssuesThenId(a: SkillClaimCount, b: SkillClaimCount): number {
  return b.issues - a.issues || a.id.localeCompare(b.id)
}
