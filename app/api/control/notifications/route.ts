import { readNotifications } from "@/lib/notifications"

// Reads the notification log as read-only display data (the app-side half of the
// G14 notifications verb; the `vivicy notifications` CLI reads the SAME file). Node
// runtime only (filesystem read). A missing/empty log is an empty list, not an error.
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
