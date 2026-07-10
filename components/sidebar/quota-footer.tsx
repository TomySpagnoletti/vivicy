"use client"

import { useEffect, useState } from "react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { createTranslator, useTranslations } from "next-intl"

import type { AgentQuota, QuotaWindow } from "@/lib/control"
import { LOCALE } from "@/lib/i18n"
import { DEFAULT_SETTINGS, type AgentSettings, type AgentsSettings, type Role } from "@/lib/settings"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import sidebarMessages from "@/messages/en/sidebar.json"

const AGENT_ROLE: Record<string, Role> = {
  claude: "implementer",
  codex: "reviewer",
}

const WINDOW_KEYS: Array<{
  key: "5h" | "weekly"
  shortKey: "windowShort5h" | "windowShortWeekly"
  longKey: "windowLong5h" | "windowLongWeekly"
}> = [
  { key: "5h", shortKey: "windowShort5h", longKey: "windowLong5h" },
  { key: "weekly", shortKey: "windowShortWeekly", longKey: "windowLongWeekly" },
]

export function friendlyModel(model: string): string {
  const map: Record<string, string> = {
    "claude-opus-4-8": "Opus 4.8",
    "gpt-5.5": "GPT 5.5",
  }
  return map[model] ?? model
}

interface QuotaState {
  agents: Record<string, AgentQuota>
}

const COLLAPSE_KEY = "vivicy:quota-footer-collapsed"

function readCollapsed(): boolean {
  if (typeof window === "undefined") return true
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) !== "false"
  } catch {
    return true
  }
}

export function QuotaFooter({
  settings = DEFAULT_SETTINGS,
}: {
  settings?: AgentsSettings
}) {
  const t = useTranslations("sidebar.quotaFooter")
  const [quota, setQuota] = useState<QuotaState | null>(null)
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
      }
      return next
    })
  }

  const agents = quota?.agents ?? {}
  const knownNames = Object.keys(AGENT_ROLE).filter((name) => name in agents)
  const extraNames = Object.keys(agents).filter((name) => !(name in AGENT_ROLE))
  const names = [...knownNames, ...extraNames]
  const hasAgents = names.length > 0

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <Separator />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t("title")}</p>
        {hasAgents ? (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? t("expandAriaLabel") : t("collapseAriaLabel")}
            aria-expanded={!collapsed}
            onClick={toggleCollapsed}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </Button>
        ) : null}
      </div>

      {!hasAgents ? (
        <p className="text-xs text-muted-foreground">{t("emptyState")}</p>
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

function agentLabel(config: AgentSettings | undefined, agent: AgentQuota, fallbackName: string): string {
  return config ? friendlyModel(config.model) : friendlyModel(agent.model ?? fallbackName)
}

function pctText(t: ReturnType<typeof useTranslations<"sidebar.quotaFooter">>, win: QuotaWindow | undefined): string {
  return win && typeof win.used_pct === "number" ? `${Math.round(win.used_pct)}%` : t("unknownPct")
}

function CollapsedRow({
  agent,
  config,
  fallbackName,
}: {
  agent: AgentQuota
  config?: AgentSettings
  fallbackName: string
}) {
  const t = useTranslations("sidebar.quotaFooter")
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
        {WINDOW_KEYS.map((w, i) => (
          <span key={w.key}>
            {i > 0 ? " · " : ""}
            {t("collapsedWindow", { short: t(w.shortKey), pct: pctText(t, windows[w.key]) })}
          </span>
        ))}
      </span>
    </div>
  )
}

function ExpandedAgent({
  agent,
  config,
  fallbackName,
}: {
  agent: AgentQuota
  config?: AgentSettings
  fallbackName: string
}) {
  const t = useTranslations("sidebar.quotaFooter")
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
          {throttled ? t("throttled") : t("available")}
        </Badge>
      </div>
      <div className="flex flex-col gap-1.5">
        {WINDOW_KEYS.map((w) => (
          <WindowBar key={w.key} label={t(w.longKey)} win={windows[w.key]} throttled={throttled} />
        ))}
      </div>
    </div>
  )
}

function WindowBar({
  label,
  win,
  throttled,
}: {
  label: string
  win: QuotaWindow | undefined
  throttled: boolean
}) {
  const t = useTranslations("sidebar.quotaFooter")
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
            {pctText(t, win)}
          </span>
        </div>
      </div>
      {hasPct ? <Progress value={win!.used_pct ?? 0} /> : null}
    </div>
  )
}

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

const formatResetT = createTranslator({ locale: LOCALE, messages: sidebarMessages, namespace: "quotaFooter" })

export function formatReset(resetAt: string | null, nowMs: number): string | null {
  if (!resetAt) return null
  const ms = new Date(resetAt).getTime() - nowMs
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMinutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours > 0) {
    return formatResetT("resetInHours", { hours, minutes: String(minutes).padStart(2, "0") })
  }
  return formatResetT("resetInMinutes", { minutes })
}
