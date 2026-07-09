/**
 * Spec-kind detection (W7a, v0.7.0 — owner decision D1). A governed project's spec is
 * one of exactly two kinds, decided MECHANICALLY from what the repository contains
 * when the spec work starts (never by an agent's judgment):
 *
 *   - "project": the repo carries no product code — Vivicy builds from scratch, so
 *     the spec is complete (stack, architecture, the whole product).
 *   - "feature": the repo already carries code — Vivicy governs an evolution, so the
 *     spec is scoped to what changes and the build must respect what exists.
 *
 * "Code" = any tracked file that is not Vivicy's own governance surface (`.vivicy/`),
 * a scaffold root file, or repo housekeeping. Git is the witness of record (the
 * scaffold guarantees a repo); a target with no usable git falls back to a filesystem
 * scan with the same exclusions.
 *
 * Shared by BOTH worlds — the Next control plane (`@/lib/...`) and the factory
 * (`../lib/spec-kind.ts`, same pattern as project-runtime.ts) — so Vivi's prompt,
 * the freeze manifest, and the extraction context all agree on one derivation.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readdirSync } from "node:fs"
import path from "node:path"

export type SpecKind = "project" | "feature"

/** Root files the scaffold itself plants — never evidence of product code. */
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

/** Is this repo-relative POSIX path evidence of product code? */
function isCodeEvidence(rel: string): boolean {
  if (rel === ".vivicy" || rel.startsWith(".vivicy/")) return false
  const base = rel.toLowerCase()
  if (!rel.includes("/") && (SCAFFOLD_ROOT_FILES.has(base) || base === ".gitkeep")) return false
  if (rel.endsWith("/.gitkeep")) return false
  return true
}

/**
 * Detect the spec kind for a target repo. Tracked files are the witness (`git
 * ls-files` — deliberately NOT untracked scratch, which is not yet part of the
 * product); without usable git, a shallow filesystem walk with the same exclusions
 * (plus `node_modules`/dot-dirs) answers instead.
 */
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
