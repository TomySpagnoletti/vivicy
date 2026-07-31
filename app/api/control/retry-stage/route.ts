import { ControlError, runExtract, startDocPrep, startSkillsInstall, startSupervisor } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Keep this set identical to `RETRYABLE_STAGES` in factory/cli.ts — the CLI dispatches the same stages.
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
          message: result.summary || "the extract retry did not reach green and said nothing about why — ask Vivi to look",
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
    const reason = (error instanceof Error && error.message) || "no reason given"
    appendNotification({
      level: "error",
      stage: "retry",
      event: "retry_error",
      message: `the ${stage} retry failed — ${reason}`,
      params: { stage, reason },
    })
    if (error instanceof ControlError) {
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    return Response.json({ ok: false, error: reason }, { status: 500 })
  }
}
