import { ControlError } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"
import { recoverInterruptedReads, runViviTurn } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      sessionId?: unknown
      message?: unknown
    } | null
    const message = typeof body?.message === "string" ? body.message : ""
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined

    const spawner = getSpawner()
    // A read orphaned by a dead process is picked back up before this turn queues behind it, so the owner's next message never runs on a corpus Vivi silently never read.
    if (sessionId) recoverInterruptedReads(spawner, sessionId)
    const result = await runViviTurn(spawner, { sessionId, message })
    return Response.json({
      ok: true,
      sessionId: result.sessionId,
      reply: result.reply,
      wrote: result.wrote,
      ...(result.rejected ? { rejected: result.rejected } : {}),
      ...(result.actions?.length ? { actions: result.actions } : {}),
    })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code },
        { status: error.code === "missing_target" ? 422 : 400 }
      )
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "vivi turn failed" },
      { status: 500 }
    )
  }
}
