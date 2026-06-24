import { readSettings, writeSettings } from "@/lib/settings-store"

// Reads/writes the JSON settings store under the Vivicy runtime dir; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Current per-agent model + thinking-level settings (defaults if unset). */
export async function GET() {
  return Response.json({ ok: true, settings: readSettings() })
}

/**
 * Persist new settings. The body is normalized + validated (effort checked
 * against the provider's allowed levels, provider fixed per role); the response
 * echoes the validated document actually written, never the raw request.
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    const settings = writeSettings(body)
    return Response.json({ ok: true, settings })
  } catch (error) {
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to save settings" },
      { status: 500 }
    )
  }
}
