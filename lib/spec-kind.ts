import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

export type SpecKind = "project" | "feature"

// The on-disk layout `npx skills add` leaves in a governed repo, hosted here rather than in a module of its own because this file must stay a LEAF: it is loaded both by the Next program (`@/lib/spec-kind`) and by plain node from the factory (`factory/doc-baseline.ts`, raw `../lib/spec-kind.ts`), and no relative value import satisfies both — an extensionless one fails NodeNext, a `.ts` one fails the app program (TS5097). `factory/install-skills.ts`, which writes and commits these paths, imports them from here so the writer and the detector below cannot drift apart.
export const AGENT_SKILLS_DIR = ".agents/skills"
export const PER_AGENT_SKILL_DIRS = [".claude/skills", ".codex/skills"] as const
export const SKILLS_CLI_LOCKFILE = "skills-lock.json"

const SCAFFOLD_ROOT_FILES = new Set([
  "agents.md",
  "claude.md",
  "readme.md",
  "vivicy.json",
  ".gitignore",
  ".gitattributes",
  "license",
  "license.md",
  "license.txt",
])

// Installed skill bundles are Vivicy's OWN governance output, committed by the skills stage — reading them as the owner's product code would flip a greenfield repo to `feature` on the first install, and that kind is stamped permanently into the frozen manifest. The filesystem arm below never saw them (dot-directories), so this is what makes the two arms agree.
const SKILLS_FOOTPRINT_DIRS = [AGENT_SKILLS_DIR, ...PER_AGENT_SKILL_DIRS]

function isCodeEvidence(rel: string): boolean {
  if (rel === ".vivicy" || rel.startsWith(".vivicy/")) return false
  if (SKILLS_FOOTPRINT_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}/`))) return false
  const base = rel.toLowerCase()
  if (!rel.includes("/") && (SCAFFOLD_ROOT_FILES.has(base) || base === SKILLS_CLI_LOCKFILE || base === ".gitkeep")) return false
  if (rel.endsWith("/.gitkeep")) return false
  return true
}

export function detectSpecKind(targetRoot: string): SpecKind {
  const tracked = gitTrackedFiles(targetRoot)
  if (tracked !== null) {
    return tracked.some(isCodeEvidence) ? "feature" : "project"
  }
  return fsHasCodeEvidence(targetRoot) ? "feature" : "project"
}

function gitTrackedFiles(targetRoot: string): string[] | null {
  try {
    const raw = execFileSync("git", ["ls-files", "-z"], {
      cwd: targetRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    return raw.split("\0").filter((line) => line.length > 0)
  } catch {
    return null
  }
}

function fsHasCodeEvidence(targetRoot: string): boolean {
  if (!existsSync(targetRoot)) return false
  const stack: string[] = [""]
  while (stack.length > 0) {
    const relDir = stack.pop() as string
    const absDir = path.join(targetRoot, relDir)
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue
        stack.push(rel)
        continue
      }
      if (entry.isFile() && isCodeEvidence(rel)) return true
    }
  }
  return false
}
