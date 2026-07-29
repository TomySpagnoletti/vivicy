import { ControlError } from "@/lib/control"
import { ImportError } from "@/lib/import-docs"
import { getSpawner } from "@/lib/spawner"
import { IMPORT_STATUS_BY_CODE, readUploadEntries } from "@/lib/upload-form"
import { decideCardImport } from "@/lib/vivi"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
    return Response.json({ ok: false, error: "sessionId, cardId, and actionId are required strings" }, { status: 400 })
  }

  try {
    const entries = await readUploadEntries(form)
    const result = await decideCardImport(getSpawner(), { sessionId, cardId, actionId, entries })
    return Response.json(result, { status: result.ok ? 200 : 422 })
  } catch (error) {
    if (error instanceof ImportError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, ...(error.details ?? {}) },
        { status: IMPORT_STATUS_BY_CODE[error.code] ?? 400 }
      )
    }
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "document import failed" }, { status: 500 })
  }
}
