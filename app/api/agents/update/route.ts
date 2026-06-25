import { z } from "zod"

import { getAgentsHealth } from "@/lib/agents-health"
import { runAgentUpdate, UnknownAgentError } from "@/lib/agents-update"

// Execs an allow-listed CLI self-update; Node runtime only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Request body: which agent to update. The agent name is validated to the closed
 * set here AND again inside {@link runAgentUpdate}; only an allow-listed, fixed
 * command ever runs (no shell, no interpolation of request input).
 */
const UpdateRequest = z.object({
  agent: z.enum(["claude", "codex"]),
})

/**
 * Agent CLI self-update (R11 follow-on). Vivicy is a LOCAL single-user tool, so
 * the server may exec — but ONLY the CLI's own built-in updater for the named
 * agent (`claude update` / `codex update`), via a closed allow-list. Captures the
 * (capped) output + exit code and re-runs health detection so the caller can show
 * the fresh version. An unknown agent is rejected before anything runs.
 */
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
    // Re-detect AFTER the update so the modal reflects the new version. Detection
    // is read-only (which/--version/auth-file reads), never runs the agent.
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
