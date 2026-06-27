import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

// Where the cross-browser screenshot captures land (xbrowser-screenshots.spec +
// the onboarding chooser capture). Created up front so any spec can write into it.
const XBROWSER_SHOTS_DIR = "/tmp/vivicy-xbrowser"

import {
  DEMO_TARGET_ROOT,
  EMPTY_TARGET_ROOT,
  LONG_TARGET_ROOT,
  onboardScaffoldParent,
  ONBOARD_TARGET_ROOT,
  RUNTIME_DIR,
} from "../playwright.config"

// The browser keys the matrix runs (kept in lock-step with playwright.config's
// BROWSERS). Each shape has one isolated server PER browser, so each gets its own
// runtime dir / scaffold parent to wipe.
const BROWSER_KEYS = [
  "chromium-desktop",
  "chromium-mobile",
  "firefox-desktop",
  "webkit-desktop",
] as const
const SHAPES = ["demo", "empty", "onboarding"] as const

/**
 * Materialize the targets the E2E servers point at, and clear every per-browser
 * runtime dir + scaffold parent so a persisted current-project (R10) / settings /
 * run-lock from a prior run never overrides the env target — each run starts from
 * the env-configured state, deterministically.
 *
 *   - NO-MAP target: a project that HAS docs/ (so it counts as resolved) but no
 *     generated architecture-data.json (so /api/map returns `no_map`).
 *   - ONBOARDING target: a directory with NO docs/ (so /api/map returns
 *     `no_target` and the R9 two-mode chooser renders). The R9 spec scaffolds a
 *     new project under a separate, wiped, per-browser parent dir.
 *
 * Idempotent: dirs are recreated/wiped on every run.
 */
export default function globalSetup() {
  // Cross-browser screenshot output dir (idempotent).
  mkdirSync(XBROWSER_SHOTS_DIR, { recursive: true })

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

  // --- Very-long-path target (overflow spec) ---
  // A deep, long-named copy of the demo target so the overflow spec can select it
  // and exercise long content across the header tooltip, picker, and Details
  // panel. Rebuilt each run so it tracks the demo fixture. Only built when the
  // demo target actually exists on disk (it ships as a committed fixture).
  const longRoot = "/tmp/vivicy-long"
  rmSync(longRoot, { recursive: true, force: true })
  if (existsSync(DEMO_TARGET_ROOT)) {
    mkdirSync(path.dirname(LONG_TARGET_ROOT), { recursive: true })
    // Copy the demo target's docs/ tree (the architecture map source) into the
    // long path; skip the demo's .git so the copy is a clean target.
    cpSync(DEMO_TARGET_ROOT, LONG_TARGET_ROOT, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}.git`),
    })
  }

  // Start each per-browser server with a clean runtime dir (no stale persisted
  // project, settings, or run-state lock from a prior run), and wipe each
  // onboarding scaffold parent so the scaffolded child dir is always new/empty —
  // the e2e onboarding exercises the FROM-SCRATCH lean scaffold path.
  for (const shape of SHAPES) {
    for (const browserKey of BROWSER_KEYS) {
      rmSync(RUNTIME_DIR(shape, browserKey), { recursive: true, force: true })
    }
  }
  for (const browserKey of BROWSER_KEYS) {
    const parent = onboardScaffoldParent(browserKey)
    rmSync(parent, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
  }
}
