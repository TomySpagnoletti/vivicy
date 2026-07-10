import { ScaffoldError, scaffoldProject } from "@/lib/scaffold"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
    return Response.json({
      ok: true,
      project: result.project,
      mode: result.mode,
      written: result.written,
      git: result.git,
    })
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
