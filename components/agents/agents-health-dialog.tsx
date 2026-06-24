"use client"

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, Copy, HelpCircle, Loader2, XCircle } from "lucide-react"
import { toast } from "sonner"

import {
  AGENT_GUIDANCE,
  type AgentHealth,
  type AgentKey,
  type AgentsHealth,
} from "@/lib/agents-health-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Separator } from "@/components/ui/separator"

type ChipState = "ok" | "warn" | "loading"

/** Overall chip state: green only when BOTH agents are present and authed. */
function overallState(health: AgentsHealth | null): ChipState {
  if (!health) return "loading"
  const ready = (a: AgentHealth) => a.present && a.authenticated === true
  return ready(health.claude) && ready(health.codex) ? "ok" : "warn"
}

/**
 * Agent-CLI setup surface (R11). A status chip in the sidebar header that is
 * green when both Claude Code and the Codex CLI are present + authenticated, and
 * amber otherwise; clicking it opens a dialog detailing each CLI's presence,
 * version, and auth, with copyable install/login guidance.
 *
 * Honest by construction: a `null` auth signal renders as "unknown", never as a
 * green "authenticated". The chip is amber whenever an agent isn't verifiably
 * ready, since the dev-loop cannot run without both.
 */
export function AgentsHealthDialog({
  onWarning,
}: {
  /** Called once per load with a human warning when an agent isn't ready. */
  onWarning?: (message: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [health, setHealth] = useState<AgentsHealth | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/agents/health", { cache: "no-store" })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        agents?: AgentsHealth
      }
      if (body.agents) {
        setHealth(body.agents)
        const warning = warningFor(body.agents)
        if (warning) onWarning?.(warning)
      }
    } catch {
      // Leave the chip in its loading-amber state; the dialog can be retried.
    } finally {
      setLoading(false)
    }
  }, [onWarning])

  // Load once on mount (drives the chip + the one-time warning); reload on open
  // so the dialog reflects a CLI the user just installed/logged into. The state
  // writes live inside `load`'s async body, not the effect body.
  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])
  useEffect(() => {
    if (!open) return
    void (async () => {
      await load()
    })()
  }, [open, load])

  const state = overallState(health)

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          aria-label="Agent CLI status"
          data-agents-state={state}
          className="gap-1.5"
        >
          <span
            aria-hidden
            className={`size-1.5 rounded-full ${
              state === "ok"
                ? "bg-primary"
                : state === "loading"
                  ? "bg-muted-foreground"
                  : "bg-destructive"
            }`}
          />
          Agents
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent CLIs</DialogTitle>
          <DialogDescription>
            The dev-loop needs both the Claude Code and Codex CLIs installed and
            signed in. Detection is read-only — it never runs the agents.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {(["claude", "codex"] as AgentKey[]).map((key) => (
            <AgentCard
              key={key}
              agentKey={key}
              health={health?.[key] ?? null}
              loading={loading && !health}
            />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/** Per-agent detail card with presence/version/auth + conditional guidance. */
function AgentCard({
  agentKey,
  health,
  loading,
}: {
  agentKey: AgentKey
  health: AgentHealth | null
  loading: boolean
}) {
  const guidance = AGENT_GUIDANCE[agentKey]
  const present = health?.present ?? false
  const auth = health?.authenticated ?? null

  return (
    <fieldset className="flex flex-col gap-2 border border-border p-3">
      <legend className="flex items-center gap-2 px-1 text-xs font-medium text-foreground">
        {guidance.label}
        {health?.version ? (
          <span className="font-normal text-muted-foreground">{health.version}</span>
        ) : null}
      </legend>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking…
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge
            ok={present}
            okLabel="Installed"
            badLabel="Not found"
            unknown={false}
          />
          <StatusBadge
            ok={auth === true}
            okLabel="Authenticated"
            badLabel="Not signed in"
            unknown={auth === null}
            unknownLabel="Auth unknown"
          />
        </div>
      )}

      {/* Guidance: install command when absent; auth command when present-not-authed. */}
      {!loading && !present ? (
        <Guidance
          hint={guidance.installHint}
          command={guidance.installCommand}
          label={`Install ${guidance.label}`}
        />
      ) : null}
      {!loading && present && auth === false ? (
        <Guidance hint={guidance.authHint} command={guidance.authCommand} label="Sign in" />
      ) : null}
      {!loading && present && auth === null ? (
        <p className="text-xs text-muted-foreground">
          No clean signal to confirm sign-in (e.g. credentials stored in the macOS
          Keychain). If the dev-loop reports auth errors, run{" "}
          <code className="text-foreground">{guidance.authCommand}</code>.
        </p>
      ) : null}
    </fieldset>
  )
}

/** A present/authenticated badge with an honest "unknown" variant. */
function StatusBadge({
  ok,
  okLabel,
  badLabel,
  unknown,
  unknownLabel,
}: {
  ok: boolean
  okLabel: string
  badLabel: string
  unknown: boolean
  unknownLabel?: string
}) {
  if (unknown) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <HelpCircle className="size-3" />
        {unknownLabel ?? "Unknown"}
      </Badge>
    )
  }
  return (
    <Badge variant="outline" className="gap-1">
      {ok ? (
        <CheckCircle2 className="size-3 text-primary" />
      ) : (
        <XCircle className="size-3 text-destructive" />
      )}
      {ok ? okLabel : badLabel}
    </Badge>
  )
}

/** A copyable command block with a one-line hint. Never auto-runs the command. */
function Guidance({
  hint,
  command,
  label,
}: {
  hint: string
  command: string
  label: string
}) {
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Copied", { description: command })
    } catch {
      toast.error("Copy failed", { description: "Select and copy the command manually." })
    }
  }, [command])

  return (
    <div className="flex flex-col gap-1.5">
      <Separator />
      <p className="text-xs text-muted-foreground">{hint}</p>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 overflow-x-auto border border-border bg-muted px-2 py-1.5 font-mono text-xs text-foreground">
          {command}
        </code>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={`Copy: ${label}`}
          onClick={copy}
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}

/**
 * A human, one-line warning when an agent isn't VERIFIABLY ready (else null).
 * Mirrors the amber chip: absent and not-signed-in are hard problems; an unknown
 * auth (null) is surfaced honestly as "could not be verified", never as a false
 * "not signed in".
 */
function warningFor(health: AgentsHealth): string | null {
  const problems: string[] = []
  for (const key of ["claude", "codex"] as AgentKey[]) {
    const a = health[key]
    const label = AGENT_GUIDANCE[key].label
    if (!a.present) problems.push(`${label} is not installed`)
    else if (a.authenticated === false) problems.push(`${label} is not signed in`)
    else if (a.authenticated === null) problems.push(`${label} sign-in could not be verified`)
  }
  if (problems.length === 0) return null
  return `${problems.join("; ")}. The dev-loop needs both CLIs installed and signed in to run.`
}
