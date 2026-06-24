import { describe, expect, it } from "vitest"

import { isResumable, resolveRunPhase, type RunStatus } from "@/lib/run-status"

function makeStatus(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    verdict: "NOT STARTED",
    issues_total: 5,
    issues_done: 0,
    done: [],
    remaining: [],
    active: [],
    process_alive: false,
    idle_seconds: null,
    gates: { pass: 0, fail: 0 },
    run_active: false,
    ...overrides,
  }
}

describe("resolveRunPhase", () => {
  it("is running when the lock is active", () => {
    expect(resolveRunPhase(makeStatus({ run_active: true, verdict: "RUNNING" }))).toBe("running")
  })

  it("is stalled when active but the verdict is stale", () => {
    expect(resolveRunPhase(makeStatus({ run_active: true, verdict: "STALE?" }))).toBe("stalled")
  })

  it("is done when every issue is verified", () => {
    expect(
      resolveRunPhase(makeStatus({ issues_total: 3, issues_done: 3, verdict: "DONE" }))
    ).toBe("done")
  })

  it("is blocked when a gate failed mid-way without an active lock", () => {
    expect(
      resolveRunPhase(
        makeStatus({ issues_done: 1, gates: { pass: 1, fail: 1 }, verdict: "STOPPED (last gate failed)" })
      )
    ).toBe("blocked")
  })

  it("is idle when nothing is running and nothing failed", () => {
    expect(resolveRunPhase(makeStatus())).toBe("idle")
  })
})

describe("isResumable", () => {
  it("is resumable when stopped part-way through", () => {
    expect(isResumable(makeStatus({ issues_total: 5, issues_done: 2 }))).toBe(true)
  })

  it("is not resumable before any progress", () => {
    expect(isResumable(makeStatus({ issues_total: 5, issues_done: 0 }))).toBe(false)
  })

  it("is not resumable when complete", () => {
    expect(isResumable(makeStatus({ issues_total: 5, issues_done: 5 }))).toBe(false)
  })

  it("is not resumable while running", () => {
    expect(isResumable(makeStatus({ run_active: true, issues_done: 2 }))).toBe(false)
  })
})
