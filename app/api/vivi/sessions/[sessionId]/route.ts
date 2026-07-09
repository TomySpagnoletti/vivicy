import { ControlError } from "@/lib/control"
import { readTranscript } from "@/lib/vivi"

// Read-only transcript of one session (W3 rehydration): the panel restores the
// visible history from the SAME JSONL the turn engine writes.
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
