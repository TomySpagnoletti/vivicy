import { ControlError } from "@/lib/control"
import { ImportError, type RawEntry } from "@/lib/import-docs"
import { decideCardImport } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const STATUS_BY_CODE: Record<string, number> = {
  no_files: 400,
  no_supported_files: 400,
  not_governed: 409,
  zip_slip: 400,
  zip_unreadable: 400,
}

export async function POST(request: Request) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return Response.json({ ok: false, error: "expected a multipart form body" }, { status: 400 })
  }

  const sessionId = form.get("sessionId")
  const cardId = form.get("cardId")
  const actionId = form.get("actionId")
  if (typeof sessionId !== "string" || typeof cardId !== "string" || typeof actionId !== "string") {
    return Response.json(
      { ok: false, error: "sessionId, cardId, and actionId are required strings" },
      { status: 400 }
    )
  }

  const files = form.getAll("files")
  const paths = form.getAll("paths")
  const entries: RawEntry[] = []
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]
    if (!(file instanceof File)) continue
    const rel = typeof paths[i] === "string" ? (paths[i] as string) : ""
    entries.push({ rel, name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) })
  }

  try {
    const result = decideCardImport({ sessionId, cardId, actionId, entries })
    return Response.json(result, { status: result.ok ? 200 : 422 })
  } catch (error) {
    if (error instanceof ImportError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, ...(error.details ?? {}) },
        { status: STATUS_BY_CODE[error.code] ?? 400 }
      )
    }
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "document import failed" },
      { status: 500 }
    )
  }
}
