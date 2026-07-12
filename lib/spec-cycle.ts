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

export const PROJECT_CYCLE_ID = "project"

export type BatchCycleBinding = { binding: "active"; id: string } | { binding: "seed" }

// The canonical is immutable ⟺ an active frozen baseline exists AND no drafting cycle reopened it — the single frozen-phase predicate the write allowlist and the batch binding both gate on.
export function isCanonicalFrozen(targetRoot: string): boolean {
  return hasActiveFrozenBaseline(targetRoot) && !isSpecCycleOpen(targetRoot)
}

export function activeCycleId(targetRoot: string): string | null {
  if (isCanonicalFrozen(targetRoot)) return null
  const cycle = readSpecCycle(targetRoot)
  return cycle ? cycle.id : PROJECT_CYCLE_ID
}

export function activeCycleKind(targetRoot: string): SpecKind | null {
  if (isCanonicalFrozen(targetRoot)) return null
  return isSpecCycleOpen(targetRoot) ? "feature" : "project"
}

export function activeCycleBinding(targetRoot: string): BatchCycleBinding {
  const id = activeCycleId(targetRoot)
  return id === null ? { binding: "seed" } : { binding: "active", id }
}

export type CycleOpenRefusalCode = "no_frozen_baseline" | "feature_cycle_active"

export interface CycleOpenRefusal {
  code: CycleOpenRefusalCode
  reason: string
}

// The one-active-feature-cycle + project-cycle-singular law (AGENTS.md "Cycle concurrency"): the single gate lib/control.ts and factory/cli.ts must both open a cycle through, so the policy can never drift between them.
export function featureCycleOpenRefusal(targetRoot: string): CycleOpenRefusal | null {
  if (!hasActiveFrozenBaseline(targetRoot)) {
    return {
      code: "no_frozen_baseline",
      reason:
        "no frozen baseline — before the first freeze the spec is already editable; a cycle is only needed to reopen a FROZEN spec",
    }
  }
  if (isSpecCycleOpen(targetRoot)) {
    return {
      code: "feature_cycle_active",
      reason:
        "a feature cycle is already open — feature cycles run one at a time (parallel feature cycles are not yet enabled); freeze it by extracting, or cancel it, before opening another",
    }
  }
  return null
}

export function parseCycleBinding(value: unknown): BatchCycleBinding | null {
  if (!value || typeof value !== "object") return null
  const v = value as { binding?: unknown; id?: unknown }
  if (v.binding === "seed") return { binding: "seed" }
  if (v.binding === "active" && typeof v.id === "string" && v.id.length > 0) return { binding: "active", id: v.id }
  return null
}

// A seed matches (its cycle has opened) and a same-id active batch matches; a batch bound to a different, non-current cycle stays out; an unparseable binding falls to the active cycle.
export function batchMatchesActiveCycle(storedBinding: unknown, currentActiveCycleId: string | null): boolean {
  if (currentActiveCycleId === null) return false
  const binding = parseCycleBinding(storedBinding)
  if (!binding) return true
  return binding.binding === "seed" || binding.id === currentActiveCycleId
}

export const UPLOADS_REL = ".vivicy/uploads"
const MANIFEST_FILE = "manifest.json"
const UNDETERMINED = "und"

export interface ManifestFile {
  path: string
  size: number
  sha256: string
}

export interface BatchManifest {
  batchId: string
  createdAt: string
  language: string
  cycle?: unknown
  files: ManifestFile[]
}

export interface Batch {
  batchId: string
  batchDir: string
  manifest: BatchManifest
}

interface ConsumedSource {
  batches_consumed?: string[]
  batch_id?: unknown
}

function readBatchManifest(abs: string): BatchManifest | null {
  if (!existsSync(abs)) return null
  let parsed: Partial<BatchManifest> | null
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8")) as Partial<BatchManifest>
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) return null
  return {
    batchId: String(parsed.batchId ?? ""),
    createdAt: String(parsed.createdAt ?? ""),
    language: typeof parsed.language === "string" && parsed.language.length > 0 ? parsed.language : UNDETERMINED,
    cycle: parsed.cycle,
    files: parsed.files.filter(
      (f): f is ManifestFile => Boolean(f) && typeof f === "object" && typeof (f as ManifestFile).path === "string",
    ),
  }
}

// The batch-complete marker is manifest.json (written LAST by import); a batch dir without it is an interrupted, non-consumable batch.
export function completeBatches(repoRoot: string): Batch[] {
  const uploadsDir = path.resolve(repoRoot, UPLOADS_REL)
  if (!existsSync(uploadsDir)) return []
  const batches: Batch[] = []
  for (const entry of readdirSync(uploadsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const batchDir = path.join(uploadsDir, entry.name)
    const manifest = readBatchManifest(path.join(batchDir, MANIFEST_FILE))
    if (manifest) batches.push({ batchId: entry.name, batchDir, manifest })
  }
  return batches.sort((a, b) => a.batchId.localeCompare(b.batchId))
}

// Never-reset ledger of every batch a prep run has fully placed: a batch is added only after all its files land, so a mid-run crash never marks an unconsumed batch consumed.
export function consumedSet(report: ConsumedSource | null): Set<string> {
  const legacyBatchId = report?.batch_id
  const legacy = typeof legacyBatchId === "string" ? [legacyBatchId] : []
  return new Set([...(Array.isArray(report?.batches_consumed) ? report!.batches_consumed : []), ...legacy])
}

// The batches the active cycle's prep must consume: complete + bound to (or seeding) the active cycle + not yet consumed by a prior run.
// Empty when the canonical is frozen (no active cycle) — seed batches then wait for the cycle they seed to open.
export function unconsumedActiveCycleBatches(repoRoot: string, report: ConsumedSource | null): Batch[] {
  const cycleId = activeCycleId(repoRoot)
  if (cycleId === null) return []
  const consumed = consumedSet(report)
  return completeBatches(repoRoot).filter(
    (b) => batchMatchesActiveCycle(b.manifest.cycle, cycleId) && !consumed.has(b.batchId),
  )
}
