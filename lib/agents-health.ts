// Server-only: node:fs/node:child_process here must never reach the client bundle (client-safe types live in agents-health-types.ts). Token value is never returned/logged/surfaced.

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { AgentHealth, AgentsHealth, AuthMethod } from "@/lib/agents-health-types"

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"

const KEYCHAIN_TIMEOUT_MS = 2_000

const CLAUDE_API_KEY_PREFIX = "sk-ant-api03-"

// exists=false → confirmed absent; secret=null+exists=true → found but locked; a null return from a probe → unprobeable (not the same as absent).
export interface KeychainResult {
  secret: string | null
  exists: boolean
}

interface AuthSignal {
  authenticated: boolean | null
  authMethod: AuthMethod | null
  plan: string | null
}

const UNAUTH: AuthSignal = { authenticated: false, authMethod: null, plan: null }
const UNKNOWN: AuthSignal = { authenticated: null, authMethod: null, plan: null }

export interface HealthProbe {
  which(bin: string): string | null
  version(bin: string): string | null
  readFile(file: string): string | null
  home(): string
  env(name: string): string | null
  platform(): NodeJS.Platform
  keychain(service: string): KeychainResult | null
}

export function normalizeVersion(raw: string | null): string | null {
  if (raw == null) return null
  let v = raw.trim()
  // Trailing ")" is optional: still cleans a truncated/malformed "--version" line like "2.1.191 (Claude Code".
  v = v.replace(/\s*\((?:claude code|claude-code)\)?\s*$/i, "")
  v = v.replace(/^(?:codex-cli|claude-code)\s+/i, "")
  return v.trim()
}

function safeExec(bin: string, args: string[]): string | null {
  try {
    const out = execFileSync(bin, args, {
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    const firstLine = out.split("\n").map((l) => l.trim()).find((l) => l.length > 0)
    return firstLine ?? null
  } catch {
    return null
  }
}

export type ExecFirstLine = (bin: string, args: string[]) => string | null

export function resolveOnPath(
  bin: string,
  platform: NodeJS.Platform,
  exec: ExecFirstLine = safeExec
): string | null {
  if (platform === "win32") {
    const resolved = exec("cmd.exe", ["/c", "where", bin])
    return resolved && path.win32.isAbsolute(resolved) ? resolved : null
  }
  // `bin` must stay a fixed internal literal ("claude"/"codex") — it's interpolated unescaped into this shell string.
  const resolved = exec("/bin/sh", ["-c", `command -v ${bin}`])
  return resolved && path.posix.isAbsolute(resolved) ? resolved : null
}

interface SecurityRun {
  code: number | null
  stdout: string
  timedOut: boolean
}

// `security` exit codes: 0 = found, 44 = not found, other (e.g. 51) = needs interactive unlock.
function runSecurity(args: string[]): SecurityRun {
  try {
    const stdout = execFileSync("/usr/bin/security", args, {
      encoding: "utf8",
      timeout: KEYCHAIN_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return { code: 0, stdout, timedOut: false }
  } catch (error) {
    const err = error as {
      status?: number | null
      killed?: boolean
      signal?: NodeJS.Signals | null
      code?: string
    }
    const timedOut =
      err.killed === true || err.signal === "SIGTERM" || err.code === "ETIMEDOUT"
    return {
      code: typeof err.status === "number" ? err.status : null,
      stdout: "",
      timedOut,
    }
  }
}

function nodeKeychain(service: string): KeychainResult | null {
  if (process.platform !== "darwin") return null
  const read = runSecurity(["find-generic-password", "-s", service, "-w"])
  if (read.timedOut) return null
  if (read.code === 0 && read.stdout.trim().length > 0) {
    return { secret: read.stdout.trim(), exists: true }
  }
  // No -w here: avoids triggering an interactive Keychain-unlock prompt.
  const exists = runSecurity(["find-generic-password", "-s", service])
  if (exists.timedOut) return null
  if (exists.code === 0) return { secret: null, exists: true }
  if (exists.code === 44) return { secret: null, exists: false }
  return null
}

export const nodeHealthProbe: HealthProbe = {
  which(bin: string): string | null {
    return resolveOnPath(bin, process.platform)
  },
  version(bin: string): string | null {
    return safeExec(bin, ["--version"])
  },
  readFile(file: string): string | null {
    try {
      return existsSync(file) ? readFileSync(file, "utf8") : null
    } catch {
      return null
    }
  },
  home(): string {
    return homedir()
  },
  env(name: string): string | null {
    const value = process.env[name]
    return typeof value === "string" && value.length > 0 ? value : null
  },
  platform(): NodeJS.Platform {
    return process.platform
  },
  keychain(service: string): KeychainResult | null {
    return nodeKeychain(service)
  },
}

export function parseCodexAuth(text: string | null): AuthSignal {
  if (!text) return UNAUTH
  try {
    const parsed = JSON.parse(text) as {
      auth_mode?: unknown
      OPENAI_API_KEY?: unknown
      tokens?: unknown
    }
    const hasApiKey =
      typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0
    if (hasApiKey || parsed.auth_mode === "apikey") {
      return { authenticated: true, authMethod: "api_key", plan: null }
    }
    const token = (parsed.tokens as { access_token?: unknown } | undefined)?.access_token
    if (typeof token === "string" && token.length > 0) {
      return { authenticated: true, authMethod: "subscription", plan: "ChatGPT" }
    }
    return UNAUTH
  } catch {
    return UNAUTH
  }
}

export function parseClaudeCredentials(text: string | null): AuthSignal | null {
  if (!text) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const root = parsed as Record<string, unknown>
  const wrapped = root.claudeAiOauth
  const inner =
    typeof wrapped === "object" && wrapped !== null
      ? (wrapped as Record<string, unknown>)
      : root
  const token = inner.accessToken
  if (typeof token !== "string" || token.length === 0) return null
  const authMethod: AuthMethod = token.startsWith(CLAUDE_API_KEY_PREFIX)
    ? "api_key"
    : "subscription"
  const sub = inner.subscriptionType
  const plan = typeof sub === "string" && sub.length > 0 ? sub : null
  return { authenticated: true, authMethod, plan }
}

function settingsHasApiKeyHelper(text: string | null): boolean {
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as { apiKeyHelper?: unknown }
    return typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.length > 0
  } catch {
    return false
  }
}

function claudeConfigDir(probe: HealthProbe): string {
  const override = probe.env("CLAUDE_CONFIG_DIR")
  return override ?? path.join(probe.home(), ".claude")
}

export function detectClaudeAuth(probe: HealthProbe): AuthSignal {
  const configDir = claudeConfigDir(probe)

  // Must run first: an API key always wins over a subscription credential found below.
  if (probe.env("ANTHROPIC_API_KEY")) {
    return { authenticated: true, authMethod: "api_key", plan: null }
  }
  const settingsPath = path.join(configDir, "settings.json")
  if (settingsHasApiKeyHelper(probe.readFile(settingsPath))) {
    return { authenticated: true, authMethod: "api_key", plan: null }
  }

  let keychainSaidAbsent = false
  // darwin only: Windows never uses Credential Manager for Claude creds — the file below is its only store.
  if (probe.platform() === "darwin") {
    const kc = probe.keychain(CLAUDE_KEYCHAIN_SERVICE)
    if (kc !== null) {
      if (kc.secret) {
        const parsed = parseClaudeCredentials(kc.secret)
        if (parsed) return parsed
      }
      if (kc.exists) {
        return { authenticated: true, authMethod: "subscription", plan: null }
      }
      keychainSaidAbsent = true
    }
  }

  const credPath = path.join(configDir, ".credentials.json")
  const fileSignal = parseClaudeCredentials(probe.readFile(credPath))
  if (fileSignal) return fileSignal

  if (keychainSaidAbsent) return UNAUTH
  if (probe.platform() !== "darwin") return UNAUTH
  return UNKNOWN
}

function codexHome(probe: HealthProbe): string {
  return probe.env("CODEX_HOME") ?? path.join(probe.home(), ".codex")
}

function detectCodex(probe: HealthProbe): AgentHealth {
  const present = probe.which("codex") !== null
  const version = present ? normalizeVersion(probe.version("codex")) : null
  // Codex's keyring/auto credential modes aren't read here — a keyring-only user reads as unauthenticated (honest false-negative, not a bug).
  const authFile = path.join(codexHome(probe), "auth.json")
  const auth = parseCodexAuth(probe.readFile(authFile))
  return { present, version, ...auth }
}

function detectClaude(probe: HealthProbe): AgentHealth {
  const present = probe.which("claude") !== null
  const version = present ? normalizeVersion(probe.version("claude")) : null
  const auth = detectClaudeAuth(probe)
  return { present, version, ...auth }
}

export function getAgentsHealth(probe: HealthProbe = nodeHealthProbe): AgentsHealth {
  return {
    claude: detectClaude(probe),
    codex: detectCodex(probe),
  }
}
