import { ControlError, readDocPrepReport, startDocPrep } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, report: readDocPrepReport() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to read doc-prep report" }, { status: 500 })
  }
}

export async function POST() {
  try {
    const run = startDocPrep(getSpawner())
    return Response.json({ ok: true, ...run })
  } catch (error) {
    const reason = (error instanceof Error && error.message) || "no reason given"
    appendNotification({
      level: "error",
      stage: "prepare",
      event: "failed",
      message: `document preparation could not start — ${reason}`,
      params: { reason },
    })
    if (error instanceof ControlError) {
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json({ ok: false, error: reason }, { status: 500 })
  }
}
