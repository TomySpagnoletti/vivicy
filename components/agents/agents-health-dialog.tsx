"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { CreditCard, Gauge, Loader2, RefreshCw } from "lucide-react"
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
import { AgentStatusBadge, CopyableCommand, InstallDocsLink } from "@/components/agents/agent-status"

type ChipState = "ok" | "warn" | "loading"

const MAX_LOG_LINES = 500

function overallState(health: AgentsHealth | null): ChipState {
  if (!health) return "loading"
  const ready = (a: AgentHealth) => a.present && a.authenticated === true
  return ready(health.claude) && ready(health.codex) ? "ok" : "warn"
}

export function AgentsHealthDialog({
  onWarning,
}: {
  onWarning?: (message: string) => void
}) {
  const t = useTranslations("agents")
  const [open, setOpen] = useState(false)
  const [health, setHealth] = useState<AgentsHealth | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(
    async (fresh = false) => {
      setLoading(true)
      try {
        const res = await fetch(fresh ? "/api/agents/health?fresh=1" : "/api/agents/health", {
          cache: "no-store",
        })
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
      } finally {
        setLoading(false)
      }
    },
    [onWarning, t]
  )

  // Two effects, deliberately not merged: mount always loads (drives the closed-dialog chip); open re-probes with fresh=1 to catch a CLI just installed/logged into.
  useEffect(() => {
    void (async () => {
      await load()
    })()
  }, [load])
  useEffect(() => {
    if (!open) return
    void (async () => {
      await load(true)
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

function AgentCard({
  agentKey,
  health,
  loading,
  onHealth,
}: {
  agentKey: AgentKey
  health: AgentHealth | null
  loading: boolean
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
            <AgentStatusBadge
              ok={present}
              okLabel={t("installed")}
              badLabel={t("notInstalled")}
              unknown={false}
            />
            <AgentStatusBadge
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
          {present ? <UpdateAction agentKey={agentKey} onHealth={onHealth} /> : null}
        </>
      )}

      {!loading && !present ? (
        <InstallDocsLink
          hint={guidance.installHint}
          href={guidance.docsUrl}
          label={t("installGuide", { label: guidance.label })}
        />
      ) : null}
      {!loading && present && auth === false ? (
        <CopyableCommand hint={guidance.authHint} command={guidance.authCommand} label={t("signIn")} />
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

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}

function methodLabel(authMethod: AuthMethod, plan: string | null, t: ReturnType<typeof useTranslations<"agents">>): string {
  if (authMethod === "api_key") return t("apiKey")
  return plan ? t("subscriptionPlan", { plan: titleCase(plan) }) : t("subscription")
}

function costNote(authMethod: AuthMethod, t: ReturnType<typeof useTranslations<"agents">>): string {
  return authMethod === "api_key" ? t("apiKeyCostNote") : t("subscriptionCostNote")
}

/** Caller must gate on `authenticated === true` before rendering — this trusts authMethod without re-checking. */
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

interface UpdateResponse {
  ok?: boolean
  code?: number | null
  stdout?: string
  stderr?: string
  error?: string
  agents?: AgentsHealth
}

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
