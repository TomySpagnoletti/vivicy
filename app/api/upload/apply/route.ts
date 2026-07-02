import { existsSync } from "node:fs"

import { getTargetRoot } from "@/lib/target"
import { applyUpload } from "@/lib/upload"

import { uploadErrorResponse } from "../route"

// Places the normalized files into the target's .vivicy/; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * PLACE a verified upload into the target's `.vivicy/` (G1's final step). The body
 * is `{ stagingId }`. Refuses (409, `not_verified`) unless `<staging>/report.json`
 * exists with a green verdict. Requires a resolved target (422, `missing_target`).
 * Places canonical -> `.vivicy/canonical/<basename>`, spikes ->
 * `.vivicy/development/spikes/<basename>`, map ->
 * `.vivicy/architecture-map/architecture-map.yml`; NEVER overwrites an existing
 * file — it checks ALL destinations first and refuses (409, `would_overwrite`,
 * listing the collisions) with nothing placed. The response is `{ ok, placed }`.
 */
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
    return Response.json({ ok: true, placed: result.placed })
  } catch (error) {
    return uploadErrorResponse(error, "failed to place upload")
  }
}
