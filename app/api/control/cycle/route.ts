import { cancelSpecCycle, ControlError, getSpecCycle, openSpecCycle } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, cycle: getSpecCycle() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to read the cycle state" }, { status: 500 })
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
      return Response.json({ ok: true, cycle })
    }
    const { id } = await cancelSpecCycle(getSpawner())
    return Response.json({ ok: true, id })
  } catch (error) {
    const reason = (error instanceof Error && error.message) || "no reason given"
    appendNotification({
      level: "error",
      stage: "cycle",
      event: "cycle_error",
      message: `spec-cycle transition refused — ${reason}`,
      params: { reason },
    })
    if (error instanceof ControlError) {
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json({ ok: false, error: reason }, { status: 500 })
  }
}
