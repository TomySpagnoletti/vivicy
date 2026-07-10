export type Provider = "claude" | "codex"

export type Role = "implementer" | "reviewer"

export const PROVIDERS: readonly Provider[] = ["claude", "codex"] as const

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
} as const

export interface ModelCapability {
  efforts: readonly string[]
  fast: boolean
}

export const CLI_HEADLESS_FAST: Record<Provider, boolean> = {
  claude: true,
  codex: true,
} as const

const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const

export const MODELS: Record<Provider, readonly { id: string; capability: ModelCapability }[]> = {
  claude: [
    { id: "claude-opus-4-8", capability: { efforts: CLAUDE_EFFORTS, fast: true } },
    { id: "claude-opus-4-7", capability: { efforts: CLAUDE_EFFORTS, fast: true } },
    { id: "claude-opus-4-6", capability: { efforts: CLAUDE_EFFORTS, fast: true } },
    { id: "claude-opus-4-5", capability: { efforts: CLAUDE_EFFORTS, fast: false } },
  ],
  codex: [
    { id: "gpt-5.5", capability: { efforts: CODEX_EFFORTS, fast: true } },
    { id: "gpt-5.4", capability: { efforts: CODEX_EFFORTS, fast: true } },
    { id: "gpt-5.4-mini", capability: { efforts: CODEX_EFFORTS, fast: false } },
    { id: "gpt-5.3-codex-spark", capability: { efforts: [], fast: false } },
  ],
} as const

export const MODEL_IDS: Record<Provider, readonly string[]> = {
  claude: MODELS.claude.map((m) => m.id),
  codex: MODELS.codex.map((m) => m.id),
} as const

export const DEFAULT_MODEL: Record<Provider, string> = {
  claude: MODELS.claude[0].id,
  codex: MODELS.codex[0].id,
} as const

export const DEFAULT_EFFORT: Record<Provider, string> = {
  claude: "xhigh",
  codex: "high",
} as const

export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  claude: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
} as const

export interface AgentSettings {
  provider: Provider
  model: string
  effort: string
  fast: boolean
}

export interface AgentsSettings {
  implementer: AgentSettings
  reviewer: AgentSettings
  maxParallel: number
  // true drops Vivicy's security-audit guarantee for installed skills.
  allowUnsafeSkills: boolean
}

export const MIN_PARALLEL = 1
export const MAX_PARALLEL = 12

// Must mirror the dev-loop's DEFAULT_CONFIG — the two are not otherwise kept in sync.
export const DEFAULT_SETTINGS: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
  reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
  maxParallel: 1,
  allowUnsafeSkills: false,
} as const

export function modelCapability(provider: Provider, model: string): ModelCapability | null {
  const entry = MODELS[provider].find((m) => m.id === model)
  return entry ? entry.capability : null
}

export function effortsForModel(provider: Provider, model: string): readonly string[] {
  const cap = modelCapability(provider, model)
  if (cap) return cap.efforts
  return EFFORT_LEVELS[provider]
}

export function modelSupportsFast(provider: Provider, model: string): boolean {
  if (!CLI_HEADLESS_FAST[provider]) return false
  const cap = modelCapability(provider, model)
  return cap ? cap.fast : false
}

export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex"
}

export function otherProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude"
}

export function isValidEffort(provider: Provider, model: string, effort: unknown): effort is string {
  return typeof effort === "string" && effortsForModel(provider, model).includes(effort)
}

export function clampMaxParallel(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < MIN_PARALLEL) return MIN_PARALLEL
  return n > MAX_PARALLEL ? MAX_PARALLEL : n
}

function defaultEffortFor(provider: Provider, model: string): string {
  const allowed = effortsForModel(provider, model)
  if (allowed.length === 0) return ""
  const preferred = DEFAULT_EFFORT[provider]
  return allowed.includes(preferred) ? preferred : allowed[0]
}

function defaultAgentFor(provider: Provider): AgentSettings {
  const model = DEFAULT_MODEL[provider]
  return { provider, model, effort: defaultEffortFor(provider, model), fast: false }
}

function coerceAgent(input: unknown, provider: Provider): AgentSettings {
  const raw = (input ?? {}) as Partial<AgentSettings>
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_MODEL[provider]
  const effort = isValidEffort(provider, model, raw.effort) ? raw.effort : defaultEffortFor(provider, model)
  const fast = raw.fast === true && modelSupportsFast(provider, model)
  return { provider, model, effort, fast }
}

export function resolveAssignment(input: unknown): Record<Role, Provider> {
  const raw = (input ?? {}) as Partial<AgentsSettings>
  const implementer = isProvider(raw.implementer?.provider)
    ? (raw.implementer!.provider as Provider)
    : DEFAULT_SETTINGS.implementer.provider
  let reviewer = isProvider(raw.reviewer?.provider)
    ? (raw.reviewer!.provider as Provider)
    : DEFAULT_SETTINGS.reviewer.provider
  if (reviewer === implementer) reviewer = otherProvider(implementer)
  return { implementer, reviewer }
}

export function normalizeSettings(input: unknown): AgentsSettings {
  const raw = (input ?? {}) as Partial<AgentsSettings>
  const assignment = resolveAssignment(input)
  return {
    implementer: coerceAgent(raw.implementer, assignment.implementer),
    reviewer: coerceAgent(raw.reviewer, assignment.reviewer),
    maxParallel: clampMaxParallel(raw.maxParallel),
    allowUnsafeSkills: raw.allowUnsafeSkills === true,
  }
}

export function isDistinctAssignment(settings: AgentsSettings): boolean {
  return settings.implementer.provider !== settings.reviewer.provider
}

export function isAgentCompatible(agent: AgentSettings): boolean {
  const { provider, model, effort, fast } = agent
  const allowed = effortsForModel(provider, model)
  const effortOk = allowed.length === 0 ? effort === "" : allowed.includes(effort)
  const fastOk = fast ? modelSupportsFast(provider, model) : true
  return effortOk && fastOk
}

export function isSettingsValid(settings: AgentsSettings): boolean {
  return (
    isDistinctAssignment(settings) &&
    isAgentCompatible(settings.implementer) &&
    isAgentCompatible(settings.reviewer)
  )
}

export function agentDefaultsFor(provider: Provider): AgentSettings {
  return defaultAgentFor(provider)
}

export function withModel(agent: AgentSettings, model: string): AgentSettings {
  return coerceAgent({ ...agent, model }, agent.provider)
}

export function settingsToEnv(settings: AgentsSettings): Record<string, string> {
  const byProvider: Record<Provider, AgentSettings> = {
    claude: settings.implementer.provider === "claude" ? settings.implementer : settings.reviewer,
    codex: settings.implementer.provider === "codex" ? settings.implementer : settings.reviewer,
  }
  const fastFlag = (a: AgentSettings) => (a.fast && modelSupportsFast(a.provider, a.model) ? "1" : "0")
  return {
    VIVICY_IMPLEMENTER_CLI: settings.implementer.provider,
    VIVICY_REVIEWER_CLI: settings.reviewer.provider,
    VIVICY_CLAUDE_MODEL: byProvider.claude.model,
    VIVICY_CLAUDE_EFFORT: byProvider.claude.effort,
    VIVICY_CLAUDE_FAST: fastFlag(byProvider.claude),
    VIVICY_CODEX_MODEL: byProvider.codex.model,
    VIVICY_CODEX_EFFORT: byProvider.codex.effort,
    VIVICY_CODEX_FAST: fastFlag(byProvider.codex),
    VIVICY_MAX_PARALLEL: String(clampMaxParallel(settings.maxParallel)),
    VIVICY_ALLOW_UNSAFE_SKILLS: settings.allowUnsafeSkills === true ? "1" : "0",
  }
}
