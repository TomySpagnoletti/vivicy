import { ControlError } from "@/lib/control"
import { PROVIDER_LABEL } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"
import { getSpawner } from "@/lib/spawner"
import { runViviTurn } from "@/lib/vivi"

// Drives an agent exec in the target repo and writes the session transcript; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Vivi's read-only engine display (G2): which CLI + model Vivi runs on. Vivi's
 * engine is the IMPLEMENTER role from the shared agent settings — never a Vivi-owned
 * setting and never editable from the chat (P6: settings live in the settings UI).
 * The chat shows this so the user knows what is answering them, not to change it.
 */
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

/**
 * Run ONE Vivi turn (S1-chat). Body: `{ sessionId?, message }`. The control plane
 * appends the user turn, composes the bounded prompt (persona + transcript + `.vivicy`
 * state summary), spawns the configured agent CLI in the target repo, enforces the
 * `.md`-under-two-dirs allowlist structurally, and returns `{ sessionId, reply, wrote }`
 * — plus `rejected` when the turn's writes broke the allowlist and were rolled back,
 * and `actions` when the governess loop executed a `vivicy-action` batch this turn
 * (the panel refreshes the map/project state off it).
 */
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
