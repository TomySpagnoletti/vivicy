import { ControlError, getCycles } from "@/lib/control"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET() {
  try {
    return Response.json({ ok: true, cycles: getCycles() })
  } catch (error) {
    if (error instanceof ControlError) {
      return Response.json({ ok: false, error: error.message, code: error.code }, { status: 422 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to read cycles" },
      { status: 500 }
    )
  }
}
