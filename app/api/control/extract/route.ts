import { ControlError, getExtractionStatus, runExtract } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// Spawns factory scripts — requires the Node runtime, not Edge.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, status: getExtractionStatus() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read extraction status" },
      { status: 500 }
    )
  }
}

export async function POST() {
  appendNotification({
    level: "info",
    stage: "extract",
    event: "started",
    message: "extraction started: freeze -> author -> validate -> verify",
  })
  try {
    const result = await runExtract(getSpawner())
    if (result.ok) {
      appendNotification({
        level: "info",
        stage: "extract",
        event: "green",
        message: result.summary,
      })
    } else if (result.blocked) {
      appendNotification({
        level: "error",
        stage: "extract",
        event: "blocked",
        message: result.summary,
      })
    } else if (result.status === "blocked_on_unverified_spikes") {
      appendNotification({
        level: "warn",
        stage: "extract",
        event: "blocked_on_unverified_spikes",
        message: result.summary,
      })
    } else {
      appendNotification({
        level: "error",
        stage: "extract",
        event: "failed",
        message: result.summary,
      })
    }
    return Response.json(
      {
        ok: result.ok,
        blocked: result.blocked,
        status: result.status,
        summary: result.summary,
      },
      { status: result.ok ? 200 : 422 }
    )
  } catch (error) {
    if (error instanceof ControlError) {
      appendNotification({
        level: "error",
        stage: "extract",
        event: error.code === "empty_canonical" ? "refused_empty_canonical" : "error",
        message: error.message,
      })
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    appendNotification({
      level: "error",
      stage: "extract",
      event: "error",
      message: error instanceof Error ? error.message : "extract failed",
    })
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "extract failed" },
      { status: 500 }
    )
  }
}
