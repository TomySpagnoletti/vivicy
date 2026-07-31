import { z } from "zod"

import { getAgentsHealth } from "@/lib/agents-health"
import { runAgentUpdate, UnknownAgentError } from "@/lib/agents-update"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Never widen this closed enum: runAgentUpdate re-validates it, and no request input ever reaches a command string.
const UpdateRequest = z.object({
  agent: z.enum(["claude", "codex"]),
})

export async function POST(request: Request) {
  let parsed: { agent: "claude" | "codex" }
  try {
    const body: unknown = await request.json().catch(() => null)
    parsed = UpdateRequest.parse(body)
  } catch {
    return Response.json({ ok: false, error: "Body must be { agent: 'claude' | 'codex' }." }, { status: 400 })
  }

  try {
    const result = await runAgentUpdate(parsed.agent)
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
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "update failed" }, { status: 500 })
  }
}
