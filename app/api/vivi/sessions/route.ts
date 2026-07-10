import { ControlError } from "@/lib/control"
import { listViviSessions } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, sessions: listViviSessions() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to list sessions" },
      { status: 500 }
    )
  }
}
