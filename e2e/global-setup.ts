import { mkdirSync, rmSync } from "node:fs"
import path from "node:path"

import {
  DEMO_RUNTIME_DIR,
  EMPTY_RUNTIME_DIR,
  EMPTY_TARGET_ROOT,
  ONBOARD_RUNTIME_DIR,
  ONBOARD_SCAFFOLD_PARENT,
  ONBOARD_TARGET_ROOT,
} from "../playwright.config"

/**
 * Materialize the targets the E2E servers point at, and clear each server's
 * isolated runtime dir so a persisted current-project (R10) from a prior run
 * never overrides the env target — each run starts from the env-configured state,
 * deterministically.
 *
 *   - NO-MAP target: a project that HAS docs/ (so it counts as resolved) but no
 *     generated architecture-data.json (so /api/map returns `no_map`).
 *   - ONBOARDING target: a directory with NO docs/ (so /api/map returns
 *     `no_target` and the R9 two-mode chooser renders). The R9 spec scaffolds a
 *     new project under a separate, wiped parent dir.
 *
 * Idempotent: dirs are recreated/wiped on every run.
 */
export default function globalSetup() {
  // --- No-map target (has docs/, no generated map) ---
  const root = EMPTY_TARGET_ROOT
  const archDir = path.join(root, "docs", "architecture-map", "viewer", "src")
  // Ensure docs/ exists so the target counts as "resolved", and remove any
  // architecture-data.json a prior Extract may have generated under the nested
  // viewer path so the no_map state is restored. `force` makes the rm a no-op
  // when the (usually absent) file isn't there.
  mkdirSync(path.join(root, "docs"), { recursive: true })
  rmSync(path.join(archDir, "architecture-data.json"), { force: true })

  // --- Onboarding target (NO docs/, so the chooser renders) ---
  // Recreate from scratch so it never accidentally carries a docs/ dir.
  rmSync(ONBOARD_TARGET_ROOT, { recursive: true, force: true })
  mkdirSync(ONBOARD_TARGET_ROOT, { recursive: true })
  // The parent the R9 spec scaffolds INTO: wipe it so the scaffolded child dir is
  // always new and empty (the scaffolder refuses a non-empty target).
  rmSync(ONBOARD_SCAFFOLD_PARENT, { recursive: true, force: true })
  mkdirSync(ONBOARD_SCAFFOLD_PARENT, { recursive: true })

  // Start each server with a clean runtime dir (no stale persisted project,
  // settings, or run-state lock from a prior run).
  rmSync(DEMO_RUNTIME_DIR, { recursive: true, force: true })
  rmSync(EMPTY_RUNTIME_DIR, { recursive: true, force: true })
  rmSync(ONBOARD_RUNTIME_DIR, { recursive: true, force: true })
}
