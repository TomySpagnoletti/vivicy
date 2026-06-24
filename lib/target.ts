/**
 * Resolve the target project root whose architecture map this viewer renders.
 *
 * Server-only. Resolution order:
 *   1. `VIVICY_TARGET_ROOT` env var (absolute or relative to cwd), when set.
 *   2. The Vivicy parent repository — `..` from the process cwd. In dev this is
 *      the Naight repo that holds the committed architecture map.
 *
 * No machine-specific paths are hardcoded; everything derives from the
 * environment or the process working directory.
 */

import { existsSync, statSync } from "node:fs"
import path from "node:path"

/** Absolute path to the resolved target project root. */
export function getTargetRoot(): string {
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv)
  }
  return path.resolve(process.cwd(), "..")
}

/** Path, relative to the target root, of the committed architecture-map JSON. */
export const ARCHITECTURE_DATA_RELATIVE_PATH = path.join(
  "docs",
  "architecture-map",
  "viewer",
  "src",
  "architecture-data.json"
)

/** Absolute path to the architecture-map JSON for the resolved target root. */
export function getArchitectureDataPath(): string {
  return path.join(getTargetRoot(), ARCHITECTURE_DATA_RELATIVE_PATH)
}

/**
 * Whether the resolved target is a usable project: the root exists and holds a
 * `docs/` directory (where the canonical spec lives). The folder-picker and
 * start modes arrive in a later phase; until then "no usable target" is the
 * onboarding signal the viewer surfaces. A target with `docs/` but no generated
 * map is a *different* onboarding case (see {@link getArchitectureDataPath}).
 */
export function isTargetResolved(): boolean {
  const root = getTargetRoot()
  const docs = path.join(root, "docs")
  try {
    return existsSync(root) && statSync(docs).isDirectory()
  } catch {
    return false
  }
}
