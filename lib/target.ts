import { existsSync, statSync } from "node:fs"
import path from "node:path"

import { readCurrentProjectRoot } from "@/lib/project"

// Persisted roots are realpath-canonical (see project.ts), so the runtime-key hash never forks across symlinked spellings; the env fallback is used verbatim.
export function getTargetRoot(): string | null {
  const persisted = readCurrentProjectRoot()
  if (persisted) return path.resolve(persisted)
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv)
  }
  return null
}

export const ARCHITECTURE_DATA_RELATIVE_PATH = path.join(
  ".vivicy",
  "architecture-map",
  "architecture-data.json"
)

export function getArchitectureDataPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, ARCHITECTURE_DATA_RELATIVE_PATH)
}

export const PROGRESS_LEDGER_RELATIVE_PATH = path.join(
  ".vivicy",
  "development",
  "progress-ledger.json"
)

// architecture-data.json is a static snapshot from extraction; this ledger is the live overlay (graph_item_states, active_items) computed at request time — no regeneration.
export function getProgressLedgerPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, PROGRESS_LEDGER_RELATIVE_PATH)
}

// Distinct from getArchitectureDataPath()'s null case: a target can have .vivicy/canonical/ but no generated map yet.
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
