"use client"

import { useCallback, useEffect, useState } from "react"
import { Settings } from "lucide-react"
import { toast } from "sonner"

import {
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  type AgentSettings,
  type AgentsSettings,
  type Provider,
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
const ROLE_LABEL: Record<keyof AgentsSettings, string> = {
  implementer: "Implementer",
  reviewer: "Reviewer",
}

/**
 * Per-agent model + thinking-level settings dialog.
 *
 * Opens from a gear button in the sidebar header. On open it loads the current
 * settings from `GET /api/settings`; Save persists via `PUT /api/settings` and
 * toasts the result. The model is an editable Input (defaulted to the latest
 * model — the owner can correct it, notably the uncertain Codex id); the
 * thinking level is a Select restricted to each provider's allowed levels.
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

  const updateAgent = useCallback(
    (role: keyof AgentsSettings, patch: Partial<AgentSettings>) => {
      setDraft((prev) => ({ ...prev, [role]: { ...prev[role], ...patch } }))
    },
    []
  )

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
        description: "New runs use the updated models and thinking levels.",
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
            Both agents always run the latest model; the thinking level is yours to choose.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {(Object.keys(ROLE_LABEL) as Array<keyof AgentsSettings>).map((role) => (
            <AgentFields
              key={role}
              role={role}
              agent={draft[role]}
              disabled={loading || saving}
              onChange={(patch) => updateAgent(role, patch)}
            />
          ))}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={saving}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={save} disabled={loading || saving}>
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
  onChange,
}: {
  role: keyof AgentsSettings
  agent: AgentSettings
  disabled: boolean
  onChange: (patch: Partial<AgentSettings>) => void
}) {
  const provider: Provider = agent.provider
  const levels = EFFORT_LEVELS[provider]
  const modelId = `settings-${role}-model`
  const effortId = `settings-${role}-effort`

  return (
    <fieldset className="flex flex-col gap-2 border border-border p-3" disabled={disabled}>
      <legend className="px-1 text-xs font-medium text-foreground">
        {ROLE_LABEL[role]}
        <span className="text-muted-foreground"> · {provider}</span>
      </legend>

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
