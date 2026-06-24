/**
 * Client-safe types for the agent CLI health surface (R11). No filesystem or
 * process access, so the status chip and setup dialog import these without
 * dragging `node:child_process`/`node:fs` into the bundle. The server-only
 * detector is in {@link file://./agents-health}.
 */

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
   *     honestly rather than guessed). Notably Claude on macOS, where the OAuth
   *     credentials live in the Keychain, not a flat file.
   */
  authenticated: boolean | null
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
  /** The shell command to install it (shown copyable; never auto-run in web). */
  installCommand: string
  /** A short one-line install hint. */
  installHint: string
  /** The command to authenticate it. */
  authCommand: string
  /** A short one-line auth hint. */
  authHint: string
}

/**
 * Install + auth guidance per agent. Static reference strings (not runtime
 * state): the official install commands for Claude Code and the Codex CLI, and
 * the login commands. Shown copyable in the setup panel; the web build never
 * auto-runs an install (native auto-install can come with Tauri later).
 */
export const AGENT_GUIDANCE: Record<AgentKey, AgentGuidance> = {
  claude: {
    label: "Claude Code",
    installCommand: "npm install -g @anthropic-ai/claude-code",
    installHint: "Install the Claude Code CLI globally, then restart your shell.",
    authCommand: "claude",
    authHint: "Run `claude` once and complete the in-terminal sign-in.",
  },
  codex: {
    label: "Codex CLI",
    installCommand: "npm install -g @openai/codex",
    installHint: "Install the Codex CLI globally (or `brew install codex`).",
    authCommand: "codex login",
    authHint: "Run `codex login` to authenticate with your ChatGPT account.",
  },
}
