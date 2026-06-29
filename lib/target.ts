/**
 * Resolve the target project root whose architecture map this viewer renders
 * (server-only). The UI-chosen persisted project (R10) wins so the picker drives
 * the app, then `VIVICY_TARGET_ROOT` (the E2E/headless override), then `..` from
 * cwd.
 */

import { existsSync, statSync } from "node:fs"
import path from "node:path"

import { readCurrentProjectRoot } from "@/lib/project"

/** Absolute path to the resolved target project root. */
export function getTargetRoot(): string {
  const persisted = readCurrentProjectRoot()
  if (persisted) return path.resolve(persisted)
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv)
  }
  return path.resolve(process.cwd(), "..")
}

/** Path, relative to the target root, of the committed architecture-map JSON. */
export const ARCHITECTURE_DATA_RELATIVE_PATH = path.join(
  ".vivicy",
  "architecture-map",
  "architecture-data.json"
)

/** Absolute path to the architecture-map JSON for the resolved target root. */
export function getArchitectureDataPath(): string {
  return path.join(getTargetRoot(), ARCHITECTURE_DATA_RELATIVE_PATH)
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
export function getProgressLedgerPath(): string {
  return path.join(getTargetRoot(), PROGRESS_LEDGER_RELATIVE_PATH)
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
  const canonicalDir = path.join(root, ".vivicy", "canonical")
  try {
    return existsSync(root) && statSync(canonicalDir).isDirectory()
  } catch {
    return false
  }
}
