import { existsSync, readdirSync, statSync } from "node:fs"
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

// The single witness that the canonical holds an authored spec, not just the scaffold seed (.gitkeep/README.md); shared by the extract guard and the map's empty-canonical reason so both agree on "there is something to extract".
export function canonicalHasSpecDoc(root: string): boolean {
  const stack = [path.join(root, ".vivicy", "canonical")]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "README.md") {
        return true
      }
    }
  }
  return false
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
