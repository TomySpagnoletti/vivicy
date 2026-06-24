import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import { EMPTY_TARGET_ROOT } from "../playwright.config"

/**
 * Materialize the no-map target the empty-state spec points at: a project that
 * has a docs/ directory (so it counts as a resolved target) but no generated
 * architecture-data.json (so /api/map returns the `no_map` onboarding state).
 *
 * Idempotent: the dir is recreated from scratch on every run, and any stale
 * architecture-data.json from a previous Extract is removed.
 */
export default function globalSetup() {
  const root = EMPTY_TARGET_ROOT
  const archDir = path.join(
    root,
    "docs",
    "architecture-map",
    "viewer",
    "src"
  )
  // Ensure docs/ exists so the target counts as "resolved", and remove any
  // architecture-data.json a prior Extract may have generated under the nested
  // viewer path so the no_map state is restored. `force` makes the rm a no-op
  // when the (usually absent) file isn't there.
  mkdirSync(path.join(root, "docs"), { recursive: true })
  rmSync(path.join(archDir, "architecture-data.json"), { force: true })
}
