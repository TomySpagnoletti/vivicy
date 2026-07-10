import { ControlError } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"
import { decideCardAction } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: { sessionId?: unknown; cardId?: unknown; actionId?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  const { sessionId, cardId, actionId } = body
  if (typeof sessionId !== "string" || typeof cardId !== "string" || typeof actionId !== "string") {
    return Response.json(
      { ok: false, error: "sessionId, cardId, and actionId are required strings" },
      { status: 400 }
    )
  }
  try {
    const result = await decideCardAction(getSpawner(), { sessionId, cardId, actionId })
    return Response.json(result, { status: result.ok ? 200 : 422 })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "card decision failed" },
      { status: 500 }
    )
  }
}
