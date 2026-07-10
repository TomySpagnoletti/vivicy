import { stageUpload, UploadError, type UploadEntry } from "@/lib/upload"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
