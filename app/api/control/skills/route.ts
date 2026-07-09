import { ControlError, readSkillsReport, removeSkills, startSkillsInstall } from "@/lib/control"
import { appendNotification } from "@/lib/notifications"
import { getSpawner } from "@/lib/spawner"

// Reads the skills report / launches the detached installer; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Read-only skills report (the SK stage + the sidebar Skills section derive
 * their state from this): install-skills.ts's own report file, reflecting
 * whatever the last install wrote, including mid-run phases
 * (selecting/auditing/installing) while a run is in flight. `report` is null
 * when no install has ever run.
 */
export async function GET() {
  try {
    return Response.json({ ok: true, report: readSkillsReport() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read skills report" },
      { status: 500 }
    )
  }
}

/**
 * Start a skills install DETACHED, or run a REMOVE synchronously (W6). Body:
 *   { ids?: string[] }    — install: absent/empty = auto mode, present = explicit
 *   { remove: string[] }  — uninstall exactly these ids (deterministic, no agent)
 * Install progress lands in the report file the GET above serves; a remove returns
 * its final report directly (it is fast — no agent leg).
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { ids?: unknown; remove?: unknown }
  if (body.remove !== undefined) {
    if (!isStringArray(body.remove) || body.remove.length === 0) {
      return Response.json(
        { ok: false, error: "remove must be a non-empty array of skill id strings" },
        { status: 400 }
      )
    }
    appendNotification({
      level: "info",
      stage: "skills",
      event: "remove_started",
      message: `skills remove requested: ${body.remove.join(", ")}`,
    })
    try {
      const report = await removeSkills(getSpawner(), { ids: body.remove })
      return Response.json({ ok: report.phase === "green", report })
    } catch (error) {
      if (error instanceof ControlError) {
        appendNotification({ level: "error", stage: "skills", event: "remove_failed", message: error.message })
        const status = error.code === "already_running" ? 409 : 422
        return Response.json({ ok: false, error: error.message, code: error.code }, { status })
      }
      const message = error instanceof Error ? error.message : "skills remove failed"
      appendNotification({ level: "error", stage: "skills", event: "remove_failed", message })
      return Response.json({ ok: false, error: message }, { status: 500 })
    }
  }
  if (body.ids !== undefined && !isStringArray(body.ids)) {
    return Response.json(
      { ok: false, error: "ids must be an array of skill id strings" },
      { status: 400 }
    )
  }
  const ids = body.ids as string[] | undefined
  const mode = ids && ids.length > 0 ? "explicit" : "auto"

  appendNotification({
    level: "info",
    stage: "skills",
    event: "started",
    message: `skills install requested (${mode} mode${mode === "explicit" ? `: ${ids!.join(", ")}` : ""})`,
  })
  try {
    const run = startSkillsInstall(getSpawner(), { ids })
    return Response.json({ ok: true, ...run })
  } catch (error) {
    if (error instanceof ControlError) {
      appendNotification({
        level: "error",
        stage: "skills",
        event: "failed",
        message: error.message,
      })
      const status = error.code === "already_running" ? 409 : 422
      return Response.json({ ok: false, error: error.message, code: error.code }, { status })
    }
    const message = error instanceof Error ? error.message : "skills install failed to start"
    appendNotification({ level: "error", stage: "skills", event: "failed", message })
    return Response.json({ ok: false, error: message }, { status: 500 })
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
}
