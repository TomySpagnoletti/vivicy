import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnLegAsync, spawnLegSync } from "./leg-timeout.ts";
import type { LegResult, LegTimeoutOptions } from "./leg-timeout.ts";

export interface AgentLeg {
  actor: string;
  role: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
}

export interface AgentIssue {
  id: string;
  transcript_dir: string;
  graph_refs?: string[];
  path?: string;
  issue_path?: string;
}

// The whole transcript taxonomy: every leg family's home under <transcriptsDir>, named ONCE here so two families can never collide and no call site composes a path of its own.
export const TRANSCRIPT_DIRS = {
  issues: "ISSUES",
  extraction: "EXTRACTION",
  acceptance: "ACCEPTANCE",
  retro: "RETRO",
  vivi: "VIVI",
  importDocs: "IMPORT-DOCS",
  autoskills: "AUTOSKILLS",
  changeRequests: "CHANGE-REQUESTS",
  spikes: "SPIKES",
} as const;

export function issueTranscriptDir(issueId: string): string {
  return `${TRANSCRIPT_DIRS.issues}/${issueId}`;
}

// The one place a work unit's declared home becomes a path: an id or a subpath reaching this function comes from a file an agent leg can write, so traversal dies here rather than one directory deeper.
export function transcriptDirRel(transcriptsDir: string, issue: AgentIssue): string {
  const subdir = issue.transcript_dir;
  const segments = typeof subdir === "string" ? subdir.split("/") : [];
  if (segments.length === 0 || subdir.includes("\\") || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`agent-spawn: "${String(subdir)}" is not a usable transcript directory for "${String(issue.id)}" — it must be a plain relative subpath of ${transcriptsDir}.`);
  }
  return `${transcriptsDir}/${subdir}`;
}

export interface LegConfig {
  promptsDir?: string;
  transcriptsDir?: string;
}

export interface LegDeps {
  composePrompt: (template: string, issue: AgentIssue) => string;
  agentCliArgs: (provider: string, leg: AgentLeg) => string[];
  abs: (rel: string) => string;
  execRoot: string;
  cwdFilter?: string | null;
}

export interface LegRunResult {
  result: LegResult;
  output: string;
  transcriptRel: string | undefined;
}

// Call sites also pass "encoding: utf8" but SpawnOptions has no such field — it's silently dropped, not forwarded.
interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: LegTimeoutOptions;
}

// Kills the leg's whole process group (not just the CLI pid) since the CLI spawns children that would otherwise survive a timeout.
export function spawnTee(command: string, args: string[], options: SpawnOptions = {}): LegResult {
  return spawnLegSync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout });
}

export function spawnTeeAsync(command: string, args: string[], options: SpawnOptions = {}): Promise<LegResult> {
  return spawnLegAsync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout });
}

export function combinedOutput(result: LegResult | null | undefined): string {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

// Everything in these namespaces configures the agent CLI, so the machine's copy of it is pollution.
const AGENT_ENV_ISOLATED_PREFIXES = ["ANTHROPIC_", "CLAUDE_", "CODEX_", "OPENAI_"];
const AGENT_ENV_ISOLATED_NAMES = new Set(["CLAUDECODE"]);

// The auth carve-out, one entry per authentication family the installed CLIs define, each carried WHOLE: a family split in half preserves a credential nothing can reach (a 3P key with no selector, an OIDC identity token with no federation/organization/scope quad — measured: the token alone cannot resolve an auth method, the group performs a real token exchange). Only ANTHROPIC_API_KEY, CLAUDE_CONFIG_DIR and CODEX_HOME are also read by lib/agents-health.ts; every other name is the CLIs' alone, so these lists are measured against their binaries and nothing else vouches for them — and the endpoints among them ARE config overrides, kept because a credential sent to the wrong host is a broken credential.
export const AGENT_ENV_AUTH_FAMILIES: Record<string, readonly string[]> = {
  anthropicFirstParty: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"],
  anthropicOidcFederation: ["ANTHROPIC_BASE_URL", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_IDENTITY_TOKEN", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_SCOPE", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID"],
  providerSelectors: ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_GATEWAY", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_VERTEX"],
  providerSkipAuth: ["CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH", "CLAUDE_CODE_SKIP_BEDROCK_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH", "CLAUDE_CODE_SKIP_MANTLE_AUTH", "CLAUDE_CODE_SKIP_VERTEX_AUTH"],
  providerCredentials: ["ANTHROPIC_AWS_API_KEY", "ANTHROPIC_BEDROCK_MANTLE_API_KEY", "ANTHROPIC_FOUNDRY_API_KEY"],
  providerEndpoints: ["ANTHROPIC_AWS_BASE_URL", "ANTHROPIC_AWS_WORKSPACE_ID", "ANTHROPIC_BEDROCK_BASE_URL", "ANTHROPIC_BEDROCK_MANTLE_BASE_URL", "ANTHROPIC_FOUNDRY_BASE_URL", "ANTHROPIC_FOUNDRY_RESOURCE", "ANTHROPIC_VERTEX_BASE_URL", "ANTHROPIC_VERTEX_PROJECT_ID"],
  codex: ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_API_KEY"],
};

export const AGENT_ENV_AUTH_PASSTHROUGH = new Set(Object.values(AGENT_ENV_AUTH_FAMILIES).flat());

export function isolateAgentEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (AGENT_ENV_AUTH_PASSTHROUGH.has(name)) {
      env[name] = value;
      continue;
    }
    if (AGENT_ENV_ISOLATED_NAMES.has(name)) continue;
    if (AGENT_ENV_ISOLATED_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
    env[name] = value;
  }
  return env;
}

// Deliberately no PROGRESS_* env injected — agents do no self-reporting; the orchestrator writes progress mechanically via its own emit().
export function agentEnv(): NodeJS.ProcessEnv {
  return isolateAgentEnv(process.env);
}

function agentHome(overrideName: string, defaultLeaf: string): string {
  const override = process.env[overrideName];
  return override && override.length > 0 ? resolve(override) : resolve(homedir(), defaultLeaf);
}

export type LegPromptErrorCode = "prompts_dir_unset" | "invalid_leg_role" | "unknown_leg_role" | "prompt_unreadable" | "empty_leg_prompt";

export class LegPromptError extends Error {
  code: LegPromptErrorCode;
  role: string;
  promptPath: string | null;
  constructor(message: string, code: LegPromptErrorCode, role: string, promptPath: string | null, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "LegPromptError";
    this.code = code;
    this.role = role;
    this.promptPath = promptPath;
  }
}

const PROMPT_EXT = ".md";
export const LEG_ROLE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function legRoles(promptsDir: string): string[] {
  return readdirSync(promptsDir, { withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(PROMPT_EXT))
    .map((entry) => entry.name.slice(0, -PROMPT_EXT.length))
    .sort();
}

function describeValidRoles(promptsDir: string): string {
  let roles: string[];
  try {
    roles = legRoles(promptsDir);
  } catch {
    return `The prompt directory ${promptsDir} could not be listed.`;
  }
  if (roles.length === 0) return `No prompt file exists under ${promptsDir}.`;
  return `Valid roles (one per prompt file under ${promptsDir}): ${roles.join(", ")}.`;
}

// cfg.promptsDir is an absolute factory path, independent of the target project being built.
export function readPrompt(cfg: LegConfig, role: string): string {
  const promptsDir = cfg.promptsDir;
  if (typeof promptsDir !== "string" || promptsDir.trim().length === 0) {
    throw new LegPromptError(
      `agent-spawn: cannot resolve the prompt for leg role "${String(role)}" — the leg config carries no promptsDir (an absolute factory prompts path is required).`,
      "prompts_dir_unset",
      String(role),
      null,
    );
  }
  if (typeof role !== "string" || !LEG_ROLE_PATTERN.test(role)) {
    throw new LegPromptError(
      `agent-spawn: "${String(role)}" is not a valid leg role — a role is lowercase kebab-case and names its prompt file <role>${PROMPT_EXT} under ${promptsDir}. ${describeValidRoles(promptsDir)}`,
      "invalid_leg_role",
      String(role),
      null,
    );
  }
  const promptPath = resolve(promptsDir, `${role}${PROMPT_EXT}`);
  let template: string;
  try {
    template = readFileSync(promptPath, "utf8");
  } catch (cause) {
    const errno = (cause as { code?: string } | null)?.code;
    if (errno === "ENOENT" || errno === "ENOTDIR") {
      throw new LegPromptError(
        `agent-spawn: leg role "${role}" has no prompt file — expected ${promptPath}. ${describeValidRoles(promptsDir)}`,
        "unknown_leg_role",
        role,
        promptPath,
        cause,
      );
    }
    throw new LegPromptError(
      `agent-spawn: leg role "${role}" has a prompt file that could not be read (${errno ?? "unknown error"}) — ${promptPath}.`,
      "prompt_unreadable",
      role,
      promptPath,
      cause,
    );
  }
  if (template.trim().length === 0) {
    throw new LegPromptError(
      `agent-spawn: leg role "${role}" resolves to an empty prompt file (${promptPath}) — a leg must never run on a blank prompt.`,
      "empty_leg_prompt",
      role,
      promptPath,
    );
  }
  return template;
}

// Loops all project dirs because the CLI's dir-name encoding for a session varies — no direct path is derivable.
export function captureClaudeTranscript(uuid: string, destAbs: string): boolean {
  const projectsDir = resolve(agentHome("CLAUDE_CONFIG_DIR", ".claude"), "projects");
  if (!existsSync(projectsDir)) return false;
  for (const sub of readdirSync(projectsDir)) {
    const candidate = resolve(projectsDir, sub, `${uuid}.jsonl`);
    if (existsSync(candidate)) {
      copyFileSync(candidate, destAbs);
      // Treat a 0-byte copy (session file not yet flushed) as not captured.
      try {
        return statSync(destAbs).size > 0;
      } catch {
        return false;
      }
    }
  }
  return false;
}

type RolloutLine = {
  cwd?: unknown;
  payload?: { cwd?: unknown; session_meta?: { cwd?: unknown } };
  session_meta?: { cwd?: unknown };
};

export function findNewestCodexRollout(sinceMs: number, cwdFilter: string | null = null): string | null {
  const base = resolve(agentHome("CODEX_HOME", ".codex"), "sessions");
  if (!existsSync(base)) return null;
  let best: string | null = null;
  let bestMtime = sinceMs - 1;
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // dir vanished or unreadable mid-walk
    }
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".jsonl")) {
        let mtime: number;
        try {
          mtime = statSync(full).mtimeMs;
        } catch {
          continue; // file removed between readdir and stat
        }
        if (mtime >= sinceMs && mtime > bestMtime && rolloutMatchesCwd(full, cwdFilter)) {
          best = full;
          bestMtime = mtime;
        }
      }
    }
  };
  walk(base);
  return best;
}

export function rolloutMatchesCwd(rolloutPath: string, cwdFilter: string | null): boolean {
  if (!cwdFilter) return true;
  let recorded: string | null = null;
  try {
    const text = readFileSync(rolloutPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      let obj: RolloutLine;
      try {
        obj = JSON.parse(line.trim()) as RolloutLine;
      } catch {
        continue;
      }
      const cwd = obj?.cwd ?? obj?.payload?.cwd ?? obj?.session_meta?.cwd ?? obj?.payload?.session_meta?.cwd;
      if (typeof cwd === "string" && cwd) {
        recorded = cwd;
        break;
      }
    }
  } catch {
    return true; // unreadable => do not exclude (best-effort capture)
  }
  if (recorded === null) return true; // no cwd recorded => cannot exclude
  return resolve(recorded) === resolve(cwdFilter);
}

export function ensureTranscriptDir(absTranscriptDir: string): void {
  mkdirSync(absTranscriptDir, { recursive: true });
}

// A leg is a product run, not a run of this machine: these flags are the whole of what keeps the user's CLAUDE.md/AGENTS.md, skills, plugins, hooks, MCP servers, memories and agent listings out of every leg; neither CLI's credential resolution sits on their path (each authenticates identically with and without them, measured with the flag as the only variable), and the target repo's project layer reaches the leg through the explicit AGENTS.md read every role prompt opens with, never through CLI auto-discovery.
export const CLAUDE_ISOLATION_ARGS = ["--safe-mode"];
export const CODEX_ISOLATION_ARGS = ["--ignore-user-config", "--ignore-rules", "-c", "skills.include_instructions=false", "--disable", "plugins", "--disable", "apps"];

export function buildClaudeArgs({ prompt, uuid, modelArgs }: { prompt: string; uuid: string; modelArgs: string[] }): string[] {
  return ["-p", prompt, ...CLAUDE_ISOLATION_ARGS, "--dangerously-skip-permissions", "--session-id", uuid, ...modelArgs];
}

export function buildCodexArgs({ prompt, root, modelArgs }: { prompt: string; root: string; modelArgs: string[] }): string[] {
  const args = ["exec", prompt, ...CODEX_ISOLATION_ARGS, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  args.push(...modelArgs);
  return args;
}

export function runClaudeLeg(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps): LegRunResult {
  return runClaudeLegWith(leg, issue, cfg, deps, spawnTee, captureClaudeTranscript) as LegRunResult;
}

export async function runClaudeLegAsync(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps): Promise<LegRunResult> {
  return runClaudeLegWith(leg, issue, cfg, deps, spawnTeeAsync, captureClaudeTranscript, true) as Promise<LegRunResult>;
}

function runClaudeLegWith(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  spawnFn: typeof spawnTee | typeof spawnTeeAsync,
  captureFn: typeof captureClaudeTranscript,
  isAsync = false,
): LegRunResult | Promise<LegRunResult> {
  const { composePrompt, agentCliArgs, abs, execRoot } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const uuid = randomUUID();
  const dirRel = transcriptDirRel(cfg.transcriptsDir!, issue);
  const transcriptRel = `${dirRel}/claude-${leg.role}-${uuid}.jsonl`;
  const args = buildClaudeArgs({ prompt, uuid, modelArgs: agentCliArgs("claude", leg) });
  const options = { cwd: execRoot, env: agentEnv(), encoding: "utf8" };
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(abs(dirRel));
    const captured = captureFn(uuid, abs(transcriptRel));
    return { result, output: combinedOutput(result), transcriptRel: captured ? transcriptRel : undefined };
  };
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("claude", args, options).then(finish);
  return finish((spawnFn as typeof spawnTee)("claude", args, options));
}

export function runCodexLeg(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps): LegRunResult {
  return runCodexLegWith(leg, issue, cfg, deps, spawnTee, false) as LegRunResult;
}

export async function runCodexLegAsync(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps): Promise<LegRunResult> {
  return runCodexLegWith(leg, issue, cfg, deps, spawnTeeAsync, true) as Promise<LegRunResult>;
}

function runCodexLegWith(
  leg: AgentLeg,
  issue: AgentIssue,
  cfg: LegConfig,
  deps: LegDeps,
  spawnFn: typeof spawnTee | typeof spawnTeeAsync,
  isAsync: boolean,
): LegRunResult | Promise<LegRunResult> {
  const { composePrompt, agentCliArgs, abs, execRoot, cwdFilter } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const dirRel = transcriptDirRel(cfg.transcriptsDir!, issue);
  const transcriptRel = `${dirRel}/codex-${leg.role}-${randomUUID()}.jsonl`;
  const args = buildCodexArgs({ prompt, root: execRoot, modelArgs: agentCliArgs("codex", leg) });
  const options = { cwd: execRoot, env: agentEnv(), encoding: "utf8" };
  const startMs = Date.now();
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(abs(dirRel));
    const output = combinedOutput(result);
    const rollout = findNewestCodexRollout(startMs, cwdFilter ?? null);
    if (rollout) {
      copyFileSync(rollout, abs(transcriptRel));
      return { result, output, transcriptRel };
    }
    return { result, output, transcriptRel: undefined };
  };
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("codex", args, options).then(finish);
  return finish((spawnFn as typeof spawnTee)("codex", args, options));
}
