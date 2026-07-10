import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { SpecKind } from "./spec-kind.ts"

// Must match extract-issues' findFrozenManifest and change-control's readFrozenBaselineIdentity — three independent implementations of the same freeze predicate.
export function hasActiveFrozenBaseline(targetRoot: string): boolean {
  const dir = path.join(targetRoot, ".vivicy", "baselines")
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue
    let manifest: { status?: unknown; superseded?: unknown; baseline_id?: unknown }
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, entry), "utf8"))
    } catch {
      continue
    }
    if (
      manifest &&
      manifest.status === "frozen" &&
      !manifest.superseded &&
      typeof manifest.baseline_id === "string" &&
      manifest.baseline_id.length > 0
    ) {
      return true
    }
  }
  return false
}

export const SPEC_CYCLE_REL = ".vivicy/development/reports/spec-cycle.json"

export interface SpecCycle {
  status: "drafting"
  kind: SpecKind
  id: string
  opened_at: string
  opened_by: string
}

function cyclePath(targetRoot: string): string {
  return path.join(targetRoot, ...SPEC_CYCLE_REL.split("/"))
}

export function readSpecCycle(targetRoot: string): SpecCycle | null {
  const file = cyclePath(targetRoot)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<SpecCycle>
    if (raw?.status !== "drafting" || typeof raw.id !== "string") return null
    return raw as SpecCycle
  } catch {
    return null
  }
}

export function isSpecCycleOpen(targetRoot: string): boolean {
  return readSpecCycle(targetRoot) !== null
}

export function writeSpecCycle(targetRoot: string, cycle: SpecCycle): void {
  const file = cyclePath(targetRoot)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(cycle, null, 2)}\n`)
}

export function clearSpecCycle(targetRoot: string): void {
  rmSync(cyclePath(targetRoot), { force: true })
}
