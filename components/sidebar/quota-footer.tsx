"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"

import type { AgentQuota, QuotaWindow } from "@/lib/control"
import { DEFAULT_SETTINGS, type AgentSettings, type AgentsSettings } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
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

/** The two rolling windows the footer surfaces, in display order. */
const WINDOWS: Array<{ key: "5h" | "weekly"; short: string; long: string }> = [
  { key: "5h", short: "5h", long: "5-hour" },
  { key: "weekly", short: "wk", long: "Weekly" },
]

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

const COLLAPSE_KEY = "vivicy:quota-footer-collapsed"

/** Read the persisted collapse state (default collapsed). Safe on the server. */
function readCollapsed(): boolean {
  if (typeof window === "undefined") return true
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) !== "false"
  } catch {
    return true
  }
}

/**
 * Honest, collapsible per-agent quota footer.
 *
 * Driven by the live SSE status stream (the same `/api/status/stream` the
 * control bar uses), which carries the dev-loop's `quota` block — including the
 * REAL per-window usage extracted from each provider's transcript:
 *   - Codex  -> real % for the 5h AND weekly windows (rollout `rate_limits`)
 *   - Claude -> a real 5h reset, but NO percentage (stream-json exposes none)
 *
 * Where a provider exposes no percentage we render "—", never a fabricated
 * number. Collapsed shows one compact line per agent; expanded shows a Progress
 * bar + reset countdown per window. The collapse state is persisted.
 */
export function QuotaFooter({
  settings = DEFAULT_SETTINGS,
}: {
  settings?: AgentsSettings
}) {
  const [quota, setQuota] = useState<QuotaState | null>(null)
  // Restore the persisted collapse state via a lazy initializer (no
  // setState-in-effect); written on toggle.
  const [collapsed, setCollapsed] = useState(readCollapsed)

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

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev
      try {
        window.localStorage.setItem(COLLAPSE_KEY, String(next))
      } catch {
        // best-effort persistence
      }
      return next
    })
  }

  const agents = quota?.agents ?? {}
  // Render in the known display order; fall back to any unknown agents after.
  const knownNames = Object.keys(AGENT_ROLE).filter((name) => name in agents)
  const extraNames = Object.keys(agents).filter((name) => !(name in AGENT_ROLE))
  const names = [...knownNames, ...extraNames]
  const hasAgents = names.length > 0

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <Separator />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">Quota</p>
        {hasAgents ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "Expand quota details" : "Collapse quota details"}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </Button>
        ) : null}
      </div>

      {!hasAgents ? (
        <p className="text-xs text-muted-foreground">
          Agent quota status appears here once a run is active.
        </p>
      ) : collapsed ? (
        <div className="flex flex-col gap-1">
          {names.map((name) => (
            <CollapsedRow
              key={name}
              agent={agents[name]}
              config={AGENT_ROLE[name] ? settings[AGENT_ROLE[name]] : undefined}
              fallbackName={name}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {names.map((name) => (
            <ExpandedAgent
              key={name}
              agent={agents[name]}
              config={AGENT_ROLE[name] ? settings[AGENT_ROLE[name]] : undefined}
              fallbackName={name}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** "Opus 4.8" label derived from settings, falling back to the reported model. */
function agentLabel(config: AgentSettings | undefined, agent: AgentQuota, fallbackName: string): string {
  return config ? friendlyModel(config.model) : friendlyModel(agent.model ?? fallbackName)
}

/** A window's percentage as "38%" or "—" when the provider exposes no number. */
function pctText(win: QuotaWindow | undefined): string {
  return win && typeof win.used_pct === "number" ? `${Math.round(win.used_pct)}%` : "—"
}

/**
 * Collapsed: one compact line per agent — model + just the window percentages,
 * e.g. "Opus 4.8  5h 38% · wk 12%" (or "—" per window when unknown).
 */
function CollapsedRow({
  agent,
  config,
  fallbackName,
}: {
  agent: AgentQuota
  config?: AgentSettings
  fallbackName: string
}) {
  const label = agentLabel(config, agent, fallbackName)
  const windows = agent.windows ?? {}
  const throttled = agent.status === "throttled"
  return (
    <div className="flex items-baseline justify-between gap-2 text-xs">
      <span className="truncate font-medium text-foreground">{label}</span>
      <span
        className={cn(
          "shrink-0 tabular-nums",
          throttled ? "font-medium text-destructive" : "text-muted-foreground"
        )}
      >
        {WINDOWS.map((w, i) => (
          <span key={w.key}>
            {i > 0 ? " · " : ""}
            {w.short} {pctText(windows[w.key])}
          </span>
        ))}
      </span>
    </div>
  )
}

/**
 * Expanded: model name + thinking level, then a Progress bar per window with its
 * % + reset countdown. Throttled agents are highlighted.
 */
function ExpandedAgent({
  agent,
  config,
  fallbackName,
}: {
  agent: AgentQuota
  config?: AgentSettings
  fallbackName: string
}) {
  const label = agentLabel(config, agent, fallbackName)
  const thinking = config?.effort
  const throttled = agent.status === "throttled"
  const windows = agent.windows ?? {}

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium text-foreground">
          {label}
          {thinking ? <span className="text-muted-foreground"> · {thinking}</span> : null}
        </span>
        <Badge variant={throttled ? "destructive" : "secondary"}>
          {throttled ? "throttled" : "available"}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        {WINDOWS.map((w) => (
          <WindowBar key={w.key} label={w.long} win={windows[w.key]} throttled={throttled} />
        ))}
      </div>
    </div>
  )
}

/**
 * One window's row: label, percentage (or "—"), a Progress bar (only when a real
 * percentage exists), and a reset countdown when known. Honest by construction —
 * no bar and no number when the provider exposes nothing.
 */
function WindowBar({
  label,
  win,
  throttled,
}: {
  label: string
  win: QuotaWindow | undefined
  throttled: boolean
}) {
  const hasPct = win && typeof win.used_pct === "number"
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <div className="flex items-center gap-1.5">
          <ResetCountdown resetAt={win?.reset_at ?? null} />
          <span
            className={cn(
              "tabular-nums",
              throttled ? "font-medium text-destructive" : "text-foreground"
            )}
          >
            {pctText(win)}
          </span>
        </div>
      </div>
      {hasPct ? <Progress value={win!.used_pct ?? 0} /> : null}
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
