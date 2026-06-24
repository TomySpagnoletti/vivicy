/**
 * Server-only detection of the two agent CLIs Vivicy drives — Claude Code and the
 * Codex CLI — plus their auth state (R11). The dev-loop cannot run without both
 * present and authenticated, so the UI surfaces this and guides install/login.
 *
 * Detection is deliberately SIDE-EFFECT-FREE and honest:
 *   - presence: `which <bin>` on PATH (no execution of the agent itself).
 *   - version: `<bin> --version` (a cheap, non-interactive, read-only probe).
 *   - auth:
 *       · Codex — read `~/.codex/auth.json`: `auth_mode` plus a token signal
 *         (`tokens` object for ChatGPT sign-in, or a non-null `OPENAI_API_KEY`).
 *         A clean file-based signal, so we report a definite true/false.
 *       · Claude — there is no documented, side-effect-free, cross-platform file
 *         signal for Claude Code auth: on macOS the OAuth credentials live in the
 *         login Keychain, not a flat file, and a non-interactive probe risks
 *         triggering a login flow or a network call. We check the file-based
 *         credentials path that some setups use and report a definite `true` when
 *         it carries a token; otherwise we report `null` ("unknown") rather than
 *         guessing a false. Honest unknown over a fabricated verdict.
 *
 * `node:fs`/`node:child_process` live here so they never reach the client bundle;
 * the client-safe types are in {@link file://./agents-health-types}.
 */

import { execFileSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

import type { AgentHealth, AgentsHealth } from "@/lib/agents-health-types"

/**
 * Injection seam so tests can stub `which`, `--version`, and the auth-file reads
 * without a real CLI or a real home dir. The real probes are pure reads.
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

/** The real probe: PATH lookup + cheap version + plain file reads. No agent runs. */
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
}

/**
 * Infer Codex auth from `~/.codex/auth.json`. Authenticated when the file parses
 * and carries a usable credential: a `tokens` object (ChatGPT sign-in) or a
 * non-null `OPENAI_API_KEY` (API-key mode). The file's presence alone is not
 * enough — a logged-out CLI may leave an empty shell — so we require the token
 * signal. Returns a definite boolean (the file is a clean, reliable signal).
 */
export function parseCodexAuth(text: string | null): boolean {
  if (!text) return false
  try {
    const parsed = JSON.parse(text) as {
      auth_mode?: unknown
      OPENAI_API_KEY?: unknown
      tokens?: unknown
    }
    const hasTokens =
      typeof parsed.tokens === "object" &&
      parsed.tokens !== null &&
      typeof (parsed.tokens as { access_token?: unknown }).access_token === "string" &&
      ((parsed.tokens as { access_token: string }).access_token).length > 0
    const hasApiKey =
      typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY.length > 0
    return hasTokens || hasApiKey
  } catch {
    return false
  }
}

/**
 * Infer Claude Code auth from the file-based credentials some setups use
 * (`~/.claude/.credentials.json`, the `claudeAiOauth` block). Returns:
 *   - `true`  when the file carries a non-empty OAuth access token,
 *   - `null`  ("unknown") when the file is absent — the common macOS case, where
 *     credentials live in the Keychain and there is no clean file signal. We do
 *     NOT return false there: absence of the file is not evidence of logged-out.
 *   - `false` only when the file exists but plainly carries no token.
 */
export function parseClaudeAuth(text: string | null): boolean | null {
  if (text === null) return null
  try {
    const parsed = JSON.parse(text) as {
      claudeAiOauth?: { accessToken?: unknown }
    }
    const token = parsed.claudeAiOauth?.accessToken
    return typeof token === "string" && token.length > 0
  } catch {
    return false
  }
}

/** Detect Codex: presence, version, and a definite auth boolean. */
function detectCodex(probe: HealthProbe): AgentHealth {
  const present = probe.which("codex") !== null
  const version = present ? probe.version("codex") : null
  const authFile = path.join(probe.home(), ".codex", "auth.json")
  const authenticated = parseCodexAuth(probe.readFile(authFile))
  return { present, version, authenticated }
}

/** Detect Claude Code: presence, version, and an HONEST auth signal (bool|null). */
function detectClaude(probe: HealthProbe): AgentHealth {
  const present = probe.which("claude") !== null
  const version = present ? probe.version("claude") : null
  const credFile = path.join(probe.home(), ".claude", ".credentials.json")
  const authenticated = parseClaudeAuth(probe.readFile(credFile))
  return { present, version, authenticated }
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
