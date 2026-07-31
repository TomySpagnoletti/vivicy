import { ImportError, startGovernance, type RawEntry } from "@/lib/import-docs"
import { ScaffoldError } from "@/lib/scaffold"
import { getSpawner } from "@/lib/spawner"
import { appendCardTurn, dispatchImportRead, seedViviWelcome, WELCOME_IMPORT_CARD } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATUS_BY_CODE: Record<string, number> = {
  already_governed: 409,
  templates_missing: 500,
}

export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const targetDir = typeof form.get("targetDir") === "string" ? (form.get("targetDir") as string) : ""
    const projectNameRaw = form.get("projectName")
    const projectName = typeof projectNameRaw === "string" ? projectNameRaw : undefined
    const files = form.getAll("files")
    const paths = form.getAll("paths")

    const entries: RawEntry[] = []
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      if (!(file instanceof File)) continue
      const rel = typeof paths[i] === "string" ? (paths[i] as string) : ""
      entries.push({ rel, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
    }

    const result = await startGovernance({ targetDir, projectName, entries })

    // Never fail a governed project on the greeting, and never wait on the reading turn.
    try {
      const sessionId = seedViviWelcome(result.batch)
      if (result.batch) void dispatchImportRead(getSpawner(), { sessionId, batch: result.batch })
      else appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    } catch {}

    return Response.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof ImportError || error instanceof ScaffoldError) {
      return Response.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          ...(error instanceof ImportError && error.details ? error.details : {}),
        },
        { status: STATUS_BY_CODE[error.code] ?? 400 }
      )
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to start governance" }, { status: 500 })
  }
}
