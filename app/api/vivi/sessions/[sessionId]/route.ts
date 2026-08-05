import { ControlError } from "@/lib/control"
import { VIVI_SESSION_ID_PATTERN } from "@/lib/project-runtime"
import { getSpawner } from "@/lib/spawner"
import { getTargetRoot } from "@/lib/target"
import { isViviTurnRunning, readTranscript, recoverInterruptedReads } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(_request: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params
  if (!VIVI_SESSION_ID_PATTERN.test(sessionId)) {
    return Response.json({ ok: false, error: "invalid session id" }, { status: 400 })
  }
  try {
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
