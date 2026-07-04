/**
 * G8 pipeline widget — stage metadata + pure state derivation.
 *
 * Stage list is the v0.5.0 pipeline contract verbatim (13 stages, S0–S12), each
 * typed 🖥️ deterministic / 🤖 agent / 🖥️🤖 mixed, and split across the autonomy
 * boundary: S0–S1 are "Non-loop" (user ↔ Vivi, no automatism), S2–S12 are
 * "Dev-loop (autonomous)". This module owns no React — it is the derivation
 * logic the widget and its tests both consume, kept separate so state mapping
 * is unit-testable without rendering.
 */

import type { RunStatus } from "@/lib/run-status"

export type StageMarker = "user" | "agent" | "mixed"
export type StageSide = "non_loop" | "dev_loop"
export type StageState = "pending" | "running" | "green" | "red"

export interface PipelineStage {
  id: string
  label: string
  marker: StageMarker
  side: StageSide
  /** Stages the honest G14 retry set actually supports (extract, dev). */
  retryStage?: "extract" | "dev"
}

/** The 13 stages, §3 order, with the dotted P7 boundary between S1 and S2. */
export const PIPELINE_STAGES: PipelineStage[] = [
  { id: "S0", label: "Onboarding", marker: "user", side: "non_loop" },
  { id: "S1", label: "Spec + spikes", marker: "mixed", side: "non_loop" },
  { id: "S2", label: "Extract/Integrate spikes", marker: "agent", side: "dev_loop" },
  { id: "S3", label: "Prove spikes", marker: "agent", side: "dev_loop" },
  { id: "S4", label: "Freeze", marker: "user", side: "dev_loop" },
  { id: "S5", label: "Map", marker: "mixed", side: "dev_loop" },
  { id: "S6", label: "Extract issues", marker: "agent", side: "dev_loop", retryStage: "extract" },
  { id: "S7", label: "Verify issues", marker: "mixed", side: "dev_loop" },
  { id: "S8", label: "Readiness", marker: "agent", side: "dev_loop" },
  { id: "S9", label: "Implement + Review", marker: "agent", side: "dev_loop", retryStage: "dev" },
  { id: "S10", label: "Merge", marker: "mixed", side: "dev_loop" },
  { id: "S11", label: "CRs", marker: "mixed", side: "dev_loop" },
  { id: "S12", label: "Done", marker: "user", side: "dev_loop" },
]

/** The glyph the widget renders for each stage type (P8). */
export const MARKER_GLYPH: Record<StageMarker, string> = {
  user: "🖥️",
  agent: "🤖",
  mixed: "🖥️🤖",
}

/** Extraction phases (extract-issues.mjs `record()` calls) that are IN FLIGHT —
 *  i.e. S2–S6 are actively running, as opposed to terminal green/blocked. */
const EXTRACTION_RUNNING_PHASES = new Set([
  "authoring",
  "fixing",
  "refreezing",
  "validating",
  "mapping",
  "verifying",
  "map-review",
])

/** Minimal shape client components need from the extraction status file; a
 *  subset of {@link import("@/lib/control").ExtractionStatus} so this stays
 *  decoupled from the server-only control module (this file, the widget, and
 *  the sidebar's SectionPipeline are all client components). */
export interface ExtractionStatusLike {
  phase?: string
  spike_mode?: "integrate" | "extract"
  map_mode?: "reused" | "authored"
  unverified_spike_gate_ids?: string[]
  summary?: string
  updated_at?: string
}

/**
 * Derive each stage's honest state from what the app can actually observe:
 * the dev-status SSE frame (S7–S12: verified issues / active work / gate
 * failures) and the extraction status file (S2–S6: which phase the
 * freeze->author->validate->verify chain is in). S0/S1 (non-loop) have no
 * machine state to observe — they stay "pending" until a target/canonical
 * exists, then read as quietly done (green) once extraction has ever run,
 * since reaching S2 is the only observable proof S0–S1 completed.
 *
 * This is a pure function so state-truth is unit-testable without SSE/fetch
 * plumbing; the widget calls it on every status tick.
 */
export function deriveStageStates(
  status: RunStatus | null,
  extraction: ExtractionStatusLike | null
): Record<string, StageState> {
  const states: Record<string, StageState> = {}
  for (const stage of PIPELINE_STAGES) states[stage.id] = "pending"

  // S0/S1: no automatism to observe (P7) — the only honest signal available is
  // whether the dev-loop side has ever been reached at all.
  const reachedDevLoop = extraction !== null || (status?.issues_total ?? 0) > 0
  if (reachedDevLoop) {
    states.S0 = "green"
    states.S1 = "green"
  }

  applyExtractionStates(states, extraction)
  applyDevStates(states, status)

  return states
}

// Gotcha: any NEW phase the extraction orchestrator starts emitting must be
// registered here (EXTRACTION_RUNNING_PHASES + phaseToRunningStage), or it
// silently renders as "pending".
function applyExtractionStates(
  states: Record<string, StageState>,
  extraction: ExtractionStatusLike | null
): void {
  if (!extraction?.phase) return
  const { phase } = extraction

  if (phase === "green") {
    for (const id of ["S2", "S3", "S4", "S5", "S6"]) states[id] = "green"
    return
  }
  if (phase === "extraction_blocked") {
    // The retries were spent inside S6 (authoring/fixing issues); S2–S5 ran
    // clean to get there, so only S6 shows the failure.
    for (const id of ["S2", "S3", "S4", "S5"]) states[id] = "green"
    states.S6 = "red"
    return
  }
  if (phase === "blocked_on_unverified_spikes") {
    // G13: S6 refuses to start while S3 (spike proving) has an unverified
    // required gate — S2 ran (spikes were extracted/integrated), S3 is the
    // stage actually blocking, S4–S6 never got a chance to run.
    states.S2 = "green"
    states.S3 = "red"
    return
  }
  if (EXTRACTION_RUNNING_PHASES.has(phase)) {
    // A loop-back re-entry (e.g. CR -> re-freeze) re-runs "refreezing" onward;
    // whichever phase is live is the stage currently pulsing (§G8's "visible
    // backward/forward movement" — state truth, no separate re-entry flag).
    const runningStage = phaseToRunningStage(phase)
    if (runningStage) states[runningStage] = "running"
    // Earlier stages in this pass are implicitly done; a re-freeze mid-flight
    // still means S2/S3 held from the prior pass.
    for (const id of ["S2", "S3", "S4"]) {
      if (states[id] === "pending" && id !== runningStage) states[id] = "green"
    }
  }
}

function phaseToRunningStage(phase: string): string | null {
  switch (phase) {
    case "refreezing":
      return "S4"
    case "mapping":
    case "map-review":
      return "S5"
    case "authoring":
    case "fixing":
    case "validating":
    case "verifying":
      return "S6"
    default:
      return null
  }
}

function applyDevStates(
  states: Record<string, StageState>,
  status: RunStatus | null
): void {
  if (!status) return
  const total = status.issues_total ?? 0
  const done = status.issues_done ?? 0
  const hasIssues = total > 0

  if (!hasIssues) return

  // Reaching S6 green implied by hasIssues; S7 (verify issues) is folded into
  // the same extraction green signal above, so only mark it here if extraction
  // never reported (defensive: dev status can outlive an old extraction run).
  if (states.S7 === "pending") states.S7 = "green"

  if (status.run_active) {
    states.S8 = "running"
    states.S9 = "running"
    states.S10 = done > 0 ? "green" : "pending"
  } else if (status.gates.fail > 0 && done < total) {
    states.S9 = "red"
  } else if (done >= total) {
    states.S8 = "green"
    states.S9 = "green"
    states.S10 = "green"
  }
  // Stopped mid-way with no failing gate (0 < done < total, not running):
  // S8-S10 stay PENDING. resolveRunPhase classifies this exact condition as
  // "idle", never "done" — marking these stages green would fabricate
  // completion for stages that never ran to completion (P1). The control bar's
  // progress counter already communicates the partial done/total.

  // S11 (CRs) has no signal in the dev-status frame or the extraction status —
  // the widget does not poll the CR registry (that list is the sidebar's own
  // fetch). Leaving it "pending" here is the honest choice (P1): a fabricated
  // "green" would claim a CR-free state the widget never actually checked.
  if (done >= total && total > 0) states.S12 = "green"
}
