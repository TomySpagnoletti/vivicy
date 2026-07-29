import { ControlError, readProductRun } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, run: readProductRun(getSpawner()) })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to read the product run" }, { status: 500 })
  }
}
