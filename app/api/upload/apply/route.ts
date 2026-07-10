import { existsSync } from "node:fs"

import { appendNotification } from "@/lib/notifications"
import { getTargetRoot } from "@/lib/target"
import { applyUpload, UploadError } from "@/lib/upload"

import { uploadErrorResponse } from "../route"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { stagingId?: unknown } | null
    const stagingId = typeof body?.stagingId === "string" ? body.stagingId : ""

    const targetRoot = getTargetRoot()
    if (targetRoot === null || !existsSync(targetRoot)) {
      return Response.json(
        {
          ok: false,
          error: "no project selected — choose a target project first",
          code: "missing_target",
        },
        { status: 422 }
      )
    }

    const result = applyUpload(stagingId, targetRoot)
    appendNotification({
      level: "info",
      stage: "upload",
      event: "placed",
      message: `placed ${result.placed.length} file(s): ${result.placed.map((f) => f.to).join(", ")}`,
    })
    return Response.json({ ok: true, placed: result.placed })
  } catch (error) {
    appendNotification({
      level: "error",
      stage: "upload",
      event: "refused",
      message: error instanceof UploadError ? error.message : error instanceof Error ? error.message : "failed to place upload",
    })
    return uploadErrorResponse(error, "failed to place upload")
  }
}
