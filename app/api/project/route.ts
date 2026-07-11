import { getCurrentProject, ProjectError, setCurrentProject } from "@/lib/project"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  return Response.json({ ok: true, project: getCurrentProject() })
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { root?: unknown; requireGoverned?: unknown }
      | null
    const root = typeof body?.root === "string" ? body.root : ""
    if (root.trim().length === 0) {
      return Response.json(
        { ok: false, error: "a project path is required", code: "not_absolute" },
        { status: 400 }
      )
    }
    const project = setCurrentProject(root, { requireGoverned: body?.requireGoverned === true })
    return Response.json({ ok: true, project })
  } catch (error) {
    if (error instanceof ProjectError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 400 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to set project" },
      { status: 500 }
    )
  }
}
