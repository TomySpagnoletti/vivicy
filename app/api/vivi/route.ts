import { ControlError } from "@/lib/control"
import { PROVIDER_LABEL } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"
import { getSpawner } from "@/lib/spawner"
import { runViviTurn } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  const { implementer } = readSettings()
  return Response.json({
    ok: true,
    engine: {
      provider: implementer.provider,
      providerLabel: PROVIDER_LABEL[implementer.provider],
      model: implementer.model,
    },
  })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      sessionId?: unknown
      message?: unknown
    } | null
    const message = typeof body?.message === "string" ? body.message : ""
    const sessionId = typeof body?.sessionId === "string" ? body.sessionId : undefined

    const result = await runViviTurn(getSpawner(), { sessionId, message })
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
