"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2,
  Copy,
  CreditCard,
  Gauge,
  HelpCircle,
  Loader2,
  RefreshCw,
  XCircle,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import {
  AGENT_GUIDANCE,
  type AgentHealth,
  type AgentKey,
  type AgentsHealth,
  type AuthMethod,
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

/** Cap on the streamed native-install log so the buffer never grows unbounded. */
const MAX_LOG_LINES = 500

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
  const t = useTranslations("agents")
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
        const warning = warningFor(body.agents, t)
        if (warning) onWarning?.(warning)
      }
    } catch {
      // Leave the chip in its loading-amber state; the dialog can be retried.
    } finally {
      setLoading(false)
    }
  }, [onWarning, t])

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
          aria-label={t("statusButtonAriaLabel")}
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
          {t("statusButtonLabel")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {(["claude", "codex"] as AgentKey[]).map((key) => (
            <AgentCard
              key={key}
              agentKey={key}
              health={health?.[key] ?? null}
              loading={loading && !health}
              onHealth={setHealth}
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
  onHealth,
}: {
  agentKey: AgentKey
  health: AgentHealth | null
  loading: boolean
  /** Apply a fresh health snapshot (e.g. the one the update route re-detects). */
  onHealth: (health: AgentsHealth) => void
}) {
  const t = useTranslations("agents")
  const guidance = AGENT_GUIDANCE[agentKey]
  const present = health?.present ?? false
  const auth = health?.authenticated ?? null
  const authMethod = health?.authMethod ?? null
  const plan = health?.plan ?? null

  return (
    <fieldset className="flex flex-col gap-2 border border-border p-3">
      <legend className="flex items-center gap-2 px-1 text-xs font-medium text-foreground">
        {guidance.label}
        {health?.version ? (
          <span className="font-normal text-muted-foreground">· {health.version}</span>
        ) : null}
      </legend>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> {t("checking")}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge
              ok={present}
              okLabel={t("installed")}
              badLabel={t("notInstalled")}
              unknown={false}
            />
            <StatusBadge
              ok={auth === true}
              okLabel={t("authenticated")}
              badLabel={t("notSignedIn")}
              unknown={auth === null}
              unknownLabel={t("authUnknown")}
            />
            {auth === true && authMethod ? (
              <MethodBadge authMethod={authMethod} plan={plan} />
            ) : null}
          </div>
          {auth === true && authMethod ? (
            <p className="px-0.5 text-xs text-muted-foreground">{costNote(authMethod, t)}</p>
          ) : null}
          {/* Self-update: only meaningful once the CLI is installed. */}
          {present ? <UpdateAction agentKey={agentKey} onHealth={onHealth} /> : null}
        </>
      )}

      {/* Guidance: install command when absent; auth command when present-not-authed.
          Both stay copy-only — install and auth are interactive and run in the
          user's terminal. */}
      {!loading && !present ? (
        <Guidance
          hint={guidance.installHint}
          command={guidance.installCommand}
          label={t("install", { label: guidance.label })}
        />
      ) : null}
      {!loading && present && auth === false ? (
        <Guidance hint={guidance.authHint} command={guidance.authCommand} label={t("signIn")} />
      ) : null}
      {!loading && present && auth === null ? (
        <p className="text-xs text-muted-foreground">
          {t.rich("authUnknownHint", {
            authCommand: guidance.authCommand,
            code: (chunks) => <code className="break-all text-foreground">{chunks}</code>,
          })}
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
  const t = useTranslations("agents")
  if (unknown) {
    return (
      <Badge variant="outline" className="gap-1 text-muted-foreground">
        <HelpCircle className="size-3" />
        {unknownLabel ?? t("unknown")}
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

/** Title-case a plan label for display (`"max"` → `"Max"`); leaves the rest intact. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Badge label for the billing method, with the plan when known. */
function methodLabel(authMethod: AuthMethod, plan: string | null, t: ReturnType<typeof useTranslations<"agents">>): string {
  if (authMethod === "api_key") return t("apiKey")
  return plan ? t("subscriptionPlan", { plan: titleCase(plan) }) : t("subscription")
}

/** Sober, one-line cost note that differentiates the two billing methods. */
function costNote(authMethod: AuthMethod, t: ReturnType<typeof useTranslations<"agents">>): string {
  return authMethod === "api_key" ? t("apiKeyCostNote") : t("subscriptionCostNote")
}

/**
 * The billing-method indicator (subscription vs API key) — the cost-relevant
 * distinction. Reflects only what detection actually established; it is rendered
 * exclusively when `authenticated === true`, so it never fabricates a method.
 */
function MethodBadge({
  authMethod,
  plan,
}: {
  authMethod: AuthMethod
  plan: string | null
}) {
  const t = useTranslations("agents")
  const Icon = authMethod === "api_key" ? CreditCard : Gauge
  return (
    <Badge variant="secondary" className="gap-1" data-auth-method={authMethod}>
      <Icon className="size-3" />
      {methodLabel(authMethod, plan, t)}
    </Badge>
  )
}

/**
 * A copyable command block with a one-line hint. Copy-only: it never runs
 * anything — install and auth are interactive and run in the user's terminal.
 */
function Guidance({
  hint,
  command,
  label,
}: {
  hint: string
  command: string
  label: string
}) {
  const t = useTranslations("agents")
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success(t("copy"), { description: command })
    } catch {
      toast.error(t("copyFailedTitle"), { description: t("copyFailedDescription") })
    }
  }, [command, t])

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
          aria-label={t("copyAriaLabel", { label })}
          onClick={copy}
        >
          <Copy />
        </Button>
      </div>
    </div>
  )
}

/** The streamed/captured response shape from `POST /api/agents/update`. */
interface UpdateResponse {
  ok?: boolean
  code?: number | null
  stdout?: string
  stderr?: string
  error?: string
  agents?: AgentsHealth
}

/**
 * Per-agent "Update" action: runs the CLI's OWN built-in self-update so the user
 * never leaves Vivicy. It POSTs to the allow-listed `/api/agents/update` route
 * (the server execs only the fixed `claude update` / `codex update` command),
 * shows honest running/done/error state, captures (capped) output, disables the
 * button while running, and re-detects health on success so the version line
 * refreshes.
 */
function UpdateAction({
  agentKey,
  onHealth,
}: {
  agentKey: AgentKey
  onHealth: (health: AgentsHealth) => void
}) {
  const t = useTranslations("agents")
  const guidance = AGENT_GUIDANCE[agentKey]
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const [result, setResult] = useState<"ok" | "fail" | null>(null)
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [output])

  const appendLine = useCallback((line: string) => {
    setOutput((prev) => {
      const next = [...prev, line]
      return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
    })
  }, [])

  const run = useCallback(async () => {
    setRunning(true)
    setResult(null)
    setOutput([`$ ${guidance.updateCommand}`])
    try {
      // The server execs ONLY the fixed allow-listed command for this agent.
      const res = await fetch("/api/agents/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agent: agentKey }),
      })
      const body = (await res.json().catch(() => ({}))) as UpdateResponse
      const stdout = body.stdout?.trimEnd()
      const stderr = body.stderr?.trimEnd()
      if (stdout) for (const line of stdout.split("\n")) appendLine(line)
      if (stderr) for (const line of stderr.split("\n")) appendLine(line)
      if (body.error) appendLine(body.error)
      const ok = res.ok && body.ok === true
      setResult(ok ? "ok" : "fail")
      // Re-detection ran server-side after the update; apply the fresh snapshot
      // so the version line refreshes without a second round-trip.
      if (body.agents) onHealth(body.agents)
      if (ok) {
        toast.success(t("updateCompleteTitle"), { description: guidance.updateCommand })
      } else {
        toast.error(t("updateFailedTitle"), {
          description: body.error ?? t("updateFailedFallback", { code: body.code ?? "?" }),
        })
      }
    } catch (error) {
      setResult("fail")
      appendLine(error instanceof Error ? error.message : t("unknownError"))
      toast.error(t("updateFailedTitle"), {
        description: error instanceof Error ? error.message : t("unknownError"),
      })
    } finally {
      setRunning(false)
    }
  }, [agentKey, appendLine, guidance, onHealth, t])

  return (
    <div className="flex flex-col gap-1.5">
      <Button
        variant="outline"
        size="sm"
        disabled={running}
        aria-label={t("updateAriaLabel", { label: guidance.label })}
        onClick={() => void run()}
        className="justify-start"
      >
        {running ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {running ? t("updating") : t("update")}
      </Button>
      {output.length > 0 ? (
        <pre
          ref={logRef}
          data-update-state={result ?? (running ? "running" : "idle")}
          className="max-h-40 overflow-auto border border-border bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
        >
          {output.join("\n")}
          {result === "ok" ? `\n${t("done")}` : result === "fail" ? `\n${t("failed")}` : ""}
        </pre>
      ) : null}
    </div>
  )
}

/**
 * A human, one-line warning when an agent isn't VERIFIABLY ready (else null).
 * Mirrors the amber chip: absent and not-signed-in are hard problems; an unknown
 * auth (null) is surfaced honestly as "could not be verified", never as a false
 * "not signed in".
 */
function warningFor(health: AgentsHealth, t: ReturnType<typeof useTranslations<"agents">>): string | null {
  const problems: string[] = []
  for (const key of ["claude", "codex"] as AgentKey[]) {
    const a = health[key]
    const label = AGENT_GUIDANCE[key].label
    if (!a.present) problems.push(t("warningNotInstalled", { label }))
    else if (a.authenticated === false) problems.push(t("warningNotSignedIn", { label }))
    else if (a.authenticated === null) problems.push(t("warningAuthUnknown", { label }))
  }
  if (problems.length === 0) return null
  return `${problems.join("; ")}. ${t("warningSuffix")}`
}
