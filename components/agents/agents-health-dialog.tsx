"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import {
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  Gauge,
  HelpCircle,
  Loader2,
  XCircle,
} from "lucide-react"
import { toast } from "sonner"

import {
  AGENT_GUIDANCE,
  type AgentHealth,
  type AgentKey,
  type AgentsHealth,
  type AuthMethod,
} from "@/lib/agents-health-types"
import { runAllowedCommandNative, useIsDesktop } from "@/lib/desktop"
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
  const [open, setOpen] = useState(false)
  const [health, setHealth] = useState<AgentsHealth | null>(null)
  const [loading, setLoading] = useState(false)
  // Desktop (Tauri) shell? Hydration-safe (false on SSR + first client render),
  // so the native "Install" button only appears in the desktop build; the web
  // build stays copy-only.
  const desktop = useIsDesktop()

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
              desktop={desktop}
              onInstalled={load}
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
  desktop,
  onInstalled,
}: {
  agentKey: AgentKey
  health: AgentHealth | null
  loading: boolean
  /** True in the Tauri desktop shell → enable native one-click install. */
  desktop: boolean
  /** Re-run health detection after a native install completes. */
  onInstalled: () => void | Promise<void>
}) {
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
          <span className="font-normal text-muted-foreground">{health.version}</span>
        ) : null}
      </legend>

      {loading ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Checking…
        </div>
      ) : (
        <>
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
            {auth === true && authMethod ? (
              <MethodBadge authMethod={authMethod} plan={plan} />
            ) : null}
          </div>
          {auth === true && authMethod ? (
            <p className="px-0.5 text-xs text-muted-foreground">{costNote(authMethod)}</p>
          ) : null}
        </>
      )}

      {/* Guidance: install command when absent; auth command when present-not-authed.
          Install upgrades to a native one-click run in the desktop shell; auth
          stays copy-only (it is interactive and must run in the user's terminal). */}
      {!loading && !present ? (
        <Guidance
          hint={guidance.installHint}
          command={guidance.installCommand}
          label={`Install ${guidance.label}`}
          nativeInstall={
            desktop
              ? { commandName: guidance.installCommandName, onDone: onInstalled }
              : undefined
          }
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

/** Title-case a plan label for display (`"max"` → `"Max"`); leaves the rest intact. */
function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

/** Badge label for the billing method, with the plan when known. */
function methodLabel(authMethod: AuthMethod, plan: string | null): string {
  if (authMethod === "api_key") return "API key"
  return plan ? `Subscription · ${titleCase(plan)}` : "Subscription"
}

/** Sober, one-line cost note that differentiates the two billing methods. */
function costNote(authMethod: AuthMethod): string {
  return authMethod === "api_key"
    ? "Billed pay-per-token against your provider API account."
    : "Usage counts against your plan quota — no per-token charge."
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
  const Icon = authMethod === "api_key" ? CreditCard : Gauge
  return (
    <Badge variant="secondary" className="gap-1" data-auth-method={authMethod}>
      <Icon className="size-3" />
      {methodLabel(authMethod, plan)}
    </Badge>
  )
}

/**
 * A copyable command block with a one-line hint. In the WEB build it is copy-only
 * and never runs anything. In the DESKTOP build, when `nativeInstall` is given,
 * it adds a "Run install" button that executes the allow-listed install command
 * natively via the Tauri shell plugin, streams its output inline, and re-checks
 * health on success. The shell allow-list (see `src-tauri/capabilities`) fixes the
 * exact command + args, so this can never run an arbitrary shell.
 */
function Guidance({
  hint,
  command,
  label,
  nativeInstall,
}: {
  hint: string
  command: string
  label: string
  nativeInstall?: { commandName: string; onDone: () => void | Promise<void> }
}) {
  const [running, setRunning] = useState(false)
  const [output, setOutput] = useState<string[]>([])
  const [result, setResult] = useState<"ok" | "fail" | null>(null)
  // Auto-scroll the streamed log to the latest line.
  const logRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [output])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Copied", { description: command })
    } catch {
      toast.error("Copy failed", { description: "Select and copy the command manually." })
    }
  }, [command])

  const runNative = useCallback(async () => {
    if (!nativeInstall) return
    setRunning(true)
    setResult(null)
    setOutput([`$ ${command}`])
    try {
      const res = await runAllowedCommandNative(nativeInstall.commandName, (l) =>
        // Keep only the last MAX_LOG_LINES so a chatty/slow install never grows
        // the buffer unbounded.
        setOutput((prev) => {
          const next = [...prev, l.line]
          return next.length > MAX_LOG_LINES ? next.slice(-MAX_LOG_LINES) : next
        })
      )
      setResult(res.ok ? "ok" : "fail")
      if (res.ok) {
        toast.success("Install complete", { description: command })
        await nativeInstall.onDone()
      } else {
        toast.error("Install failed", { description: `Exited with code ${res.code ?? "?"}` })
      }
    } catch (error) {
      setResult("fail")
      setOutput((prev) => [
        ...prev,
        error instanceof Error ? error.message : "unknown error",
      ])
      toast.error("Install failed", {
        description: error instanceof Error ? error.message : "unknown error",
      })
    } finally {
      setRunning(false)
    }
  }, [command, nativeInstall])

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

      {/* Desktop only: run the install natively (allow-listed command). */}
      {nativeInstall ? (
        <>
          <Button
            variant="default"
            size="sm"
            disabled={running}
            aria-label={`Run install: ${label}`}
            onClick={() => void runNative()}
            className="justify-start"
          >
            {running ? <Loader2 className="animate-spin" /> : <Download />}
            {running ? "Installing…" : "Run install"}
          </Button>
          {output.length > 0 ? (
            <pre
              ref={logRef}
              data-install-state={result ?? (running ? "running" : "idle")}
              className="max-h-40 overflow-auto border border-border bg-muted px-2 py-1.5 font-mono text-xs whitespace-pre-wrap text-muted-foreground"
            >
              {output.join("\n")}
              {result === "ok" ? "\n✓ done" : result === "fail" ? "\n✗ failed" : ""}
            </pre>
          ) : null}
        </>
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
