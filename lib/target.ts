/**
 * Resolve the target project root whose architecture map this viewer renders
 * (server-only). The UI-chosen persisted project (R10) wins so the picker drives
 * the app, then `VIVICY_TARGET_ROOT` (the E2E/headless override), then `null` —
 * Vivicy is standalone, so there is NO implicit target (matching the factory's
 * {@link file://../factory/target-root#resolveTargetRoot}). Callers surface the
 * null case as the "no target" onboarding state rather than guessing a directory.
 */

import { existsSync, statSync } from "node:fs"
import path from "node:path"

import { readCurrentProjectRoot } from "@/lib/project"

/**
 * Absolute path to the resolved target project root, or null when none is set.
 *
 * Spelling contract: persisted roots are CANONICAL by construction (the project
 * store realpaths on write — see {@link file://./project#describeProject}), so the
 * W8 per-project runtime key (which hashes this string) never forks across
 * symlinked spellings of one directory. The env fallback is used verbatim: an
 * env-driven server has a single, consistent spelling for its whole lifetime.
 */
export function getTargetRoot(): string | null {
  const persisted = readCurrentProjectRoot()
  if (persisted) return path.resolve(persisted)
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv)
  }
  return null
}

/** Path, relative to the target root, of the committed architecture-map JSON. */
export const ARCHITECTURE_DATA_RELATIVE_PATH = path.join(
  ".vivicy",
  "architecture-map",
  "architecture-data.json"
)

/** Absolute path to the architecture-map JSON, or null when no target is set. */
export function getArchitectureDataPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, ARCHITECTURE_DATA_RELATIVE_PATH)
}

/**
 * Path, relative to the target root, of the live progress ledger — the SINGLE
 * source of truth for per-issue/per-graph-item progress during development.
 */
export const PROGRESS_LEDGER_RELATIVE_PATH = path.join(
  ".vivicy",
  "development",
  "progress-ledger.json"
)

/**
 * Absolute path to the live progress ledger for the resolved target root.
 *
 * The architecture-map JSON is a STATIC graph generated once at extraction; the
 * live overlay (`graph_item_states`, `active_items`) is derived from THIS file at
 * request time, so the map always reflects current progress with no regeneration.
 */
export function getProgressLedgerPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, PROGRESS_LEDGER_RELATIVE_PATH)
}

/**
 * Whether the resolved target is a usable project: the root exists and holds a
 * `.vivicy/canonical/` directory (where the canonical spec lives). The folder-picker
 * and start modes arrive in a later phase; until then "no usable target" is the
 * onboarding signal the viewer surfaces. A target with `.vivicy/canonical/` but no
 * generated map is a *different* onboarding case (see {@link getArchitectureDataPath}).
 */
export function isTargetResolved(): boolean {
  const root = getTargetRoot()
  if (root === null) return false
  const canonicalDir = path.join(root, ".vivicy", "canonical")
  try {
    return existsSync(root) && statSync(canonicalDir).isDirectory()
  } catch {
    return false
  }
}
