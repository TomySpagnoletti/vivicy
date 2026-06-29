import { getCurrentProject, ProjectError, setCurrentProject } from "@/lib/project"

// Reads/writes the current-project JSON under the Vivicy runtime dir; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** The current target project (null when none is set or the path went stale). */
export async function GET() {
  return Response.json({ ok: true, project: getCurrentProject() })
}

/**
 * Set the current target project from an absolute path. The body is validated
 * (must be an absolute path to an existing directory); the response echoes the
 * described project actually written (root, name, hasCanonicalSpec), never the raw input.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { root?: unknown } | null
    const root = typeof body?.root === "string" ? body.root : ""
    if (root.trim().length === 0) {
      return Response.json(
        { ok: false, error: "a project path is required", code: "not_absolute" },
        { status: 400 }
      )
    }
    const project = setCurrentProject(root)
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
