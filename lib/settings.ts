/**
 * Vivicy agent settings: per-agent model + thinking-level schema, defaults, and
 * validation. Client-safe (no filesystem access) so client components can import
 * the types, defaults, and allowed levels. The filesystem store lives in
 * {@link file://./settings-store} (server-only).
 *
 * Policy (owner decision, P4): "always use the latest model" for both agents,
 * but the THINKING LEVEL is user-choosable. The model id stays editable too, so
 * the owner can correct it (the Codex model id is uncertain — see DEFAULTS).
 *
 * Defaults:
 *   implementer = Claude  · model claude-opus-4-8 · effort xhigh
 *   reviewer    = Codex   · model gpt-5.5-codex   · effort high
 *
 * This module is the single source of truth for the settings schema, the allowed
 * thinking levels per provider, and the defaults; the dev-loop mirrors the same
 * defaults in its DEFAULT_CONFIG.
 */

/** Agent providers Vivicy knows how to drive. */
export type Provider = "claude" | "codex"

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

/** One agent's configurable model + thinking level. */
export interface AgentSettings {
  provider: Provider
  model: string
  effort: string
}

/** The whole settings document: one block per agent role. */
export interface AgentsSettings {
  implementer: AgentSettings
  reviewer: AgentSettings
}

/**
 * The default settings. Mirrors the dev-loop's DEFAULT_CONFIG (these two must
 * agree). Latest model pinned; thinking level is the user knob.
 */
export const DEFAULT_SETTINGS: AgentsSettings = {
  implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
  reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "high" },
} as const

/** Is `effort` a level the given provider's CLI accepts? */
export function isValidEffort(provider: Provider, effort: unknown): effort is string {
  return typeof effort === "string" && EFFORT_LEVELS[provider].includes(effort)
}

/**
 * Coerce one agent block from untrusted input, falling back to the role default
 * for any missing/invalid field. The provider is fixed per role (claude for the
 * implementer, codex for the reviewer) — it is never user-switchable, so we
 * always keep the default provider and only accept model + a VALID effort.
 */
function coerceAgent(input: unknown, fallback: AgentSettings): AgentSettings {
  const raw = (input ?? {}) as Partial<AgentSettings>
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : fallback.model
  const effort = isValidEffort(fallback.provider, raw.effort) ? raw.effort : fallback.effort
  return { provider: fallback.provider, model, effort }
}

/** Normalize an arbitrary parsed object into a complete, valid settings doc. */
export function normalizeSettings(input: unknown): AgentsSettings {
  const raw = (input ?? {}) as Partial<AgentsSettings>
  return {
    implementer: coerceAgent(raw.implementer, DEFAULT_SETTINGS.implementer),
    reviewer: coerceAgent(raw.reviewer, DEFAULT_SETTINGS.reviewer),
  }
}

/**
 * Translate settings into the env vars the dev-loop reads (VIVICY_CLAUDE_* /
 * VIVICY_CODEX_*). The control plane merges this into the supervisor's env so a
 * run uses exactly the user's chosen models + thinking levels. Pure, so it lives
 * here with the rest of the schema.
 */
export function settingsToEnv(settings: AgentsSettings): Record<string, string> {
  return {
    VIVICY_CLAUDE_MODEL: settings.implementer.model,
    VIVICY_CLAUDE_EFFORT: settings.implementer.effort,
    VIVICY_CODEX_MODEL: settings.reviewer.model,
    VIVICY_CODEX_EFFORT: settings.reviewer.effort,
  }
}
