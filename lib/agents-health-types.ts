/**
 * Client-safe types for the agent CLI health surface (R11). No filesystem or
 * process access, so the status chip and setup dialog import these without
 * dragging `node:child_process`/`node:fs` into the bundle. The server-only
 * detector is in {@link file://./agents-health}.
 */

/**
 * How an authenticated CLI bills its usage — the cost-relevant distinction:
 *   - `"subscription"` — usage counts against a plan quota (Claude Pro/Max,
 *     ChatGPT). No per-token charge.
 *   - `"api_key"`      — billed pay-per-token against a provider API account.
 */
export type AuthMethod = "subscription" | "api_key"

/** Detection result for one agent CLI. */
export interface AgentHealth {
  /** Whether the CLI was found on PATH. */
  present: boolean
  /** The `--version` string, or null when absent/unreadable. */
  version: string | null
  /**
   * Auth state:
   *   - `true`  — a usable credential was detected.
   *   - `false` — present-but-not-authenticated (a clean signal said so).
   *   - `null`  — unknown: no clean, side-effect-free signal exists (reported
   *     honestly rather than guessed), e.g. a macOS Keychain item whose secret is
   *     locked AND whose existence could not be confirmed.
   */
  authenticated: boolean | null
  /**
   * Billing method when authenticated, or `null` when not authenticated / not
   * determinable (e.g. a locked Keychain item we could only confirm exists).
   * Drives the per-agent cost note in the UI. Never carries the token itself.
   */
  authMethod: AuthMethod | null
  /**
   * Human plan label when known (e.g. `"max"`, `"pro"`, `"ChatGPT"`), else null.
   * Display-only; never a credential.
   */
  plan: string | null
}

/** Health snapshot for both agent CLIs Vivicy drives. */
export interface AgentsHealth {
  claude: AgentHealth
  codex: AgentHealth
}

/** The two agent CLIs Vivicy detects. */
export type AgentKey = "claude" | "codex"

/** Static, machine-independent guidance shown when a CLI is missing or logged out. */
export interface AgentGuidance {
  /** Human label for the CLI. */
  label: string
  /** The shell command to install it (shown copyable; never auto-run). */
  installCommand: string
  /** A short one-line install hint. */
  installHint: string
  /** The command to authenticate it. */
  authCommand: string
  /** A short one-line auth hint. */
  authHint: string
  /**
   * The CLI's OWN built-in self-update command (e.g. `claude update`), shown as
   * copyable text and run by the per-agent "Update" action. The server execs it
   * through `POST /api/agents/update` (allow-listed, fixed command).
   */
  updateCommand: string
}

/**
 * Install + auth guidance per agent. Static reference strings (not runtime
 * state): the official install commands for Claude Code and the Codex CLI, and
 * the login commands. Shown copyable in the setup panel; the install command is
 * never auto-run.
 */
export const AGENT_GUIDANCE: Record<AgentKey, AgentGuidance> = {
  claude: {
    label: "Claude Code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    installHint: "Install the Claude Code CLI globally, then restart your shell.",
    authCommand: "claude",
    authHint: "Run `claude` once and complete the in-terminal sign-in.",
    updateCommand: "claude update",
  },
  codex: {
    label: "Codex CLI",
    installCommand: "npm install -g @openai/codex",
    installHint: "Install the Codex CLI globally (or `brew install codex`).",
    authCommand: "codex login",
    authHint: "Run `codex login` to authenticate with your ChatGPT account.",
    updateCommand: "codex update",
  },
}
