import { FsBrowseError, getDefaultBrowseRoot, listDirectories } from "@/lib/fs-browser"

// Lists local directories for the project picker; filesystem access, Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Browse the local filesystem for the project picker (R10): the immediate
 * subdirectories of `?path=` (default: the user's home dir), plus a parent-up
 * pointer. Path-safety (absolute, existing, canonical directory only) is enforced
 * in {@link listDirectories}; a rejected path returns 400 with a typed code.
 */
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
