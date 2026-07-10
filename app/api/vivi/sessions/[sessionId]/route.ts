import { ControlError } from "@/lib/control"
import { readTranscript } from "@/lib/vivi"

// Reads the SAME JSONL the turn engine writes elsewhere — no separate read-side representation.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  if (!SESSION_ID_RE.test(sessionId)) {
    return Response.json({ ok: false, error: "invalid session id" }, { status: 400 })
  }
  try {
    return Response.json({ ok: true, sessionId, turns: readTranscript(sessionId) })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read the session" },
      { status: 500 }
    )
  }
}
