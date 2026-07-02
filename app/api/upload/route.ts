import { stageUpload, UploadError, type UploadEntry } from "@/lib/upload"

// Writes the staged upload to the local filesystem; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * STAGE an external doc upload (G1, S1-import). The body is multipart/form-data
 * with a repeated `files` field (the uploaded File entries) and a parallel `paths`
 * field the client fills to preserve each file's relative path (`paths[i]` is the
 * relative path of `files[i]`, "" for a bare file). Accepts .md/.markdown/.txt/
 * .doc/.docx/.yml/.yaml/.zip; a `.zip` is expanded into the staging `raw/` set.
 * Each staged file is classified canonical|spike|map|unknown. The response echoes
 * the new `stagingId` and the classified `staged` set — nothing is placed here;
 * verification (/verify) and placement (/apply) are separate steps.
 */
export async function POST(request: Request) {
  try {
    const form = await request.formData()
    const files = form.getAll("files")
    const paths = form.getAll("paths")

    const entries: UploadEntry[] = []
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i]
      if (!(file instanceof File)) continue
      const rel = typeof paths[i] === "string" ? (paths[i] as string) : ""
      const bytes = new Uint8Array(await file.arrayBuffer())
      entries.push({ rel, name: file.name, bytes })
    }

    const result = stageUpload(entries)
    return Response.json({ ok: true, stagingId: result.stagingId, staged: result.staged })
  } catch (error) {
    return uploadErrorResponse(error, "failed to stage upload")
  }
}

/**
 * Map an {@link UploadError} to its HTTP status per the G1 contract, or a generic
 * 500 for an unexpected error. Shared by all three upload routes so the status
 * codes stay identical everywhere: a bad request is 400, a conflict (unexpandable
 * zip / not-verified / collision) is 409, a missing target is 422.
 */
export function uploadErrorResponse(error: unknown, fallback: string): Response {
  if (error instanceof UploadError) {
    const status = uploadStatus(error.code)
    return Response.json(
      { ok: false, error: error.message, code: error.code, ...(error.details ?? {}) },
      { status }
    )
  }
  return Response.json(
    { ok: false, error: error instanceof Error ? error.message : fallback },
    { status: 500 }
  )
}

function uploadStatus(code: UploadError["code"]): number {
  switch (code) {
    case "zip_unsupported":
    case "not_verified":
    case "would_overwrite":
      return 409
    case "bad_staging":
      return 404
    default:
      return 400
  }
}
