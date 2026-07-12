import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  featureCycleOpenRefusal,
  writeSpecCycle,
  type CycleOpenRefusal,
} from "@/lib/spec-cycle"

let root: string

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "vivicy-cycle-guard-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seedFrozenBaseline(): void {
  const dir = path.join(root, ".vivicy", "baselines")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, "baseline-v1.0.0.json"),
    JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen" }),
  )
}

function openFeatureCycle(): void {
  writeSpecCycle(root, {
    status: "drafting",
    kind: "feature",
    id: "cycle-2026-01-01-abc123",
    opened_at: "2026-01-01T00:00:00.000Z",
    opened_by: "owner:test",
  })
}

describe("featureCycleOpenRefusal — the cycle-concurrency gate", () => {
  it("refuses opening a feature cycle while the singular project cycle is still live (project never parallel)", () => {
    const refusal = featureCycleOpenRefusal(root) as CycleOpenRefusal
    expect(refusal).not.toBeNull()
    expect(refusal.code).toBe("no_frozen_baseline")
    expect(refusal.reason).toMatch(/no frozen baseline/)
  })

  it("allows exactly one feature cycle once the project cycle has frozen", () => {
    seedFrozenBaseline()
    expect(featureCycleOpenRefusal(root)).toBeNull()
  })

  it("refuses a second concurrent feature cycle (one-active gate; parallel not yet enabled)", () => {
    seedFrozenBaseline()
    openFeatureCycle()
    const refusal = featureCycleOpenRefusal(root) as CycleOpenRefusal
    expect(refusal).not.toBeNull()
    expect(refusal.code).toBe("feature_cycle_active")
    expect(refusal.reason).toMatch(/already open/)
    expect(refusal.reason).toMatch(/parallel feature cycles are not yet enabled/)
  })

  it("degrades to a typed refusal on corrupt state, never a crash", () => {
    const baselines = path.join(root, ".vivicy", "baselines")
    mkdirSync(baselines, { recursive: true })
    writeFileSync(path.join(baselines, "baseline-v1.0.0.json"), "{ not json")
    const reports = path.join(root, ".vivicy", "development", "reports")
    mkdirSync(reports, { recursive: true })
    writeFileSync(path.join(reports, "spec-cycle.json"), "}{")

    const refusal = featureCycleOpenRefusal(root) as CycleOpenRefusal
    expect(refusal.code).toBe("no_frozen_baseline")
  })
})
