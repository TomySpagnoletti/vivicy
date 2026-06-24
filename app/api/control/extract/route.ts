import { ControlError, runExtract } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

// Runs the deterministic extraction-verification scripts; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const steps = await runExtract(getSpawner())
    const ok = steps.every((s) => s.code === 0)
    return Response.json({ ok, steps })
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
