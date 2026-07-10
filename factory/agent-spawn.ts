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
  graph_refs?: string[];
  path?: string;
  issue_path?: string;
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
  transcriptDirAbs?: string;
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

// Deliberately no PROGRESS_* env injected — agents do no self-reporting; the orchestrator writes progress mechanically via its own emit().
export function agentEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

// cfg.promptsDir is an absolute factory path, independent of the target project being built.
export function readPrompt(cfg: LegConfig, name: string): string {
  return readFileSync(resolve(cfg.promptsDir!, `${name}.md`), "utf8");
}

// Loops all project dirs because the CLI's dir-name encoding for a session varies — no direct path is derivable.
export function captureClaudeTranscript(uuid: string, destAbs: string): boolean {
  const projectsDir = resolve(homedir(), ".claude", "projects");
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
  const base = resolve(homedir(), ".codex", "sessions");
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

export function buildClaudeArgs({ prompt, uuid, modelArgs }: { prompt: string; uuid: string; modelArgs: string[] }): string[] {
  return ["-p", prompt, "--dangerously-skip-permissions", "--session-id", uuid, ...modelArgs];
}

export function buildCodexArgs({ prompt, root, modelArgs }: { prompt: string; root: string; modelArgs: string[] }): string[] {
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
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
  const { composePrompt, agentCliArgs, abs, execRoot, transcriptDirAbs } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const uuid = randomUUID();
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/claude-${leg.role}-${uuid}.jsonl`;
  const args = buildClaudeArgs({ prompt, uuid, modelArgs: agentCliArgs("claude", leg) });
  const options = { cwd: execRoot, env: agentEnv(), encoding: "utf8" };
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(transcriptDirAbs!);
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
  const { composePrompt, agentCliArgs, abs, execRoot, transcriptDirAbs, cwdFilter } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/codex-${leg.role}-${randomUUID()}.jsonl`;
  const args = buildCodexArgs({ prompt, root: execRoot, modelArgs: agentCliArgs("codex", leg) });
  const options = { cwd: execRoot, env: agentEnv(), encoding: "utf8" };
  const startMs = Date.now();
  const finish = (result: LegResult): LegRunResult => {
    ensureTranscriptDir(transcriptDirAbs!);
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
