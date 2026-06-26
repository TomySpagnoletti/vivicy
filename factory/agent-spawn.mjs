// Shared agent-leg spawn infrastructure.
//
// One owner for "spawn a real Claude/Codex CLI leg, tee its output to the
// console, capture its full session transcript into our gitignored store, and
// return the leg-result shape the rest of the pipeline understands". Both the
// two-agent dev loop (dev-loop.mjs) and the semantic issue extractor
// (extract-issues.mjs) drive agents through these helpers, so the model/effort
// flags, the max-permission flags, the MCP wiring, the actor/role env, and the
// transcript capture are defined ONCE and never diverge between the two drivers.
//
// Pure helpers (composePrompt, agentCliArgs) live in dev-loop.mjs and are
// imported here, so this module owns only the impure spawn + capture surface.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

// Spawn an agent leg capturing stdout+stderr while still TEEing them to the
// console (so the live view is never lost) — we need the text to scan for a
// rate-limit signal. Returns the spawnSync-style result with `.stdout`/`.stderr`
// populated (combined text available via `combinedOutput(result)`).
export function spawnTee(command, args, options) {
  // pipe (capture) + an `on("data")`-style tee is not available from spawnSync;
  // we capture via spawnSync's default pipe and re-emit to the parent streams.
  const result = spawnSync(command, args, { ...options, stdio: ["inherit", "pipe", "pipe"] });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result;
}

// Async sibling of spawnTee: spawn the leg WITHOUT blocking the event loop, so N
// parallel issues can each have a CLI child running at once (the whole point of
// the parallel loop — spawnSync would serialize them). Captures stdout+stderr
// (teeing live to the console) and resolves to the same spawnSync-shaped result
// ({ status, stdout, stderr }) the rest of the pipeline already understands.
export function spawnTeeAsync(command, args, options) {
  return new Promise((resolveLeg) => {
    let child;
    try {
      child = spawn(command, args, { ...options, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      // Mirror spawnSync's error shape so detectRateLimit/quota handling still run.
      resolveLeg({ status: null, stdout: "", stderr: String(error?.message ?? error), error });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      resolveLeg({ status: null, stdout, stderr: `${stderr}${error?.message ?? error}`, error });
    });
    child.on("close", (code) => {
      resolveLeg({ status: code, stdout, stderr });
    });
  });
}

// Combined stdout+stderr text of a leg result (for rate-limit scanning).
export function combinedOutput(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

// Env injected into each agent leg so its lifecycle hooks know the issue, actor,
// role, session, and ledger paths to report against — identity is config-driven,
// not chosen by the agent.
export function agentEnv(issue, cfg, leg) {
  return {
    ...process.env,
    PROGRESS_ISSUE_ID: issue.id,
    PROGRESS_GRAPH_REFS: (issue.graph_refs ?? []).join(","),
    PROGRESS_ACTOR: leg.actor,
    PROGRESS_ROLE: leg.role,
    PROGRESS_SESSION_REF: `${leg.actor}:${issue.id}`,
    PROGRESS_ISSUE_INDEX_PATH: cfg.issueIndexPath,
    PROGRESS_PROGRESS_LEDGER_PATH: cfg.progressLedgerPath,
  };
}

// Role prompts are bundled with the factory (cfg.promptsDir is an absolute
// factory path), independent of which target project the loop is building.
export function readPrompt(cfg, name) {
  return readFileSync(resolve(cfg.promptsDir, `${name}.md`), "utf8");
}

// Locate the Claude session transcript JSONL by its session id across the CLI's
// project dirs (the dir-name encoding varies), and copy it into our store.
export function captureClaudeTranscript(uuid, destAbs) {
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

// The rollout created during this leg = newest .jsonl under ~/.codex/sessions with
// mtime at or after the run start. Sequentially (one codex at a time) the newest
// since start is unambiguous. Under concurrency, pass `cwdFilter` (the leg's
// worktree root): we then only accept a rollout whose recorded session cwd matches
// that worktree, so a SIBLING codex leg running in another worktree is never
// mis-captured. A rollout that records no cwd still matches (best-effort) so the
// filter never drops a legitimately-empty capture.
export function findNewestCodexRollout(sinceMs, cwdFilter = null) {
  const base = resolve(homedir(), ".codex", "sessions");
  if (!existsSync(base)) return null;
  let best = null;
  let bestMtime = sinceMs - 1;
  const walk = (dir) => {
    let entries;
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
        let mtime;
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
export function rolloutMatchesCwd(rolloutPath, cwdFilter) {
  if (!cwdFilter) return true;
  let recorded = null;
  try {
    const text = readFileSync(rolloutPath, "utf8");
    for (const line of text.split("\n")) {
      if (!line.includes('"cwd"')) continue;
      let obj;
      try {
        obj = JSON.parse(line.trim());
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

export function ensureTranscriptDir(absTranscriptDir) {
  mkdirSync(absTranscriptDir, { recursive: true });
}

// Build the Claude CLI argv for a leg: the composed prompt, max-permission +
// session-id flags, optional MCP config, then the model/effort/fast flags. The
// caller supplies `agentCliArgs` (pure, lives in dev-loop.mjs) so this module
// stays free of the flag-policy details while still owning the spawn shape.
export function buildClaudeArgs({ prompt, uuid, mcpConfigPath, modelArgs }) {
  const args = ["-p", prompt, "--dangerously-skip-permissions", "--session-id", uuid];
  if (mcpConfigPath) args.push("--mcp-config", mcpConfigPath);
  args.push(...modelArgs);
  return args;
}

// Build the Codex CLI argv for a leg.
export function buildCodexArgs({ prompt, root, modelArgs }) {
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  args.push(...modelArgs);
  return args;
}

// Run ONE Claude leg (sync). `deps` injects spawn + capture so tests run without
// a real CLI; production passes the real spawnTee + captureClaudeTranscript.
// Returns the canonical leg-result shape { result, output, transcriptRel }.
export function runClaudeLeg(leg, issue, cfg, deps) {
  return runClaudeLegWith(leg, issue, cfg, deps, spawnTee, captureClaudeTranscript);
}

// Async sibling: spawn non-blocking so N legs can run at once.
export async function runClaudeLegAsync(leg, issue, cfg, deps) {
  return runClaudeLegWith(leg, issue, cfg, deps, spawnTeeAsync, captureClaudeTranscript, true);
}

function runClaudeLegWith(leg, issue, cfg, deps, spawnFn, captureFn, isAsync = false) {
  const { composePrompt, agentCliArgs, abs, execRoot, transcriptDirAbs } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const uuid = randomUUID();
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/claude-${leg.role}-${uuid}.jsonl`;
  const args = buildClaudeArgs({ prompt, uuid, mcpConfigPath: cfg.mcpConfigPath, modelArgs: agentCliArgs("claude", leg) });
  const options = { cwd: execRoot, env: agentEnv(issue, cfg, leg), encoding: "utf8" };
  const finish = (result) => {
    ensureTranscriptDir(transcriptDirAbs);
    const captured = captureFn(uuid, abs(transcriptRel));
    return { result, output: combinedOutput(result), transcriptRel: captured ? transcriptRel : undefined };
  };
  if (isAsync) return spawnFn("claude", args, options).then(finish);
  return finish(spawnFn("claude", args, options));
}

// Run ONE Codex leg (sync).
export function runCodexLeg(leg, issue, cfg, deps) {
  return runCodexLegWith(leg, issue, cfg, deps, spawnTee, false);
}

export async function runCodexLegAsync(leg, issue, cfg, deps) {
  return runCodexLegWith(leg, issue, cfg, deps, spawnTeeAsync, true);
}

function runCodexLegWith(leg, issue, cfg, deps, spawnFn, isAsync) {
  const { composePrompt, agentCliArgs, abs, execRoot, transcriptDirAbs, cwdFilter } = deps;
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/codex-${leg.role}-${randomUUID()}.jsonl`;
  const args = buildCodexArgs({ prompt, root: execRoot, modelArgs: agentCliArgs("codex", leg) });
  const options = { cwd: execRoot, env: agentEnv(issue, cfg, leg), encoding: "utf8" };
  const startMs = Date.now();
  const finish = (result) => {
    ensureTranscriptDir(transcriptDirAbs);
    const output = combinedOutput(result);
    const rollout = findNewestCodexRollout(startMs, cwdFilter ?? null);
    if (rollout) {
      copyFileSync(rollout, abs(transcriptRel));
      return { result, output, transcriptRel };
    }
    return { result, output, transcriptRel: undefined };
  };
  if (isAsync) return spawnFn("codex", args, options).then(finish);
  return finish(spawnFn("codex", args, options));
}
