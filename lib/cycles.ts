import type { CycleKind } from "./doc-prep-report.ts"

export type CyclePhase = "editable" | "frozen" | "building" | "done"

export interface ActiveCycle {
  id: string | null
  kind: CycleKind | null
  editable: boolean
  pending_batches: number
}

export interface PastCycle {
  baseline_id: string
  version: string
  kind: CycleKind | null
  approval_ref: string | null
  closed_at: string | null
  superseded: boolean
}

export interface CyclesView {
  active: ActiveCycle | null
  history: PastCycle[]
}
