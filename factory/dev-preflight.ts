#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { countForm, countOf } from "../lib/count-form.ts"
import { declaredSkillName, skillDocRel } from "./skill-id.ts"
import { resolveTargetRoot } from "./target-root.ts"

interface SkillsCheck {
  ok: boolean
  missingRequired: string[]
  reason: string | undefined
}

export function readRequiredSkills(targetRoot = resolveTargetRoot()): string[] {
  if (!targetRoot) return []
  const config = readJsonOrNull(join(targetRoot, "vivicy.json"))
  if (!config || typeof config !== "object") return []
  const declared = (config as { requiredSkills?: unknown }).requiredSkills
  if (!Array.isArray(declared)) return []
  return declared.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch {
    return null
  }
}

// Installed means the BUNDLE is in the target repo: `.agents/skills/<name>/SKILL.md` is what the skills block hands every leg and what a per-issue worktree cut from HEAD carries, so a skill living only in the machine's user-level store satisfies nothing this project's agents can read. The declared id is matched by its own on-disk name — exactly, never as a substring of some tool's output, where `vendor/next-auth@auth`'s bundle would answer for `vendor/x@auth`.
export function missingRequiredSkills(targetRoot: string | null, required: readonly string[]): string[] {
  if (targetRoot === null) return [...required]
  return required.filter((entry) => {
    const name = declaredSkillName(entry)
    return name === null || !existsSync(join(targetRoot, skillDocRel(name)))
  })
}

export function checkSkills(targetRoot = resolveTargetRoot(), required = readRequiredSkills(targetRoot)): SkillsCheck {
  if (required.length === 0) return { ok: true, missingRequired: [], reason: undefined }
  const missingRequired = missingRequiredSkills(targetRoot, required)
  return {
    ok: missingRequired.length === 0,
    missingRequired,
    reason: missingRequired.length === 0 ? undefined : "required development skills are not installed in the target project",
  }
}

// Owner-facing refusal contract, shared with factory/dev-loop.ts's preflight: it must name ONLY vivicy.json, the one location readRequiredSkills reads, and the one location the check itself looks at — an instruction pointing anywhere else cannot clear the refusal.
export function missingSkillsRefusal(missing: string[]): string {
  const them = countForm(missing.length, "it", "them")
  return (
    `${countOf(missing.length, "required development skill", "required development skills")} missing: ${missing.join(", ")}\n` +
    `  install ${them} into the target project with the Vercel \`skills\` CLI (\`npx skills add <owner/repo> --skill <name>\`), so \`${skillDocRel("<name>")}\` exists there, or drop ${them} from the target project's vivicy.json "requiredSkills"\n`
  )
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const targetRoot = resolveTargetRoot()
  const required = readRequiredSkills(targetRoot)
  const { ok, missingRequired } = checkSkills(targetRoot, required)

  if (ok) {
    if (required.length === 0) {
      process.stdout.write("dev-preflight: no development skills declared by the target project; nothing to check.\n")
    } else {
      process.stdout.write("dev-preflight: all required development skills are installed.\n")
    }
  } else {
    process.stderr.write(`dev-preflight: ${missingSkillsRefusal(missingRequired)}`)
    process.exit(1)
  }
}
