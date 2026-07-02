import { ControlError, runUploadVerify } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"
import { appendNotification } from "@/lib/notifications"

import { uploadErrorResponse } from "../route"

// Runs a deterministic normalization pass + an agent CHECK leg; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * VERIFY a staged upload (G1's check-then-place gate). The body is `{ stagingId }`.
 * Runs the deterministic normalization pass into `<staging>/normalized/`, then the
 * agent CHECK (verify-upload.mjs via the control plane) which writes the report.
 * The response is `{ ok, verdict, problems, summary, normalized }`; a red verdict
 * (drift/contradiction/rewrite, a conversion that could not run, or a dead leg) is
 * surfaced honestly — nothing is placed until /apply sees a green report.
 */
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
