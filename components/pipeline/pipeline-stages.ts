import type { RunStatus } from "@/lib/run-status"
import type { SkillsReport } from "@/lib/skills-report"
import type { DocPrepReport } from "@/lib/doc-prep-report"

export type StageMarker = "user" | "agent" | "mixed"
export type StageSide = "non_loop" | "dev_loop"
export type StageState = "pending" | "running" | "green" | "red"

export interface PipelineStage {
  id: string
  marker: StageMarker
  side: StageSide
  retryStage?: "prepare" | "extract" | "skills" | "dev"
}

export const PIPELINE_STAGES: PipelineStage[] = [
  { id: "S0", marker: "user", side: "non_loop" },
  { id: "S1", marker: "mixed", side: "non_loop" },
  { id: "SP", marker: "mixed", side: "dev_loop", retryStage: "prepare" },
  { id: "S2", marker: "agent", side: "dev_loop" },
  { id: "S3", marker: "agent", side: "dev_loop" },
  { id: "S4", marker: "user", side: "dev_loop" },
  { id: "S5", marker: "mixed", side: "dev_loop" },
  { id: "S6", marker: "agent", side: "dev_loop", retryStage: "extract" },
  { id: "S7", marker: "mixed", side: "dev_loop" },
  { id: "SK", marker: "mixed", side: "dev_loop", retryStage: "skills" },
  { id: "S8", marker: "agent", side: "dev_loop" },
  { id: "S9", marker: "agent", side: "dev_loop", retryStage: "dev" },
  { id: "S10", marker: "mixed", side: "dev_loop" },
  { id: "S11", marker: "mixed", side: "dev_loop" },
  { id: "S12", marker: "user", side: "dev_loop" },
]

export const MARKER_GLYPH: Record<StageMarker, string> = {
  user: "🖥️",
  agent: "🤖",
  mixed: "🖥️🤖",
}

const EXTRACTION_RUNNING_PHASES = new Set([
  "authoring",
  "fixing",
  "refreezing",
  "validating",
  "mapping",
  "verifying",
  "map-review",
])

// Subset of @/lib/control's ExtractionStatus, redeclared here because this file and its consumers (the widget, SectionPipeline) are client components that can't import the server-only control module.
export interface ExtractionStatusLike {
  phase?: string
  spike_mode?: "integrate" | "extract"
  map_mode?: "reused" | "authored"
  unverified_spike_gate_ids?: string[]
  summary?: string
  updated_at?: string
}

export function deriveStageStates(
  status: RunStatus | null,
  extraction: ExtractionStatusLike | null,
  skills: SkillsReport | null = null,
  docPrep: DocPrepReport | null = null
): Record<string, StageState> {
  const states: Record<string, StageState> = {}
  for (const stage of PIPELINE_STAGES) states[stage.id] = "pending"

  // S0/S1 have no observable automatism; reaching the dev-loop (or having prepared docs) is the only honest signal that they completed.
  const reachedDevLoop = extraction !== null || (status?.issues_total ?? 0) > 0 || Boolean(docPrep?.phase)
  if (reachedDevLoop) {
    states.S0 = "green"
    states.S1 = "green"
  }

  applyDocPrepStates(states, docPrep)
  applyExtractionStates(states, extraction)
  applySkillsStates(states, skills)
  applyDevStates(states, status)

  return states
}

const DOC_PREP_RUNNING_PHASES = new Set(["classifying", "extracting", "placing"])

function applyDocPrepStates(
  states: Record<string, StageState>,
  docPrep: DocPrepReport | null
): void {
  if (!docPrep?.phase) return
  if (DOC_PREP_RUNNING_PHASES.has(docPrep.phase)) states.SP = "running"
  else if (docPrep.phase === "green" || docPrep.phase === "skipped") states.SP = "green"
  else if (docPrep.phase === "failed") states.SP = "red"
}

// New extraction phases must be added to EXTRACTION_RUNNING_PHASES and phaseToRunningStage, or they silently render as "pending".
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
    for (const id of ["S2", "S3", "S4", "S5"]) states[id] = "green"
    states.S6 = "red"
    return
  }
  if (phase === "blocked_on_unverified_spikes") {
    states.S2 = "green"
    states.S3 = "red"
    return
  }
  if (EXTRACTION_RUNNING_PHASES.has(phase)) {
    const runningStage = phaseToRunningStage(phase)
    if (runningStage) states[runningStage] = "running"
    for (const id of ["S2", "S3", "S4"]) {
      if (states[id] === "pending" && id !== runningStage) states[id] = "green"
    }
  }
}

const SKILLS_RUNNING_PHASES = new Set(["selecting", "auditing", "installing"])

function applySkillsStates(
  states: Record<string, StageState>,
  skills: SkillsReport | null
): void {
  if (!skills?.phase) return
  if (SKILLS_RUNNING_PHASES.has(skills.phase)) states.SK = "running"
  else if (skills.phase === "green" || skills.phase === "skipped") states.SK = "green"
  else if (skills.phase === "failed") states.SK = "red"
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

  // Defensive fallback: dev status can outlive an old extraction run, so only set S7 here if extraction never reported it.
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
  // Stopped mid-way with no failing gate: S8-S10 stay pending, not green — resolveRunPhase treats this as "idle", not "done", and marking them green would fabricate completion.

  // S11 has no signal here (the widget doesn't poll the CR registry) — left pending rather than fabricating a CR-free "green".
  if (done >= total && total > 0) states.S12 = "green"
}
