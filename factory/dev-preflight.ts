#!/usr/bin/env node
import { existsSync } from "node:fs"
import { join } from "node:path"
import { countForm, countOf } from "../lib/count-form.ts"
import { declaredSkillName, skillDocRel } from "./skill-id.ts"
import { declaredSkillIds, PROJECT_SKILLS_SOURCE } from "./skill-pin.ts"
import { resolveTargetRoot } from "./target-root.ts"

interface SkillsCheck {
  ok: boolean
  missing: string[]
  reason: string | undefined
}

export function readDeclaredSkills(targetRoot = resolveTargetRoot()): string[] {
  return targetRoot === null ? [] : declaredSkillIds(targetRoot)
}

// Installed means the BUNDLE is in the target repo: `.agents/skills/<name>/SKILL.md` is what the skills block hands every leg and what a per-issue worktree cut from HEAD carries, so a skill living only in the machine's user-level store satisfies nothing this project's agents can read. The declared id is matched by its own on-disk name — exactly, never as a substring of some tool's output, where `vendor/next-auth@auth`'s bundle would answer for `vendor/x@auth`.
export function missingDeclaredSkills(targetRoot: string | null, declared: readonly string[]): string[] {
  if (targetRoot === null) return [...declared]
  return declared.filter((entry) => {
    const name = declaredSkillName(entry)
    return name === null || !existsSync(join(targetRoot, skillDocRel(name)))
  })
}

export function checkSkills(targetRoot = resolveTargetRoot(), declared = readDeclaredSkills(targetRoot)): SkillsCheck {
  if (declared.length === 0) return { ok: true, missing: [], reason: undefined }
  const missing = missingDeclaredSkills(targetRoot, declared)
  return {
    ok: missing.length === 0,
    missing,
    reason: missing.length === 0 ? undefined : "required development skills are not installed in the target project",
  }
}

// Owner-facing refusal contract, shared with factory/dev-loop.ts's preflight: it must name ONLY the vivicy.json declaration the check reads and the one on-disk location it looks at — an instruction pointing anywhere else cannot clear the refusal.
export function missingSkillsRefusal(missing: string[]): string {
  const them = countForm(missing.length, "it", "them")
  return (
    `${countOf(missing.length, "required development skill", "required development skills")} missing: ${missing.join(", ")}\n` +
    `  install ${them} into the target project with the Vercel \`skills\` CLI (\`npx skills add <owner/repo> --skill <name>\`), so \`${skillDocRel("<name>")}\` exists there, or drop ${them} from the target project's ${PROJECT_SKILLS_SOURCE}\n`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targetRoot = resolveTargetRoot()
  const declared = readDeclaredSkills(targetRoot)
  const { ok, missing } = checkSkills(targetRoot, declared)

  if (ok) {
    if (declared.length === 0) {
      process.stdout.write("dev-preflight: no development skills declared by the target project; nothing to check.\n")
    } else {
      process.stdout.write("dev-preflight: all required development skills are installed.\n")
    }
  } else {
    process.stderr.write(`dev-preflight: ${missingSkillsRefusal(missing)}`)
    process.exit(1)
  }
}
