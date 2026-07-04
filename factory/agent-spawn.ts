// Shared agent-leg spawn infrastructure.
//
// One owner for "spawn a real Claude/Codex CLI leg, tee its output to the
// console, capture its full session transcript into our gitignored store, and
// return the leg-result shape the rest of the pipeline understands". Both the
// two-agent dev loop (dev-loop.ts) and the semantic issue extractor
// (extract-issues.ts) drive agents through these helpers, so the model/effort
// flags, the max-permission flags, and the transcript capture are defined ONCE and
// never diverge between the two drivers. Agents do NO governance — no progress MCP,
// no self-reporting — so there is no MCP wiring or progress env to inject here.
//
// Pure helpers (composePrompt, agentCliArgs) live in dev-loop.ts and are
// imported here, so this module owns only the impure spawn + capture surface.
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawnLegAsync, spawnLegSync } from "./leg-timeout.ts";
import type { LegResult, LegTimeoutOptions } from "./leg-timeout.ts";

// One agent leg's identity + model policy (built by resolveAgentLegs in dev-loop.ts;
// re-roled by the CR applier / upload verifier / vivi turn). `provider` selects the
// CLI; `role` picks the prompt + names the transcript. Every field beyond actor/role
// is optional: re-roled legs are built by spreading a base leg and overriding role.
export interface AgentLeg {
  actor: string;
  role: string;
  provider?: string;
  model?: string;
  effort?: string;
  fast?: boolean;
}

// The synthetic (or real) issue a leg runs against — its transcript/identity handle.
// Only `id` is required; the runners read it for the transcript path.
export interface AgentIssue {
  id: string;
  graph_refs?: string[];
  path?: string;
  issue_path?: string;
}

// The config fields the leg runners read: the factory prompts dir (readPrompt) and
// the transcripts dir (transcript path). Optional to accept the loop's fuller Config
// (dev-loop's DEFAULT_CONFIG is passed); the runners assume they are present, exactly
// as the pre-migration code did.
export interface LegConfig {
  promptsDir?: string;
  transcriptsDir?: string;
}

// The injected root-resolution + prompt seams a caller binds to its own repo, so
// this module stays free of target-root/flag-policy details. `composePrompt` may
// ignore its args (vivi passes an already-composed prompt) — fewer params is fine.
export interface LegDeps {
  composePrompt: (template: string, issue: AgentIssue) => string;
  agentCliArgs: (provider: string, leg: AgentLeg) => string[];
  abs: (rel: string) => string;
  execRoot: string;
  transcriptDirAbs?: string;
  cwdFilter?: string | null;
}

// The canonical leg-run result the runners return: the raw leg result, its combined
// output, and the captured transcript path (undefined when nothing was captured).
export interface LegRunResult {
  result: LegResult;
  output: string;
  transcriptRel: string | undefined;
}

// Options forwarded to the timeout-enforcing spawn (cwd/env/timeout). `encoding`
// rides along on the concrete call sites and is ignored by the spawn layer.
interface SpawnOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeout?: LegTimeoutOptions;
}

// Spawn an agent leg capturing stdout+stderr while still TEEing them to the
// console (so the live view is never lost) — we need the text to scan for a
// rate-limit signal. Returns the spawnSync-style result with `.stdout`/`.stderr`
// populated (combined text available via `combinedOutput(result)`).
//
// Every leg runs under leg-timeout.ts: a hard wall-clock cap AND a stall/idle
// timeout (whichever trips first), each enforced by killing the leg's WHOLE
// process group (the CLI spawns children) so a wedged `codex exec`/`claude` can
// never block the orchestrator forever. A trip returns a structured timeout
// failure (`timedOut:true`, `timeoutReason`, non-zero status) so the loop treats
// it as a failed attempt within its existing bounded-retry logic. Pass
// `options.timeout` ({ capMs, idleMs, graceMs }) to override the env/defaults
// (tests use tiny values; production uses VIVICY_LEG_TIMEOUT_MS / _IDLE_MS).
export function spawnTee(command: string, args: string[], options: SpawnOptions = {}): LegResult {
  return spawnLegSync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout });
}

// Async sibling of spawnTee: spawn the leg WITHOUT blocking the event loop, so N
// parallel issues can each have a CLI child running at once (the whole point of
// the parallel loop — a sync spawn would serialize them). Same timeout +
// process-group-kill guarantees as spawnTee; resolves to the same leg-result
// shape ({ status, stdout, stderr, timedOut?, timeoutReason? }).
export function spawnTeeAsync(command: string, args: string[], options: SpawnOptions = {}): Promise<LegResult> {
  return spawnLegAsync(command, args, { cwd: options.cwd, env: options.env, timeout: options.timeout });
}

// Combined stdout+stderr text of a leg result (for rate-limit scanning).
export function combinedOutput(result: LegResult | null | undefined): string {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

// The environment a leg inherits. Agents do NO governance — progress is written
// MECHANICALLY by the orchestrator (dev-loop's own emit()), never self-reported by
// the agent — so no PROGRESS_* identity/ledger env is injected here. The leg runs
// with the operator's environment only; its identity (actor/role) drives the
// transcript name and the orchestrator's ledger events, not any agent-side hook.
export function agentEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

// Role prompts are bundled with the factory (cfg.promptsDir is an absolute
// factory path), independent of which target project the loop is building.
export function readPrompt(cfg: LegConfig, name: string): string {
  return readFileSync(resolve(cfg.promptsDir!, `${name}.md`), "utf8");
}

// Locate the Claude session transcript JSONL by its session id across the CLI's
// project dirs (the dir-name encoding varies), and copy it into our store.
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

// A parsed line of a codex rollout JSONL — only the cwd-bearing shapes we probe.
type RolloutLine = {
  cwd?: unknown;
  payload?: { cwd?: unknown; session_meta?: { cwd?: unknown } };
  session_meta?: { cwd?: unknown };
};

// The rollout created during this leg = newest .jsonl under ~/.codex/sessions with
// mtime at or after the run start. Sequentially (one codex at a time) the newest
// since start is unambiguous. Under concurrency, pass `cwdFilter` (the leg's
// worktree root): we then only accept a rollout whose recorded session cwd matches
// that worktree, so a SIBLING codex leg running in another worktree is never
// mis-captured. A rollout that records no cwd still matches (best-effort) so the
// filter never drops a legitimately-empty capture.
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

// Does a codex rollout file belong to a session launched in `cwdFilter`? Codex
// records the session cwd in its first `session_meta` line. With no filter (the
// sequential path) every rollout matches. A rollout that records no parseable cwd
// matches too, so the filter only EXCLUDES a rollout we can positively attribute
// to a DIFFERENT worktree — never a false negative that loses a real transcript.
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

// Build the Claude CLI argv for a leg: the composed prompt, max-permission +
// session-id flags, then the model/effort/fast flags. No MCP config is wired —
// agents do exactly one of the four allowed actions and NO governance, so there is
// no progress MCP for them to reach. The caller supplies `agentCliArgs` (pure,
// lives in dev-loop.ts) so this module stays free of the flag-policy details
// while still owning the spawn shape.
export function buildClaudeArgs({ prompt, uuid, modelArgs }: { prompt: string; uuid: string; modelArgs: string[] }): string[] {
  return ["-p", prompt, "--dangerously-skip-permissions", "--session-id", uuid, ...modelArgs];
}

// Build the Codex CLI argv for a leg.
export function buildCodexArgs({ prompt, root, modelArgs }: { prompt: string; root: string; modelArgs: string[] }): string[] {
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  args.push(...modelArgs);
  return args;
}

// Run ONE Claude leg (sync). `deps` injects spawn + capture so tests run without
// a real CLI; production passes the real spawnTee + captureClaudeTranscript.
// Returns the canonical leg-result shape { result, output, transcriptRel }.
export function runClaudeLeg(leg: AgentLeg, issue: AgentIssue, cfg: LegConfig, deps: LegDeps): LegRunResult {
  return runClaudeLegWith(leg, issue, cfg, deps, spawnTee, captureClaudeTranscript) as LegRunResult;
}

// Async sibling: spawn non-blocking so N legs can run at once.
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
  // spawnFn is exactly spawnTee (sync) or spawnTeeAsync (async), picked by isAsync;
  // narrow the union to the matching concrete signature at each branch.
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("claude", args, options).then(finish);
  return finish((spawnFn as typeof spawnTee)("claude", args, options));
}

// Run ONE Codex leg (sync).
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
  // spawnFn is exactly spawnTee (sync) or spawnTeeAsync (async), picked by isAsync;
  // narrow the union to the matching concrete signature at each branch.
  if (isAsync) return (spawnFn as typeof spawnTeeAsync)("codex", args, options).then(finish);
  return finish((spawnFn as typeof spawnTee)("codex", args, options));
}
