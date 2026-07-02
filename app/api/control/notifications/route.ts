import { dismissNotifications, readNotifications } from "@/lib/notifications"

// Reads the notification log as read-only display data (the app-side half of the
// G14 notifications verb; the `vivicy notifications` CLI reads the SAME file). Node
// runtime only (filesystem read/write). A missing/empty log is an empty list, not
// an error.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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

/**
 * Dismiss one or more notifications (G9's per-item X and "clear all"). Body is
 * `{ id: string }` (single dismiss — the notification's unique `id`; a legacy
 * line without one matches on its `ts` instead, see lib/notifications.ts) or
 * `{ all: true }` (clear all). Flips `dismissed: true` in place — see
 * lib/notifications.ts for why a rewrite, not a second append, is the chosen
 * mechanism. Always 200 with the count actually flipped; dismissing an
 * already-dismissed or unknown `id` is a harmless no-op (count 0), not an error.
 */
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
