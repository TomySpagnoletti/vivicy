/**
 * Vivi Action Protocol (v0.7.0 — "the governess"): the ONE structured channel through
 * which Vivi drives the control plane. Vivi's reply may carry a single fenced block:
 *
 *   ```vivicy-action
 *   {"actions": [{"tool": "pipeline.start", "args": {}}]}
 *   ```
 *
 * The agent leg itself has ZERO tool access — it emits intent as text, and the
 * orchestrator (runViviTurn) parses it here, validates every action against the
 * server-side registry below, and executes by calling the SAME lib/control functions
 * the UI routes and the G14 CLI drive. Enforcement is always the orchestrator's (P5):
 * an unknown tool or bad args yields an honest per-action failure result, never a
 * trusted side effect. Every EXECUTED action appends a notification (P9).
 *
 * Deliberately NOT a tool: `cr.decide` — the CR decision is the single human
 * touchpoint (P2). Vivi may present a decision; only the owner's click records one.
 *
 * The generalized successor of the `vivicy-skills` fence (still parsed by vivi.ts as
 * a deprecated alias): same strict-JSON, same "malformed is a note, not a rejection"
 * posture, one honest outcome per action.
 */

import {
  cancelSpecCycle,
  getExtractionStatus,
  listChangeRequests,
  openSpecCycle,
  readDevStatus,
  readSkillsReport,
  removeSkills,
  runExtract,
  startSkillsInstall,
  startSupervisor,
  stopSupervisor,
  type Spawner,
} from "@/lib/control"
import { applyLayoutSave, validateLayoutSavePayload } from "@/lib/map-layout-save"
import { appendNotification, readNotifications, type Notification } from "@/lib/notifications"

/** Matches Vivi's action fenced block (see prompts/vivi.md, "Acting on Vivicy"). */
const ACTION_FENCE = /```vivicy-action\s*\n([\s\S]*?)\n\s*```/

/** Hard cap on actions per turn — a runaway batch is a prompt bug, not a workload. */
const MAX_ACTIONS_PER_TURN = 5

/** One action as requested by Vivi's fenced block (parsed, not yet validated). */
export interface ViviActionRequest {
  tool: string
  args: Record<string, unknown>
}

/** One executed (or refused) action's honest outcome, recorded on the transcript. */
export interface ViviActionResult {
  tool: string
  ok: boolean
  /** One human sentence: what happened (or why it was refused). */
  summary: string
  /** Compact machine payload for read verbs (status, lists) — fed back to Vivi. */
  data?: unknown
}

/** Outcome of {@link parseActionDirective}: requests, an honest malformed reason,
 *  or null when the reply carries no action block at all. */
export type ActionDirective = { actions: ViviActionRequest[] } | { malformed: string } | null

/**
 * Parse the optional `vivicy-action` fenced block out of a Vivi reply. STRICT:
 * valid JSON of shape `{"actions": [{"tool": "<name>", "args": {...}?}, ...]}`,
 * 1..MAX_ACTIONS_PER_TURN entries. A present-but-broken block returns `{ malformed }`
 * so the caller appends an honest note WITHOUT rejecting the turn (same posture as
 * the legacy skills fence); no block returns null. Registry membership is NOT
 * checked here — an unknown tool is refused at execution with a per-action result,
 * so a partially-valid batch still reports honestly on every entry.
 */
export function parseActionDirective(reply: string): ActionDirective {
  const match = reply.match(ACTION_FENCE)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { malformed: "the vivicy-action block is not valid JSON" }
  }
  const actions = (parsed as { actions?: unknown } | null)?.actions
  if (!Array.isArray(actions) || actions.length === 0) {
    return { malformed: 'the vivicy-action block must be {"actions": [{"tool": "<name>", ...}]} with at least one action' }
  }
  if (actions.length > MAX_ACTIONS_PER_TURN) {
    return { malformed: `the vivicy-action block lists ${actions.length} actions — the cap is ${MAX_ACTIONS_PER_TURN} per turn` }
  }
  const out: ViviActionRequest[] = []
  for (const entry of actions) {
    const tool = (entry as { tool?: unknown } | null)?.tool
    if (typeof tool !== "string" || tool.trim().length === 0) {
      return { malformed: "every action must carry a non-empty string \"tool\"" }
    }
    const args = (entry as { args?: unknown }).args
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
      return { malformed: `action "${tool.trim()}": "args" must be a JSON object when present` }
    }
    out.push({ tool: tool.trim(), args: (args as Record<string, unknown>) ?? {} })
  }
  return { actions: out }
}

/**
 * The executable surface behind the registry — every entry resolves to a control-plane
 * function. Injectable so tests exercise the registry without spawning anything; the
 * default wiring is the real lib/control + lib/map-layout-save modules.
 */
export interface ViviActionDeps {
  readDevStatus: typeof readDevStatus
  getExtractionStatus: typeof getExtractionStatus
  readSkillsReport: typeof readSkillsReport
  startSupervisor: typeof startSupervisor
  stopSupervisor: typeof stopSupervisor
  runExtract: typeof runExtract
  startSkillsInstall: typeof startSkillsInstall
  removeSkills: typeof removeSkills
  openSpecCycle: typeof openSpecCycle
  cancelSpecCycle: typeof cancelSpecCycle
  listChangeRequests: typeof listChangeRequests
  readNotifications: () => Notification[]
  applyLayoutSave: typeof applyLayoutSave
  validateLayoutSavePayload: typeof validateLayoutSavePayload
  notify: typeof appendNotification
}

/** The real dependency wiring — every verb backed by the module of record. */
export function defaultViviActionDeps(): ViviActionDeps {
  return {
    readDevStatus,
    getExtractionStatus,
    readSkillsReport,
    startSupervisor,
    stopSupervisor,
    runExtract,
    startSkillsInstall,
    removeSkills,
    openSpecCycle,
    cancelSpecCycle,
    listChangeRequests,
    readNotifications,
    applyLayoutSave,
    validateLayoutSavePayload,
    notify: appendNotification,
  }
}

/** The stages `pipeline.retry` accepts — identical to the retry-stage route/CLI. */
const RETRYABLE_STAGES = ["extract", "skills", "dev"] as const
type RetryableStage = (typeof RETRYABLE_STAGES)[number]

/** Every verb Vivi may invoke, with a one-line contract (mirrored in prompts/vivi.md). */
export const VIVI_ACTION_TOOLS = [
  "status.read",
  "pipeline.start",
  "pipeline.resume",
  "pipeline.stop",
  "pipeline.extract",
  "pipeline.retry",
  "skills.install",
  "skills.remove",
  "map.move",
  "crs.list",
  "cycle.open",
  "cycle.cancel",
  "notifications.read",
] as const

export type ViviActionTool = (typeof VIVI_ACTION_TOOLS)[number]

function isKnownTool(tool: string): tool is ViviActionTool {
  return (VIVI_ACTION_TOOLS as readonly string[]).includes(tool)
}

/** Non-empty trimmed string list from `args[key]`, or null when absent/invalid. */
function stringList(args: Record<string, unknown>, key: string): string[] | null {
  const raw = args[key]
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) return null
    out.push(entry.trim())
  }
  return out
}

/**
 * Execute one validated batch of actions SEQUENTIALLY (order is Vivi's plan; a
 * failed action never aborts the rest — each entry gets its own honest result).
 * Every executed action appends a notification with stage "vivi" (P9), level
 * mirroring the outcome, so the autonomous internals stay loud.
 */
export async function executeViviActions(
  spawner: Spawner,
  actions: ViviActionRequest[],
  deps: ViviActionDeps = defaultViviActionDeps()
): Promise<ViviActionResult[]> {
  const results: ViviActionResult[] = []
  for (const action of actions) {
    const result = await executeOne(spawner, action, deps)
    try {
      deps.notify({
        level: result.ok ? "info" : "error",
        stage: "vivi",
        event: `action_${action.tool.replace(/\./g, "_")}${result.ok ? "" : "_error"}`,
        message: `Vivi action ${action.tool}: ${result.summary}`,
      })
    } catch {
      // A notification write failure never breaks the action outcome itself.
    }
    results.push(result)
  }
  return results
}

async function executeOne(
  spawner: Spawner,
  action: ViviActionRequest,
  deps: ViviActionDeps
): Promise<ViviActionResult> {
  const { tool, args } = action
  if (!isKnownTool(tool)) {
    return {
      tool,
      ok: false,
      summary: `unknown tool "${tool}" — available: ${VIVI_ACTION_TOOLS.join(", ")}`,
    }
  }
  try {
    switch (tool) {
      case "status.read": {
        const status = await deps.readDevStatus(spawner)
        const extraction = deps.getExtractionStatus()
        const skills = deps.readSkillsReport()
        const data = {
          run_active: status.run_active,
          verdict: status.verdict,
          issues_done: status.issues_done,
          issues_total: status.issues_total,
          gates: status.gates,
          extraction_phase: extraction?.phase ?? null,
          skills_phase: skills?.phase ?? null,
        }
        return {
          tool,
          ok: true,
          summary: `run_active=${data.run_active}, issues ${data.issues_done}/${data.issues_total} done, gates fail=${data.gates?.fail ?? "?"}, extraction=${data.extraction_phase ?? "never"}, skills=${data.skills_phase ?? "never"}`,
          data,
        }
      }
      case "pipeline.start":
      case "pipeline.resume": {
        const mode = tool === "pipeline.start" ? "start" : "resume"
        const state = deps.startSupervisor(spawner, mode)
        return { tool, ok: true, summary: `supervisor ${mode}ed (pid ${state.pid})`, data: { pid: state.pid, mode } }
      }
      case "pipeline.stop": {
        const { pid } = deps.stopSupervisor(spawner)
        return { tool, ok: true, summary: `supervisor stopped (pid ${pid})`, data: { pid } }
      }
      case "pipeline.extract": {
        const result = await deps.runExtract(spawner)
        return {
          tool,
          ok: result.ok,
          summary: result.summary || result.status,
          data: { status: result.status, blocked: result.blocked },
        }
      }
      case "pipeline.retry": {
        const stage = args.stage
        if (typeof stage !== "string" || !(RETRYABLE_STAGES as readonly string[]).includes(stage)) {
          return { tool, ok: false, summary: `args.stage must be one of: ${RETRYABLE_STAGES.join(", ")}` }
        }
        // Identical dispatch to the retry-stage route and the G14 CLI.
        if ((stage as RetryableStage) === "extract") {
          const result = await deps.runExtract(spawner)
          return { tool, ok: result.ok, summary: result.summary || result.status, data: { stage, status: result.status } }
        }
        if ((stage as RetryableStage) === "skills") {
          const run = deps.startSkillsInstall(spawner)
          return { tool, ok: true, summary: `skills install retried (pid ${run.pid}, ${run.mode} mode)`, data: { stage, pid: run.pid } }
        }
        const run = deps.startSupervisor(spawner, "resume")
        return { tool, ok: true, summary: `dev-loop retried as a resume (pid ${run.pid})`, data: { stage, pid: run.pid } }
      }
      case "skills.install": {
        const ids = stringList(args, "ids")
        if (!ids) {
          return { tool, ok: false, summary: 'args.ids must be a non-empty list of skill ids/URLs' }
        }
        const run = deps.startSkillsInstall(spawner, { ids })
        return { tool, ok: true, summary: `skills install started (explicit mode, pid ${run.pid}): ${ids.join(", ")}`, data: { ids, pid: run.pid } }
      }
      case "skills.remove": {
        const ids = stringList(args, "ids")
        if (!ids) {
          return { tool, ok: false, summary: 'args.ids must be a non-empty list of skill ids/URLs' }
        }
        const report = await deps.removeSkills(spawner, { ids })
        const removed = report.removed?.length ?? 0
        const refused = report.rejected?.length ?? 0
        return {
          tool,
          ok: report.phase === "green",
          summary: report.summary ?? `skills remove: ${removed} removed, ${refused} refused`,
          data: { removed: report.removed ?? [], rejected: report.rejected ?? [] },
        }
      }
      case "map.move": {
        // Reuses the exact validated UI save path: coordinates + edge-label ratios
        // only, unknown ids refused, source YAML patched line-by-line, regen with
        // rollback, VIVICY_MAP_LAYOUT_WRITE kill-switch still applies.
        const payload = deps.validateLayoutSavePayload(args)
        const saved = await deps.applyLayoutSave({ payload })
        const moved = payload.nodes.length
        const ratios = payload.edgeLabels.length
        return {
          tool,
          ok: true,
          summary: `map layout saved (${moved} node${moved === 1 ? "" : "s"}, ${ratios} edge label${ratios === 1 ? "" : "s"})`,
          data: { mapPath: saved.mapPath, nodes: moved, edgeLabels: ratios },
        }
      }
      case "crs.list": {
        const { crs } = deps.listChangeRequests()
        return {
          tool,
          ok: true,
          summary: crs.length === 0 ? "no change requests on file" : `${crs.length} change request(s) on file`,
          data: { crs },
        }
      }
      case "cycle.open": {
        const cycle = deps.openSpecCycle(spawner, "owner:vivi")
        return {
          tool,
          ok: true,
          summary: `drafting cycle ${cycle.id} opened — the canonical spec is editable again; extraction will freeze it (minor bump) and close the cycle`,
          data: { cycle },
        }
      }
      case "cycle.cancel": {
        const { id } = await deps.cancelSpecCycle(spawner)
        return { tool, ok: true, summary: `drafting cycle ${id} cancelled (the canonical had not drifted)`, data: { id } }
      }
      case "notifications.read": {
        const limitRaw = args.limit
        const limit = typeof limitRaw === "number" && Number.isFinite(limitRaw) ? Math.max(1, Math.min(50, Math.floor(limitRaw))) : 20
        const all = deps.readNotifications().filter((n) => !n.dismissed)
        const slice = all.slice(-limit)
        return {
          tool,
          ok: true,
          summary: `${slice.length} undismissed notification(s) (of ${all.length})`,
          data: { notifications: slice },
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { tool, ok: false, summary: message }
  }
}

/** Render executed results as the honest per-action lines a transcript turn records. */
export function renderActionResults(results: ViviActionResult[]): string {
  return results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.tool}: ${r.summary}`)
    .join("\n")
}

/** Remove the action fence from a reply for display/transcript purposes — the
 *  requested actions live on as the structured "action" turn's results, so the raw
 *  JSON block adds nothing for a human reader. */
export function stripActionFence(reply: string): string {
  return reply.replace(ACTION_FENCE, "").replace(/\n{3,}/g, "\n\n").trim()
}
