/**
 * Map the raw dev-status verdict (+ run-active lock) to the five UI phases the
 * control bar renders. Pure and shared so the pill, the disabled-state logic,
 * and tests all agree on one mapping.
 */

import type { DevStatus } from "@/lib/control"

export type RunPhase = "idle" | "running" | "done" | "blocked" | "stalled"

export interface RunStatus extends DevStatus {
  run_active: boolean
}

/** The shape the status endpoints return. */
export type StatusResponse = RunStatus

/**
 * Phase resolution, in priority order:
 *   - an active lock + a stale verdict => "stalled" (running but no progress)
 *   - an active lock => "running"
 *   - all issues verified => "done"
 *   - a failed gate while incomplete => "blocked"
 *   - otherwise => "idle"
 */
export function resolveRunPhase(status: RunStatus): RunPhase {
  const verdict = (status.verdict ?? "").toUpperCase()
  if (status.run_active) {
    return verdict.startsWith("STALE") ? "stalled" : "running"
  }
  if (status.issues_total > 0 && status.issues_done >= status.issues_total) return "done"
  if (verdict.startsWith("STALE")) return "stalled"
  if (status.gates?.fail > 0 && status.issues_done < status.issues_total) return "blocked"
  return "idle"
}

/** Did the run start but not finish? (Resume is offered for this case.) */
export function isResumable(status: RunStatus): boolean {
  const phase = resolveRunPhase(status)
  return (
    (phase === "idle" || phase === "blocked" || phase === "stalled") &&
    status.issues_done > 0 &&
    status.issues_done < status.issues_total
  )
}

export const PHASE_LABELS: Record<RunPhase, string> = {
  idle: "idle",
  running: "running",
  done: "done",
  blocked: "blocked",
  stalled: "stalled",
}
