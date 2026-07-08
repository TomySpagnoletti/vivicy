import { existsSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

/**
 * The directory skeleton every Vivicy-managed project needs: the `.vivicy/` layout
 * the factory reads + writes (so the empty-map onboarding resolves cleanly) and the
 * always-present output dirs. Empty dirs are tracked with a `.gitkeep` so they survive
 * a commit; the `.gitkeep` is a placeholder ONLY — {@link pruneGitkeeps} removes it
 * mechanically the moment real content lands next to it.
 */
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

/**
 * Remove the `.gitkeep` placeholder from every skeleton dir that now holds real
 * content. Deterministic, idempotent, and cheap (8 readdirs) — callers run it after
 * any write that can populate a skeleton dir (upload placement, Vivi turns, freeze,
 * extraction, CR application, dev-loop checkpoints). `.DS_Store` does not count as
 * content, mirroring resolveTargetDir's noise rule. Returns the pruned repo-relative
 * paths (POSIX separators, matching how the skeleton is declared).
 */
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
