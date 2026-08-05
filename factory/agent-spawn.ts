import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { homedir } from "node:os"
import { resolve } from "node:path"
import { spawnLegAsync, spawnLegSync } from "./leg-timeout.ts"
import type { LegResult, LegTimeoutOptions } from "./leg-timeout.ts"

export interface AgentLeg {
  actor: string
  role: string
  provider?: string
  model?: string
  effort?: string
  fast?: boolean
}

export interface AgentIssue {
  id: string
  transcript_dir: string
  graph_refs?: string[]
  path?: string
  issue_path?: string
}

export const TRANSCRIPT_DIRS = {
  issues: "ISSUES",
  extraction: "EXTRACTION",
  acceptance: "ACCEPTANCE",
  retro: "RETRO",
  vivi: "VIVI",
  importDocs: "IMPORT-DOCS",
  autoskills: "AUTOSKILLS",
  changeRequests: "CHANGE-REQUESTS",
  spikes: "SPIKES",
} as const

export function issueTranscriptDir(issueId: string): string {
  return `${TRANSCRIPT_DIRS.issues}/${issueId}`
}

// The subpath comes from an agent-writable file and this is its only traversal guard — never weaken it.
export function transcriptDirRel(transcriptsDir: string, issue: AgentIssue): string {
  const subdir = issue.transcript_dir
  const segments = typeof subdir === "string" ? subdir.split("/") : []
  if (
    segments.length === 0 ||
    subdir.includes("\\") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(
      `agent-spawn: "${String(subdir)}" is not a usable transcript directory for "${String(issue.id)}" — it must be a plain relative subpath of ${transcriptsDir}.`
    )
  }
  return `${transcriptsDir}/${subdir}`
}

export interface LegConfig {
  promptsDir?: string
  transcriptsDir?: string
}

export interface LegDeps {
  composePrompt: (template: string, issue: AgentIssue) => string
  agentCliArgs: (provider: string, leg: AgentLeg) => string[]
  abs: (rel: string) => string
  execRoot: string
  cwdFilter?: string | null
}

// How full the CLI conversation is, normalized across providers: the prompt the last request actually sent, against the model's window.
export interface ContextPressure {
  used: number
  window: number
}

export interface LegRunResult {
  result: LegResult
  output: string
  transcriptRel: string | undefined
  reply: string
  sessionId: string | undefined
  context?: ContextPressure
}

export interface LegTurn {
  resumeSessionId?: string
  measureContext?: boolean
}

export interface ClaudeLegTurn extends LegTurn {
  jsonReply?: boolean
}

interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: LegTimeoutOptions
}

export function spawnTee(command: string, args: string[], options: SpawnOptions = {}): LegResult {
  return spawnLegSync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout })
}

export function spawnTeeAsync(command: string, args: string[], options: SpawnOptions = {}): Promise<LegResult> {
  return spawnLegAsync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout })
}

export function combinedOutput(result: LegResult | null | undefined): string {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`
}

const AGENT_ENV_ISOLATED_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_"]
const AGENT_ENV_ISOLATED_NAMES = new Set(["CLAUDECODE"])

// Every family passes through WHOLE, endpoints included: a family split in half preserves a credential nothing can use.
export const AGENT_ENV_AUTH_FAMILIES: Record<string, readonly string[]> = {
  anthropicFirstParty: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_CUSTOM_HEADERS",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
  ],
  anthropicOidcFederation: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SCOPE",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
  ],
  providerSelectors: [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  providerSkipAuth: [
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  ],
  providerCredentials: ["ANTHROPIC_AWS_API_KEY", "ANTHROPIC_BEDROCK_MANTLE_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY"],
  providerEndpoints: [
    "ANTHROPIC_AWS_BASE_URL",
    "ANTHROPIC_AWS_WORKSPACE_ID",
    "ANTHROPIC_BEDROCK_BASE_URL",
    "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
    "ANTHROPIC_FOUNDRY_BASE_URL",
    "ANTHROPIC_FOUNDRY_RESOURCE",
    "ANTHROPIC_VERTEX_BASE_URL",
    "ANTHROPIC_VERTEX_PROJECT_ID",
  ],
  codex: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY"],
}

export const AGENT_ENV_AUTH_PASSTHROUGH = new Set(Object.values(AGENT_ENV_AUTH_FAMILIES).flat())

export function isolateAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (AGENT_ENV_AUTH_PASSTHROUGH.has(name)) {
      env[name] = value
      continue
    }
    if (AGENT_ENV_ISOLATED_NAMES.has(name)) continue
    if (AGENT_ENV_ISOLATED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue
    env[name] = value
  }
  return env
}

// Never inject progress env here: a leg does no self-reporting, the orchestrator emits progress itself.
export function agentEnv(): NodeJS.ProcessEnv {
  return isolateAgentEnv(process.env)
}

function agentHome(overrideName: string, defaultLeaf: string): string {
  const override = process.env[overrideName]
  return override && override.length > 0 ? resolve(override) : resolve(homedir(), defaultLeaf)
}

export type LegPromptErrorCode = "prompts_dir_unset" | "invalid_leg_role" | "unknown_leg_role" | "prompt_unreadable" | "empty_leg_prompt"

export class LegPromptError extends Error {
  code: LegPromptErrorCode
  role: string
  promptPath: string | null
  constructor(message: string, code: LegPromptErrorCode, role: string, promptPath: string | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "LegPromptError"
    this.code = code
    this.role = role
    this.promptPath = promptPath
  }
}

const PROMPT_EXT = ".md"
export const LEG_ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function legRoles(promptsDir: string): string[] {
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(PROMPT_EXT))
    .map((entry) => entry.name.slice(0, -PROMPT_EXT.length))
    .sort()
}

function describeValidRoles(promptsDir: string): string {
  let roles: string[]
  try {
    roles = legRoles(promptsDir)
  } catch {
    return `The prompt directory ${promptsDir} could not be listed.`
  }
  if (roles.length === 0) return `No prompt file exists under ${promptsDir}.`
  return `Valid roles (one per prompt file under ${promptsDir}): ${roles.join(", ")}.`
}

// promptsDir is an absolute FACTORY path — never resolve it against the target project.
export function readPrompt(cfg: LegConfig, role: string): string {
  const promptsDir = cfg.promptsDir
  if (typeof promptsDir !== "string" || promptsDir.trim().length === 0) {
    throw new LegPromptError(
      `agent-spawn: cannot resolve the prompt for leg role "${String(role)}" — the leg config carries no promptsDir (an absolute factory prompts path is required).`,
      "prompts_dir_unset",
      String(role),
      null
    )
  }
  if (typeof role !== "string" || !LEG_ROLE_PATTERN.test(role)) {
    throw new LegPromptError(
      `agent-spawn: "${String(role)}" is not a valid leg role — a role is lowercase kebab-case and names its prompt file <role>${PROMPT_EXT} under ${promptsDir}. ${describeValidRoles(promptsDir)}`,
      "invalid_leg_role",
      String(role),
      null
    )
  }
  const promptPath = resolve(promptsDir, `${role}${PROMPT_EXT}`)
  let template: string
  try {
    template = readFileSync(promptPath, "utf8")
  } catch (cause) {
    const errno = (cause as { code?: string } | null)?.code
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      throw new LegPromptError(
        `agent-spawn: leg role "${role}" has no prompt file — expected ${promptPath}. ${describeValidRoles(promptsDir)}`,
        "unknown_leg_role",
        role,
        promptPath,
        cause
      )
    }
    throw new LegPromptError(
      `agent-spawn: leg role "${role}" has a prompt file that could not be read (${errno ?? "unknown error"}) — ${promptPath}.`,
      "prompt_unreadable",
      role,
      promptPath,
      cause
    )
  }
  if (template.trim().length === 0) {
    throw new LegPromptError(
      `agent-spawn: leg role "${role}" resolves to an empty prompt file (${promptPath}) — a leg must never run on a blank prompt.`,
      "empty_leg_prompt",
      role,
      promptPath
    )
  }
  return template
}

// The CLI's per-session project dir name is not derivable — the scan over every project dir is required.
export function claudeRolloutPath(uuid: string): string | null {
  const projectsDir = resolve(agentHome("CLAUDE_CONFIG_DIR", ".claude"), "projects")
  if (!existsSync(projectsDir)) return null
  for (const sub of readdirSync(projectsDir)) {
    const candidate = resolve(projectsDir, sub, `${uuid}.jsonl`)
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function captureClaudeTranscript(uuid: string, destAbs: string): boolean {
  const rollout = claudeRolloutPath(uuid)
  if (rollout === null) return false
  copyFileSync(rollout, destAbs)
  try {
    return statSync(destAbs).size > 0
  } catch {
    return false
  }
}

type RolloutLine = {
  cwd?: unknown
  payload?: { cwd?: unknown; session_meta?: { cwd?: unknown } }
  session_meta?: { cwd?: unknown }
}

export function findNewestCodexRollout(sinceMs: number, cwdFilter: string | null = null): string | null {
  const base = resolve(agentHome("CODEX_HOME", ".codex"), "sessions")
  if (!existsSync(base)) return null
  let best: string | null = null
  let bestMtime = sinceMs - 1
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.name.endsWith(".jsonl")) {
        let mtime: number
        try {
          mtime = statSync(full).mtimeMs
        } catch {
          continue
        }
        if (mtime >= sinceMs && mtime > bestMtime && rolloutMatchesCwd(full, cwdFilter)) {
          best = full
          bestMtime = mtime
        }
      }
    }
  }
  walk(base)
  return best
}

export function readCodexSessionId(rolloutPath: string): string | undefined {
  let first: string
  try {
    first = readFileSync(rolloutPath, "utf8").split("\n", 1)[0] ?? ""
  } catch {
    return undefined
  }
  let line: { payload?: { session_id?: unknown } }
  try {
    line = JSON.parse(first) as { payload?: { session_id?: unknown } }
  } catch {
    return undefined
  }
  const id = line?.payload?.session_id
  return isLegSessionId(id) ? id : undefined
}

function rolloutLines(rolloutPath: string): string[] {
  try {
    return readFileSync(rolloutPath, "utf8").split("\n")
  } catch {
    return []
  }
}

function positiveInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

// The prompt of the rollout's LAST request IS the conversation's current occupancy; the envelope's own `usage` sums a turn's requests and would double what is actually in the window.
export function readClaudeContextUsed(rolloutPath: string): { tokens: number; model: string } | null {
  const lines = rolloutLines(rolloutPath)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"usage"')) continue
    let row: { type?: unknown; message?: { model?: unknown; usage?: Record<string, unknown> } }
    try {
      row = JSON.parse(lines[i]) as typeof row
    } catch {
      continue
    }
    const usage = row?.type === "assistant" ? row.message?.usage : undefined
    const model = row?.message?.model
    if (usage === null || typeof usage !== "object" || typeof model !== "string" || model.length === 0) continue
    const tokens =
      positiveInt(usage.input_tokens) + positiveInt(usage.cache_read_input_tokens) + positiveInt(usage.cache_creation_input_tokens)
    if (tokens > 0) return { tokens, model }
  }
  return null
}

// codex keeps its own accounting: the last `token_count` event carries both the prompt that turn sent and the model's window.
export function readCodexContextPressure(rolloutPath: string): ContextPressure | null {
  const lines = rolloutLines(rolloutPath)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].includes('"token_count"')) continue
    let row: { payload?: { type?: unknown; info?: { last_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } } }
    try {
      row = JSON.parse(lines[i]) as typeof row
    } catch {
      continue
    }
    if (row?.payload?.type !== "token_count") continue
    const used = positiveInt(row.payload.info?.last_token_usage?.total_tokens)
    const window = positiveInt(row.payload.info?.model_context_window)
    if (used > 0 && window > 0) return { used, window }
  }
  return null
}

// A compaction is witnessed by the rollout's own boundary and NEVER by what the leg replied — a model asked to compact answers that it did whether or not anything happened (measured on `codex exec`, which has no compaction at all). Every trigger the CLI writes counts: an auto or refusal boundary relieves the conversation exactly as a manual one does.
export function compactBoundaryTriggers(rolloutPath: string): string[] {
  const triggers: string[] = []
  for (const line of rolloutLines(rolloutPath)) {
    if (!line.includes("compact_boundary")) continue
    let row: { type?: unknown; subtype?: unknown; compactMetadata?: { trigger?: unknown } }
    try {
      row = JSON.parse(line) as typeof row
    } catch {
      continue
    }
    if (row?.type !== "system" || row?.subtype !== "compact_boundary") continue
    const trigger = row.compactMetadata?.trigger
    triggers.push(typeof trigger === "string" && trigger.length > 0 ? trigger : "unknown")
  }
  return triggers
}

export function rolloutMatchesCwd(rolloutPath: string, cwdFilter: string | null): boolean {
  if (!cwdFilter) return true
  let recorded: string | null = null
  try {
    const text = readFileSync(rolloutPath, "utf8")
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue
      let obj: RolloutLine
      try {
        obj = JSON.parse(line.trim()) as RolloutLine
      } catch {
        continue
      }
      const cwd = obj?.cwd ?? obj?.payload?.cwd ?? obj?.session_meta?.cwd ?? obj?.payload?.session_meta?.cwd
      if (typeof cwd === "string" && cwd) {
        recorded = cwd
        break
      }
    }
  } catch {
    return true
  }
  if (recorded === null) return true
  return resolve(recorded) === resolve(cwdFilter)
}

export function ensureTranscriptDir(absTranscriptDir: string): void {
  mkdirSync(absTranscriptDir, { recursive: true })
}

// These flags are the whole boundary keeping the machine's own config, skills, plugins, hooks and MCP servers out of every leg — never drop one.
export const CLAUDE_ISOLATION_ARGS = ["--safe-mode"]
export const CODEX_ISOLATION_ARGS = [
  "--ignore-user-config",
  "--ignore-rules",
  "-c",
  "skills.include_instructions=false",
  "--disable",
  "plugins",
  "--disable",
  "apps",
]

export const LEG_SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isLegSessionId(value: unknown): value is string {
  return typeof value === "string" && LEG_SESSION_ID_PATTERN.test(value)
}

export function resumeIdOf(turn: LegTurn): string | undefined {
  const id = turn.resumeSessionId
  if (id === undefined) return undefined
  if (!isLegSessionId(id)) {
    throw new Error(
      `agent-spawn: "${String(id)}" is not a usable session id to resume — it must be the lowercase-hex uuid the CLI itself minted.`
    )
  }
  return id
}

export function buildClaudeArgs({
  prompt,
  sessionId,
  resume = false,
  jsonReply = false,
  modelArgs,
}: {
  prompt: string
  sessionId: string
  resume?: boolean
  jsonReply?: boolean
  modelArgs: string[]
}): string[] {
  return [
    "-p",
    prompt,
    ...CLAUDE_ISOLATION_ARGS,
    "--dangerously-skip-permissions",
    resume ? "--resume" : "--session-id",
    sessionId,
    ...(jsonReply ? ["--output-format", "json"] : []),
    ...modelArgs,
  ]
}

export function buildCodexArgs({
  prompt,
  root,
  resumeSessionId,
  modelArgs,
}: {
  prompt: string
  root: string
  resumeSessionId?: string
  modelArgs: string[]
}): string[] {
  const args = resumeSessionId ? ["exec", "resume", resumeSessionId, prompt] : ["exec", prompt]
  args.push(...CODEX_ISOLATION_ARGS, "--dangerously-bypass-approvals-and-sandbox")
  if (!resumeSessionId) args.push("-C", root)
  args.push("--skip-git-repo-check", ...modelArgs)
  return args
}

export interface SpokenReply {
  reply: string
  sessionId?: string
  contextWindows?: Map<string, number>
}

// Keyed by the CLI's own full model id, which is what the rollout's assistant lines name — the window is then a JOIN, never a guess about which model carried the conversation.
function modelContextWindows(source: unknown): Map<string, number> | undefined {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return undefined
  const windows = new Map<string, number>()
  for (const [model, entry] of Object.entries(source as Record<string, unknown>)) {
    const window = positiveInt((entry as { contextWindow?: unknown } | null)?.contextWindow)
    if (window > 0) windows.set(model, window)
  }
  return windows.size > 0 ? windows : undefined
}

export function readReply(stdout: string, jsonReply: boolean): SpokenReply {
  if (!jsonReply) return { reply: stdout.trim() }
  let envelope: unknown
  try {
    envelope = JSON.parse(stdout)
  } catch {
    return { reply: "" }
  }
  if (envelope === null || typeof envelope !== "object") return { reply: "" }
  const { is_error: isError, result, session_id: sessionId, modelUsage } = envelope as Record<string, unknown>
  return {
    reply: isError !== true && typeof result === "string" ? result.trim() : "",
    sessionId: isLegSessionId(sessionId) ? sessionId : undefined,
    contextWindows: modelContextWindows(modelUsage),
  }
}

function claudeContextPressure(uuid: string, windows: Map<string, number> | undefined): ContextPressure | undefined {
  if (windows === undefined) return undefined
  const rollout = claudeRolloutPath(uuid)
  if (rollout === null) return undefined
  const used = readClaudeContextUsed(rollout)
  const window = used === null ? undefined : windows.get(used.model)
  return used === null || window === undefined ? undefined : { used: used.tokens, window }
}

export function runClaudeLeg(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps, turn: ClaudeLegTurn = {}): LegRunResult {
  return runClaudeLegWith(leg, issue, cfg, deps, turn, spawnTee, captureClaudeTranscript) as LegRunResult
}

export async function runClaudeLegAsync(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  turn: ClaudeLegTurn = {}
): Promise<LegRunResult> {
  return runClaudeLegWith(leg, issue, cfg, deps, turn, spawnTeeAsync, captureClaudeTranscript, true) as Promise<LegRunResult>
}

function runClaudeLegWith(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  turn: ClaudeLegTurn,
  spawnFn: typeof spawnTee | typeof spawnTeeAsync,
  captureFn: typeof captureClaudeTranscript,
  isAsync = false
): LegRunResult | Promise<LegRunResult> {
  const { composePrompt, agentCliArgs, abs, execRoot } = deps
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue)
  const resumeId = resumeIdOf(turn)
  const sessionId = resumeId ?? randomUUID()
  const jsonReply = turn.jsonReply === true
  const dirRel = transcriptDirRel(cfg.transcriptsDir!, issue)
  const transcriptRel = `${dirRel}/claude-${leg.role}-${sessionId}.jsonl`
  const args = buildClaudeArgs({ prompt, sessionId, resume: resumeId !== undefined, jsonReply, modelArgs: agentCliArgs("claude", leg) })
  const options = { cwd: execRoot, env: agentEnv() }
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(abs(dirRel))
    const captured = captureFn(sessionId, abs(transcriptRel))
    const spoken = readReply(result.stdout, jsonReply)
    return {
      result,
      output: combinedOutput(result),
      transcriptRel: captured ? transcriptRel : undefined,
      reply: spoken.reply,
      sessionId: spoken.sessionId ?? sessionId,
      context: turn.measureContext === true ? claudeContextPressure(sessionId, spoken.contextWindows) : undefined,
    }
  }
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("claude", args, options).then(finish)
  return finish((spawnFn as typeof spawnTee)("claude", args, options))
}

export function runCodexLeg(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps, turn: LegTurn = {}): LegRunResult {
  return runCodexLegWith(leg, issue, cfg, deps, turn, spawnTee, false) as LegRunResult
}

export async function runCodexLegAsync(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  turn: LegTurn = {}
): Promise<LegRunResult> {
  return runCodexLegWith(leg, issue, cfg, deps, turn, spawnTeeAsync, true) as Promise<LegRunResult>
}

function runCodexLegWith(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  turn: LegTurn,
  spawnFn: typeof spawnTee | typeof spawnTeeAsync,
  isAsync: boolean
): LegRunResult | Promise<LegRunResult> {
  const { composePrompt, agentCliArgs, abs, execRoot, cwdFilter } = deps
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue)
  const resumeId = resumeIdOf(turn)
  const dirRel = transcriptDirRel(cfg.transcriptsDir!, issue)
  const transcriptRel = `${dirRel}/codex-${leg.role}-${resumeId ?? randomUUID()}.jsonl`
  const args = buildCodexArgs({ prompt, root: execRoot, resumeSessionId: resumeId, modelArgs: agentCliArgs("codex", leg) })
  const options = { cwd: execRoot, env: agentEnv() }
  const startMs = Date.now()
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(abs(dirRel))
    const output = combinedOutput(result)
    const reply = readReply(result.stdout, false).reply
    const rollout = findNewestCodexRollout(startMs, cwdFilter ?? null)
    if (rollout) {
      copyFileSync(rollout, abs(transcriptRel))
      const context = turn.measureContext === true ? (readCodexContextPressure(rollout) ?? undefined) : undefined
      return { result, output, transcriptRel, reply, sessionId: readCodexSessionId(rollout) ?? resumeId, context }
    }
    return { result, output, transcriptRel: undefined, reply, sessionId: resumeId }
  }
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("codex", args, options).then(finish)
  return finish((spawnFn as typeof spawnTee)("codex", args, options))
}
