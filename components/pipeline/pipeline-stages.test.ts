import { describe, expect, it } from "vitest"

import {
  deriveStageStates,
  MARKER_GLYPH,
  PIPELINE_STAGES,
} from "@/components/pipeline/pipeline-stages"
import type { RunStatus } from "@/lib/run-status"

function status(overrides: Partial<RunStatus> = {}): RunStatus {
  return {
    verdict: "OK",
    issues_total: 0,
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

describe("PIPELINE_STAGES — §3 stage list + SK", () => {
  it("has exactly the 14 stages S0..S12 with SK between S7 and S8, in order", () => {
    expect(PIPELINE_STAGES.map((s) => s.id)).toEqual([
      "S0", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "SK", "S8", "S9", "S10", "S11", "S12",
    ])
  })

  it("puts the P7 boundary exactly between S1 (non_loop) and S2 (dev_loop)", () => {
    const sides = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, s.side]))
    expect(sides.S0).toBe("non_loop")
    expect(sides.S1).toBe("non_loop")
    expect(sides.S2).toBe("dev_loop")
    expect(sides.S12).toBe("dev_loop")
  })

  it("assigns the honest G14 retry set (S6 extract, SK skills, S9 dev) and nothing else", () => {
    const retryable = PIPELINE_STAGES.filter((s) => s.retryStage).map((s) => s.id)
    expect(retryable).toEqual(["S6", "SK", "S9"])
    expect(PIPELINE_STAGES.find((s) => s.id === "SK")?.retryStage).toBe("skills")
  })

  it("carries no display label — those live in the pipeline message catalog", () => {
    expect(PIPELINE_STAGES.every((s) => !("label" in s))).toBe(true)
  })

  it("maps P8 stage typing per §3", () => {
    const marker = Object.fromEntries(PIPELINE_STAGES.map((s) => [s.id, s.marker]))
    expect(marker).toEqual({
      S0: "user",
      S1: "mixed",
      S2: "agent",
      S3: "agent",
      S4: "user",
      S5: "mixed",
      S6: "agent",
      S7: "mixed",
      SK: "mixed",
      S8: "agent",
      S9: "agent",
      S10: "mixed",
      S11: "mixed",
      S12: "user",
    })
  })

  it("has a glyph for every marker kind", () => {
    expect(MARKER_GLYPH.user).toBe("🖥️")
    expect(MARKER_GLYPH.agent).toBe("🤖")
    expect(MARKER_GLYPH.mixed).toBe("🖥️🤖")
  })
})

describe("deriveStageStates — honest state truth, no fake progress", () => {
  it("everything pending when nothing has ever run", () => {
    const states = deriveStageStates(null, null)
    expect(Object.values(states).every((s) => s === "pending")).toBe(true)
  })

  it("S0/S1 flip green once the dev-loop side has ever been reached", () => {
    const states = deriveStageStates(null, { phase: "green" })
    expect(states.S0).toBe("green")
    expect(states.S1).toBe("green")
  })

  it("a green extraction marks S2..S6 green", () => {
    const states = deriveStageStates(null, { phase: "green" })
    expect(states.S2).toBe("green")
    expect(states.S3).toBe("green")
    expect(states.S4).toBe("green")
    expect(states.S5).toBe("green")
    expect(states.S6).toBe("green")
  })

  it("extraction_blocked marks S2-S5 green and S6 red (the retries were spent inside S6)", () => {
    const states = deriveStageStates(null, { phase: "extraction_blocked" })
    expect(states.S2).toBe("green")
    expect(states.S5).toBe("green")
    expect(states.S6).toBe("red")
  })

  it("blocked_on_unverified_spikes marks S3 red (G13 ordering) and leaves S4-S6 pending", () => {
    const states = deriveStageStates(null, {
      phase: "blocked_on_unverified_spikes",
      unverified_spike_gate_ids: ["SPIKE-01"],
    })
    expect(states.S2).toBe("green")
    expect(states.S3).toBe("red")
    expect(states.S4).toBe("pending")
    expect(states.S6).toBe("pending")
  })

  it("an in-flight authoring phase pulses S6 running, with S2-S4 implicitly green", () => {
    const states = deriveStageStates(null, { phase: "authoring" })
    expect(states.S6).toBe("running")
    expect(states.S2).toBe("green")
    expect(states.S4).toBe("green")
  })

  it("a re-freeze loop-back (CR -> re-freeze) shows S4 running, not S6 — the earlier stage re-pulses", () => {
    const states = deriveStageStates(null, { phase: "refreezing" })
    expect(states.S4).toBe("running")
    expect(states.S6).not.toBe("running")
  })

  it("mapping/map-review phases pulse S5", () => {
    expect(deriveStageStates(null, { phase: "mapping" }).S5).toBe("running")
    expect(deriveStageStates(null, { phase: "map-review" }).S5).toBe("running")
  })

  it("an active dev-loop run pulses S8/S9 running regardless of progress", () => {
    const states = deriveStageStates(
      status({ run_active: true, issues_total: 8, issues_done: 2 }),
      { phase: "green" }
    )
    expect(states.S8).toBe("running")
    expect(states.S9).toBe("running")
  })

  it("a failing gate while incomplete and NOT running marks S9 red", () => {
    const states = deriveStageStates(
      status({ run_active: false, issues_total: 8, issues_done: 3, gates: { pass: 3, fail: 1 } }),
      { phase: "green" }
    )
    expect(states.S9).toBe("red")
  })

  it("all issues done marks S8-S10 and S12 green, S11 stays pending (not observed here)", () => {
    const states = deriveStageStates(
      status({ run_active: false, issues_total: 8, issues_done: 8 }),
      { phase: "green" }
    )
    expect(states.S8).toBe("green")
    expect(states.S9).toBe("green")
    expect(states.S10).toBe("green")
    expect(states.S12).toBe("green")
    expect(states.S11).toBe("pending")
  })

  it("never fabricates S11 green — it has no observed signal in this derivation", () => {
    const states = deriveStageStates(
      status({ run_active: false, issues_total: 8, issues_done: 8 }),
      { phase: "green" }
    )
    expect(states.S11).not.toBe("green")
  })

  it("SK stays pending when no skills report exists (absent third arg included)", () => {
    expect(deriveStageStates(null, { phase: "green" }).SK).toBe("pending")
    expect(deriveStageStates(null, { phase: "green" }, null).SK).toBe("pending")
  })

  it("SK pulses running for every in-flight skills phase", () => {
    for (const phase of ["selecting", "auditing", "installing"]) {
      expect(deriveStageStates(null, { phase: "green" }, { phase }).SK).toBe("running")
    }
  })

  it("SK is green on a green install AND on skipped (honest 'nothing to install')", () => {
    expect(deriveStageStates(null, { phase: "green" }, { phase: "green" }).SK).toBe("green")
    expect(deriveStageStates(null, { phase: "green" }, { phase: "skipped" }).SK).toBe("green")
  })

  it("SK is red on a failed install", () => {
    expect(deriveStageStates(null, { phase: "green" }, { phase: "failed" }).SK).toBe("red")
  })

  it("an unknown skills phase leaves SK pending rather than guessing", () => {
    expect(deriveStageStates(null, null, { phase: "someday-phase" }).SK).toBe("pending")
  })

  it("a paused mid-way run (0 < done < total, not running, no failing gate) leaves S8-S10 pending — never a fabricated green (P1; resolveRunPhase calls this exact condition 'idle')", () => {
    const states = deriveStageStates(
      status({ run_active: false, issues_total: 8, issues_done: 4, gates: { pass: 4, fail: 0 } }),
      { phase: "green" }
    )
    expect(states.S8).toBe("pending")
    expect(states.S9).toBe("pending")
    expect(states.S10).toBe("pending")
    expect(states.S12).toBe("pending")
  })
})
