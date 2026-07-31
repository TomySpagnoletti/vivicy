import { ControlError, getExtractionStatus, runExtract } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, status: getExtractionStatus() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to read extraction status" }, { status: 500 })
  }
}

export async function POST() {
  try {
    const result = await runExtract(getSpawner())
    if (!result.ok) {
      if (result.blocked) {
        appendNotification({
          level: "error",
          stage: "extract",
          event: "blocked",
          message: result.summary || "extraction blocked after bounded retries",
        })
      } else if (result.status === "blocked_on_unverified_spikes") {
        appendNotification({
          level: "warning",
          stage: "extract",
          event: "blocked_on_unverified_spikes",
          message: result.summary || "extraction refused: unverified spikes",
        })
      } else {
        appendNotification({
          level: "error",
          stage: "extract",
          event: "failed",
          message: result.summary || "extraction did not reach green and said nothing about why — ask Vivi to look",
        })
      }
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
      const reason = error.message || "no reason given"
      if (error.code === "empty_canonical") {
        appendNotification({
          level: "error",
          stage: "extract",
          event: "refused_empty_canonical",
          message: `extraction refused — ${reason}`,
          params: { reason },
        })
      } else {
        appendNotification({
          level: "error",
          stage: "extract",
          event: "error",
          message: `extraction failed — ${reason}`,
          params: { reason },
        })
      }
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    const reason = (error instanceof Error && error.message) || "no reason given"
    appendNotification({ level: "error", stage: "extract", event: "error", message: `extraction failed — ${reason}`, params: { reason } })
    return Response.json({ ok: false, error: reason }, { status: 500 })
  }
}
