import { ControlError, runUploadVerify } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"
import { appendNotification } from "@/lib/notifications"

import { uploadErrorResponse } from "../route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Never places files itself — /apply refuses (409) unless this has written a green report.json first.
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { stagingId?: unknown } | null
    const stagingId = typeof body?.stagingId === "string" ? body.stagingId : ""

    const result = await runUploadVerify(nodeSpawner, stagingId)
    appendNotification({
      level: result.verdict === "green" ? "info" : "error",
      stage: "upload",
      event: result.verdict === "green" ? "verify_green" : "verify_red",
      message: result.summary,
    })
    return Response.json({
      ok: result.ok,
      verdict: result.verdict,
      problems: result.problems,
      summary: result.summary,
      normalized: result.normalized,
    })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.code === "missing_target" ? 422 : 400 }
      )
    }
    return uploadErrorResponse(error, "failed to verify upload")
  }
}
