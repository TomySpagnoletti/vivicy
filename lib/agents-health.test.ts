import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  detectClaudeAuth,
  getAgentsHealth,
  type HealthProbe,
  type KeychainResult,
  parseClaudeCredentials,
  parseCodexAuth,
} from "@/lib/agents-health"

const HOME = "/home/test-user"
const CODEX_AUTH = path.join(HOME, ".codex", "auth.json")
const CLAUDE_CRED = path.join(HOME, ".claude", ".credentials.json")
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json")

/**
 * A fully-stubbed probe so detection is exercised without a real CLI, home dir,
 * env, or — critically — the real macOS Keychain. `keychain` defaults to "no item"
 * and tests opt into a specific {@link KeychainResult} (or `null` = unprobeable).
 */
function makeProbe(opts: {
  present?: Record<string, string>
  versions?: Record<string, string>
  files?: Record<string, string>
  env?: Record<string, string>
  platform?: NodeJS.Platform
  keychain?: KeychainResult | null
}): HealthProbe {
  return {
    which: (bin) => opts.present?.[bin] ?? null,
    version: (bin) => opts.versions?.[bin] ?? null,
    readFile: (file) => opts.files?.[file] ?? null,
    home: () => HOME,
    env: (name) => opts.env?.[name] ?? null,
    platform: () => opts.platform ?? "linux",
    // `keychain` may be explicitly null (unprobeable); only default when omitted.
    keychain: () =>
      "keychain" in opts ? opts.keychain ?? null : { secret: null, exists: false },
  }
}

// A realistic Keychain secret: OAuth creds wrapped under `claudeAiOauth`, as the
// live macOS item is shaped. The token is fake; tests never read a real secret.
const KEYCHAIN_MAX_JSON = JSON.stringify({
  claudeAiOauth: {
    accessToken: "sk-ant-oat01-FAKEFAKEFAKE",
    refreshToken: "sk-ant-ort01-FAKEFAKEFAKE",
    expiresAt: 1782407136337,
    scopes: ["user:inference"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  },
})

describe("parseCodexAuth", () => {
  it("is subscription (ChatGPT) with a tokens block and no API key", () => {
    expect(
      parseCodexAuth(
        JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "abc" } })
      )
    ).toEqual({ authenticated: true, authMethod: "subscription", plan: "ChatGPT" })
  })

  it("is api_key when OPENAI_API_KEY is set", () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }))).toEqual({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
    })
  })

  it("is api_key when auth_mode is apikey even without a key in the file", () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: null }))).toEqual({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
    })
  })

  it("is unauthenticated when tokens lack an access_token and there is no key", () => {
    expect(parseCodexAuth(JSON.stringify({ auth_mode: "chatgpt", tokens: {} }))).toEqual({
      authenticated: false,
      authMethod: null,
      plan: null,
    })
  })

  it("is unauthenticated for null/garbage", () => {
    expect(parseCodexAuth(null).authenticated).toBe(false)
    expect(parseCodexAuth("{ not json").authenticated).toBe(false)
  })
})

describe("parseClaudeCredentials", () => {
  it("reads a wrapped Keychain secret as subscription + plan", () => {
    expect(parseClaudeCredentials(KEYCHAIN_MAX_JSON)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: "max",
    })
  })

  it("reads a flat credentials blob the same way", () => {
    expect(
      parseClaudeCredentials(
        JSON.stringify({ accessToken: "sk-ant-oat01-FAKE", subscriptionType: "pro" })
      )
    ).toEqual({ authenticated: true, authMethod: "subscription", plan: "pro" })
  })

  it("classifies a Console API-key token (sk-ant-api03-) as api_key", () => {
    expect(
      parseClaudeCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-api03-FAKE" } }))
    ).toEqual({ authenticated: true, authMethod: "api_key", plan: null })
  })

  it("returns null when there is no usable access token", () => {
    expect(parseClaudeCredentials(JSON.stringify({ claudeAiOauth: {} }))).toBe(null)
    expect(parseClaudeCredentials(JSON.stringify({}))).toBe(null)
    expect(parseClaudeCredentials(null)).toBe(null)
    expect(parseClaudeCredentials("{ not json")).toBe(null)
  })

  it("never echoes the token — only booleans/method/plan", () => {
    const result = parseClaudeCredentials(KEYCHAIN_MAX_JSON)
    expect(JSON.stringify(result)).not.toContain("sk-ant-oat01")
  })
})

describe("detectClaudeAuth (layered, honest)", () => {
  it("a: ANTHROPIC_API_KEY env → api_key, regardless of platform", () => {
    const probe = makeProbe({
      platform: "darwin",
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-FAKE" },
      keychain: { secret: KEYCHAIN_MAX_JSON, exists: true }, // present but env wins
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
    })
  })

  it("a: settings.json apiKeyHelper → api_key", () => {
    const probe = makeProbe({
      platform: "darwin",
      files: { [CLAUDE_SETTINGS]: JSON.stringify({ apiKeyHelper: "/usr/local/bin/key.sh" }) },
    })
    expect(detectClaudeAuth(probe).authMethod).toBe("api_key")
  })

  it("b: darwin Keychain secret → subscription + plan (the live-machine case)", () => {
    const probe = makeProbe({
      platform: "darwin",
      keychain: { secret: KEYCHAIN_MAX_JSON, exists: true },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: "max",
    })
  })

  it("b: Keychain item exists but secret is locked → authenticated, plan unknown", () => {
    const probe = makeProbe({
      platform: "darwin",
      keychain: { secret: null, exists: true },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: null,
    })
  })

  it("c: file credentials fallback on Linux → subscription", () => {
    const probe = makeProbe({
      platform: "linux",
      files: { [CLAUDE_CRED]: JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-X" } }) },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: null,
    })
  })

  it("d: darwin Keychain confirms absent + no file → unauthenticated (false)", () => {
    const probe = makeProbe({
      platform: "darwin",
      keychain: { secret: null, exists: false },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: false,
      authMethod: null,
      plan: null,
    })
  })

  it("d: Linux with no creds file → unauthenticated (file is the store there)", () => {
    const probe = makeProbe({ platform: "linux" })
    expect(detectClaudeAuth(probe).authenticated).toBe(false)
  })

  it("d: darwin Keychain unprobeable + no file → null (honest unknown)", () => {
    const probe = makeProbe({ platform: "darwin", keychain: null })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: null,
      authMethod: null,
      plan: null,
    })
  })
})

describe("getAgentsHealth", () => {
  it("reports both authed with method on a macOS subscription machine", () => {
    const probe = makeProbe({
      present: { claude: "/usr/bin/claude", codex: "/usr/bin/codex" },
      versions: { claude: "2.1.0 (Claude Code)", codex: "codex-cli 0.141.0" },
      platform: "darwin",
      keychain: { secret: KEYCHAIN_MAX_JSON, exists: true },
      files: {
        [CODEX_AUTH]: JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { access_token: "abc" },
        }),
      },
    })
    const health = getAgentsHealth(probe)
    expect(health.claude).toEqual({
      present: true,
      version: "2.1.0 (Claude Code)",
      authenticated: true,
      authMethod: "subscription",
      plan: "max",
    })
    expect(health.codex).toEqual({
      present: true,
      version: "codex-cli 0.141.0",
      authenticated: true,
      authMethod: "subscription",
      plan: "ChatGPT",
    })
  })

  it("reports absent CLIs with null version and no version probe", () => {
    const probe = makeProbe({ present: {}, platform: "darwin" })
    const health = getAgentsHealth(probe)
    expect(health.claude.present).toBe(false)
    expect(health.claude.version).toBe(null)
    expect(health.codex.present).toBe(false)
    expect(health.codex.version).toBe(null)
  })

  it("reports Codex api_key when the auth file carries an OPENAI_API_KEY", () => {
    const probe = makeProbe({
      present: { codex: "/usr/bin/codex" },
      versions: { codex: "codex-cli 0.1.0" },
      files: { [CODEX_AUTH]: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }) },
    })
    expect(getAgentsHealth(probe).codex).toMatchObject({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
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
