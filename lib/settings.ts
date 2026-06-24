/**
 * Vivicy agent settings: per-role CLI assignment + per-role model + thinking-level
 * schema, defaults, and validation. Client-safe (no filesystem access) so client
 * components can import the types, defaults, and allowed levels. The filesystem
 * store lives in {@link file://./settings-store} (server-only).
 *
 * Two user-tunable knobs:
 *   - ROLE ASSIGNMENT (R12): which CLI fills each role. The implementer and the
 *     reviewer must be DISTINCT CLIs — the whole point of the two-agent loop is
 *     that the reviewer never authored the code, so the same CLI can never hold
 *     both roles. Defaults: implementer = Claude, reviewer = Codex.
 *   - THINKING LEVEL (P4): "always run the latest model" for both agents, but the
 *     reasoning/effort level is user-choosable. The model id stays editable too
 *     (always-latest is a default, not a lock).
 *
 * Defaults:
 *   implementer = Claude  · model claude-opus-4-8 · effort xhigh
 *   reviewer    = Codex   · model gpt-5.5-codex   · effort high
 *
 * This module is the single source of truth for the settings schema, the allowed
 * thinking levels per provider, and the defaults; the dev-loop mirrors the same
 * defaults in its DEFAULT_CONFIG and reads the assignment from the env this
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
 * Allowed thinking levels per provider (the only values the CLIs accept):
 *   - claude: `--effort` ∈ {low, medium, high, xhigh, max}
 *   - codex:  `model_reasoning_effort` ∈ {minimal, low, medium, high}
 * Defined once here; the Select UI renders these and validation rejects anything
 * outside the set so a bad value never reaches the spawned CLI.
 */
export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high"],
} as const

/** The latest known model id per CLI (a default; the model stays editable). */
export const DEFAULT_MODEL: Record<Provider, string> = {
  claude: "claude-opus-4-8",
  codex: "gpt-5.5-codex",
} as const

/** The default thinking level per CLI. */
export const DEFAULT_EFFORT: Record<Provider, string> = {
  claude: "xhigh",
  codex: "high",
} as const

/** One agent's assigned CLI + configurable model + thinking level. */
export interface AgentSettings {
  /** The CLI assigned to this role (user-assignable, R12). */
  provider: Provider
  model: string
  effort: string
}

/** The whole settings document: one block per loop role. */
export interface AgentsSettings {
  implementer: AgentSettings
  reviewer: AgentSettings
}

/**
 * The default settings. Mirrors the dev-loop's DEFAULT_CONFIG (these two must
 * agree). Default assignment: implementer = Claude, reviewer = Codex. Latest
 * model pinned; thinking level is the user knob.
 */
export const DEFAULT_SETTINGS: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
  reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "high" },
} as const

/** Is `value` one of the CLIs Vivicy can drive? */
export function isProvider(value: unknown): value is Provider {
  return value === "claude" || value === "codex"
}

/** The other CLI — used to repair an invalid same-CLI-both-roles assignment. */
export function otherProvider(provider: Provider): Provider {
  return provider === "claude" ? "codex" : "claude"
}

/** Is `effort` a level the given provider's CLI accepts? */
export function isValidEffort(provider: Provider, effort: unknown): effort is string {
  return typeof effort === "string" && EFFORT_LEVELS[provider].includes(effort)
}

/**
 * Build a default agent block for whatever CLI is assigned to a role. The model
 * and effort default to that CLI's latest/known values (so reassigning a role to
 * a different CLI yields sensible defaults, never a cross-CLI mismatch).
 */
function defaultAgentFor(provider: Provider): AgentSettings {
  return { provider, model: DEFAULT_MODEL[provider], effort: DEFAULT_EFFORT[provider] }
}

/**
 * Coerce one agent block from untrusted input given the CLI assigned to its role.
 * The provider is decided by the caller (assignment is resolved first, with the
 * distinct-CLI invariant enforced); here we only accept the model and a VALID
 * effort for THAT provider, falling back to the CLI's defaults otherwise.
 */
function coerceAgent(input: unknown, provider: Provider): AgentSettings {
  const raw = (input ?? {}) as Partial<AgentSettings>
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : DEFAULT_MODEL[provider]
  const effort = isValidEffort(provider, raw.effort) ? raw.effort : DEFAULT_EFFORT[provider]
  return { provider, model, effort }
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
  }
}

/** Does this settings doc satisfy the distinct-CLI invariant? */
export function isDistinctAssignment(settings: AgentsSettings): boolean {
  return settings.implementer.provider !== settings.reviewer.provider
}

/**
 * Defaults for a role when the user reassigns its CLI: switching the CLI swaps in
 * that CLI's default model + effort (so the UI never shows a cross-CLI mismatch
 * like a Claude effort level under a Codex assignment).
 */
export function agentDefaultsFor(provider: Provider): AgentSettings {
  return defaultAgentFor(provider)
}

/**
 * Translate settings into the env vars the dev-loop reads. The loop needs two
 * things: which CLI fills each ROLE, and each CLI's model + thinking level.
 *   - VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI — the role -> CLI assignment.
 *   - VIVICY_CLAUDE_* / VIVICY_CODEX_* — each CLI's model + effort, keyed by the
 *     CLI itself (so the values follow the CLI regardless of which role it fills).
 * Pure, so it lives here with the rest of the schema.
 */
export function settingsToEnv(settings: AgentsSettings): Record<string, string> {
  const byProvider: Record<Provider, AgentSettings> = {
    claude: settings.implementer.provider === "claude" ? settings.implementer : settings.reviewer,
    codex: settings.implementer.provider === "codex" ? settings.implementer : settings.reviewer,
  }
  return {
    VIVICY_IMPLEMENTER_CLI: settings.implementer.provider,
    VIVICY_REVIEWER_CLI: settings.reviewer.provider,
    VIVICY_CLAUDE_MODEL: byProvider.claude.model,
    VIVICY_CLAUDE_EFFORT: byProvider.claude.effort,
    VIVICY_CODEX_MODEL: byProvider.codex.model,
    VIVICY_CODEX_EFFORT: byProvider.codex.effort,
  }
}
