import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import {
  DEMO_RUNTIME_DIR,
  EMPTY_RUNTIME_DIR,
  EMPTY_TARGET_ROOT,
} from "../playwright.config"

/**
 * Materialize the no-map target the empty-state spec points at: a project that
 * has a docs/ directory (so it counts as a resolved target) but no generated
 * architecture-data.json (so /api/map returns the `no_map` onboarding state).
 *
 * Also clears each server's isolated runtime dir so a persisted current-project
 * (R10) from a prior picker run never overrides the env target — each E2E run
 * starts from the env-configured target, deterministically.
 *
 * Idempotent: the no-map dir is recreated from scratch on every run, any stale
 * architecture-data.json from a previous Extract is removed, and the runtime dirs
 * are wiped.
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

  // Start each server with a clean runtime dir (no stale persisted project,
  // settings, or run-state lock from a prior run).
  rmSync(DEMO_RUNTIME_DIR, { recursive: true, force: true })
  rmSync(EMPTY_RUNTIME_DIR, { recursive: true, force: true })
}
