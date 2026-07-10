import { FsBrowseError, getDefaultBrowseRoot, listDirectories } from "@/lib/fs-browser"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("path")
  try {
    const listing = listDirectories(requested)
    return Response.json({ ok: true, ...listing })
  } catch (error) {
    if (error instanceof FsBrowseError) {
      return Response.json(
        { ok: false, error: error.message, code: error.code, default: getDefaultBrowseRoot() },
        { status: 400 }
      )
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to list directory" },
      { status: 500 }
    )
  }
}
