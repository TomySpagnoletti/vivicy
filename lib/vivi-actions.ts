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

/** Matches Vivi's action fenced block (see prompts/vivi.md, "Acting on Vivicy"); succeeds the legacy "vivicy-skills" fence still parsed by vivi.ts as a deprecated alias. */
const ACTION_FENCE = /```vivicy-action\s*\n([\s\S]*?)\n\s*```/

const MAX_ACTIONS_PER_TURN = 5

export interface ViviActionRequest {
  tool: string
  args: Record<string, unknown>
}

export interface ViviActionResult {
  tool: string
  ok: boolean
  summary: string
  data?: unknown
}

export type ActionDirective = { actions: ViviActionRequest[] } | { malformed: string } | null

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

/** Mirrored in prompts/vivi.md — keep in sync. `cr.decide` is deliberately absent: the CR decision is the sole human touchpoint, recorded only by the owner's click. */
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

/** Sequential by design — actions mutate shared external state (supervisor process, files); do not parallelize. */
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
        // Same validated path as the UI save — unknown ids refused, VIVICY_MAP_LAYOUT_WRITE kill-switch still applies; no privileged bypass for Vivi.
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

export function renderActionResults(results: ViviActionResult[]): string {
  return results
    .map((r) => `${r.ok ? "✓" : "✗"} ${r.tool}: ${r.summary}`)
    .join("\n")
}

export function stripActionFence(reply: string): string {
  return reply.replace(ACTION_FENCE, "").replace(/\n{3,}/g, "\n\n").trim()
}
