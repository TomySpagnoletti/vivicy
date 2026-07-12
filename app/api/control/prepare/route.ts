import { ControlError, readDocPrepReport, startDocPrep } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// Launches a detached preparation process — requires the Node runtime, not Edge.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, report: readDocPrepReport() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read doc-prep report" },
      { status: 500 }
    )
  }
}

export async function POST() {
  appendNotification({
    level: "info",
    stage: "prepare",
    event: "started",
    message: "document preparation requested: classify -> explode/translate -> place",
  })
  try {
    const run = startDocPrep(getSpawner())
    return Response.json({ ok: true, ...run })
  } catch (error) {
    if (error instanceof ControlError) {
      appendNotification({ level: "error", stage: "prepare", event: "failed", message: error.message })
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    const message = error instanceof Error ? error.message : "document preparation failed to start"
    appendNotification({ level: "error", stage: "prepare", event: "failed", message })
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
