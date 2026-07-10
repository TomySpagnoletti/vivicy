import { ControlError, decideCr } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// The apply leg itself lives in the factory script; this route only launches it via the control plane.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// decidedBy is a parameter of decideCr because other callers (e.g. the CLI) pass their own actor; this route always attributes decisions to the UI owner.
const DECIDED_BY = "owner:ui"

export async function POST(request: Request) {
  let body: { id?: unknown; decision?: unknown }
  try {
    body = (await request.json()) as { id?: unknown; decision?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  const id = typeof body.id === "string" ? body.id : ""
  const decision = body.decision
  if (!/^CR-\d{4}$/.test(id) || (decision !== "approved" && decision !== "rejected")) {
    return Response.json(
      { ok: false, error: "body must be { id: 'CR-####', decision: 'approved' | 'rejected' }" },
      { status: 400 }
    )
  }

  try {
    const result = await decideCr(getSpawner(), { id, decision, decidedBy: DECIDED_BY })
    // ok:false here means the decision landed but the apply chain is blocked, not that the decision failed (mirrors the extract route's 200/422 split).
    if (decision === "rejected") {
      appendNotification({
        level: "info",
        stage: "crs",
        event: "rejected",
        message: `${id} rejected: ${result.summary}`,
      })
    } else if (result.applied?.ok) {
      appendNotification({
        level: "info",
        stage: "crs",
        event: "approved_applied",
        message: `${id} approved and applied: ${result.applied.summary}`,
      })
    } else {
      appendNotification({
        level: "error",
        stage: "crs",
        event: "approved_apply_blocked",
        message: `${id} approved but the apply chain is blocked: ${result.summary}`,
      })
    }
    return Response.json(
      {
        ok: result.ok,
        status: result.status,
        summary: result.summary,
        ...(result.applied ? { applied: result.applied } : {}),
      },
      { status: result.ok ? 200 : 422 }
    )
  } catch (error) {
    const message = error instanceof ControlError ? error.message : error instanceof Error ? error.message : "decision failed"
    appendNotification({ level: "error", stage: "crs", event: "decide_error", message: `${id}: ${message}` })
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
