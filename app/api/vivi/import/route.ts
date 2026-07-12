import { ControlError } from "@/lib/control"
import { ImportError } from "@/lib/import-docs"
import { IMPORT_STATUS_BY_CODE, readUploadEntries } from "@/lib/upload-form"
import { importDocsIntoSession } from "@/lib/vivi"

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

  try {
    const entries = await readUploadEntries(form)
    const result = await importDocsIntoSession({
      sessionId: typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined,
      entries,
    })
    return Response.json(result, { status: 200 })
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
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "document import failed" },
      { status: 500 }
    )
  }
}
