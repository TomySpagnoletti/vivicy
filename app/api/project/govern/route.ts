import { ImportError, startGovernance, type RawEntry } from "@/lib/import-docs"
import { ScaffoldError } from "@/lib/scaffold"
import { appendCardTurn, seedViviWelcome, WELCOME_IMPORT_CARD } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATUS_BY_CODE: Record<string, number> = {
  already_governed: 409,
  no_supported_files: 400,
  zip_slip: 400,
  zip_unreadable: 400,
  not_absolute: 400,
  not_a_directory: 400,
  invalid_name: 400,
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

    try {
      const sessionId = seedViviWelcome()
      if (!result.batch) appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
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
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to start governance" },
      { status: 500 }
    )
  }
}
