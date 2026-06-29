/**
 * Vivicy agent settings: per-role CLI assignment + per-role model + thinking-level
 * + fast-mode schema, defaults, and STRICT per-model compatibility. Client-safe (no
 * filesystem access) so client components can import the types, defaults, model
 * lists, and the compatibility map. The filesystem store lives in
 * {@link file://./settings-store} (server-only).
 *
 * Three user-tunable knobs: role assignment (R12), model + thinking level (P4),
 * and a per-role fast-mode toggle. The implementer and reviewer must be DISTINCT
 * CLIs — the two-agent loop only works if the reviewer never authored the code,
 * so one CLI can never hold both roles.
 *
 * Reference docs (verified 2026-06):
 *   - Claude — https://code.claude.com/docs/en/fast-mode
 *   - Codex — https://developers.openai.com/codex/config-reference
 *
 * This module is the single source of truth for the settings schema, the model
 * lists, the per-model compatibility map, and the defaults; the dev-loop mirrors
 * the same defaults + capability facts and reads the assignment from the env this
 * module emits.
 */

/** Agent CLIs Vivicy knows how to drive. */
export type Provider = "claude" | "codex"

/** The two loop roles. */
export type Role = "implementer" | "reviewer"

/** Every CLI Vivicy can assign to a role. */
export const PROVIDERS: readonly Provider[] = ["claude", "codex"] as const

/** Human label for each CLI shown in the UI. */
export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
} as const

/**
 * Per-model capability: the exact reasoning/effort levels the model accepts, and
 * whether fast mode genuinely functions for it on the HEADLESS run the dev-loop
 * drives. This is the strict compatibility contract — the UI filters its controls
 * by it and validation repairs anything outside it.
 */
export interface ModelCapability {
  /** Effort levels this model accepts (empty => the model has no thinking control). */
  efforts: readonly string[]
  /** Does fast mode genuinely function for this model on the headless run? */
  fast: boolean
}

/**
 * Does the CLI have a fast mechanism that affects the HEADLESS run the dev-loop
 * uses? When false, the fast toggle is disabled for every one of that CLI's models
 * — we never offer a non-functional toggle.
 */
export const CLI_HEADLESS_FAST: Record<Provider, boolean> = {
  claude: true,
  codex: true,
} as const

/** All Claude effort levels the CLI accepts (`--effort`). */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const
/** Codex reasoning effort levels (`model_reasoning_effort`). */
const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const

/**
 * The curated model list per CLI, newest first; the first entry is each CLI's
 * default. Each model carries its own compatibility (allowed efforts + fast
 * support). gpt-5.3-codex-spark is the speed-first model: no reasoning levels and
 * no fast toggle.
 */
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

/** The curated model ids per CLI (UI list order = newest first). */
export const MODEL_IDS: Record<Provider, readonly string[]> = {
  claude: MODELS.claude.map((m) => m.id),
  codex: MODELS.codex.map((m) => m.id),
} as const

/** The latest known model id per CLI (a default; the model stays user-choosable). */
export const DEFAULT_MODEL: Record<Provider, string> = {
  claude: MODELS.claude[0].id,
  codex: MODELS.codex[0].id,
} as const

/** The default thinking level per CLI (must be valid for that CLI's default model). */
export const DEFAULT_EFFORT: Record<Provider, string> = {
  claude: "xhigh",
  codex: "high",
} as const

/**
 * Allowed thinking levels per provider — the UNION over the provider's models, for
 * back-compat with callers that ask "what does this CLI accept at all". The strict,
 * per-MODEL set lives in {@link MODELS}; UI + validation use {@link effortsForModel}.
 */
export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  claude: CLAUDE_EFFORTS,
  codex: CODEX_EFFORTS,
} as const

/** One agent's assigned CLI + configurable model + thinking level + fast flag. */
export interface AgentSettings {
  /** The CLI assigned to this role (user-assignable, R12). */
  provider: Provider
  model: string
  effort: string
  /** Fast inference for this role — only ever true for a fast-capable model+CLI. */
  fast: boolean
}

/** The whole settings document: one block per loop role, plus the concurrency knob. */
export interface AgentsSettings {
  implementer: AgentSettings
  reviewer: AgentSettings
  /**
   * Maximum number of INDEPENDENT issues the dev-loop runs concurrently, each in
   * its own git worktree. 1 = the sequential default (one issue at a time, today's
   * exact behavior); >1 enables the parallel scheduler. Clamped to an integer in
   * [MIN_PARALLEL, MAX_PARALLEL] = [1, 12]; a value below 1 (or unparseable) falls
   * back to 1 and a value above 12 is capped at 12.
   */
  maxParallel: number
}

/** Lower/upper bounds for the concurrency knob (UI + validation share these). */
export const MIN_PARALLEL = 1
export const MAX_PARALLEL = 12

/**
 * The default settings. Mirrors the dev-loop's DEFAULT_CONFIG (these two must
 * agree). Fast is off by default because it consumes the quota much faster, and
 * maxParallel defaults to 1 (the sequential loop).
 */
export const DEFAULT_SETTINGS: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
  reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
  maxParallel: 1,
} as const

// --------------------------------------------------------------------------
// Compatibility lookups (the strict per-model contract)
// --------------------------------------------------------------------------

/** The capability record for a given provider+model, or null when the model is custom. */
export function modelCapability(provider: Provider, model: string): ModelCapability | null {
  const entry = MODELS[provider].find((m) => m.id === model)
  return entry ? entry.capability : null
}

/**
 * The effort levels valid for a given provider+model. For a KNOWN model this is the
 * model's own set (which may be empty — e.g. gpt-5.3-codex-spark has no reasoning
 * control). For a CUSTOM (persisted-but-not-listed) model we fall back to the CLI's
 * full union so a hand-set model is never stranded without a usable level.
 */
export function effortsForModel(provider: Provider, model: string): readonly string[] {
  const cap = modelCapability(provider, model)
  if (cap) return cap.efforts
  return EFFORT_LEVELS[provider]
}

/**
 * Does fast mode genuinely function for this provider+model? Requires BOTH a CLI
 * with a headless fast mechanism AND a fast-capable model. A custom (unlisted)
 * model is treated as fast-INcapable: we never offer a toggle we cannot vouch for.
 */
export function modelSupportsFast(provider: Provider, model: string): boolean {
  if (!CLI_HEADLESS_FAST[provider]) return false
  const cap = modelCapability(provider, model)
  return cap ? cap.fast : false
}

/** Is `value` one of the CLIs Vivicy can drive? */
export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex"
}

/** The other CLI — used to repair an invalid same-CLI-both-roles assignment. */
export function otherProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude"
}

/** Is `effort` a level the given provider+model accepts? */
export function isValidEffort(provider: Provider, model: string, effort: unknown): effort is string {
  return typeof effort === "string" && effortsForModel(provider, model).includes(effort)
}

/** Coerce an untrusted concurrency value into an integer within [MIN, MAX]. */
export function clampMaxParallel(value: unknown): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n) || n < MIN_PARALLEL) return MIN_PARALLEL
  return n > MAX_PARALLEL ? MAX_PARALLEL : n
}

/**
 * The default effort for a provider+model: the CLI's documented default when that
 * model accepts it, else the model's first allowed level, else "" when the model
 * has no thinking control at all (e.g. gpt-5.3-codex-spark).
 */
function defaultEffortFor(provider: Provider, model: string): string {
  const allowed = effortsForModel(provider, model)
  if (allowed.length === 0) return ""
  const preferred = DEFAULT_EFFORT[provider]
  return allowed.includes(preferred) ? preferred : allowed[0]
}

/**
 * Build a default agent block for whatever CLI is assigned to a role. The model,
 * effort, and fast flag default to that CLI's latest/known values (so reassigning
 * a role to a different CLI yields sensible, compatible defaults).
 */
function defaultAgentFor(provider: Provider): AgentSettings {
  const model = DEFAULT_MODEL[provider]
  return { provider, model, effort: defaultEffortFor(provider, model), fast: false }
}

/**
 * Coerce one agent block from untrusted input given the CLI assigned to its role.
 * The provider is decided by the caller (assignment is resolved first, with the
 * distinct-CLI invariant enforced); here we accept the model, a VALID effort for
 * THAT provider+model, and a fast flag ONLY when the resolved model genuinely
 * supports fast. This is where an incompatible model+effort or model+fast combo is
 * REJECTED/REPAIRED — an impossible combination can never survive normalization.
 */
function coerceAgent(input: unknown, provider: Provider): AgentSettings {
  const raw = (input ?? {}) as Partial<AgentSettings>
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_MODEL[provider]
  // Effort must be valid for THIS model; otherwise fall back to the model's default
  // (which is "" for a model with no reasoning control).
  const effort = isValidEffort(provider, model, raw.effort) ? raw.effort : defaultEffortFor(provider, model)
  // Fast is only ever true on a model+CLI that genuinely supports it. Any request
  // to set fast on an incapable model is dropped to false.
  const fast = raw.fast === true && modelSupportsFast(provider, model)
  return { provider, model, effort, fast }
}

/**
 * Resolve the role -> CLI assignment from untrusted input, enforcing the
 * distinct-CLI invariant (implementer != reviewer). Resolution:
 *   - take each role's requested provider when it is a known CLI, else its default;
 *   - if both roles resolve to the SAME CLI, the implementer keeps its choice and
 *     the reviewer is repaired to the other CLI (so the request never strands the
 *     loop with one agent reviewing its own work).
 */
export function resolveAssignment(input: unknown): Record<Role, Provider> {
  const raw = (input ?? {}) as Partial<AgentsSettings>
  const implementer = isProvider(raw.implementer?.provider)
    ? (raw.implementer!.provider as Provider)
    : DEFAULT_SETTINGS.implementer.provider
  let reviewer = isProvider(raw.reviewer?.provider)
    ? (raw.reviewer!.provider as Provider)
    : DEFAULT_SETTINGS.reviewer.provider
  // Distinct-CLI invariant: a CLI can never review its own implementation.
  if (reviewer === implementer) reviewer = otherProvider(implementer)
  return { implementer, reviewer }
}

/** Normalize an arbitrary parsed object into a complete, valid settings doc. */
export function normalizeSettings(input: unknown): AgentsSettings {
  const raw = (input ?? {}) as Partial<AgentsSettings>
  const assignment = resolveAssignment(input)
  return {
    implementer: coerceAgent(raw.implementer, assignment.implementer),
    reviewer: coerceAgent(raw.reviewer, assignment.reviewer),
    maxParallel: clampMaxParallel(raw.maxParallel),
  }
}

/** Does this settings doc satisfy the distinct-CLI invariant? */
export function isDistinctAssignment(settings: AgentsSettings): boolean {
  return settings.implementer.provider !== settings.reviewer.provider
}

/**
 * Is one agent block internally compatible — its effort valid for its model and
 * its fast flag only set on a fast-capable model? The UI's Save guard uses this so
 * an impossible combination is never even submitted (defence in depth on top of
 * normalizeSettings).
 */
export function isAgentCompatible(agent: AgentSettings): boolean {
  const { provider, model, effort, fast } = agent
  const allowed = effortsForModel(provider, model)
  // Effort must be empty exactly when the model has no thinking control, and
  // otherwise be one of the model's allowed levels.
  const effortOk = allowed.length === 0 ? effort === "" : allowed.includes(effort)
  const fastOk = fast ? modelSupportsFast(provider, model) : true
  return effortOk && fastOk
}

/** Are both role blocks internally compatible AND distinctly assigned? */
export function isSettingsValid(settings: AgentsSettings): boolean {
  return (
    isDistinctAssignment(settings) &&
    isAgentCompatible(settings.implementer) &&
    isAgentCompatible(settings.reviewer)
  )
}

/**
 * Defaults for a role when the user reassigns its CLI: switching the CLI swaps in
 * that CLI's default model + effort + fast (so the UI never shows a cross-CLI
 * mismatch like a Claude effort level under a Codex assignment).
 */
export function agentDefaultsFor(provider: Provider): AgentSettings {
  return defaultAgentFor(provider)
}

/**
 * Re-coerce one agent block after a MODEL change so the effort + fast flag stay
 * compatible with the new model (drop fast if the new model can't, repair the
 * effort to the new model's set). Pure, used by the UI's model picker.
 */
export function withModel(agent: AgentSettings, model: string): AgentSettings {
  return coerceAgent({ ...agent, model }, agent.provider)
}

/**
 * Translate settings into the env vars the dev-loop reads. The loop needs: which
 * CLI fills each ROLE, and each CLI's model + thinking level + fast flag.
 *   - VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI — the role -> CLI assignment.
 *   - VIVICY_CLAUDE_* / VIVICY_CODEX_* — each CLI's model + effort + fast, keyed by
 *     the CLI itself (so the values follow the CLI regardless of which role it
 *     fills). The fast flag is emitted ("1") ONLY when fast is on AND the model
 *     genuinely supports it; otherwise "0" — the loop never asks a CLI for a fast
 *     run it cannot perform.
 * Pure, so it lives here with the rest of the schema.
 */
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
    // Max independent issues to run concurrently (1 = sequential default). The
    // dev-loop reads this via DEFAULT_CONFIG.maxParallel and clamps it again.
    VIVICY_MAX_PARALLEL: String(clampMaxParallel(settings.maxParallel)),
  }
}
