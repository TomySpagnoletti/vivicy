import {
  applyLayoutSave,
  LayoutSaveError,
  validateLayoutSavePayload,
} from "@/lib/map-layout-save"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function statusFor(code: LayoutSaveError["code"]): number {
  switch (code) {
    case "read_only":
      return 403
    case "no_target":
    case "no_map":
      return 404
    case "invalid_payload":
    case "patch_failed":
      return 400
    case "regen_failed":
      return 422
    default:
      return 500
  }
}

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      { ok: false, error: "Request body must be valid JSON.", code: "invalid_payload" },
      { status: 400 }
    )
  }

  try {
    const payload = validateLayoutSavePayload(body)
    await applyLayoutSave({ payload })
    return Response.json({ ok: true })
  } catch (error) {
    if (error instanceof LayoutSaveError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code },
        { status: statusFor(error.code) }
      )
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "layout save failed" },
      { status: 500 }
    )
  }
}
