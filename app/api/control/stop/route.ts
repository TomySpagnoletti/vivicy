import { ControlError, stopSupervisor } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const result = stopSupervisor(getSpawner())
    appendNotification({
      level: "info",
      stage: "dev",
      event: "stopped",
      message: `dev-loop stopped (pid ${result.pid})`,
    })
    return Response.json({ ok: true, stopped: result })
  } catch (error) {
    if (error instanceof ControlError) {
      const status = error.code === "not_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "stop failed" },
      { status: 500 }
    )
  }
}
