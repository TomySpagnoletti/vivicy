import { ControlError, startSupervisor } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"

// Resume re-launches the supervisor, which picks up from done/ + the ledger.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST() {
  try {
    const state = startSupervisor(getSpawner(), "resume")
    return Response.json({ ok: true, run: state })
  } catch (error) {
    if (error instanceof ControlError) {
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "resume failed" },
      { status: 500 }
    )
  }
}
