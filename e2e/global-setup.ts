import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

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

// The committed demo fixture: a COMPLETE, valid `.vivicy/` (canonical spec,
// generated architecture map, requirements, issue index, issues, and a live
// progress ledger with verified/in_progress states). Materialized to
// DEMO_TARGET_ROOT so the app resolves a target (`.vivicy/canonical/` present)
// and `/api/map` renders the populated graph with live progress voyants.
const DEMO_FIXTURE_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "demo-target"
)

/** cpSync a directory tree, skipping any nested `.git` so the copy is a clean target. */
function copyTarget(from: string, to: string): void {
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.git`),
  })
}

/**
 * Materialize the targets the E2E servers point at, and clear every per-browser
 * runtime dir + scaffold parent so a persisted current-project (R10) / settings /
 * run-lock from a prior run never overrides the env target — each run starts from
 * the env-configured state, deterministically.
 *
 * The three app SHAPES map to the three states {@link file://../lib/target.ts}
 * distinguishes via `.vivicy/`:
 *
 *   - DEMO target: a copy of the committed demo fixture — a full `.vivicy/` with a
 *     generated `architecture-map/architecture-data.json`, so `/api/map` renders
 *     the populated graph (with the live progress overlay from its ledger).
 *   - NO-MAP target: a `.vivicy/canonical/` holding a real doc but NO generated
 *     `architecture-data.json`, so the target is "resolved" yet `/api/map` returns
 *     `no_map` (the "extract the map" onboarding case).
 *   - ONBOARDING target: a directory with NO `.vivicy/` at all, so the target is
 *     unresolved and `/api/map` returns `no_target` (the G10 chooser). The G10 spec
 *     scaffolds a new project under a separate, wiped, per-browser parent dir.
 *
 * Idempotent: every target dir is rebuilt from scratch on each run.
 */
export default function globalSetup() {
  // Cross-browser screenshot output dir (idempotent).
  mkdirSync(XBROWSER_SHOTS_DIR, { recursive: true })

  // --- Demo target (full .vivicy with a generated map + live ledger) ---
  // Rebuilt each run from the committed fixture so the demo graph is deterministic
  // and every demo-server spec (and the layout-edit round-trip) sees the same bytes.
  rmSync(DEMO_TARGET_ROOT, { recursive: true, force: true })
  mkdirSync(path.dirname(DEMO_TARGET_ROOT), { recursive: true })
  copyTarget(DEMO_FIXTURE_ROOT, DEMO_TARGET_ROOT)

  // --- No-map target (.vivicy/canonical/ present, no generated map) ---
  // A resolved target (`.vivicy/canonical/` exists) whose map has NOT been
  // generated, so `/api/map` returns `no_map`. Rebuilt from scratch so a prior
  // Extract can never leave an architecture-data.json behind.
  rmSync(EMPTY_TARGET_ROOT, { recursive: true, force: true })
  const emptyCanonicalDir = path.join(EMPTY_TARGET_ROOT, ".vivicy", "canonical")
  mkdirSync(emptyCanonicalDir, { recursive: true })
  writeFileSync(
    path.join(emptyCanonicalDir, "01-overview.md"),
    "# Overview\n\nA canonical spec with no architecture map generated yet.\n"
  )

  // --- Onboarding target (NO .vivicy/, so the chooser renders) ---
  // Recreate from scratch so it never accidentally carries a `.vivicy/` dir.
  rmSync(ONBOARD_TARGET_ROOT, { recursive: true, force: true })
  mkdirSync(ONBOARD_TARGET_ROOT, { recursive: true })

  // --- Very-long-path target (overflow spec) ---
  // A deep, long-named copy of the demo target so the overflow spec can select it
  // and exercise long content across the header tooltip, picker, and Details
  // panel. Rebuilt each run so it tracks the demo fixture.
  const longRoot = "/tmp/vivicy-long"
  rmSync(longRoot, { recursive: true, force: true })
  if (existsSync(DEMO_TARGET_ROOT)) {
    mkdirSync(path.dirname(LONG_TARGET_ROOT), { recursive: true })
    copyTarget(DEMO_TARGET_ROOT, LONG_TARGET_ROOT)
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

  // The DEMO shape persists its target as the current project (R10) so the setup
  // bar's "Change project" affordance renders. `/api/project` reports ONLY the
  // persisted current-project (it does NOT fall back to VIVICY_TARGET_ROOT), and
  // the setup bar hides the switcher until a project exists — so a demo server
  // that knows its target only via the env var would never show that button and
  // the picker-driven specs (setup, overflow, xbrowser) could never open it. This
  // seeds exactly what selecting the demo target in the picker would persist. The
  // realpath keeps the stored root canonical (macOS maps /tmp -> /private/tmp), so
  // `getCurrentProject()`'s re-stat resolves it. The empty/onboarding shapes are
  // left unseeded on purpose: their `no_map` / `no_target` states must come from
  // the env target alone.
  const demoRoot = realpathSync(DEMO_TARGET_ROOT)
  for (const browserKey of BROWSER_KEYS) {
    const runtimeDir = RUNTIME_DIR("demo", browserKey)
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      path.join(runtimeDir, "current-project.json"),
      `${JSON.stringify({ root: demoRoot }, null, 2)}\n`
    )
  }
  for (const browserKey of BROWSER_KEYS) {
    const parent = onboardScaffoldParent(browserKey)
    rmSync(parent, { recursive: true, force: true })
    mkdirSync(parent, { recursive: true })
  }
}
