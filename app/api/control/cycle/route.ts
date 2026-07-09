import { cancelSpecCycle, ControlError, getSpecCycle, openSpecCycle } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// Spec-cycle state + transitions (W7b): GET reads the open drafting cycle (null when
// none); POST {action:"open"|"cancel"} transitions it. The freeze side of the state
// machine lives in extraction — this route never closes a cycle by declaration.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, cycle: getSpecCycle() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read the cycle state" },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  let body: { action?: unknown }
  try {
    body = (await request.json()) as { action?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  if (body.action !== "open" && body.action !== "cancel") {
    return Response.json({ ok: false, error: 'action must be "open" or "cancel"' }, { status: 400 })
  }
  try {
    if (body.action === "open") {
      const cycle = openSpecCycle(getSpawner(), "owner:ui")
      appendNotification({
        level: "info",
        stage: "cycle",
        event: "cycle_opened",
        message: `drafting spec cycle ${cycle.id} opened — the canonical is editable until the next extraction freezes it`,
      })
      return Response.json({ ok: true, cycle })
    }
    const { id } = await cancelSpecCycle(getSpawner())
    appendNotification({
      level: "info",
      stage: "cycle",
      event: "cycle_cancelled",
      message: `drafting spec cycle ${id} cancelled (no drift)`,
    })
    return Response.json({ ok: true, id })
  } catch (error) {
    if (error instanceof ControlError) {
      appendNotification({ level: "error", stage: "cycle", event: "cycle_error", message: error.message })
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    const message = error instanceof Error ? error.message : "cycle transition failed"
    appendNotification({ level: "error", stage: "cycle", event: "cycle_error", message })
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
