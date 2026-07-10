import { ControlError, startSupervisor } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const state = startSupervisor(getSpawner(), "start")
    appendNotification({
      level: "info",
      stage: "dev",
      event: "started",
      message: `dev-loop started (pid ${state.pid})`,
    })
    return Response.json({ ok: true, run: state })
  } catch (error) {
    if (error instanceof ControlError) {
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "start failed" },
      { status: 500 }
    )
  }
}
