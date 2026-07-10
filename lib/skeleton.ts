import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

export const SKELETON_DIRS = [
  ".vivicy/canonical",
  ".vivicy/baselines",
  ".vivicy/architecture-map",
  ".vivicy/development/issues",
  ".vivicy/development/spikes",
  ".vivicy/development/reports",
  ".vivicy/requirements",
  ".vivicy/change-requests",
] as const

// Mirrors resolveTargetDir's noise rule in lib/scaffold.ts — keep both in sync.
export function pruneGitkeeps(targetRoot: string): string[] {
  const pruned: string[] = []
  for (const rel of SKELETON_DIRS) {
    const dir = path.join(targetRoot, rel)
    const keep = path.join(dir, ".gitkeep")
    if (!existsSync(keep)) continue
    const others = readdirSync(dir).filter((name) => name !== ".gitkeep" && name !== ".DS_Store")
    if (others.length === 0) continue
    rmSync(keep, { force: true })
    pruned.push(`${rel}/.gitkeep`)
  }
  return pruned
}
