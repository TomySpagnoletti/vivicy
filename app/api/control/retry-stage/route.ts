import { ControlError, runExtract, startDocPrep, startSkillsInstall, startSupervisor } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// The `vivicy retry-stage` CLI dispatches identically (CLI+API parity); spawns a factory script and writes the run-state lock, so Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// map generation lives inside extraction (no standalone stage); dev is a resume via done/ + the ledger — the CLI's dispatcher matches this list exactly.
const RETRYABLE_STAGES = ["prepare", "extract", "skills", "dev"] as const
type RetryableStage = (typeof RETRYABLE_STAGES)[number]

function isRetryable(stage: unknown): stage is RetryableStage {
  return typeof stage === "string" && (RETRYABLE_STAGES as readonly string[]).includes(stage)
}

export async function POST(request: Request) {
  let body: { stage?: unknown }
  try {
    body = (await request.json()) as { stage?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  if (!isRetryable(body.stage)) {
    return Response.json(
      {
        ok: false,
        error: `stage is not retryable; supported: ${RETRYABLE_STAGES.join(", ")}`,
        supported: RETRYABLE_STAGES,
      },
      { status: 400 }
    )
  }
  const stage = body.stage

  try {
    if (stage === "prepare") {
      const run = startDocPrep(getSpawner())
      return Response.json({ ok: true, stage, run })
    }
    if (stage === "extract") {
      const result = await runExtract(getSpawner())
      if (!result.ok) {
        appendNotification({
          level: "error",
          stage: "retry",
          event: "retry_extract_blocked",
          message: result.summary,
        })
      }
      return Response.json(
        { ok: result.ok, stage, blocked: result.blocked, status: result.status, summary: result.summary },
        { status: result.ok ? 200 : 422 }
      )
    }
    if (stage === "skills") {
      const run = startSkillsInstall(getSpawner())
      return Response.json({ ok: true, stage, run })
    }
    const run = startSupervisor(getSpawner(), "resume")
    return Response.json({ ok: true, stage, run })
  } catch (error) {
    if (error instanceof ControlError) {
      appendNotification({
        level: "error",
        stage: "retry",
        event: `retry_${stage}_error`,
        message: error.message,
      })
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    const message = error instanceof Error ? error.message : "retry failed"
    appendNotification({ level: "error", stage: "retry", event: `retry_${stage}_error`, message })
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}
