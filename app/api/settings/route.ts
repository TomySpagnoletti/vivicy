import { readSettings, writeSettings } from "@/lib/settings-store"

// Reads/writes the JSON settings store under the Vivicy runtime dir; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// A client error: the request body is the wrong shape for a settings document.
// Mapped to 400 so a bad request is never reported as a server failure (500).
class SettingsValidationError extends Error {}

// The store coerces any object (or null) into a complete document, but a JSON
// primitive or array is not a settings object — reject it as a client error.
function parseSettingsBody(body: unknown): object | null {
  if (body === null) return null
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new SettingsValidationError("settings body must be a JSON object")
  }
  return body
}

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
    const settings = writeSettings(parseSettingsBody(body))
    return Response.json({ ok: true, settings })
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "failed to save settings" },
      { status: 500 }
    )
  }
}
