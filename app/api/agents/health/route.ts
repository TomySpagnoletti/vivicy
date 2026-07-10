import { getAgentsHealth } from "@/lib/agents-health"
import type { AgentsHealth } from "@/lib/agents-health-types"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

let memo: AgentsHealth | null = null

// Detection never runs the agent itself — only `which`, `--version`, and reads of documented auth files.
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1"
  if (fresh || memo === null) memo = getAgentsHealth()
  return Response.json({ ok: true, agents: memo })
}
