"use client"

import { useCallback, useEffect, useState } from "react"
import { Settings, Zap } from "lucide-react"
import { toast } from "sonner"

import {
  agentDefaultsFor,
  clampMaxParallel,
  DEFAULT_SETTINGS,
  effortsForModel,
  isSettingsValid,
  MAX_PARALLEL,
  MIN_PARALLEL,
  MODEL_IDS,
  modelSupportsFast,
  otherProvider,
  PROVIDER_LABEL,
  PROVIDERS,
  withModel,
  type AgentSettings,
  type AgentsSettings,
  type Provider,
  type Role,
} from "@/lib/settings"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { NumberStepper } from "@/components/ui/number-stepper"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"

/** Human label for each agent role shown in the dialog. */
const ROLE_LABEL: Record<Role, string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
}

/** The opposite role — used to keep the two-CLI assignment distinct. */
const OTHER_ROLE: Record<Role, Role> = {
  implementer: "reviewer",
  reviewer: "implementer",
}

/**
 * Agent settings dialog: per-role CLI assignment (R12) plus per-role model, thinking
 * level, and fast mode (P4) — with STRICT per-model compatibility.
 *
 * Opens from a gear button in the sidebar header. On open it loads the current
 * settings from `GET /api/settings`; Save persists via `PUT /api/settings` and
 * toasts the result.
 *
 * Each role gets a CLI Select, a MODEL Select (the curated last-4 list for the
 * assigned CLI — plus the persisted model as an extra option if it is custom), a
 * thinking-level Select restricted to THAT MODEL's allowed levels (hidden when the
 * model has no reasoning control), and a Fast switch enabled ONLY for a model+CLI
 * that genuinely supports fast on the headless run. The two roles must run DISTINCT
 * CLIs (a CLI can never review its own work). Save is disabled on any invalid
 * combination; the schema validators are the source of truth and the form mirrors
 * them so an impossible combo is never even submitted.
 *
 * `onSaved` lets the parent (e.g. the quota footer) reflect the new labels.
 */
export function SettingsDialog({
  onSaved,
}: {
  onSaved?: (settings: AgentsSettings) => void
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AgentsSettings>(DEFAULT_SETTINGS)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)

  // Load the persisted settings each time the dialog opens, so it always edits
  // the live values rather than a stale snapshot.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void (async () => {
      setLoading(true)
      try {
        const res = await fetch("/api/settings", { cache: "no-store" })
        const body = (await res.json()) as { settings?: AgentsSettings }
        if (!cancelled && body.settings) setDraft(body.settings)
      } catch {
        // Keep the defaults/last draft on a failed load; the user can still edit.
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Update one field of one role's agent block (effort / fast).
  const updateAgent = useCallback((role: Role, patch: Partial<AgentSettings>) => {
    setDraft((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
  }, [])

  // Change a role's model. The effort + fast flag are re-coerced to the new model
  // (withModel) so the form can never hold an incompatible model+effort/fast combo.
  const setModel = useCallback((role: Role, model: string) => {
    setDraft((prev) => ({ ...prev, [role]: withModel(prev[role], model) }))
  }, [])

  // Set the max parallel issues knob, clamped to [MIN_PARALLEL, MAX_PARALLEL].
  const setMaxParallel = useCallback((value: number) => {
    setDraft((prev) => ({ ...prev, maxParallel: clampMaxParallel(value) }))
  }, [])

  // Reassign a role to a different CLI. The two roles must stay distinct, so the
  // OTHER role is forced to the complementary CLI; both roles reset to their new
  // CLI's defaults (model + level + fast are CLI-specific). Picking the CLI the
  // role already has is a no-op.
  const assignCli = useCallback((role: Role, provider: Provider) => {
    setDraft((prev) => {
      if (prev[role].provider === provider) return prev
      const other = OTHER_ROLE[role]
      return {
        ...prev,
        [role]: agentDefaultsFor(provider),
        [other]: agentDefaultsFor(otherProvider(provider)),
      } as AgentsSettings
    })
  }, [])

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        error?: string
        settings?: AgentsSettings
      }
      if (!res.ok || body.ok === false || !body.settings) {
        toast.error("Save failed", { description: body.error ?? `HTTP ${res.status}` })
        return
      }
      // Echo the validated document the server actually wrote.
      setDraft(body.settings)
      onSaved?.(body.settings)
      toast.success("Settings saved", {
        description: "New runs use the updated agents, models, thinking levels, and fast mode.",
      })
      setOpen(false)
    } catch (error) {
      toast.error("Save failed", {
        description: error instanceof Error ? error.message : "network error",
      })
    } finally {
      setSaving(false)
    }
  }, [draft, onSaved])

  // The schema validators are the source of truth: Save is disabled unless the two
  // roles are distinct AND every role block is internally compatible (effort valid
  // for its model, fast only on a fast-capable model).
  const valid = isSettingsValid(draft)
  const distinct = draft.implementer.provider !== draft.reviewer.provider

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label="Settings">
          <Settings />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent settings</DialogTitle>
          <DialogDescription>
            Assign each role to an agent CLI, pick its model and thinking level, and
            optionally turn on fast inference. The implementer and reviewer must be
            different agents — the reviewer never authored the code.
          </DialogDescription>
        </DialogHeader>

        <TooltipProvider>
          <div className="flex flex-col gap-4">
            {(Object.keys(ROLE_LABEL) as Role[]).map((role) => (
              <AgentFields
                key={role}
                role={role}
                agent={draft[role]}
                disabled={loading || saving}
                onAssignCli={(provider) => assignCli(role, provider)}
                onModel={(model) => setModel(role, model)}
                onChange={(patch) => updateAgent(role, patch)}
              />
            ))}

            <fieldset
              className="flex flex-col gap-2 border border-border p-3"
              disabled={loading || saving}
            >
              <legend className="px-1 text-xs font-medium text-foreground">Concurrency</legend>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="settings-max-parallel">Max parallel issues</Label>
                <NumberStepper
                  id="settings-max-parallel"
                  min={MIN_PARALLEL}
                  max={MAX_PARALLEL}
                  step={1}
                  value={draft.maxParallel}
                  onValueChange={setMaxParallel}
                  aria-describedby="settings-max-parallel-help"
                  aria-label="Max parallel issues"
                  className="w-28"
                />
                <p id="settings-max-parallel-help" className="text-xs text-muted-foreground">
                  Independent issues run at once (1–{MAX_PARALLEL}), each in its own
                  git worktree (1 = sequential). The batch is spread across different
                  parts of the map to minimize merge conflicts. Dependent issues
                  always wait their turn.
                </p>
              </div>
            </fieldset>
          </div>
        </TooltipProvider>

        {!distinct ? (
          <p className="text-xs text-destructive">
            The implementer and reviewer must run different agents.
          </p>
        ) : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={loading || saving || !valid}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AgentFields({
  role,
  agent,
  disabled,
  onAssignCli,
  onModel,
  onChange,
}: {
  role: Role
  agent: AgentSettings
  disabled: boolean
  onAssignCli: (provider: Provider) => void
  onModel: (model: string) => void
  onChange: (patch: Partial<AgentSettings>) => void
}) {
  const provider: Provider = agent.provider
  const cliId = `settings-${role}-cli`
  const modelId = `settings-${role}-model`
  const effortId = `settings-${role}-effort`
  const fastId = `settings-${role}-fast`

  // The curated list for this CLI, plus the persisted model as an extra option when
  // it is custom (not in the list) — so a hand-set model never disappears.
  const listed = MODEL_IDS[provider]
  const modelOptions = listed.includes(agent.model) ? listed : [agent.model, ...listed]

  // Strict per-MODEL compatibility drives the rest of the controls.
  const levels = effortsForModel(provider, agent.model)
  const hasEffort = levels.length > 0
  const fastOk = modelSupportsFast(provider, agent.model)
  const fastDisabledReason = fastReason(provider, agent.model, fastOk)

  return (
    <fieldset className="flex flex-col gap-2 border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-medium text-foreground">{ROLE_LABEL[role]}</legend>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={cliId}>Agent</Label>
        <Select value={provider} onValueChange={(value) => onAssignCli(value as Provider)}>
          <SelectTrigger id={cliId} aria-label={`${ROLE_LABEL[role]} agent`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDERS.map((p) => (
              <SelectItem key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={modelId}>Model</Label>
        <Select value={agent.model} onValueChange={(value) => onModel(value)}>
          <SelectTrigger id={modelId} aria-label={`${ROLE_LABEL[role]} model`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modelOptions.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
                {!listed.includes(id) ? " (custom)" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {hasEffort ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={effortId}>Thinking level</Label>
          <Select value={agent.effort} onValueChange={(value) => onChange({ effort: value })}>
            <SelectTrigger id={effortId} aria-label={`${ROLE_LABEL[role]} thinking level`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {agent.model} has no separate thinking level — it runs at a fixed,
          low-latency reasoning setting.
        </p>
      )}

      <div className="flex items-start justify-between gap-3 pt-1">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={fastId} className="flex items-center gap-1.5">
            <Zap className="size-3.5" aria-hidden="true" />
            Fast mode
          </Label>
          <p className="text-xs text-muted-foreground">
            Faster inference — consumes the quota much faster.
          </p>
        </div>
        {fastOk ? (
          <Switch
            id={fastId}
            checked={agent.fast}
            onCheckedChange={(checked) => onChange({ fast: checked === true })}
            aria-label={`${ROLE_LABEL[role]} fast mode`}
          />
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* A disabled switch swallows pointer events, so wrap it to keep the
                  tooltip reachable on hover/focus. */}
              <span tabIndex={0} className="inline-flex" aria-label={`${ROLE_LABEL[role]} fast mode unavailable`}>
                <Switch
                  id={fastId}
                  checked={false}
                  disabled
                  aria-label={`${ROLE_LABEL[role]} fast mode`}
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{fastDisabledReason}</TooltipContent>
          </Tooltip>
        )}
      </div>
    </fieldset>
  )
}

/** Honest, specific reason a model+CLI cannot offer fast mode. */
function fastReason(provider: Provider, model: string, fastOk: boolean): string {
  if (fastOk) return ""
  if (provider === "codex" && model === "gpt-5.3-codex-spark") {
    return "Spark is already a low-latency model — fast mode does not apply."
  }
  if (provider === "claude") {
    return `Fast mode is only available on Opus 4.6–4.8. ${model} does not support it.`
  }
  return `${model} does not support fast mode.`
}
