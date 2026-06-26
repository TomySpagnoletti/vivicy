import { ControlError, runExtract } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

// Runs the deterministic extraction-verification scripts; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const result = await runExtract(getSpawner())
    // Honest about the blocked case: the checks stayed red after the bounded
    // retries and a human must look — distinct from a transient failure.
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
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "extract failed" },
      { status: 500 }
    )
  }
}
