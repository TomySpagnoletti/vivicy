import { ControlError } from "@/lib/control"
import { listViviSessions } from "@/lib/vivi"

// Read-only session index for the panel's rehydration (W3): the per-project
// transcripts already persist on disk; this lists them newest-first.
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
