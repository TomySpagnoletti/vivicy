import { createDirectory, FsBrowseError, getDefaultBrowseRoot } from "@/lib/fs-browser"

// Creates a directory on the local filesystem for the project picker; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Create a new folder inside the currently-browsed directory (R10 helper). The
 * body is `{ parent, name }`: `parent` must be an absolute, existing, canonical
 * directory (resolved through the same path-safety chokepoint as the browser),
 * and `name` a single validated path segment (`[A-Za-z0-9 ._-]`, no separators,
 * no traversal, no absolute path). Path-safety lives in
 * {@link createDirectory}; a rejected request returns 400 with a typed code.
 * The response echoes the created absolute path so the client can refresh the
 * listing and navigate into it.
 */
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
