import { ControlError, listChangeRequests } from "@/lib/control"

// Lists the change-request registry as read-only display data; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const { crs } = listChangeRequests()
    return Response.json({ ok: true, crs })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to list change requests" },
      { status: 500 }
    )
  }
}
