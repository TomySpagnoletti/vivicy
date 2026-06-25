/**
 * Server-only detection of the two agent CLIs Vivicy drives — Claude Code and the
 * Codex CLI — plus their auth state AND billing method (R11). The dev-loop cannot
 * run without both present and authenticated, and the auth *method* (subscription
 * vs API key) determines the user's cost, so the UI surfaces both.
 *
 * Detection is deliberately SIDE-EFFECT-FREE and honest:
 *   - presence: `which <bin>` on PATH (no execution of the agent itself).
 *   - version: `<bin> --version` (a cheap, non-interactive, read-only probe).
 *   - auth + method:
 *       · Codex — read `~/.codex/auth.json`: `OPENAI_API_KEY` / `auth_mode`
 *         (`"apikey"` = API key) or a `tokens.access_token` (ChatGPT sign-in =
 *         subscription). A clean file signal → a definite verdict.
 *       · Claude — layered, first-match wins:
 *           a) `ANTHROPIC_API_KEY` env or `settings.json` `apiKeyHelper` → API key.
 *           b) on macOS, the login Keychain item `Claude Code-credentials`
 *              (`security find-generic-password`) — the real store on darwin. The
 *              secret's `accessToken` prefix tells method (`sk-ant-api03-` = API
 *              key, else OAuth = subscription) and carries `subscriptionType` as
 *              the plan. If the secret is locked but the item is confirmed to
 *              EXIST, we still report authenticated (subscription, plan unknown).
 *           c) `~/.claude/.credentials.json` (flat or under `claudeAiOauth`) —
 *              the Linux/SSH store.
 *           d) otherwise unauthenticated, or `null` ("unknown") only when the
 *              store could not be probed at all.
 *
 * The token value is NEVER returned, logged, or surfaced — only the booleans, the
 * method, and the plan label. Keychain probes carry SHORT timeouts and degrade
 * gracefully (never hang, never throw to the route).
 *
 * `node:fs`/`node:child_process` live here so they never reach the client bundle;
 * the client-safe types are in {@link file://./agents-health-types}.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { AgentHealth, AgentsHealth, AuthMethod } from "@/lib/agents-health-types"

/** macOS login-Keychain service name Claude Code stores its OAuth creds under. */
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials"

/** Timeout (ms) for each `security` Keychain probe — short, so we never hang. */
const KEYCHAIN_TIMEOUT_MS = 2_000

/** Console API keys carry this prefix; OAuth tokens (`sk-ant-oat01-`) do not. */
const CLAUDE_API_KEY_PREFIX = "sk-ant-api03-"

/**
 * Result of a macOS Keychain lookup:
 *   - `{ secret, exists: true }` — the item exists and its secret was readable.
 *   - `{ secret: null, exists: true }` — the item exists but its secret was locked
 *     / blocked (we know they're signed in, but not the method/plan).
 *   - `{ secret: null, exists: false }` — the item is definitively absent.
 *   - `null` (from the probe) — the Keychain could not be probed (timeout / error);
 *     genuinely undetectable, so the caller reports "unknown".
 */
export interface KeychainResult {
  secret: string | null
  exists: boolean
}

/** Normalised, token-free auth signal shared by both agents. */
interface AuthSignal {
  authenticated: boolean | null
  authMethod: AuthMethod | null
  plan: string | null
}

const UNAUTH: AuthSignal = { authenticated: false, authMethod: null, plan: null }
const UNKNOWN: AuthSignal = { authenticated: null, authMethod: null, plan: null }

/**
 * Injection seam so tests can stub presence, version, file reads, env, platform,
 * and the Keychain lookup — never touching a real CLI, home dir, or Keychain. The
 * real probes are pure reads with no agent execution.
 */
export interface HealthProbe {
  /** Absolute path of `bin` on PATH, or null when not found. */
  which(bin: string): string | null
  /** Output of `<bin> --version` (trimmed first line), or null on any failure. */
  version(bin: string): string | null
  /** Read a file's text, or null when absent/unreadable. */
  readFile(file: string): string | null
  /** The user's home directory (so the auth-file paths are derivable in tests). */
  home(): string
  /** A process env var's value, or null when unset/empty. */
  env(name: string): string | null
  /** The platform string (`process.platform`), e.g. `"darwin"` / `"linux"`. */
  platform(): NodeJS.Platform
  /**
   * Look up a macOS Keychain generic-password by service name. Returns a
   * {@link KeychainResult}, or `null` when the Keychain could not be probed
   * (timeout / unexpected error / not macOS) — i.e. genuinely undetectable.
   */
  keychain(service: string): KeychainResult | null
}

/**
 * Strip the redundant product-name decoration the agent CLIs add to their raw
 * `--version` output, leaving JUST the version number:
 *   - Claude prints `2.1.191 (Claude Code)` → drop the trailing
 *     ` (Claude Code)` / ` (claude-code)` parenthetical.
 *   - Codex prints `codex-cli 0.141.0` → drop the leading `codex-cli ` /
 *     `claude-code ` product prefix.
 * A plain version string (`0.141.0`) passes through untouched. The UI already
 * labels which agent a row is, so repeating the product name in the version is
 * pure noise. Returns null when the input is null (CLI absent/unreadable).
 */
export function normalizeVersion(raw: string | null): string | null {
  if (raw == null) return null
  let v = raw.trim()
  // Drop a trailing product-name parenthetical, e.g. " (Claude Code)". The
  // closing paren is optional so a truncated/malformed `--version` line
  // ("2.1.191 (Claude Code") is still cleaned rather than passed through.
  v = v.replace(/\s*\((?:claude code|claude-code)\)?\s*$/i, "")
  // Drop a leading product-name prefix, e.g. "codex-cli " or "claude-code ".
  v = v.replace(/^(?:codex-cli|claude-code)\s+/i, "")
  return v.trim()
}

/** Run a command and capture stdout, returning null on any non-zero/throw. */
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

/** Outcome of one `security` invocation: exit code, stdout, and whether it timed out. */
interface SecurityRun {
  code: number | null
  stdout: string
  timedOut: boolean
}

/**
 * Run `/usr/bin/security` with a hard timeout, capturing the exit code. `security`
 * exits 0 when the item is found, 44 when it is not, and non-zero (e.g. 51) when
 * an interactive unlock would be required. We translate throws into a structured
 * result so the caller never sees an exception.
 */
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

/**
 * Read a Keychain generic-password by service. First tries to read the secret
 * (`-w`); if that is blocked/locked, falls back to a secret-free existence probe
 * (no `-w`, which never prompts). A timeout on either step yields `null`
 * (undetectable). Only ever runs on macOS.
 */
function nodeKeychain(service: string): KeychainResult | null {
  if (process.platform !== "darwin") return null
  // Step 1: try to read the secret itself.
  const read = runSecurity(["find-generic-password", "-s", service, "-w"])
  if (read.timedOut) return null
  if (read.code === 0 && read.stdout.trim().length > 0) {
    return { secret: read.stdout.trim(), exists: true }
  }
  // Step 2: secret unreadable — confirm existence without it (no prompt).
  const exists = runSecurity(["find-generic-password", "-s", service])
  if (exists.timedOut) return null
  if (exists.code === 0) return { secret: null, exists: true }
  if (exists.code === 44) return { secret: null, exists: false }
  return null // unexpected error → undetectable
}

/** The real probe: PATH lookup + cheap version + plain reads + env/Keychain. */
export const nodeHealthProbe: HealthProbe = {
  which(bin: string): string | null {
    // `command -v` resolves PATH (and builtins/aliases) portably across shells.
    const resolved = safeExec("/bin/sh", ["-c", `command -v ${bin}`])
    return resolved && path.isAbsolute(resolved) ? resolved : null
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

/**
 * Infer Codex auth + method from `~/.codex/auth.json`:
 *   - `OPENAI_API_KEY` set OR `auth_mode === "apikey"` → API key (pay-per-token).
 *   - else a `tokens.access_token` (typically `auth_mode: "chatgpt"`) →
 *     subscription, plan `"ChatGPT"`.
 *   - else unauthenticated.
 * The file is a clean, reliable signal, so the verdict is a definite boolean.
 */
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

/**
 * Parse a Claude credential blob (Keychain secret OR `.credentials.json`) into a
 * token-free auth signal, or `null` when it carries no usable access token. The
 * blob may be flat or wrapped under `claudeAiOauth`. Method is derived from the
 * token PREFIX only (`sk-ant-api03-` = API key, else OAuth = subscription) — the
 * token value itself is never returned.
 */
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

/** True when `settings.json` defines an `apiKeyHelper` (an explicit API-key setup). */
function settingsHasApiKeyHelper(text: string | null): boolean {
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as { apiKeyHelper?: unknown }
    return typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.length > 0
  } catch {
    return false
  }
}

/**
 * Layered Claude auth detection (first match wins). See the module header for the
 * a→d order. Returns a token-free {@link AuthSignal}; `authenticated` is `null`
 * only when the store could not be probed at all (genuinely undetectable).
 */
export function detectClaudeAuth(probe: HealthProbe): AuthSignal {
  // a. Explicit API-key signals — env key or an apiKeyHelper. These mean
  //    pay-per-token billing and win over any subscription credential present.
  if (probe.env("ANTHROPIC_API_KEY")) {
    return { authenticated: true, authMethod: "api_key", plan: null }
  }
  const settingsPath = path.join(probe.home(), ".claude", "settings.json")
  if (settingsHasApiKeyHelper(probe.readFile(settingsPath))) {
    return { authenticated: true, authMethod: "api_key", plan: null }
  }

  // b. macOS Keychain — the real store on darwin.
  let keychainSaidAbsent = false
  if (probe.platform() === "darwin") {
    const kc = probe.keychain(CLAUDE_KEYCHAIN_SERVICE)
    if (kc !== null) {
      if (kc.secret) {
        const parsed = parseClaudeCredentials(kc.secret)
        if (parsed) return parsed
      }
      if (kc.exists) {
        // Item present but secret locked/blocked: signed in, method/plan unknown.
        return { authenticated: true, authMethod: "subscription", plan: null }
      }
      keychainSaidAbsent = true // item definitively not in the Keychain
    }
    // kc === null → Keychain unprobeable; fall through and resolve below.
  }

  // c. File credentials (Linux / SSH; also a macOS user with a flat creds file).
  const credPath = path.join(probe.home(), ".claude", ".credentials.json")
  const fileSignal = parseClaudeCredentials(probe.readFile(credPath))
  if (fileSignal) return fileSignal

  // d. Resolve unknown vs unauthenticated.
  //    - Keychain confirmed the item is absent → confident logged-out.
  //    - Non-darwin with no creds file → the file IS the store there → logged-out.
  //    - darwin where the Keychain could not be probed and no file → genuinely
  //      undetectable → honest "unknown".
  if (keychainSaidAbsent) return UNAUTH
  if (probe.platform() !== "darwin") return UNAUTH
  return UNKNOWN
}

/** Detect Codex: presence, version, and a definite auth + method signal. */
function detectCodex(probe: HealthProbe): AgentHealth {
  const present = probe.which("codex") !== null
  const version = present ? normalizeVersion(probe.version("codex")) : null
  const authFile = path.join(probe.home(), ".codex", "auth.json")
  const auth = parseCodexAuth(probe.readFile(authFile))
  return { present, version, ...auth }
}

/** Detect Claude Code: presence, version, and a layered auth + method signal. */
function detectClaude(probe: HealthProbe): AgentHealth {
  const present = probe.which("claude") !== null
  const version = present ? normalizeVersion(probe.version("claude")) : null
  const auth = detectClaudeAuth(probe)
  return { present, version, ...auth }
}

/**
 * Full health snapshot for both agents. Pure with respect to the injected probe,
 * so the route uses {@link nodeHealthProbe} and tests inject a fake.
 */
export function getAgentsHealth(probe: HealthProbe = nodeHealthProbe): AgentsHealth {
  return {
    claude: detectClaude(probe),
    codex: detectCodex(probe),
  }
}
