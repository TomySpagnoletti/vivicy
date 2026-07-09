/**
 * Spec-cycle state (W7b, v0.7.0). A governed project's life is an ordered chain of
 * spec CYCLES: at most one "project" spec (greenfield), then any number of "feature"
 * specs — ONE active at a time. Between two builds, opening a feature cycle is the
 * OFFICIAL mechanism for evolving the canonical spec (the macro-CR): it reopens
 * pre-freeze editing for Vivi, and it ends when extraction re-freezes the baseline
 * (minor bump) — never by an agent's say-so. Mid-build intention changes remain
 * Change Requests (truth-model rule 3); a cycle is for the NEXT build.
 *
 * The state is ONE orchestrator-owned file under the target:
 *   .vivicy/development/reports/spec-cycle.json  { status:"drafting", kind, id, opened_at, opened_by }
 * Present ⇔ a drafting cycle is OPEN on top of a frozen baseline. Absent ⇔ normal
 * regime (pre-freeze drafting when no baseline exists; CR-only when one does).
 * Extraction DELETES the file at its freeze — closing the cycle is a mechanical
 * side effect of the freeze, not a separate declaration (P1).
 *
 * Shared by both worlds (`@/lib/...` and `../lib/spec-cycle.ts`) like spec-kind.ts,
 * so Vivi's allowlist, the control plane's guards, the CLI, and the extraction
 * orchestrator all read the SAME truth.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { SpecKind } from "./spec-kind.ts"

/**
 * Does the target carry an ACTIVE frozen baseline? A `.vivicy/baselines/*.json` with
 * `status: "frozen"`, no `superseded` marker, and a non-empty `baseline_id` — the
 * exact definition the factory uses (extract-issues `findFrozenManifest`,
 * change-control `readFrozenBaselineIdentity`). Cheap, synchronous, read-only; a
 * malformed manifest is simply not a freeze. Lives here so the phase logic (Vivi's
 * allowlist, the cycle guards) shares ONE derivation.
 */
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

/** Repo-relative path of the cycle-state file under the target root. */
export const SPEC_CYCLE_REL = ".vivicy/development/reports/spec-cycle.json"

export interface SpecCycle {
  status: "drafting"
  /** The cycle's spec kind — always "feature" today (a cycle opens on top of a
   *  frozen baseline, so code exists by definition once the first build ran; kept
   *  as a field for honest provenance and future kinds). */
  kind: SpecKind
  /** Human-readable cycle id, e.g. "cycle-2026-07-08-a1b2c3" — provenance only. */
  id: string
  opened_at: string
  /** Who opened it (e.g. "owner:vivi-ui", "owner:cli"). */
  opened_by: string
}

function cyclePath(targetRoot: string): string {
  return path.join(targetRoot, ...SPEC_CYCLE_REL.split("/"))
}

/** The open drafting cycle, or null (absent/malformed file = no cycle — honest). */
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

/** Is a drafting cycle currently open on this target? */
export function isSpecCycleOpen(targetRoot: string): boolean {
  return readSpecCycle(targetRoot) !== null
}

/** Write the cycle-state file (callers enforce the guards; this only records). */
export function writeSpecCycle(targetRoot: string, cycle: SpecCycle): void {
  const file = cyclePath(targetRoot)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(cycle, null, 2)}\n`)
}

/** Remove the cycle-state file (extraction's freeze, or an explicit clean cancel). */
export function clearSpecCycle(targetRoot: string): void {
  rmSync(cyclePath(targetRoot), { force: true })
}
