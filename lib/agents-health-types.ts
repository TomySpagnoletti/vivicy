// Client-safe: must never import node:fs/node:child_process (dragged into the client bundle). Server-only detector: agents-health.ts.

export type AuthMethod = "subscription" | "api_key"

// Fields here reach the client bundle — never add a token/secret field.
export interface AgentHealth {
  present: boolean
  version: string | null
  authenticated: boolean | null
  authMethod: AuthMethod | null
  plan: string | null
}

export interface AgentsHealth {
  claude: AgentHealth
  codex: AgentHealth
}

export type AgentKey = "claude" | "codex"

// updateCommand alone is exec'd server-side (POST /api/agents/update, allow-listed + fixed); docsUrl/authCommand/installHint are display/navigation-only, never auto-run.
export interface AgentGuidance {
  label: string
  docsUrl: string
  installHint: string
  authCommand: string
  authHint: string
  updateCommand: string
}

export const AGENT_GUIDANCE: Record<AgentKey, AgentGuidance> = {
  claude: {
    label: "Claude Code",
    docsUrl: "https://code.claude.com/docs/en/quickstart",
    installHint: "Install the Claude Code CLI globally, then restart your shell.",
    authCommand: "claude",
    authHint: "Run `claude` once and complete the in-terminal sign-in.",
    updateCommand: "claude update",
  },
  codex: {
    label: "Codex CLI",
    docsUrl: "https://learn.chatgpt.com/docs/codex/cli",
    installHint: "Install the Codex CLI globally, then restart your shell.",
    authCommand: "codex login",
    authHint: "Run `codex login` to authenticate with your ChatGPT account.",
    updateCommand: "codex update",
  },
}
