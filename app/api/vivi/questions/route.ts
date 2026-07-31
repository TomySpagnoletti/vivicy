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
    // A replayed answer stays 409, never 422: components/chat/question-stack.tsx resyncs on it instead of surfacing an error.
    return Response.json(result, { status: result.ok ? 200 : 409 })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "the answer could not be recorded" }, { status: 500 })
  }
}
