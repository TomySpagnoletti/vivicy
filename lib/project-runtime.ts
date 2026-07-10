import { createHash } from "node:crypto"
import path from "node:path"

// Imported directly by factory/cli.ts via a relative .ts path (no bundler) — this file must stay free of Next path aliases and any Next-only imports.
export const PROJECTS_SUBDIR = "projects"

// Changing this key's derivation orphans already-created project folders on disk.
export function projectRuntimeKey(targetRoot: string): string {
  const abs = path.resolve(targetRoot)
  const slug =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "project"
  const hash = createHash("sha256").update(abs).digest("hex").slice(0, 8)
  return `${slug}-${hash}`
}

export function getProjectRuntimeDir(runtimeRoot: string, targetRoot: string): string {
  return path.join(runtimeRoot, PROJECTS_SUBDIR, projectRuntimeKey(targetRoot))
}
