import { ControlError } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"
import { getTargetRoot } from "@/lib/target"
import { isViviTurnRunning, readTranscript, recoverInterruptedReads } from "@/lib/vivi"

// Reads the SAME JSONL the turn engine writes elsewhere — no separate read-side representation.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const SESSION_ID_RE = /^[0-9a-fA-F-]{36}$/

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!SESSION_ID_RE.test(sessionId)) {
    return Response.json({ ok: false, error: "invalid session id" }, { status: 400 })
  }
  try {
    // Session load and the resume poll both land here, so this is where a read orphaned by a dead process is repaired — the UI is never handed one as if it were in flight.
    recoverInterruptedReads(getSpawner(), sessionId)
    const targetRoot = getTargetRoot()
    return Response.json({
      ok: true,
      sessionId,
      turns: readTranscript(sessionId),
      busy: targetRoot !== null && isViviTurnRunning(targetRoot),
    })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to read the session" }, { status: 500 })
  }
}
