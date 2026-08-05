import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  AGENT_ENV_AUTH_FAMILIES,
  AGENT_ENV_AUTH_PASSTHROUGH,
  CLAUDE_ISOLATION_ARGS,
  CODEX_ISOLATION_ARGS,
  LEG_ROLE_PATTERN,
  LegPromptError,
  TRANSCRIPT_DIRS,
  agentEnv,
  buildClaudeArgs,
  buildCodexArgs,
  captureClaudeTranscript,
  findNewestCodexRollout,
  isLegSessionId,
  isolateAgentEnv,
  issueTranscriptDir,
  legRoles,
  readCodexSessionId,
  readPrompt,
  readReply,
  resumeIdOf,
  runClaudeLeg,
  runCodexLeg,
  transcriptDirRel,
} from "./agent-spawn.ts"
import type { AgentIssue, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts"
import { FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.ts"

function scratchPrompts(): string {
  return mkdtempSync(join(tmpdir(), "vivicy-prompts-"))
}

function refusal(run: () => unknown): LegPromptError {
  let outcome: unknown
  try {
    outcome = run()
  } catch (error) {
    assert.ok(error instanceof LegPromptError, `expected a LegPromptError, got ${String(error)}`)
    return error
  }
  assert.fail(`expected a typed refusal, got ${JSON.stringify(outcome)}`)
}

test("readPrompt returns the role's prompt verbatim when the file backs it", () => {
  const dir = scratchPrompts()
  try {
    writeFileSync(join(dir, "readiness-checker.md"), "# Readiness Checker\n\nbody\n")
    assert.equal(readPrompt({ promptsDir: dir }, "readiness-checker"), "# Readiness Checker\n\nbody\n")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPrompt refuses a leg role with no prompt file, naming the role, the expected path, and the directory-derived valid roles", () => {
  const dir = scratchPrompts()
  try {
    writeFileSync(join(dir, "implementer.md"), "impl\n")
    writeFileSync(join(dir, "reviewer.md"), "rev\n")
    const error = refusal(() => readPrompt({ promptsDir: dir }, "readiness-checker"))
    assert.equal(error.code, "unknown_leg_role")
    assert.equal(error.name, "LegPromptError")
    assert.equal(error.role, "readiness-checker")
    assert.equal(error.promptPath, resolve(dir, "readiness-checker.md"))
    assert.match(error.message, /leg role "readiness-checker" has no prompt file/, "the refusal names the role that has no prompt")
    assert.ok(error.message.includes(resolve(dir, "readiness-checker.md")), "the refusal names the exact path it expected")
    assert.match(
      error.message,
      /Valid roles \(one per prompt file under .*\): implementer, reviewer\./,
      "the refusal lists the roles derived from the prompt directory, never a hand-list"
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPrompt refuses a blank prompt file rather than running a leg on no instructions", () => {
  const dir = scratchPrompts()
  try {
    writeFileSync(join(dir, "reviewer.md"), "   \n\t\n")
    const error = refusal(() => readPrompt({ promptsDir: dir }, "reviewer"))
    assert.equal(error.code, "empty_leg_prompt")
    assert.equal(error.role, "reviewer")
    assert.equal(error.promptPath, resolve(dir, "reviewer.md"))
    assert.match(error.message, /empty prompt file/, "the refusal says the file is empty, not that the role is unknown")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("readPrompt refuses a malformed leg role before it can resolve outside the prompt directory", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-prompts-root-"))
  try {
    const dir = join(root, "prompts")
    mkdirSync(dir)
    writeFileSync(join(dir, "reviewer.md"), "rev\n")
    writeFileSync(join(root, "outside.md"), "escaped\n")
    for (const role of ["", "  ", "../outside", "nested/reviewer", "Reviewer", "spike_prover", "reviewer.md", "-reviewer", "reviewer-"]) {
      const error = refusal(() => readPrompt({ promptsDir: dir }, role))
      assert.equal(error.code, "invalid_leg_role", `role ${JSON.stringify(role)} must be refused as malformed`)
      assert.equal(error.promptPath, null, `role ${JSON.stringify(role)} must be refused with no resolved prompt path to speak of`)
      assert.ok(
        !error.message.includes(join(root, "outside.md")),
        `role ${JSON.stringify(role)} must never name a path outside the prompt directory`
      )
    }
    const nonString = refusal(() => readPrompt({ promptsDir: dir }, null as unknown as string))
    assert.equal(nonString.code, "invalid_leg_role")
    assert.match(
      nonString.message,
      /"null" is not a valid leg role/,
      "a non-string role degrades to the same typed refusal, never a raw TypeError"
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("readPrompt refuses a leg config with no prompts directory instead of throwing a raw path error", () => {
  for (const promptsDir of [undefined, "", "   "]) {
    const error = refusal(() => readPrompt({ promptsDir }, "implementer"))
    assert.equal(error.code, "prompts_dir_unset")
    assert.equal(error.role, "implementer")
    assert.equal(error.promptPath, null)
    assert.match(error.message, /carries no promptsDir/, "the refusal names the missing config field")
  }
})

test("readPrompt distinguishes an unreadable prompt from an absent one instead of blaming the role", () => {
  const dir = scratchPrompts()
  try {
    mkdirSync(join(dir, "reviewer.md"))
    const error = refusal(() => readPrompt({ promptsDir: dir }, "reviewer"))
    assert.equal(error.code, "prompt_unreadable", "a directory sitting where the prompt belongs is a read failure, not an unknown role")
    assert.equal(error.promptPath, resolve(dir, "reviewer.md"))
    assert.equal((error.cause as { code?: string } | undefined)?.code, "EISDIR", "the underlying errno rides along as the cause")
    assert.doesNotMatch(error.message, /has no prompt file/, "a present-but-unreadable prompt must never be reported as a missing role")
    assert.deepEqual(legRoles(dir), [], "a directory named <role>.md is never advertised as a valid role")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("legRoles derives the valid role set from the prompt directory alone (*.md stems, non-prompt files ignored)", () => {
  const dir = scratchPrompts()
  try {
    writeFileSync(join(dir, "zebra-groomer.md"), "z\n")
    writeFileSync(join(dir, "quokka-herder.md"), "q\n")
    writeFileSync(join(dir, "aardvark-tamer.md"), "a\n")
    writeFileSync(join(dir, "notes.txt"), "not a prompt\n")
    writeFileSync(join(dir, "README"), "not a prompt\n")
    assert.deepEqual(legRoles(dir), ["aardvark-tamer", "quokka-herder", "zebra-groomer"])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("every role the factory's own prompt directory declares loads a non-empty prompt through the spawn seam", () => {
  const roles = legRoles(FACTORY_PROMPTS_DIR)
  assert.ok(roles.length > 0, "the factory prompt directory must declare at least one leg role")
  for (const role of roles) {
    assert.match(role, LEG_ROLE_PATTERN, `prompt file ${role}.md is not named after a valid leg role`)
    assert.ok(readPrompt({ promptsDir: FACTORY_PROMPTS_DIR }, role).trim().length > 0, `role ${role} must load a non-empty prompt`)
  }
})

const LEG_ROLE_LITERAL = new RegExp(`(?:\\brole:\\s*|\\bleg\\()"(${LEG_ROLE_PATTERN.source.replace(/^\^|\$$/g, "")})"`, "g")

test("buildClaudeArgs isolates the leg from the machine's Claude Code layers while keeping the prompt, the session id and the model args", () => {
  const args = buildClaudeArgs({
    prompt: "do the thing",
    sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    modelArgs: ["--model", "claude-opus-4-8", "--effort", "xhigh"],
  })
  assert.deepEqual(args, [
    "-p",
    "do the thing",
    "--safe-mode",
    "--dangerously-skip-permissions",
    "--session-id",
    "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    "--model",
    "claude-opus-4-8",
    "--effort",
    "xhigh",
  ])
  assert.deepEqual(
    CLAUDE_ISOLATION_ARGS,
    ["--safe-mode"],
    "one flag disables the whole user layer (CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents) and leaves auth resolution alone"
  )
})

test("buildClaudeArgs swaps ONLY the session flag to resume the same conversation — the isolation vector rides both modes verbatim", () => {
  const created = buildClaudeArgs({ prompt: "turn one", sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba", modelArgs: ["--model", "m"] })
  const resumed = buildClaudeArgs({
    prompt: "turn one",
    sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    resume: true,
    modelArgs: ["--model", "m"],
  })
  assert.deepEqual(resumed, [
    "-p",
    "turn one",
    "--safe-mode",
    "--dangerously-skip-permissions",
    "--resume",
    "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    "--model",
    "m",
  ])
  assert.deepEqual(
    resumed.filter((arg) => arg !== "--resume"),
    created.filter((arg) => arg !== "--session-id"),
    "resume changes one token and nothing else — measured: --resume composes with the whole isolation vector"
  )
  assert.equal(
    resumed.includes("--session-id"),
    false,
    "measured: the CLI refuses --session-id together with --resume unless --fork-session is set, and refuses a --session-id it already owns"
  )
  assert.equal(created.includes("--resume"), false, "a first turn mints its session, never resumes one")
})

test("buildClaudeArgs adopts --output-format json only where the caller asks for it, leaving the vector otherwise untouched", () => {
  const plain = buildClaudeArgs({ prompt: "p", sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba", modelArgs: ["--model", "m"] })
  const json = buildClaudeArgs({
    prompt: "p",
    sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    jsonReply: true,
    modelArgs: ["--model", "m"],
  })
  assert.equal(plain.includes("--output-format"), false, "every non-vivi leg still reads plain stdout — its argv must not move")
  assert.deepEqual(json, [
    "-p",
    "p",
    "--safe-mode",
    "--dangerously-skip-permissions",
    "--session-id",
    "0f9e8d7c-6b5a-4321-9876-543210fedcba",
    "--output-format",
    "json",
    "--model",
    "m",
  ])
  assert.deepEqual(
    buildClaudeArgs({ prompt: "p", sessionId: "0f9e8d7c-6b5a-4321-9876-543210fedcba", resume: true, jsonReply: true, modelArgs: [] }),
    [
      "-p",
      "p",
      "--safe-mode",
      "--dangerously-skip-permissions",
      "--resume",
      "0f9e8d7c-6b5a-4321-9876-543210fedcba",
      "--output-format",
      "json",
    ],
    "the json envelope is what carries session_id and usage back, so it must compose with resume too"
  )
})

test("buildCodexArgs isolates the leg from the machine's Codex layers while keeping the prompt, the exec root and the model args", () => {
  const args = buildCodexArgs({
    prompt: "do the thing",
    root: "/tmp/target",
    modelArgs: ["-m", "gpt-5.5", "-c", 'model_reasoning_effort="high"'],
  })
  assert.deepEqual(args, [
    "exec",
    "do the thing",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "skills.include_instructions=false",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--dangerously-bypass-approvals-and-sandbox",
    "-C",
    "/tmp/target",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
  ])
  assert.deepEqual(
    CODEX_ISOLATION_ARGS,
    ["--ignore-user-config", "--ignore-rules", "-c", "skills.include_instructions=false", "--disable", "plugins", "--disable", "apps"],
    "config.toml carries the user's MCP servers, memories and personality, .rules its execpolicy, the skills block its machine-wide SKILL.md roots, and the plugin/app surface its connectors plus the tool that would install more — auth keeps reading CODEX_HOME through all of it"
  )
})

test("buildCodexArgs resumes a thread as `exec resume <id> <prompt>` and drops -C, which that subcommand does not take", () => {
  const args = buildCodexArgs({
    prompt: "do the thing",
    root: "/tmp/target",
    resumeSessionId: "019fced2-d3d6-7902-b9d5-73abcd79c514",
    modelArgs: ["-m", "gpt-5.5"],
  })
  assert.deepEqual(args, [
    "exec",
    "resume",
    "019fced2-d3d6-7902-b9d5-73abcd79c514",
    "do the thing",
    "--ignore-user-config",
    "--ignore-rules",
    "-c",
    "skills.include_instructions=false",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "-m",
    "gpt-5.5",
  ])
  assert.equal(
    args.includes("-C"),
    false,
    "measured: `codex exec resume` rejects -C with exit 2 (`unexpected argument '-C' found`) — the resumed turn takes its cwd from the spawn, which is the same execRoot"
  )
  assert.deepEqual(
    args.filter((arg) => arg !== "resume" && arg !== "019fced2-d3d6-7902-b9d5-73abcd79c514"),
    buildCodexArgs({ prompt: "do the thing", root: "/tmp/target", modelArgs: ["-m", "gpt-5.5"] }).filter(
      (arg) => arg !== "-C" && arg !== "/tmp/target"
    ),
    "the whole isolation vector rides the resume subcommand verbatim — only the session identity and the cwd flag differ"
  )
})

const AUTH_CARVE_OUT = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_AWS_API_KEY",
  "ANTHROPIC_AWS_BASE_URL",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_BEDROCK_BASE_URL",
  "ANTHROPIC_BEDROCK_MANTLE_API_KEY",
  "ANTHROPIC_BEDROCK_MANTLE_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FOUNDRY_API_KEY",
  "ANTHROPIC_FOUNDRY_BASE_URL",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_IDENTITY_TOKEN",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SCOPE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_VERTEX_BASE_URL",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_WORKSPACE_ID",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
  "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
  "CLAUDE_CODE_SKIP_MANTLE_AUTH",
  "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_GATEWAY",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "OPENAI_API_KEY",
]

test("isolateAgentEnv drops every agent-CLI-configuring variable and keeps exactly the auth carve-out", () => {
  const kept = Object.fromEntries(AUTH_CARVE_OUT.map((name, index) => [name, `auth-${index}`]))
  const machine = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    ANTHROPIC_SMALL_FAST_MODEL: "claude-haiku-4-5",
    ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION: "eu-west-3",
    ANTHROPIC_BEDROCK_SERVICE_TIER: "priority",
    CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "vscode",
    CODEX_SANDBOX: "seatbelt",
    OPENAI_BASE_URL: "https://proxy.invalid",
  }
  const neutral = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    LANG: "en_US.UTF-8",
    AWS_PROFILE: "bedrock",
    GOOGLE_APPLICATION_CREDENTIALS: "/gcp.json",
    CLOUD_ML_REGION: "europe-west1",
    VIVICY_TARGET_ROOT: "/repo",
    VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
  }
  const env = isolateAgentEnv({ ...neutral, ...machine, ...kept, UNSET: undefined })
  assert.deepEqual(
    Object.keys(env).sort(),
    [...Object.keys(neutral), ...AUTH_CARVE_OUT].sort(),
    "the leg keeps its toolchain env (including the AWS/GCP credential vars that live outside these namespaces), Vivicy's own settings and every auth carrier, and loses every machine-level CLI configuration variable — including the model/tier/region knobs that sit inside the same provider families as the carriers"
  )
  assert.deepEqual(
    [...AGENT_ENV_AUTH_PASSTHROUGH].sort(),
    [...AUTH_CARVE_OUT].sort(),
    "the carve-out is credentials, credential-store locations, provider selectors/skip-auth flags and the endpoints a credential is valid against; changing it is an auth decision measured against the CLIs, since only ANTHROPIC_API_KEY/CLAUDE_CONFIG_DIR/CODEX_HOME are also read by lib/agents-health.ts"
  )
})

const CLI_AUTH_FAMILIES: Record<string, string[]> = {
  anthropicOidcFederation: [
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_IDENTITY_TOKEN",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_SCOPE",
    "ANTHROPIC_SERVICE_ACCOUNT_ID",
    "ANTHROPIC_WORKSPACE_ID",
  ],
  providerSelectors: [
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_GATEWAY",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_VERTEX",
  ],
  providerSkipAuth: [
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH",
    "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH",
  ],
}

test("every authentication family is carried whole — a kept credential is never left unreachable", () => {
  for (const [family, names] of Object.entries(CLI_AUTH_FAMILIES)) {
    assert.deepEqual(
      [...(AGENT_ENV_AUTH_FAMILIES[family] ?? [])].sort(),
      [...names].sort(),
      `${family}: the carve-out must carry this family exactly as the CLI defines it — half a family preserves a credential nothing can reach (a 3P key with no selector, an OIDC identity token with no federation/organization/scope quad), which is worse than dropping the family`
    )
  }
  for (const provider of ["ANTHROPIC_AWS", "BEDROCK", "FOUNDRY", "MANTLE", "VERTEX"]) {
    assert.ok(AGENT_ENV_AUTH_PASSTHROUGH.has(`CLAUDE_CODE_USE_${provider}`), `${provider}: skip-auth flag kept without its selector`)
    assert.ok(AGENT_ENV_AUTH_PASSTHROUGH.has(`CLAUDE_CODE_SKIP_${provider}_AUTH`), `${provider}: selector kept without its skip-auth flag`)
  }
  assert.ok(
    AGENT_ENV_AUTH_PASSTHROUGH.has("CLAUDE_CODE_USE_GATEWAY"),
    "the gateway is the one provider with a selector and no skip-auth flag; it must still ride through"
  )
  assert.deepEqual(
    [...AGENT_ENV_AUTH_PASSTHROUGH].sort(),
    [...new Set(Object.values(AGENT_ENV_AUTH_FAMILIES).flat())].sort(),
    "the passthrough set is derived from the families and never hand-extended beside them"
  )
})

test("agentEnv applies the isolation to the orchestrator's own environment", () => {
  const injected = {
    CLAUDE_CODE_PROBE_MARKER: "1",
    ANTHROPIC_MODEL: "claude-haiku-4-5",
    VIVICY_PROBE_MARKER: "1",
    ANTHROPIC_API_KEY: "sk-ant-api03-probe",
  }
  const previous = new Map(Object.entries(injected).map(([name]) => [name, process.env[name]]))
  Object.assign(process.env, injected)
  try {
    const env = agentEnv()
    assert.equal(env.CLAUDE_CODE_PROBE_MARKER, undefined)
    assert.equal(env.ANTHROPIC_MODEL, undefined)
    assert.equal(env.VIVICY_PROBE_MARKER, "1")
    assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-api03-probe")
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})

function withEnv<T>(overrides: Record<string, string | undefined>, run: () => T): T {
  const previous = new Map(Object.keys(overrides).map((name) => [name, process.env[name]]))
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  try {
    return run()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("transcript capture follows the same credential-store overrides the isolation lets through", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-agent-home-"))
  try {
    const uuid = "11112222-3333-4444-5555-666677778888"
    const claudeDir = join(root, "claude-config")
    mkdirSync(join(claudeDir, "projects", "-some-target"), { recursive: true })
    writeFileSync(join(claudeDir, "projects", "-some-target", `${uuid}.jsonl`), '{"type":"user"}\n')
    const dest = join(root, "captured.jsonl")
    assert.equal(
      withEnv({ CLAUDE_CONFIG_DIR: claudeDir }, () => captureClaudeTranscript(uuid, dest)),
      true
    )
    assert.equal(readFileSync(dest, "utf8"), '{"type":"user"}\n')
    assert.equal(
      withEnv({ CLAUDE_CONFIG_DIR: join(root, "empty") }, () => captureClaudeTranscript(uuid, dest)),
      false,
      "a redirected config dir with no session for the uuid is a miss, never a silent read of the default dir"
    )

    const codexHome = join(root, "codex-home")
    const rollout = join(codexHome, "sessions", "2026", "01", "01", "rollout-probe.jsonl")
    mkdirSync(resolve(rollout, ".."), { recursive: true })
    writeFileSync(rollout, '{"cwd":"/some/target"}\n')
    const stamp = new Date(2_000_000_000_000)
    utimesSync(rollout, stamp, stamp)
    assert.equal(
      withEnv({ CODEX_HOME: codexHome }, () => findNewestCodexRollout(1_999_999_999_000, null)),
      rollout
    )
    assert.equal(
      withEnv({ CODEX_HOME: join(root, "empty") }, () => findNewestCodexRollout(1_999_999_999_000, null)),
      null
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

interface FakeCliRun {
  argv: string[]
  env: Record<string, string>
  outcome: LegRunResult
}

function fakeCliRun(
  name: string,
  run: (deps: { cfg: LegConfig; issue: AgentIssue; deps: LegDeps; root: string }) => LegRunResult,
  says = ""
): FakeCliRun {
  const root = mkdtempSync(join(tmpdir(), "vivicy-fake-cli-"))
  try {
    const bin = join(root, "bin")
    const argvPath = join(root, "argv")
    const envPath = join(root, "env")
    const saysPath = join(root, "says")
    mkdirSync(bin, { recursive: true })
    writeFileSync(saysPath, says)
    writeFileSync(
      join(bin, name),
      `#!/bin/sh\nprintf '%s\\0' "$@" > ${JSON.stringify(argvPath)}\n/usr/bin/env -0 > ${JSON.stringify(envPath)}\ncat ${JSON.stringify(saysPath)}\n`,
      { mode: 0o755 }
    )
    const promptsDir = join(root, "prompts")
    mkdirSync(promptsDir, { recursive: true })
    writeFileSync(join(promptsDir, "implementer.md"), "leg instructions\n")
    const execRoot = join(root, "target")
    mkdirSync(execRoot, { recursive: true })
    const cfg: LegConfig = { promptsDir, transcriptsDir: ".vivicy/development/transcripts" }
    const issue: AgentIssue = { id: "ISSUE-1", transcript_dir: issueTranscriptDir("ISSUE-1") }
    const deps: LegDeps = {
      composePrompt: (template) => template,
      agentCliArgs: () => [],
      abs: (rel) => resolve(execRoot, rel),
      execRoot,
      cwdFilter: null,
    }
    const outcome = withEnv(
      {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        CLAUDE_CODE_PROBE_MARKER: "1",
        ANTHROPIC_MODEL: "claude-haiku-4-5",
        CLAUDECODE: "1",
        CODEX_SANDBOX: "seatbelt",
        VIVICY_PROBE_MARKER: "1",
        CLAUDE_CONFIG_DIR: join(root, "claude-config"),
        CODEX_HOME: join(root, "codex-home"),
        VIVICY_LEG_TIMEOUT_MS: "60000",
        VIVICY_LEG_IDLE_MS: "60000",
      },
      () => run({ cfg, issue, deps, root })
    )
    assert.ok(existsSync(argvPath), `the seam never reached the fake ${name} on PATH — nothing was recorded at ${argvPath}`)
    const argv = readFileSync(argvPath, "utf8").split("\0").slice(0, -1)
    const env: Record<string, string> = {}
    for (const entry of readFileSync(envPath, "utf8").split("\0")) {
      const eq = entry.indexOf("=")
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
    }
    return { argv, env, outcome }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("the spawn seam hands the real CLI the isolation flags and an isolated environment, for both providers", () => {
  const claude = fakeCliRun("claude", ({ cfg, issue, deps }) =>
    runClaudeLeg({ actor: "claude", role: "implementer", provider: "claude" }, issue, cfg, deps)
  )
  assert.ok(claude.argv.includes("--safe-mode"), `the claude leg must carry --safe-mode, got ${JSON.stringify(claude.argv)}`)
  assert.ok(claude.argv.includes("--dangerously-skip-permissions"))
  assert.equal(claude.argv[1], "leg instructions\n", "the composed prompt still rides as the -p argument")

  const codex = fakeCliRun("codex", ({ cfg, issue, deps }) =>
    runCodexLeg({ actor: "codex", role: "implementer", provider: "codex" }, issue, cfg, deps)
  )
  assert.ok(codex.argv.includes("--ignore-user-config"), `the codex leg must carry --ignore-user-config, got ${JSON.stringify(codex.argv)}`)
  assert.ok(codex.argv.includes("--ignore-rules"))
  assert.equal(codex.argv[1], "leg instructions\n", "the composed prompt still rides as the exec argument")

  for (const [provider, run] of [
    ["claude", claude],
    ["codex", codex],
  ] as const) {
    assert.equal(
      run.env.CLAUDE_CODE_PROBE_MARKER,
      undefined,
      `${provider}: a machine-level CLAUDE_CODE_* variable must not survive the seam`
    )
    assert.equal(run.env.ANTHROPIC_MODEL, undefined, `${provider}: a machine-level model override must not survive the seam`)
    assert.equal(run.env.CLAUDECODE, undefined, `${provider}: the leg must not run believing it is a nested Claude Code session`)
    assert.equal(run.env.CODEX_SANDBOX, undefined, `${provider}: a machine-level CODEX_* variable must not survive the seam`)
    assert.equal(run.env.VIVICY_PROBE_MARKER, "1", `${provider}: Vivicy's own env must survive the seam`)
    assert.ok(run.env.CLAUDE_CONFIG_DIR, `${provider}: the claude credential store override must survive the seam`)
    assert.ok(run.env.CODEX_HOME, `${provider}: the codex credential store override must survive the seam`)
    assert.ok(run.env.PATH, `${provider}: the leg's toolchain PATH must survive the seam`)
  }
})

const CLAUDE_JSON_ENVELOPE = JSON.stringify({
  is_error: false,
  num_turns: 1,
  session_id: "17aec720-df8e-4f19-959a-795075b2bbf8",
  total_cost_usd: 0.0026317,
  usage: { input_tokens: 10, cache_read_input_tokens: 21317, output_tokens: 88, service_tier: "standard" },
  modelUsage: { "claude-haiku-4-5": { contextWindow: 200000 } },
  subtype: "success",
  result: "BLUE-OTTER-42",
  type: "result",
})

// The measured rollout shape: every assistant line carries the exact prompt of the request that produced it.
function claudeAssistantLine(fill: { input: number; cacheRead: number; cacheCreation: number }, model = "claude-haiku-4-5"): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      model,
      usage: {
        input_tokens: fill.input,
        cache_read_input_tokens: fill.cacheRead,
        cache_creation_input_tokens: fill.cacheCreation,
        output_tokens: 279,
      },
    },
  })
}

test("the claude seam resumes a conversation instead of minting one, and one rollout keeps one transcript file", () => {
  const resumed = "17aec720-df8e-4f19-959a-795075b2bbf8"
  const run = fakeCliRun(
    "claude",
    ({ cfg, issue, deps, root }) => {
      const projects = join(root, "claude-config", "projects", "-target")
      mkdirSync(projects, { recursive: true })
      writeFileSync(
        join(projects, `${resumed}.jsonl`),
        `{"type":"user"}\n${claudeAssistantLine({ input: 10, cacheRead: 20539, cacheCreation: 4177 })}\n`
      )
      return runClaudeLeg({ actor: "claude", role: "implementer", provider: "claude" }, issue, cfg, deps, {
        resumeSessionId: resumed,
        jsonReply: true,
        measureContext: true,
      })
    },
    CLAUDE_JSON_ENVELOPE
  )
  assert.ok(run.argv.includes("--resume"), `the resumed leg must carry --resume, got ${JSON.stringify(run.argv)}`)
  assert.equal(run.argv[run.argv.indexOf("--resume") + 1], resumed)
  assert.equal(run.argv.includes("--session-id"), false, "the CLI refuses the session id it already owns — a resumed turn never carries it")
  assert.ok(
    run.argv.includes("--safe-mode") && run.argv.includes("--dangerously-skip-permissions"),
    "the isolation vector rides the resume"
  )
  assert.equal(
    run.outcome.transcriptRel,
    `.vivicy/development/transcripts/ISSUES/ISSUE-1/claude-implementer-${resumed}.jsonl`,
    "a resumed turn appends to ONE rollout, so its transcript is named after that conversation instead of piling up a file per turn"
  )
  assert.equal(run.outcome.reply, "BLUE-OTTER-42", "the reply is the envelope's .result, never the envelope itself")
  assert.equal(run.outcome.sessionId, resumed)
  assert.deepEqual(
    run.outcome.context,
    { used: 24726, window: 200000 },
    "the conversation's occupancy is the rollout's last prompt, joined to the window the envelope reports for that very model"
  )
})

test("the codex seam resumes by thread id and reads the id codex mints back out of the rollout it captured", () => {
  const thread = "019fced2-d3d6-7902-b9d5-73abcd79c514"
  const rolloutLine = JSON.stringify({
    timestamp: "2026-08-04T22:09:11.325Z",
    type: "session_meta",
    payload: { session_id: thread, cwd: "/target", cli_version: "0.146.0" },
  })
  const plantRollout = (root: string): void => {
    const dir = join(root, "codex-home", "sessions", "2026", "08", "05")
    mkdirSync(dir, { recursive: true })
    const rollout = join(dir, `rollout-${thread}.jsonl`)
    writeFileSync(rollout, `${rolloutLine}\n`)
    const ahead = new Date(Date.now() + 3_600_000)
    utimesSync(rollout, ahead, ahead)
  }

  const created = fakeCliRun("codex", ({ cfg, issue, deps, root }) => {
    plantRollout(root)
    return runCodexLeg({ actor: "codex", role: "implementer", provider: "codex" }, issue, cfg, deps)
  })
  assert.equal(created.argv[0], "exec")
  assert.equal(created.argv[1], "leg instructions\n", "a first turn is still `exec <prompt>` — nothing about it moves")
  assert.ok(created.argv.includes("-C"), "a first turn still declares its cwd with -C")
  assert.equal(created.outcome.sessionId, thread, "codex mints its own id; the rollout's session_meta is where the seam reads it back")

  const resumed = fakeCliRun("codex", ({ cfg, issue, deps, root }) => {
    plantRollout(root)
    return runCodexLeg({ actor: "codex", role: "implementer", provider: "codex" }, issue, cfg, deps, { resumeSessionId: thread })
  })
  assert.deepEqual(resumed.argv.slice(0, 4), ["exec", "resume", thread, "leg instructions\n"])
  assert.equal(resumed.argv.includes("-C"), false, "`codex exec resume` takes no -C — the resumed turn runs in the spawn cwd")
  assert.ok(
    resumed.argv.includes("--ignore-user-config") && resumed.argv.includes("--ignore-rules"),
    "the isolation vector rides the resume"
  )
  assert.equal(resumed.outcome.sessionId, thread)
  assert.equal(
    resumed.outcome.transcriptRel,
    `.vivicy/development/transcripts/ISSUES/ISSUE-1/codex-implementer-${thread}.jsonl`,
    "the resumed turn re-captures the one rollout it appended to, under that conversation's name"
  )
})

test("readReply is the one reader of what a leg said, in both output modes", () => {
  assert.deepEqual(readReply("  Ciao!  \n", false), { reply: "Ciao!" }, "plain stdout is the reply, trimmed — no envelope is expected")
  assert.deepEqual(readReply(`${CLAUDE_JSON_ENVELOPE}\n`, true), {
    reply: "BLUE-OTTER-42",
    sessionId: "17aec720-df8e-4f19-959a-795075b2bbf8",
    contextWindows: new Map([["claude-haiku-4-5", 200000]]),
  })
  for (const [stdout, why] of [
    ["", "an empty stdout"],
    ["Ciao!", "a plain sentence where an envelope was asked for"],
    ['{"type":"result","result":', "a truncated envelope"],
    ["null", "a JSON null"],
    ['"a string"', "a JSON scalar"],
    ['{"type":"result","subtype":"success"}', "an envelope with no result field"],
    ['{"type":"result","result":42}', "a non-string result"],
    ['{"type":"result","is_error":true,"result":"Credit balance too low"}', "an envelope the CLI itself marks failed"],
  ] as const) {
    assert.equal(
      readReply(stdout, true).reply,
      "",
      `${why} must leave the reply EMPTY, so the orchestrator's honest note speaks instead of the agent — never the raw envelope in Vivi's voice`
    )
  }
  assert.equal(
    readReply('{"type":"result","result":"hi","session_id":"../../../etc/passwd"}', true).sessionId,
    undefined,
    "the session id becomes a transcript filename and a lookup path, so a value that is not the CLI's own uuid is dropped"
  )
  for (const modelUsage of ['"lots"', "17", "null", "[10,88]", "{}", '{"m":null}', '{"m":{"contextWindow":0}}', '{"m":{}}']) {
    assert.equal(
      readReply(`{"type":"result","result":"hi","modelUsage":${modelUsage}}`, true).contextWindows,
      undefined,
      `${modelUsage} carries no usable context window`
    )
  }
  assert.deepEqual(
    [...(readReply(CLAUDE_JSON_ENVELOPE, true).contextWindows ?? new Map())],
    [["claude-haiku-4-5", 200000]],
    "the window is keyed by the CLI's own model id, which is what the rollout's assistant lines name"
  )
})

test("readCodexSessionId reads the thread id off the rollout's session_meta line and nothing else", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-codex-meta-"))
  try {
    const at = (name: string, body: string): string => {
      const path = join(root, name)
      writeFileSync(path, body)
      return path
    }
    const thread = "019fced2-d3d6-7902-b9d5-73abcd79c514"
    assert.equal(
      readCodexSessionId(
        at("ok.jsonl", `${JSON.stringify({ type: "session_meta", payload: { session_id: thread } })}\n{"type":"event"}\n`)
      ),
      thread
    )
    assert.equal(readCodexSessionId(join(root, "absent.jsonl")), undefined, "a rollout that is not there decides nothing")
    assert.equal(readCodexSessionId(at("empty.jsonl", "")), undefined)
    assert.equal(readCodexSessionId(at("torn.jsonl", '{"type":"session_meta","payload":{"session')), undefined, "a torn first line")
    assert.equal(readCodexSessionId(at("nometa.jsonl", '{"type":"event"}\n')), undefined, "the id is read from the FIRST line alone")
    assert.equal(
      readCodexSessionId(at("hostile.jsonl", '{"type":"session_meta","payload":{"session_id":"../../escape"}}\n')),
      undefined,
      "the id names a transcript file, so anything but the CLI's own uuid is dropped"
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a resume id that is not the CLI's own uuid is refused at the seam, never resolved into a path", () => {
  const cfg: LegConfig = { promptsDir: FACTORY_PROMPTS_DIR, transcriptsDir: ".vivicy/development/transcripts" }
  const issue: AgentIssue = { id: "ISSUE-1", transcript_dir: issueTranscriptDir("ISSUE-1") }
  const deps: LegDeps = {
    composePrompt: (template) => template,
    agentCliArgs: () => [],
    abs: (rel) => resolve("/vivicy-never-written", rel),
    execRoot: "/vivicy-never-written",
    cwdFilter: null,
  }
  for (const hostile of ["", "   ", "../../etc/passwd", "17AEC720-DF8E-4F19-959A-795075B2BBF8", "17aec720df8e4f19959a795075b2bbf8", "x"]) {
    assert.equal(isLegSessionId(hostile), false, `${JSON.stringify(hostile)} is not a CLI-minted session id`)
    for (const [provider, run] of [
      [
        "claude",
        () => runClaudeLeg({ actor: "claude", role: "implementer", provider: "claude" }, issue, cfg, deps, { resumeSessionId: hostile }),
      ],
      [
        "codex",
        () => runCodexLeg({ actor: "codex", role: "implementer", provider: "codex" }, issue, cfg, deps, { resumeSessionId: hostile }),
      ],
    ] as const) {
      assert.throws(
        run,
        /is not a usable session id to resume/,
        `${provider} must refuse ${JSON.stringify(hostile)} before it spawns anything`
      )
    }
  }
  assert.equal(resumeIdOf({}), undefined, "no resume id is the ordinary first turn, never a refusal")
  assert.equal(resumeIdOf({ resumeSessionId: "17aec720-df8e-4f19-959a-795075b2bbf8" }), "17aec720-df8e-4f19-959a-795075b2bbf8")
})

test("the role set the factory stamps on legs and the prompt-file set are the same set (bidirectional, no hand-list on either side)", () => {
  const stamped = new Set<string>()
  const sources = readdirSync(FACTORY_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
  assert.ok(sources.length > 0, "the factory source scan must find modules to read")
  for (const name of sources) {
    for (const match of readFileSync(join(FACTORY_DIR, name), "utf8").matchAll(LEG_ROLE_LITERAL)) stamped.add(match[1])
  }
  assert.deepEqual(
    [...stamped].sort(),
    legRoles(FACTORY_PROMPTS_DIR),
    'a leg role with no factory/prompts/<role>.md refuses at the spawn seam the first time that leg runs, and a prompt file no role stamps is dead weight — if a leg legitimately derives its role indirectly (not a literal `role: "…"` / `leg("…")`), that role is invisible to this scan and only the seam\'s typed refusal covers it'
  )
})

test("the ratified transcript taxonomy is the whole namespace, named once", () => {
  assert.deepEqual(TRANSCRIPT_DIRS, {
    issues: "ISSUES",
    extraction: "EXTRACTION",
    acceptance: "ACCEPTANCE",
    retro: "RETRO",
    vivi: "VIVI",
    importDocs: "IMPORT-DOCS",
    autoskills: "AUTOSKILLS",
    changeRequests: "CHANGE-REQUESTS",
    spikes: "SPIKES",
  })
  assert.equal(issueTranscriptDir("ISSUE-0007"), "ISSUES/ISSUE-0007", "a tracked product issue is grouped, never flat at the root")
})

test("every leg family declares its ratified transcript home exactly once, and no other factory module composes one", () => {
  const homes: Record<string, string> = {
    "extract-issues.ts": "transcript_dir: TRANSCRIPT_DIRS.extraction",
    "acceptance.ts": "transcript_dir: TRANSCRIPT_DIRS.acceptance",
    "retro.ts": "transcript_dir: TRANSCRIPT_DIRS.retro",
    "vivi-turn.ts": "transcript_dir: TRANSCRIPT_DIRS.vivi",
    "prepare-docs.ts": "transcript_dir: TRANSCRIPT_DIRS.importDocs",
    "detect-language.ts": "transcript_dir: TRANSCRIPT_DIRS.importDocs",
    "install-skills.ts": "transcript_dir: TRANSCRIPT_DIRS.autoskills",
    "cr-apply.ts": "transcript_dir: `${TRANSCRIPT_DIRS.changeRequests}/${id}`",
    "spike-prover.ts": "transcript_dir: `${TRANSCRIPT_DIRS.spikes}/${id}`",
    "dev-loop.ts": "transcript_dir: issueTranscriptDir(issue.id)",
  }
  const sources = readdirSync(FACTORY_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "agent-spawn.ts")
  const declaring: string[] = []
  for (const name of sources) {
    const text = readFileSync(join(FACTORY_DIR, name), "utf8")
    const occurrences = [...text.matchAll(/transcript_dir:(?!\s*string\b)/g)].length
    if (occurrences === 0) continue
    declaring.push(name)
    assert.equal(occurrences, 1, `${name} declares ${occurrences} transcript homes — a family has exactly one`)
    assert.ok(homes[name], `${name} declares a transcript home that this taxonomy pin does not know about`)
    assert.ok(
      text.includes(homes[name]),
      `${name} must declare its home as \`${homes[name]}\` — a hand-written path here is the per-call-site munging the single table exists to forbid`
    )
  }
  assert.deepEqual(
    declaring.sort(),
    Object.keys(homes).sort(),
    "a family that stopped declaring its home falls back to the ISSUES group silently"
  )
})

test("transcriptDirRel composes <transcripts>/<declared home> for every family shape", () => {
  const root = ".vivicy/development/transcripts"
  const dir = (transcript_dir: string) => transcriptDirRel(root, { id: "x", transcript_dir })
  assert.equal(transcriptDirRel(root, { id: "ISSUE-0007", transcript_dir: issueTranscriptDir("ISSUE-0007") }), `${root}/ISSUES/ISSUE-0007`)
  assert.equal(dir(TRANSCRIPT_DIRS.extraction), `${root}/EXTRACTION`)
  assert.equal(dir(TRANSCRIPT_DIRS.acceptance), `${root}/ACCEPTANCE`)
  assert.equal(dir(TRANSCRIPT_DIRS.retro), `${root}/RETRO`)
  assert.equal(dir(TRANSCRIPT_DIRS.vivi), `${root}/VIVI`)
  assert.equal(dir(TRANSCRIPT_DIRS.importDocs), `${root}/IMPORT-DOCS`)
  assert.equal(dir(TRANSCRIPT_DIRS.autoskills), `${root}/AUTOSKILLS`)
  assert.equal(dir(`${TRANSCRIPT_DIRS.changeRequests}/CR-APPLY-7`), `${root}/CHANGE-REQUESTS/CR-APPLY-7`)
  assert.equal(dir(`${TRANSCRIPT_DIRS.spikes}/SPIKE-S01-argon2id`), `${root}/SPIKES/SPIKE-S01-argon2id`)
})

test("transcriptDirRel refuses a declared home that is not a plain relative subpath", () => {
  const root = ".vivicy/development/transcripts"
  for (const hostile of [
    "..",
    "../../etc",
    "ISSUES/../../etc",
    "/etc/passwd",
    "",
    "ISSUES//ISSUE-1",
    "ISSUES/./ISSUE-1",
    "ISSUES\\..\\..\\etc",
    "ISSUES/ISSUE-1/",
  ]) {
    assert.throws(
      () => transcriptDirRel(root, { id: "ISSUE-1", transcript_dir: hostile }),
      /is not a usable transcript directory/,
      `"${hostile}" must never reach the filesystem — the issue index and the CR/spike files a leg can write feed this`
    )
  }
})

test("a leg's transcript lands under its family's directory, role-named so two legs of one family never collide", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-transcript-layout-"))
  try {
    const bin = join(root, "bin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const execRoot = join(root, "target")
    const codexHome = join(root, "codex-home")
    const sessions = join(codexHome, "sessions")
    mkdirSync(sessions, { recursive: true })
    const rollout = join(sessions, "rollout.jsonl")
    writeFileSync(rollout, '{"type":"session_meta"}\n')
    // The rollout mtime must stay ahead of every leg below: findNewestCodexRollout only takes a rollout at or after the leg's start.
    const ahead = new Date(Date.now() + 3_600_000)
    utimesSync(rollout, ahead, ahead)

    const cfg: LegConfig = { promptsDir: FACTORY_PROMPTS_DIR, transcriptsDir: ".vivicy/development/transcripts" }
    const deps: LegDeps = {
      composePrompt: (template) => template,
      agentCliArgs: () => [],
      abs: (rel) => resolve(execRoot, rel),
      execRoot,
      cwdFilter: null,
    }
    const landed = (role: string, issue: AgentIssue): string => {
      const result = withEnv(
        { PATH: `${bin}:${process.env.PATH ?? ""}`, CODEX_HOME: codexHome, VIVICY_LEG_TIMEOUT_MS: "60000", VIVICY_LEG_IDLE_MS: "60000" },
        () => runCodexLeg({ actor: "codex", role, provider: "codex" }, issue, cfg, deps)
      )
      const rel = result.transcriptRel
      assert.ok(rel, `the ${role} leg captured no transcript, so nothing proves where it would have landed`)
      assert.ok(existsSync(deps.abs(rel!)), `the ${role} leg's transcript is not on disk at ${rel}`)
      return rel!
    }

    assert.match(
      landed("implementer", { id: "ISSUE-0007", transcript_dir: issueTranscriptDir("ISSUE-0007") }),
      /^\.vivicy\/development\/transcripts\/ISSUES\/ISSUE-0007\/codex-implementer-[0-9a-f-]{36}\.jsonl$/
    )
    assert.equal(
      existsSync(deps.abs(".vivicy/development/transcripts/ISSUE-0007")),
      false,
      "no issue transcript may sit flat beside the family groups"
    )

    const importDocs: AgentIssue = { id: TRANSCRIPT_DIRS.importDocs, transcript_dir: TRANSCRIPT_DIRS.importDocs }
    const prep = landed("doc-prep", importDocs)
    const lang = landed("detect-language", importDocs)
    assert.match(prep, /^\.vivicy\/development\/transcripts\/IMPORT-DOCS\/codex-doc-prep-[0-9a-f-]{36}\.jsonl$/)
    assert.match(lang, /^\.vivicy\/development\/transcripts\/IMPORT-DOCS\/codex-detect-language-[0-9a-f-]{36}\.jsonl$/)
    assert.notEqual(prep, lang, "the two legs folded into IMPORT-DOCS are told apart by their role-named files")

    assert.match(
      landed("cr-applier", { id: "CR-APPLY-7", transcript_dir: `${TRANSCRIPT_DIRS.changeRequests}/CR-APPLY-7` }),
      /^\.vivicy\/development\/transcripts\/CHANGE-REQUESTS\/CR-APPLY-7\/codex-cr-applier-[0-9a-f-]{36}\.jsonl$/
    )
    assert.match(
      landed("spike-prover", { id: "SPIKE-S01-argon2id", transcript_dir: `${TRANSCRIPT_DIRS.spikes}/SPIKE-S01-argon2id` }),
      /^\.vivicy\/development\/transcripts\/SPIKES\/SPIKE-S01-argon2id\/codex-spike-prover-[0-9a-f-]{36}\.jsonl$/
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
