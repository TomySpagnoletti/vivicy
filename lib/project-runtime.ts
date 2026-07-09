/**
 * Per-project runtime namespacing (W8, v0.7.0). One governed project = one folder
 * under `<runtime>/projects/`, so notifications, Vivi sessions, run locks, logs, and
 * upload staging NEVER leak across projects. The key is derived from the target's
 * absolute path — stable across restarts, human-readable prefix, collision-proof
 * suffix.
 *
 * GLOBAL (stays at the runtime ROOT, deliberately): `current-project.json` (it IS the
 * project pointer — it cannot live under the project it selects) and `settings.json`
 * (agent CLIs/models are machine-level, not project-level).
 *
 * Shared by BOTH worlds — the Next control plane (`@/lib/...`) and the factory CLI
 * (`../lib/project-runtime.ts`, same pattern as `development-overlay.ts`) — so the
 * run-state lock path is derived identically on both sides. That shared derivation IS
 * the CLI↔UI agreement; neither side hardcodes the other's layout. Pure path/crypto:
 * no Next imports, no fs.
 */

import { createHash } from "node:crypto"
import path from "node:path"

/** Subdirectory of the runtime root that holds one folder per governed project. */
export const PROJECTS_SUBDIR = "projects"

/**
 * Stable per-project key: `<basename-slug>-<sha256(absolute path) first 8 hex>`.
 * The slug keeps the folder findable by a human; the hash makes two targets with the
 * same basename (or a renamed clone at a different path) collision-proof.
 */
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

/** Absolute path of a project's runtime namespace under the runtime root. */
export function getProjectRuntimeDir(runtimeRoot: string, targetRoot: string): string {
  return path.join(runtimeRoot, PROJECTS_SUBDIR, projectRuntimeKey(targetRoot))
}
