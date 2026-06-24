import { getAgentsHealth } from "@/lib/agents-health"

// Probes the local CLIs (PATH + version) and reads auth files; Node only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Agent CLI health (R11): for each of Claude Code and the Codex CLI, whether it
 * is present on PATH, its version, and an honest auth signal (true/false, or null
 * when no clean side-effect-free signal exists). Detection never runs the agent
 * itself — only `which`, `--version`, and reads of the documented auth files.
 */
export async function GET() {
  return Response.json({ ok: true, agents: getAgentsHealth() })
}
