"use client"

import { useCallback, useEffect, useState } from "react"
import { Settings } from "lucide-react"
import { toast } from "sonner"

import {
  agentDefaultsFor,
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  isDistinctAssignment,
  otherProvider,
  PROVIDER_LABEL,
  PROVIDERS,
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

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
 * Agent settings dialog: per-role CLI assignment (R12) plus per-role model and
 * thinking level (P4).
 *
 * Opens from a gear button in the sidebar header. On open it loads the current
 * settings from `GET /api/settings`; Save persists via `PUT /api/settings` and
 * toasts the result.
 *
 * Each role gets a CLI Select (which agent implements / which reviews), a model
 * Input (defaulted to the assigned CLI's latest model — the owner can correct it),
 * and a thinking-level Select restricted to the assigned CLI's allowed levels.
 * The two roles must run DISTINCT CLIs (a CLI can never review its own work):
 * reassigning one role's CLI moves the other role to the complementary CLI and
 * resets both to that CLI's defaults, so the form can never hold an invalid
 * same-CLI-both-roles assignment.
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

  // Update one field of one role's agent block (model / effort).
  const updateAgent = useCallback(
    (role: Role, patch: Partial<AgentSettings>) => {
      setDraft((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
    },
    []
  )

  // Reassign a role to a different CLI. The two roles must stay distinct, so the
  // OTHER role is forced to the complementary CLI; both roles reset to their new
  // CLI's defaults (model + level are CLI-specific). Picking the CLI the role
  // already has is a no-op.
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
        description: "New runs use the updated agents, models, and thinking levels.",
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

  // Defensive: the assignment helpers keep the two roles distinct, but never let
  // Save send a same-CLI-both-roles document even if state were forced invalid.
  const distinct = isDistinctAssignment(draft)

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
            Assign each role to an agent CLI, then pick its thinking level. The
            implementer and reviewer must be different agents — the reviewer never
            authored the code.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {(Object.keys(ROLE_LABEL) as Role[]).map((role) => (
            <AgentFields
              key={role}
              role={role}
              agent={draft[role]}
              disabled={loading || saving}
              onAssignCli={(provider) => assignCli(role, provider)}
              onChange={(patch) => updateAgent(role, patch)}
            />
          ))}
        </div>

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
          <Button onClick={save} disabled={loading || saving || !distinct}>
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
  onChange,
}: {
  role: Role
  agent: AgentSettings
  disabled: boolean
  onAssignCli: (provider: Provider) => void
  onChange: (patch: Partial<AgentSettings>) => void
}) {
  const provider: Provider = agent.provider
  const levels = EFFORT_LEVELS[provider]
  const cliId = `settings-${role}-cli`
  const modelId = `settings-${role}-model`
  const effortId = `settings-${role}-effort`

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
        <Input
          id={modelId}
          value={agent.model}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange({ model: event.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={effortId}>Thinking level</Label>
        <Select
          value={agent.effort}
          onValueChange={(value) => onChange({ effort: value })}
        >
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
    </fieldset>
  )
}
