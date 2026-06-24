import { ScaffoldError, scaffoldProject } from "@/lib/scaffold"

// Writes the scaffold skeleton to the local filesystem; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Scaffold a brand-new project (R9, Mode B). The body is `{ targetDir, projectName }`:
 * `targetDir` must be an absolute path that is absent or an empty directory, and
 * `projectName` a 1–64 char name. On success the generic governance/method
 * skeleton is written (with the name substituted) and the project is set as the
 * current target; the response echoes the described project and the files written.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      targetDir?: unknown
      projectName?: unknown
    } | null
    const result = scaffoldProject({
      targetDir: body?.targetDir,
      projectName: body?.projectName,
    })
    return Response.json({ ok: true, project: result.project, written: result.written })
  } catch (error) {
    if (error instanceof ScaffoldError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 400 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to scaffold project" },
      { status: 500 }
    )
  }
}
