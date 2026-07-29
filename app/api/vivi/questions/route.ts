import { ControlError } from "@/lib/control"
import { getSpawner } from "@/lib/spawner"
import { answerViviQuestion } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let body: {
    sessionId?: unknown
    stackId?: unknown
    questionId?: unknown
    optionIndex?: unknown
    other?: unknown
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  const { sessionId, stackId, questionId } = body
  if (typeof sessionId !== "string" || typeof stackId !== "string" || typeof questionId !== "string") {
    return Response.json({ ok: false, error: "sessionId, stackId, and questionId are required strings" }, { status: 400 })
  }
  try {
    const result = answerViviQuestion(getSpawner(), {
      sessionId,
      stackId,
      questionId,
      optionIndex: typeof body.optionIndex === "number" ? body.optionIndex : undefined,
      other: typeof body.other === "string" ? body.other : undefined,
    })
    // 409, not 422: a second answer to a card that already carries its line is a lost race, not a bad request — the client resyncs from the thread instead of alarming the owner.
    return Response.json(result, { status: result.ok ? 200 : 409 })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "the answer could not be recorded" }, { status: 500 })
  }
}
