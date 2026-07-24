import { ControlError, stopProductRun } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const result = stopProductRun(getSpawner())
    appendNotification({
      level: "info",
      stage: "run",
      event: "product_run_stopped",
      message: `product run stopped (pid ${result.pid})`,
    })
    return Response.json({ ok: true, stopped: result })
  } catch (error) {
    if (error instanceof ControlError) {
      const status = error.code === "not_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to stop the product" },
      { status: 500 }
    )
  }
}
