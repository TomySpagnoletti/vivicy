import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  getAgentsHealth,
  type HealthProbe,
  parseClaudeAuth,
  parseCodexAuth,
} from "@/lib/agents-health"

const HOME = "/home/test-user"
const CODEX_AUTH = path.join(HOME, ".codex", "auth.json")
const CLAUDE_CRED = path.join(HOME, ".claude", ".credentials.json")

/**
 * A fully-stubbed probe so the detector is tested without a real CLI or home dir.
 * `present` maps a bin to its resolved path (or absent), `versions` maps a bin to
 * its `--version` line, and `files` maps a path to its text.
 */
function makeProbe(opts: {
  present?: Record<string, string>
  versions?: Record<string, string>
  files?: Record<string, string>
}): HealthProbe {
  return {
    which: (bin) => opts.present?.[bin] ?? null,
    version: (bin) => opts.versions?.[bin] ?? null,
    readFile: (file) => opts.files?.[file] ?? null,
    home: () => HOME,
  }
}

describe("parseCodexAuth", () => {
  it("is authenticated with a ChatGPT tokens block", () => {
    expect(
      parseCodexAuth(JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "abc" } }))
    ).toBe(true)
  })

  it("is authenticated with a non-null OPENAI_API_KEY", () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }))).toBe(
      true
    )
  })

  it("is NOT authenticated when tokens lack an access_token and no api key", () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }))).toBe(
      false
    )
    expect(parseCodexAuth(JSON.stringify({ tokens: {} }))).toBe(false)
  })

  it("is NOT authenticated for null/garbage", () => {
    expect(parseCodexAuth(null)).toBe(false)
    expect(parseCodexAuth("{ not json")).toBe(false)
  })
})

describe("parseClaudeAuth (honest unknown)", () => {
  it("is authenticated with a non-empty OAuth access token", () => {
    expect(parseClaudeAuth(JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))).toBe(true)
  })

  it("returns null (unknown) when the file is ABSENT — never a false guess", () => {
    // Absence is the common macOS case (Keychain-stored creds); we don't claim
    // logged-out from it.
    expect(parseClaudeAuth(null)).toBe(null)
  })

  it("returns false when the file exists but plainly carries no token", () => {
    expect(parseClaudeAuth(JSON.stringify({ claudeAiOauth: {} }))).toBe(false)
    expect(parseClaudeAuth(JSON.stringify({}))).toBe(false)
  })

  it("returns false for a corrupt existing file", () => {
    expect(parseClaudeAuth("{ not json")).toBe(false)
  })
})

describe("getAgentsHealth", () => {
  it("reports both present + authed when CLIs and auth files are good", () => {
    const probe = makeProbe({
      present: { claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
      versions: { claude: "2.1.0 (Claude Code)", codex: "codex-cli 0.141.0" },
      files: {
        [CLAUDE_CRED]: JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }),
        [CODEX_AUTH]: JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "abc" } }),
      },
    })
    const health = getAgentsHealth(probe)
    expect(health.claude).toEqual({
      present: true,
      version: "2.1.0 (Claude Code)",
      authenticated: true,
    })
    expect(health.codex).toEqual({
      present: true,
      version: "codex-cli 0.141.0",
      authenticated: true,
    })
  })

  it("reports absent CLIs with null version and no version probe", () => {
    const probe = makeProbe({ present: {} })
    const health = getAgentsHealth(probe)
    expect(health.claude.present).toBe(false)
    expect(health.claude.version).toBe(null)
    expect(health.codex.present).toBe(false)
    expect(health.codex.version).toBe(null)
  })

  it("reports Claude auth as null (unknown) when present but no credentials file", () => {
    const probe = makeProbe({
      present: { claude: "/usr/bin/claude" },
      versions: { claude: "2.1.0" },
      // No CLAUDE_CRED file -> honest unknown, not a fabricated true.
    })
    expect(getAgentsHealth(probe).claude).toEqual({
      present: true,
      version: "2.1.0",
      authenticated: null,
    })
  })

  it("reports Codex present-but-not-authed when the auth file lacks a credential", () => {
    const probe = makeProbe({
      present: { codex: "/usr/bin/codex" },
      versions: { codex: "codex-cli 0.1.0" },
      files: { [CODEX_AUTH]: JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }) },
    })
    expect(getAgentsHealth(probe).codex.authenticated).toBe(false)
  })
})
