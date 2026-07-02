import { ControlError, runExtract, startSupervisor } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// Per-stage retry (G8 buttons call this; the `vivicy retry-stage` CLI dispatches
// identically — CLI+API parity). Node runtime only: spawns a factory script / writes
// the run-state lock.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Honest v0.5.0 scope: only two stages are actually retryable today. `extract`
// re-runs extraction; `dev` relaunches the supervisor (a resume — it picks up from
// done/ + the ledger). Map generation lives INSIDE extraction, so there is no
// standalone map stage. Anything else is a 400 listing what IS supported — the same
// dispatcher the CLI applies, so both clients steer the pipeline the same way.
const RETRYABLE_STAGES = ["extract", "dev"] as const
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

  appendNotification({
    level: "info",
    stage: "retry",
    event: `retry_${stage}_started`,
    message: `manual retry requested for stage "${stage}"`,
  })

  try {
    if (stage === "extract") {
      const result = await runExtract(getSpawner())
      // Same 200/422 honest split as the extract route: a blocked extraction is not
      // a clean success.
      appendNotification({
        level: result.ok ? "info" : "error",
        stage: "retry",
        event: result.ok ? "retry_extract_green" : "retry_extract_blocked",
        message: result.summary,
      })
      return Response.json(
        { ok: result.ok, stage, blocked: result.blocked, status: result.status, summary: result.summary },
        { status: result.ok ? 200 : 422 }
      )
    }
    // stage === "dev": relaunch the supervisor as a resume.
    const run = startSupervisor(getSpawner(), "resume")
    appendNotification({
      level: "info",
      stage: "retry",
      event: "retry_dev_started",
      message: `dev-loop retried (pid ${run.pid})`,
    })
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
