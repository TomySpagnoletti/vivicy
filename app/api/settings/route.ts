import { readSettingsState, saveSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

class SettingsValidationError extends Error {}

function parseSettingsBody(body: unknown): object | null {
  if (body === null) return null
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new SettingsValidationError("settings body must be a JSON object")
  }
  return body
}

export async function GET() {
  return Response.json({ ok: true, ...readSettingsState(getTargetRoot()) })
}

export async function PUT(request: Request) {
  try {
    const body = await request.json().catch(() => null)
    const state = saveSettings(getTargetRoot(), parseSettingsBody(body))
    return Response.json({ ok: true, ...state })
  } catch (error) {
    if (error instanceof SettingsValidationError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 })
    }
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "failed to save settings" }, { status: 500 })
  }
}
