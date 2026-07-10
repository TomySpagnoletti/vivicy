import { createDirectory, FsBrowseError, getDefaultBrowseRoot } from "@/lib/fs-browser"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as {
      parent?: unknown
      name?: unknown
    } | null
    const created = createDirectory(
      typeof body?.parent === "string" ? body.parent : null,
      body?.name
    )
    return Response.json({ ok: true, path: created })
  } catch (error) {
    if (error instanceof FsBrowseError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, default: getDefaultBrowseRoot() },
        { status: 400 }
      )
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to create directory" },
      { status: 500 }
    )
  }
}
