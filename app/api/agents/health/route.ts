import { getAgentsHealth } from "@/lib/agents-health"
import type { AgentsHealth } from "@/lib/agents-health-types"

// Probes the local CLIs (PATH + version) and reads auth files; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Once-per-server-process memo (W4a): the probe shells out (`command -v`,
 * `--version`, macOS `security`) and CLI presence/auth changes rarely, so the
 * first GET's snapshot is served to every later caller. `?fresh=1` re-probes on
 * demand — the gate's "Check again" and the setup dialog's on-open reload use it
 * so a just-installed CLI is detected without restarting the server.
 */
let memo: AgentsHealth | null = null

/**
 * Agent CLI health (R11): for each of Claude Code and the Codex CLI, whether it
 * is present on PATH, its version, and an honest auth signal (true/false, or null
 * when no clean side-effect-free signal exists). Detection never runs the agent
 * itself — only `which`, `--version`, and reads of the documented auth files.
 */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1"
  if (fresh || memo === null) memo = getAgentsHealth()
  return Response.json({ ok: true, agents: memo })
}
