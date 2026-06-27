import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  detectClaudeAuth,
  type ExecFirstLine,
  getAgentsHealth,
  type HealthProbe,
  type KeychainResult,
  normalizeVersion,
  parseClaudeCredentials,
  parseCodexAuth,
  resolveOnPath,
} from "@/lib/agents-health"

const HOME = "/home/test-user"
const CODEX_AUTH = path.join(HOME, ".codex", "auth.json")
const CLAUDE_CRED = path.join(HOME, ".claude", ".credentials.json")
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json")

// A realistic Windows home + the OS-correct credential/auth paths under it. The
// detector composes these with `path.join`, so tests must key the probe's file
// map with the SAME join. On a posix test host `path.join` stays posix; that is
// fine — the platform SEAM (`platform: "win32"`) is what selects the Windows code
// path, and the file lookups are keyed consistently on both sides of the seam.
const WIN_HOME = "C:\\Users\\test-user"
const WIN_CLAUDE_CRED = path.join(WIN_HOME, ".claude", ".credentials.json")
const WIN_CLAUDE_SETTINGS = path.join(WIN_HOME, ".claude", "settings.json")
const WIN_CODEX_AUTH = path.join(WIN_HOME, ".codex", "auth.json")

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
  home?: string
  keychain?: KeychainResult | null
}): HealthProbe {
  return {
    which: (bin) => opts.present?.[bin] ?? null,
    version: (bin) => opts.versions?.[bin] ?? null,
    readFile: (file) => opts.files?.[file] ?? null,
    home: () => opts.home ?? HOME,
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

describe("normalizeVersion", () => {
  it("strips Claude's trailing product-name parenthetical (real raw string)", () => {
    // `claude --version` prints e.g. "2.1.191 (Claude Code)".
    expect(normalizeVersion("2.1.191 (Claude Code)")).toBe("2.1.191")
  })

  it("strips Codex's leading product-name prefix (real raw string)", () => {
    // `codex --version` prints e.g. "codex-cli 0.141.0".
    expect(normalizeVersion("codex-cli 0.141.0")).toBe("0.141.0")
  })

  it("leaves a plain version untouched", () => {
    expect(normalizeVersion("0.141.0")).toBe("0.141.0")
    expect(normalizeVersion("2.1.191")).toBe("2.1.191")
  })

  it("is case- and spacing-tolerant for the product decoration", () => {
    expect(normalizeVersion("2.1.191  (claude code)")).toBe("2.1.191")
    expect(normalizeVersion("claude-code 2.1.191")).toBe("2.1.191")
  })

  it("cleans a truncated/malformed product parenthetical (no closing paren)", () => {
    // A garbled `--version` line must not leak the dangling product name.
    expect(normalizeVersion("2.1.191 (Claude Code")).toBe("2.1.191")
  })

  it("passes through null (CLI absent / version unreadable)", () => {
    expect(normalizeVersion(null)).toBe(null)
  })

  it("never doubles up — only the redundant product name is removed", () => {
    // A version that merely contains digits and dots must survive verbatim.
    expect(normalizeVersion("v1.2.3-beta.4")).toBe("v1.2.3-beta.4")
  })
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
    // The raw probe strings ("2.1.0 (Claude Code)", "codex-cli 0.141.0") are
    // normalized to just the version number before reaching the UI.
    expect(health.claude).toEqual({
      present: true,
      version: "2.1.0",
      authenticated: true,
      authMethod: "subscription",
      plan: "max",
    })
    expect(health.codex).toEqual({
      present: true,
      version: "0.141.0",
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

describe("resolveOnPath (cross-platform presence, no real spawn)", () => {
  // Inject the exec seam so we assert WHICH command each platform runs and that
  // Windows never reaches the POSIX `/bin/sh` probe (which would throw there).
  function recordingExec(reply: (bin: string, args: string[]) => string | null) {
    const calls: Array<{ bin: string; args: string[] }> = []
    const exec: ExecFirstLine = (bin, args) => {
      calls.push({ bin, args })
      return reply(bin, args)
    }
    return { exec, calls }
  }

  it("Windows: runs `cmd.exe /c where <bin>` and returns the first absolute match", () => {
    const { exec, calls } = recordingExec((bin) =>
      bin === "cmd.exe" ? "C:\\Users\\test-user\\AppData\\Roaming\\npm\\claude.cmd" : null
    )
    const resolved = resolveOnPath("claude", "win32", exec)
    expect(resolved).toBe("C:\\Users\\test-user\\AppData\\Roaming\\npm\\claude.cmd")
    // It used `where` via cmd.exe and NEVER touched `/bin/sh`.
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ bin: "cmd.exe", args: ["/c", "where", "claude"] })
    expect(calls.some((c) => c.bin === "/bin/sh")).toBe(false)
  })

  it("Windows: a non-absolute / error line from `where` is rejected as absent", () => {
    // `where` prints "INFO: Could not find files..." to stdout on a miss; the
    // absolute-path guard rejects it rather than treating it as a hit.
    const { exec } = recordingExec(() => "INFO: Could not find files for the given pattern(s).")
    expect(resolveOnPath("claude", "win32", exec)).toBe(null)
  })

  it("Windows: a clean no-match (null) is absent", () => {
    const { exec } = recordingExec(() => null)
    expect(resolveOnPath("codex", "win32", exec)).toBe(null)
  })

  it("Unix: runs `command -v` under /bin/sh and returns an absolute path", () => {
    const { exec, calls } = recordingExec((bin) =>
      bin === "/bin/sh" ? "/usr/local/bin/codex" : null
    )
    expect(resolveOnPath("codex", "linux", exec)).toBe("/usr/local/bin/codex")
    expect(calls[0]).toEqual({ bin: "/bin/sh", args: ["-c", "command -v codex"] })
    // It never spawned cmd.exe on Unix.
    expect(calls.some((c) => c.bin === "cmd.exe")).toBe(false)
  })

  it("Unix: a relative resolution (shell builtin/alias) is rejected as not-on-PATH", () => {
    const { exec } = recordingExec(() => "claude") // builtin/alias, not an abs path
    expect(resolveOnPath("claude", "darwin", exec)).toBe(null)
  })
})

describe("Windows auth detection (file store, per official docs)", () => {
  // Per https://code.claude.com/docs/en/authentication, Windows stores Claude
  // creds at %USERPROFILE%\.claude\.credentials.json — a FILE, not the Credential
  // Manager. Detection must read that file, never call the Keychain branch.
  it("Claude: reads %USERPROFILE%\\.claude\\.credentials.json as subscription", () => {
    const probe = makeProbe({
      platform: "win32",
      home: WIN_HOME,
      files: {
        [WIN_CLAUDE_CRED]: JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat01-X", subscriptionType: "max" },
        }),
      },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: "max",
    })
  })

  it("Claude: a Console api-key token in the Windows file is classified api_key", () => {
    const probe = makeProbe({
      platform: "win32",
      home: WIN_HOME,
      files: { [WIN_CLAUDE_CRED]: JSON.stringify({ accessToken: "sk-ant-api03-X" }) },
    })
    expect(detectClaudeAuth(probe).authMethod).toBe("api_key")
  })

  it("Claude: ANTHROPIC_API_KEY env wins on Windows too", () => {
    const probe = makeProbe({
      platform: "win32",
      home: WIN_HOME,
      env: { ANTHROPIC_API_KEY: "sk-ant-api03-X" },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
    })
  })

  it("Claude: settings.json apiKeyHelper under the Windows config dir → api_key", () => {
    const probe = makeProbe({
      platform: "win32",
      home: WIN_HOME,
      files: { [WIN_CLAUDE_SETTINGS]: JSON.stringify({ apiKeyHelper: "C:\\key.cmd" }) },
    })
    expect(detectClaudeAuth(probe).authMethod).toBe("api_key")
  })

  it("Claude: NO file on Windows → confident unauthenticated (file IS the store, not unknown)", () => {
    const probe = makeProbe({ platform: "win32", home: WIN_HOME })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: false,
      authMethod: null,
      plan: null,
    })
  })

  it("Claude: the Keychain seam is NEVER consulted on Windows", () => {
    let keychainCalls = 0
    const probe: HealthProbe = {
      ...makeProbe({ platform: "win32", home: WIN_HOME }),
      keychain: () => {
        keychainCalls += 1
        return { secret: null, exists: true }
      },
    }
    detectClaudeAuth(probe)
    expect(keychainCalls).toBe(0)
  })

  it("Codex: reads %USERPROFILE%\\.codex\\auth.json on Windows (subscription)", () => {
    const probe = makeProbe({
      present: { codex: "C:\\npm\\codex.cmd" },
      versions: { codex: "codex-cli 0.141.0" },
      platform: "win32",
      home: WIN_HOME,
      files: {
        [WIN_CODEX_AUTH]: JSON.stringify({
          auth_mode: "chatgpt",
          OPENAI_API_KEY: null,
          tokens: { access_token: "abc" },
        }),
      },
    })
    expect(getAgentsHealth(probe).codex).toEqual({
      present: true,
      version: "0.141.0",
      authenticated: true,
      authMethod: "subscription",
      plan: "ChatGPT",
    })
  })

  it("Codex: reads the Windows auth.json api-key mode", () => {
    const probe = makeProbe({
      platform: "win32",
      home: WIN_HOME,
      files: { [WIN_CODEX_AUTH]: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }) },
    })
    expect(getAgentsHealth(probe).codex).toMatchObject({
      authenticated: true,
      authMethod: "api_key",
      plan: null,
    })
  })
})

describe("config-dir overrides (cross-platform)", () => {
  it("Claude honours CLAUDE_CONFIG_DIR for the credentials file", () => {
    const overrideDir = "/custom/cfg"
    const cred = path.join(overrideDir, ".credentials.json")
    const probe = makeProbe({
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: overrideDir },
      files: { [cred]: JSON.stringify({ accessToken: "sk-ant-oat01-X", subscriptionType: "pro" }) },
    })
    expect(detectClaudeAuth(probe)).toEqual({
      authenticated: true,
      authMethod: "subscription",
      plan: "pro",
    })
  })

  it("Codex honours CODEX_HOME for auth.json", () => {
    const overrideDir = "/custom/codex"
    const auth = path.join(overrideDir, "auth.json")
    const probe = makeProbe({
      env: { CODEX_HOME: overrideDir },
      files: { [auth]: JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-x" }) },
    })
    expect(getAgentsHealth(probe).codex).toMatchObject({
      authenticated: true,
      authMethod: "api_key",
    })
  })
})

describe("honest unknown vs unauthenticated by OS", () => {
  it("Codex keyring mode (no auth.json on disk) degrades to not-authenticated, never fabricated", () => {
    // With `cli_auth_credentials_store=keyring`, creds live in the OS keyring and
    // auth.json is absent. We cannot read the keyring non-interactively, so the
    // honest verdict is the no-file one — NOT a made-up "authenticated".
    const probe = makeProbe({
      present: { codex: "/usr/bin/codex" },
      versions: { codex: "codex-cli 0.141.0" },
      platform: "win32",
      home: WIN_HOME,
      // no WIN_CODEX_AUTH entry → file absent
    })
    const codex = getAgentsHealth(probe).codex
    expect(codex.present).toBe(true)
    expect(codex.authenticated).toBe(false)
    expect(codex.authMethod).toBe(null)
  })

  it("macOS keeps honest 'unknown' (null) when the Keychain is unprobeable and no file", () => {
    const probe = makeProbe({ platform: "darwin", keychain: null })
    expect(detectClaudeAuth(probe).authenticated).toBe(null)
  })

  it("Windows/Linux never report 'unknown' — the file store gives a definite verdict", () => {
    expect(detectClaudeAuth(makeProbe({ platform: "win32", home: WIN_HOME })).authenticated).toBe(
      false
    )
    expect(detectClaudeAuth(makeProbe({ platform: "linux" })).authenticated).toBe(false)
  })
})

describe("no token leak (cross-platform)", () => {
  it("Windows health snapshot never echoes the access token", () => {
    const probe = makeProbe({
      present: { claude: "C:\\npm\\claude.cmd", codex: "C:\\npm\\codex.cmd" },
      versions: { claude: "2.1.0 (Claude Code)", codex: "codex-cli 0.141.0" },
      platform: "win32",
      home: WIN_HOME,
      files: {
        [WIN_CLAUDE_CRED]: JSON.stringify({
          claudeAiOauth: { accessToken: "sk-ant-oat01-SECRETLEAK", subscriptionType: "max" },
        }),
        [WIN_CODEX_AUTH]: JSON.stringify({
          auth_mode: "chatgpt",
          tokens: { access_token: "CODEX-SECRETLEAK" },
        }),
      },
    })
    const serialized = JSON.stringify(getAgentsHealth(probe))
    expect(serialized).not.toContain("sk-ant-oat01-SECRETLEAK")
    expect(serialized).not.toContain("CODEX-SECRETLEAK")
  })
})
