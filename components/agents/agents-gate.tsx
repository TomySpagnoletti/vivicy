"use client"

import { useCallback, useState } from "react"
import { Loader2, RefreshCw, TerminalSquare, TriangleAlert, X } from "lucide-react"
import { useTranslations } from "next-intl"

import { BRAND } from "@/lib/brand"
import {
  AGENT_GUIDANCE,
  type AgentHealth,
  type AgentKey,
  type AgentsHealth,
} from "@/lib/agents-health-types"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { AgentStatusBadge, CopyableCommand } from "@/components/agents/agent-status"

/** The gate blocks only on a MISSING binary — auth problems get the banner instead. */
export function agentsGateBlocked(health: AgentsHealth): boolean {
  return !health.claude.present || !health.codex.present
}

/** The agents that are installed but verifiably signed out (the banner's subjects). */
export function unauthenticatedAgents(health: AgentsHealth): AgentKey[] {
  return (["claude", "codex"] as AgentKey[]).filter(
    (key) => health[key].present && health[key].authenticated === false
  )
}

/**
 * The prerequisite gate (W4a): a full-screen blocking screen shown INSTEAD of the
 * app whenever either agent CLI binary is missing from PATH — Vivicy runs
 * entirely on the two CLIs, so nothing downstream (map, onboarding, Vivi) can
 * work without them. Per-agent status rows, the exact install command from
 * {@link AGENT_GUIDANCE} as a copy-only block, and a "Check again" that re-probes
 * with `?fresh=1` (bypassing the route's once-per-process memo) and hands the
 * fresh snapshot back up so the page can lift the gate the moment both are found.
 */
export function AgentsGate({
  health,
  onHealth,
}: {
  health: AgentsHealth
  /** Receives the re-probed snapshot after "Check again". */
  onHealth: (health: AgentsHealth) => void
}) {
  const t = useTranslations("agents")
  const [checking, setChecking] = useState(false)

  const recheck = useCallback(async () => {
    setChecking(true)
    try {
      const res = await fetch("/api/agents/health?fresh=1", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as { agents?: AgentsHealth }
      if (body.agents) onHealth(body.agents)
    } catch {
      // Best-effort: a failed re-probe keeps the last snapshot; the user can retry.
    } finally {
      setChecking(false)
    }
  }, [onHealth])

  // items-start + m-auto (not items-center) on the scroller: centering clips the
  // TOP of content taller than the viewport unreachably (short windows, 200% zoom);
  // auto margins center only when space allows.
  return (
    <div className="flex h-svh w-full items-start justify-center overflow-y-auto p-6">
      <div className="m-auto flex w-full max-w-xl flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
          >
            <TerminalSquare className="size-5" />
          </span>
          <h1 className="text-lg font-medium text-foreground">{t("gate.title")}</h1>
          <p className="max-w-lg text-sm text-muted-foreground">
            {t("gate.description", { brandName: BRAND.name })}
          </p>
        </div>

        {(["claude", "codex"] as AgentKey[]).map((key) => (
          <GateAgentCard key={key} agentKey={key} health={health[key]} />
        ))}

        <div className="flex justify-center">
          <Button size="sm" disabled={checking} onClick={() => void recheck()}>
            {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {checking ? t("gate.checking") : t("gate.checkAgain")}
          </Button>
        </div>
      </div>
    </div>
  )
}

/** One agent's status row on the gate, with the install command when it is missing. */
function GateAgentCard({ agentKey, health }: { agentKey: AgentKey; health: AgentHealth }) {
  const t = useTranslations("agents")
  const guidance = AGENT_GUIDANCE[agentKey]

  return (
    <Card className="gap-3 [--card-spacing:--spacing(4)]" data-agent={agentKey}>
      <CardHeader className="gap-1">
        <CardTitle className="flex items-center gap-2">
          {guidance.label}
          {health.version ? (
            <span className="text-xs font-normal text-muted-foreground">· {health.version}</span>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <AgentStatusBadge
            ok={health.present}
            okLabel={t("installed")}
            badLabel={t("notInstalled")}
            unknown={false}
          />
          {health.present ? (
            <AgentStatusBadge
              ok={health.authenticated === true}
              okLabel={t("authenticated")}
              badLabel={t("notSignedIn")}
              unknown={health.authenticated === null}
              unknownLabel={t("authUnknown")}
            />
          ) : null}
        </div>
        {!health.present ? (
          <CopyableCommand
            hint={guidance.installHint}
            command={guidance.installCommand}
            label={t("install", { label: guidance.label })}
          />
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * The non-blocking half of W4a: an agent that is INSTALLED but verifiably signed
 * out gets a dismissible amber banner over the normal app (never a gate — the map
 * and onboarding still work; only the agent legs would refuse). One line per
 * signed-out agent with its exact auth command.
 */
export function AgentsAuthBanner({ health }: { health: AgentsHealth }) {
  const t = useTranslations("agents")
  const [dismissed, setDismissed] = useState(false)
  const signedOut = unauthenticatedAgents(health)
  if (dismissed || signedOut.length === 0) return null

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-30 flex justify-center px-2">
      <Alert className="pointer-events-auto w-full max-w-xl border-warning/50 shadow-md">
        <TriangleAlert className="text-warning" />
        <AlertTitle>{t("authBanner.title")}</AlertTitle>
        <AlertDescription>
          <ul className="flex flex-col gap-0.5">
            {signedOut.map((key) => (
              <li key={key}>
                {t.rich("authBanner.agentLine", {
                  label: AGENT_GUIDANCE[key].label,
                  authCommand: AGENT_GUIDANCE[key].authCommand,
                  code: (chunks) => <code className="text-foreground">{chunks}</code>,
                })}
              </li>
            ))}
          </ul>
        </AlertDescription>
        <AlertAction>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("authBanner.dismissAriaLabel")}
            onClick={() => setDismissed(true)}
          >
            <X />
          </Button>
        </AlertAction>
      </Alert>
    </div>
  )
}
