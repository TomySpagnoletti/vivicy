import type { DevStatus } from "@/lib/control"

export type RunPhase = "idle" | "running" | "done" | "blocked" | "stalled"

export interface RunStatus extends DevStatus {
  run_active: boolean
}

export type StatusResponse = RunStatus

export function resolveRunPhase(status: RunStatus): RunPhase {
  const verdict = (status.verdict ?? "").toUpperCase()
  if (status.run_active) {
    return verdict.startsWith("STALE") ? "stalled" : "running"
  }
  if (status.issues_total > 0 && status.issues_done >= status.issues_total) return "done"
  if (verdict.startsWith("STALE")) return "stalled"
  if (status.gates.fail > 0 && status.issues_done < status.issues_total) return "blocked"
  return "idle"
}

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
