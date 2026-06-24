import { ControlError, readDevStatus } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

// Runs the read-only dev-status probe; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const status = await readDevStatus(getSpawner())
    return Response.json(status)
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "status failed" },
      { status: 500 }
    )
  }
}
