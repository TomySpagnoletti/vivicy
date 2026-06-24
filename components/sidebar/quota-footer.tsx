"use client"

import { useEffect, useState } from "react"

import type { AgentQuota } from "@/lib/control"
import { DEFAULT_SETTINGS, type AgentSettings, type AgentsSettings } from "@/lib/settings"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

/**
 * Map each dev-loop agent actor to the settings role that configures it and the
 * display order. The label + thinking level are DERIVED from those live settings
 * (see {@link friendlyModel}), never hardcoded — so editing settings updates the
 * footer.
 */
const AGENT_ROLE: Record<string, keyof AgentsSettings> = {
  claude: "implementer",
  codex: "reviewer",
}

/**
 * Friendly display name for a model id, derived from the configured model so the
 * footer reads "Opus 4.8" rather than the raw "claude-opus-4-8". Unknown ids
 * fall back to the raw model string (still honest, never fabricated).
 */
export function friendlyModel(model: string): string {
  const map: Record<string, string> = {
    "claude-opus-4-8": "Opus 4.8",
    "gpt-5.5-codex": "GPT 5.5",
  }
  return map[model] ?? model
}

interface QuotaState {
  agents: Record<string, AgentQuota>
}

/**
 * Honest per-agent quota footer.
 *
 * Driven by the live SSE status stream (the same `/api/status/stream` the
 * control bar uses), which now carries the dev-loop's `quota` block. For each
 * agent we show ONLY what is real:
 *   - model + thinking level
 *   - an available / throttled status Badge
 *   - a reset countdown when throttled and a reset time is known
 *
 * There is no non-interactive remaining-quota API in the claude/codex CLIs, so
 * we deliberately do NOT render a usage percentage or bar — that would be
 * fabricated. Until a leg is rate-limited, agents read "available".
 */
export function QuotaFooter({
  settings = DEFAULT_SETTINGS,
}: {
  settings?: AgentsSettings
}) {
  const [quota, setQuota] = useState<QuotaState | null>(null)

  useEffect(() => {
    const source = new EventSource("/api/status/stream")
    source.onmessage = (event) => {
      try {
        const next = JSON.parse(event.data) as {
          quota?: QuotaState
          error?: string
        }
        if (next.error) return
        setQuota(next.quota ?? { agents: {} })
      } catch {
        // Ignore malformed frames; keep the last good state.
      }
    }
    return () => source.close()
  }, [])

  const agents = quota?.agents ?? {}
  // Render in the known display order; fall back to any unknown agents after.
  const knownNames = Object.keys(AGENT_ROLE).filter((name) => name in agents)
  const extraNames = Object.keys(agents).filter((name) => !(name in AGENT_ROLE))
  const names = [...knownNames, ...extraNames]

  return (
    <div className="flex flex-col gap-2.5 px-3 py-3">
      <Separator />
      {names.length === 0 ? (
        <p className="text-xs text-muted-foreground">Agent quota status appears here once a run is active.</p>
      ) : (
        names.map((name) => {
          const role = AGENT_ROLE[name]
          return (
            <QuotaRow
              key={name}
              name={name}
              agent={agents[name]}
              config={role ? settings[role] : undefined}
            />
          )
        })
      )}
    </div>
  )
}

function QuotaRow({
  name,
  agent,
  config,
}: {
  name: string
  agent: AgentQuota
  config?: AgentSettings
}) {
  // Prefer the live configured model + thinking level; fall back to the model
  // the run actually reported (quota state) or the agent name, never a hardcode.
  const label = config ? friendlyModel(config.model) : friendlyModel(agent.model ?? name)
  const thinking = config?.effort
  const throttled = agent.status === "throttled"

  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="truncate font-medium text-foreground">
        {label}
        {thinking ? <span className="text-muted-foreground"> · {thinking}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {throttled ? <ResetCountdown resetAt={agent.reset_at} /> : null}
        <Badge variant={throttled ? "destructive" : "secondary"}>
          {throttled ? "throttled" : "available"}
        </Badge>
      </div>
    </div>
  )
}

/**
 * "resets in 2h14" countdown. The label is derived during render from the
 * `resetAt` prop and a ticking `nowMs` clock (advanced each minute), so we never
 * setState synchronously inside an effect — only the clock tick updates state.
 * Hidden when the reset time is unknown or already past.
 */
function ResetCountdown({ resetAt }: { resetAt: string | null }) {
  const [nowMs, setNowMs] = useState(() => Date.now())

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])

  const label = formatReset(resetAt, nowMs)
  if (!label) return null
  return <span className="tabular-nums text-muted-foreground">{label}</span>
}

/** ISO reset time -> "resets in 2h14" / "resets in 45m"; null when past/unknown. */
export function formatReset(resetAt: string | null, nowMs: number): string | null {
  if (!resetAt) return null
  const ms = new Date(resetAt).getTime() - nowMs
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMinutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return `resets in ${hours}h${String(minutes).padStart(2, "0")}`
  }
  return `resets in ${minutes}m`
}
