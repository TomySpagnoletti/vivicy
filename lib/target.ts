import { existsSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

import { readCurrentProjectRoot } from "@/lib/project"

// Persisted roots arrive realpath-canonical from project.ts; the env fallback is used verbatim, never re-resolved.
export function getTargetRoot(): string | null {
  const persisted = readCurrentProjectRoot()
  if (persisted) return path.resolve(persisted)
  const fromEnv = process.env.VIVICY_TARGET_ROOT
  if (fromEnv && fromEnv.trim().length > 0) {
    return path.resolve(fromEnv)
  }
  return null
}

export const ARCHITECTURE_DATA_RELATIVE_PATH = path.join(".vivicy", "architecture-map", "architecture-data.json")

export function getArchitectureDataPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, ARCHITECTURE_DATA_RELATIVE_PATH)
}

export const PROGRESS_LEDGER_RELATIVE_PATH = path.join(".vivicy", "development", "progress-ledger.json")

export function getProgressLedgerPath(): string | null {
  const root = getTargetRoot()
  return root === null ? null : path.join(root, PROGRESS_LEDGER_RELATIVE_PATH)
}

// The ONE witness that the canonical holds an authored spec: the extract guard and the map's empty-canonical reason both read it, never a spelling of their own.
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
