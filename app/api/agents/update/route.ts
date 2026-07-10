import { z } from "zod"

import { getAgentsHealth } from "@/lib/agents-health"
import { runAgentUpdate, UnknownAgentError } from "@/lib/agents-update"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Validated against this closed enum here AND again inside runAgentUpdate — only an allow-listed, fixed command ever runs (no shell, no interpolation of request input).
const UpdateRequest = z.object({
  agent: z.enum(["claude", "codex"]),
})

// Vivicy is a local single-user tool, so this route may exec — but only the CLI's own allow-listed self-update command, never arbitrary input.
export async function POST(request: Request) {
  let parsed: { agent: "claude" | "codex" }
  try {
    const body: unknown = await request.json().catch(() => null)
    parsed = UpdateRequest.parse(body)
  } catch {
    return Response.json(
      { ok: false, error: "Body must be { agent: 'claude' | 'codex' }." },
      { status: 400 }
    )
  }

  try {
    const result = await runAgentUpdate(parsed.agent)
    // Re-detect AFTER the update (not before) so the response reflects the new version; detection is read-only (which/--version/auth-file reads), never runs the agent.
    const agents = getAgentsHealth()
    return Response.json({
      ok: result.ok,
      agent: result.agent,
      command: result.command,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
      agents,
    })
  } catch (error) {
    if (error instanceof UnknownAgentError) {
      return Response.json({ ok: false, error: error.message }, { status: 400 })
    }
    return Response.json(
      { ok: false, error: error instanceof Error ? error.message : "update failed" },
      { status: 500 }
    )
  }
}
