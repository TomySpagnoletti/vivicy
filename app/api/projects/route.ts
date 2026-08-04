import { ProjectError } from "@/lib/project"
import { RegistryError } from "@/lib/project-registry"
import {
  forgetProject,
  listProjects,
  openProject,
  ProjectServerError,
  restartProject,
  stopProject,
  type OpenedProject,
} from "@/lib/project-server"
import { nodeServerHost } from "@/lib/server-host"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATUS_BY_CODE: Record<string, number> = {
  not_absolute: 400,
  not_found: 400,
  not_a_directory: 400,
  unknown_project: 404,
  registry_busy: 409,
  no_free_port: 409,
  not_built: 409,
  not_ready: 504,
  spawn_failed: 500,
}

const ACTIONS = new Set(["open", "restart", "stop", "forget"])

export async function GET() {
  try {
    return Response.json({ ok: true, projects: await listProjects(nodeServerHost) })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as { action?: unknown; root?: unknown } | null
  const action = typeof body?.action === "string" ? body.action : ""
  const root = typeof body?.root === "string" ? body.root.trim() : ""
  if (!ACTIONS.has(action)) {
    return Response.json({ ok: false, error: `unknown project action: ${action || "(none)"}` }, { status: 400 })
  }
  if (root.length === 0) {
    return Response.json({ ok: false, error: "a project path is required", code: "not_absolute" }, { status: 400 })
  }

  try {
    let opened: OpenedProject | null = null
    if (action === "open") opened = await openProject(nodeServerHost, root)
    else if (action === "restart") opened = await restartProject(nodeServerHost, root)
    else if (action === "stop") await stopProject(nodeServerHost, root)
    else await forgetProject(nodeServerHost, root)
    return Response.json({ ok: true, opened, projects: await listProjects(nodeServerHost) })
  } catch (error) {
    return failure(error)
  }
}

function failure(error: unknown): Response {
  if (error instanceof ProjectError || error instanceof RegistryError || error instanceof ProjectServerError) {
    return Response.json({ ok: false, error: error.message, code: error.code }, { status: STATUS_BY_CODE[error.code] ?? 400 })
  }
  return Response.json({ ok: false, error: error instanceof Error ? error.message : "the project manager failed" }, { status: 500 })
}
