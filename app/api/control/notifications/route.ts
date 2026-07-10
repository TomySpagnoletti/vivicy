import { dismissNotifications, readNotifications } from "@/lib/notifications"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// The `vivicy notifications` CLI reads this same log file; a missing/empty log is an empty list here, not an error.
export async function GET() {
  try {
    return Response.json({ ok: true, notifications: readNotifications() })
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read notifications" },
      { status: 500 }
    )
  }
}

// A notification without an id (legacy line) is matched by its ts instead; dismissing an already-dismissed or unknown id is a harmless no-op, not an error.
export async function POST(request: Request) {
  let body: { id?: unknown; all?: unknown }
  try {
    body = (await request.json()) as { id?: unknown; all?: unknown }
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 })
  }
  if (body.all === true) {
    return Response.json({ ok: true, dismissed: dismissNotifications() })
  }
  if (typeof body.id !== "string" || body.id.length === 0) {
    return Response.json(
      { ok: false, error: "body must be { id: string } or { all: true }" },
      { status: 400 }
    )
  }
  try {
    const dismissed = dismissNotifications([body.id])
    return Response.json({ ok: true, dismissed })
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to dismiss notification" },
      { status: 500 }
    )
  }
}
