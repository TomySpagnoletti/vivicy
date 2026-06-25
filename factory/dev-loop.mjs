#!/usr/bin/env node
// Vivicy development orchestrator (the conductor).
//
// Deterministic loop, NOT a self-looping agent:
//   pick next ready issue -> implementer agent -> reviewer agent (review & fix)
//   -> orchestrator RE-RUNS the gate itself (never trusts an agent's "done") ->
//   on green: emit verified, commit, move the issue to done/ -> next. Up to
//   maxRetries cycles, then issue_blocked for a human.
//
// One issue = one conversation: each leg is a fresh CLI invocation (no carryover).
// Durable state lives in the repo, canonical docs, issue-index and the ledger.
//
// Which CLI fills each ROLE is configurable (R12): the implementer and reviewer
// are assigned to distinct CLIs (claude / codex) — a CLI never reviews its own
// work. The assignment + each CLI's model/level come from the Vivicy settings
// dialog via env (VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI / VIVICY_CLAUDE_* /
// VIVICY_CODEX_*); see resolveAgentLegs.
//
// Agent/gate/commit steps are injectable (opts) so the flow is unit-tested with
// fast deterministic stubs; the defaults invoke the real claude / codex CLIs.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./atomic-write.mjs";
import { recordProgressEvent } from "./progress-ledger.mjs";
import { checkSkills } from "./dev-preflight.mjs";
import { resolveTargetRoot, FACTORY_PROMPTS_DIR } from "./target-root.mjs";

// The target project the loop drives (agents cwd, gate, paths all resolve there).
// VIVICY_TARGET_ROOT selects it (NAIGHT_DEV_ROOT is the legacy alias); unset =>
// no target. The loop only resolves the target when it actually runs against one
// (see assertTargetRoot); pure helpers (composePrompt, gate parsing, …) and the
// unit tests stay usable with no target configured.
const repoRootOrNull = resolveTargetRoot();

/**
 * The configured target project root, or throw a clear error when none is set.
 * Vivicy is standalone: with no VIVICY_TARGET_ROOT there is no project to build,
 * so we fail loudly instead of guessing a directory.
 */
function requireRepoRoot() {
  if (!repoRootOrNull) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project Vivicy should build.",
    );
  }
  return repoRootOrNull;
}

// The CLIs Vivicy can assign to a role, with each CLI's latest-known model + the
// default thinking level. Mirrors lib/settings.ts (the two must agree); the level
// is the user-tunable knob, the model defaults to always-latest.
export const CLI_DEFAULTS = {
  claude: { model: "claude-opus-4-8", effort: "xhigh" },
  codex: { model: "gpt-5.5", effort: "high" },
};

/** The set of CLIs the loop knows how to spawn. */
export const KNOWN_CLIS = ["claude", "codex"];

// The models whose FAST mode genuinely functions on the HEADLESS run each CLI does
// here. Mirrors lib/settings.ts MODELS[*].capability.fast (the two must agree) — the
// loop is the authoritative gate: even if the env asks for fast on a model not in
// this set, agentCliArgs omits the fast flag, so a non-functional fast run is never
// requested. Provenance (verified 2026-06 against official docs + local CLIs):
//   - Claude fast mode = `"fastMode": true` in the settings JSON, handed to the
//     headless `claude -p` via `--settings` (which accepts a JSON string). The
//     `fastMode` settings key and `--settings <file-or-json>` are both documented;
//     the headless run reads the settings it is given. Supported ONLY on Opus
//     4.6/4.7/4.8 (not Sonnet/Haiku/older). Requires a Claude subscription/Console
//     auth with usage credits; on an API-key-only box it is a no-op, never an error.
//     (https://code.claude.com/docs/en/fast-mode)
//   - Codex fast mode = `-c fast_mode=true`, a STABLE feature flag (`codex features
//     list` shows fast_mode stable) honored by `codex exec`. It prioritises serving
//     (~1.5x faster inference; 2.5x credit rate on gpt-5.5, 2x on gpt-5.4) and works
//     ONLY when authenticated via ChatGPT — with an API key it is a no-op. Supported
//     on gpt-5.5 + gpt-5.4 only; gpt-5.4-mini has no documented fast support and
//     gpt-5.3-codex-spark is already a separate low-latency model, so neither is a
//     fast target. (https://developers.openai.com/codex/models,
//     https://developers.openai.com/codex/speed)
export const FAST_CAPABLE_MODELS = {
  claude: new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]),
  codex: new Set(["gpt-5.5", "gpt-5.4"]),
};

/** Does fast mode genuinely function for this CLI+model on the headless run? */
function modelSupportsFast(provider, model) {
  return FAST_CAPABLE_MODELS[provider]?.has(model) ?? false;
}

// The reasoning/effort levels each CLI accepts, as a defensive gate on env-supplied
// values. Mirrors lib/settings.ts EFFORT_LEVELS (the two must agree). The settings →
// env pipeline already normalizes effort, but a hand-edited settings file or a
// directly-set VIVICY_<CLI>_EFFORT could carry a bad value; gating it here keeps the
// loop from ever spawning a CLI with an effort flag it would reject. An empty/unset
// effort is allowed (a model with no reasoning control, e.g. gpt-5.3-codex-spark,
// runs with no effort flag).
const VALID_EFFORTS = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["minimal", "low", "medium", "high", "xhigh"]),
};

/** Is `effort` a level the given CLI accepts (empty string = "no effort", allowed)? */
function isValidEffortFor(provider, effort) {
  if (!effort) return true;
  return VALID_EFFORTS[provider]?.has(effort) ?? false;
}

/** Is `value` a CLI the loop can drive? */
function isKnownCli(value) {
  return value === "claude" || value === "codex";
}

// Coerce a concurrency setting (env string or number) into a sane integer >= 1.
// Anything unparseable or below 1 falls back to 1 — the sequential default — so a
// bad value never accidentally widens parallelism or stalls the loop at 0.
export function clampConcurrency(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Build the two agent legs (implementer + reviewer) from the environment.
 *
 * R12 — role -> CLI assignment is configurable:
 *   - VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI pick which CLI fills each role
 *     (defaults implementer=claude, reviewer=codex).
 *   - The two MUST be distinct (a CLI can never review its own implementation); if
 *     the env assigns the same CLI to both, the reviewer is repaired to the other
 *     CLI so the loop never runs a single agent against itself.
 *   - Each CLI's model + thinking level come from VIVICY_<CLI>_* (claude/codex),
 *     keyed by the CLI itself, so the values follow the CLI regardless of role.
 *
 * A leg carries: role (implementer|reviewer), the assigned CLI as both `provider`
 * (drives the spawn + flag dialect) and `actor` (drives hook identity, quota
 * keying, transcript naming), plus the resolved model + effort + fast flag.
 *
 * FAST MODE (P5): VIVICY_<CLI>_FAST ("1"/"0") carries the per-role fast toggle from
 * the settings dialog. The leg's `fast` is true ONLY when the env asks for it AND
 * the resolved model genuinely supports fast on the headless run — a request to run
 * fast on an incapable model is dropped here, so the loop never asks a CLI for a
 * fast run it cannot perform.
 */
export function resolveAgentLegs(env = {}) {
  const implementerCli = isKnownCli(env.VIVICY_IMPLEMENTER_CLI)
    ? env.VIVICY_IMPLEMENTER_CLI
    : "claude";
  let reviewerCli = isKnownCli(env.VIVICY_REVIEWER_CLI) ? env.VIVICY_REVIEWER_CLI : "codex";
  // Distinct-CLI invariant: never let one CLI hold both roles.
  if (reviewerCli === implementerCli) {
    reviewerCli = implementerCli === "claude" ? "codex" : "claude";
  }
  const leg = (role, cli) => {
    const model = env[`VIVICY_${cli.toUpperCase()}_MODEL`] || CLI_DEFAULTS[cli].model;
    const fastRequested = env[`VIVICY_${cli.toUpperCase()}_FAST`] === "1";
    // Take the env effort only if the CLI actually accepts it; otherwise fall back to
    // the CLI default. Symmetrical to the fast gate so a hand-edited/out-of-band env
    // never reaches agentCliArgs with a level the CLI would reject.
    const rawEffort = env[`VIVICY_${cli.toUpperCase()}_EFFORT`];
    const effort = isValidEffortFor(cli, rawEffort) && rawEffort ? rawEffort : CLI_DEFAULTS[cli].effort;
    return {
      actor: cli,
      role,
      provider: cli,
      model,
      effort,
      // Honor fast ONLY when the model genuinely supports it (authoritative gate).
      fast: fastRequested && modelSupportsFast(cli, model),
    };
  };
  return {
    implementer: leg("implementer", implementerCli),
    reviewer: leg("reviewer", reviewerCli),
  };
}

export const DEFAULT_CONFIG = {
  issueIndexPath: "spec/development/issue-index.json",
  progressLedgerPath: "spec/development/progress-ledger.json",
  issuesDir: "spec/development/issues",
  doneDir: "spec/development/issues/done",
  gatesDir: "spec/development/gates",
  reportsDir: "spec/development/reports",
  // Role prompts are Vivicy's OWN assets, bundled in factory/prompts/ — they are
  // NOT read from the target project (which only receives the dev OUTPUT: issues,
  // ledger, gates, done). Resolved factory-relative; see readPrompt.
  promptsDir: FACTORY_PROMPTS_DIR,
  // Gitignored full-transcript store (one JSONL per agent leg). Referenced from
  // the ledger so the map links node/edge -> issue -> complete transcript.
  transcriptsDir: "spec/development/transcripts",
  maxRetries: 2,
  defaultGateCommand: "npm test",
  // Maximum number of INDEPENDENT issues the loop runs concurrently. Default 1 =
  // today's exact sequential behavior (one worktree-free issue at a time against
  // the main root). >1 enables parallel execution: each concurrent issue runs in
  // its own git worktree branched from the integration HEAD, with the gate +
  // integration serialized back onto the main branch. The value comes from the
  // Vivicy settings dialog via VIVICY_MAX_PARALLEL (clamped to >= 1).
  maxParallel: clampConcurrency(process.env.VIVICY_MAX_PARALLEL),
  // Gitignored root under the main repo where per-issue worktrees are created
  // (one subdir per concurrently-running issue). Only used when maxParallel > 1.
  worktreesDir: ".vivicy-worktrees",
  // Per-role CLI assignment + per-CLI model + thinking-level (R12 + P4). Two knobs,
  // both driven from the Vivicy settings dialog via env:
  //   - which CLI fills each ROLE: VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI
  //     (defaults implementer=claude, reviewer=codex). The two MUST differ — a CLI
  //     can never review its own implementation; resolveAgentLegs enforces it.
  //   - each CLI's model + level + fast: VIVICY_CLAUDE_* / VIVICY_CODEX_*
  //     (always-latest model is the default, the thinking level is the user-tunable
  //     knob, VIVICY_<CLI>_FAST="1" turns on fast mode for a fast-capable model).
  // resolveAgentLegs() builds the two legs from that env at module load.
  ...resolveAgentLegs(process.env),
  // Per-agent live quota state, written by the quota handler and read by the
  // status probe / the Vivicy footer.
  quotaStatePath: "spec/development/reports/quota-state.json",
  // Quota-aware retry tuning (all config seams so tests run on a fake clock):
  //   quotaBackoffStartMs — first wait when no reset time is parseable.
  //   quotaBackoffCapMs   — per-wait ceiling (the product's 5h window).
  //   quotaMaxWaitMs      — total cumulative wait before we give up and block.
  quotaBackoffStartMs: 5 * 60 * 1000, // 5 minutes
  quotaBackoffCapMs: 5 * 60 * 60 * 1000, // 5 hours (the rolling quota window)
  quotaMaxWaitMs: 8 * 60 * 60 * 1000, // 8 hours
  // Claude exposes its REAL subscription percentages ONLY through the documented
  // status-line stdin contract, which `claude -p` never fires. To surface the
  // real 5h + weekly % in the footer the loop runs a tiny side probe
  // (captureClaudeStatusLine) that drives one minimal interactive turn and reads
  // the status-line `rate_limits` payload. It costs ~one trivial turn, so the
  // loop runs it at most once per refresh window, never per leg. Disable by
  // setting VIVICY_CLAUDE_QUOTA_PROBE=0 (tests inject claudeQuotaProbe directly).
  claudeQuotaProbeEnabled: process.env.VIVICY_CLAUDE_QUOTA_PROBE !== "0",
  // Minimum gap between status-line probes, so a busy loop never spends more than
  // one trivial turn per window on quota telemetry.
  claudeQuotaProbeMinIntervalMs: 30 * 60 * 1000, // 30 minutes
};

// Rate-limit / quota-exhaustion signals. Neither `claude` nor `codex` exposes a
// non-interactive usage API, so the only robust signal is the failure itself:
// we scan a FAILED leg's combined stdout+stderr (case-insensitive) for these.
//
// IMPORTANT: Naight OS is a product *about* quotas / rate limits / HTTP 429, so
// a SUCCESSFUL agent leg routinely prints that vocabulary in its summary ("added
// rate-limit middleware", "implemented per-tenant quota"). To avoid falsely
// throttling a green leg, detection requires BOTH a non-zero exit AND a match,
// and the patterns target provider *error* shapes — `rate_limit_error`, an HTTP
// `429 Too Many Requests`, "usage limit reached", "resets at <time>" — not the
// bare nouns. Adding a provider phrase later is a one-line config change
// (cfg.quotaPatterns).
export const DEFAULT_QUOTA_PATTERNS = [
  /rate[\s_-]?limit(?:_error|ed|\s+(?:error|exceeded|reached|hit))?/i,
  /usage[\s_-]?limit(?:\s+(?:reached|exceeded|hit))?/i,
  /quota\s+(?:exceeded|exhausted|reached|hit)/i,
  /\b429\b\s*(?:too many requests)?/i,
  /too many requests/i,
  /(?:server|model|api)\s+overloaded|overloaded[_-]?error/i,
  /resets?[\s_-]?(?:at|in)\b/i,
  /try again (?:later|in)\b/i,
  /retry[\s_-]?after\b/i,
];

// Minimum wait between rate-limited retries, even when a provider reports a
// near-zero reset. Keeps a misbehaving provider from being hammered in a tight
// spawn loop without delaying a genuine short reset noticeably.
const QUOTA_MIN_WAIT_MS = 30 * 1000;

// The two rolling quota windows the footer surfaces. Keys are the canonical
// labels used in the quota-state file and the Vivicy footer.
//   "5h"     — the short rolling window (Codex `primary`, window_minutes 300;
//              Claude `rate_limit_event.rateLimitType === "five_hour"`).
//   "weekly" — the long rolling window (Codex `secondary`, window_minutes 10080).
// A null per-window record means "unknown" — we never fabricate a percentage.
export const QUOTA_WINDOW_KEYS = ["5h", "weekly"];

// --------------------------------------------------------------------------
// Pure core (unit-tested)
// --------------------------------------------------------------------------

export function dependenciesSatisfied(issue, doneIds) {
  const deps = Array.isArray(issue.depends_on) ? issue.depends_on : [];
  return deps.every((dep) => doneIds.has(dep));
}

// An issue is done if its file already lives in done/, or the ledger records
// THIS issue verified on every one of its graph refs. (Resume falls out of this
// for free.) The check is per-issue, not per-node: a shared node verified by a
// different issue must never mark this one done (doc 05: one issue going green
// never overstates a shared node or edge).
export function computeDoneIds(issues, ledger, doneFileNames) {
  const done = new Set();
  const verifiedIssuesByRef = new Map();
  for (const state of ledger.graph_item_states ?? []) {
    const verified = Object.entries(state.issue_states ?? {})
      .filter(([, status]) => status === "verified")
      .map(([issueId]) => issueId);
    verifiedIssuesByRef.set(state.graph_ref, new Set(verified));
  }
  for (const issue of issues) {
    if (doneFileNames.has(`${issue.id}.md`)) {
      done.add(issue.id);
      continue;
    }
    const refs = Array.isArray(issue.graph_refs) ? issue.graph_refs : [];
    if (refs.length > 0 && refs.every((ref) => verifiedIssuesByRef.get(ref)?.has(issue.id))) {
      done.add(issue.id);
    }
  }
  return done;
}

export function pickNextIssue(issues, doneIds) {
  for (const issue of issues) {
    if (doneIds.has(issue.id)) continue;
    if (dependenciesSatisfied(issue, doneIds)) return issue;
  }
  return null;
}

// --------------------------------------------------------------------------
// Parallel scheduler (pure, unit-tested)
//
// The ready set + independence rule that decide which issues may run at once.
// Parallel work is allowed ONLY for issues that are mutually independent — no
// dependency path between them AND a disjoint claim (graph_refs / claimed files)
// — exactly the governance method's parallel rule (doc 05): a distinct claim,
// explicit graph_refs, and a dedicated worktree per concurrent issue. The same
// rule, run with maxParallel = 1, degrades to picking exactly one ready issue at
// a time (today's sequential behavior).
// --------------------------------------------------------------------------

// The READY SET: every not-done issue whose declared dependencies are all done,
// in the issue index's own order (so selection is deterministic and stable).
// `running` (a set of issue ids already executing in this wave) is excluded so a
// resumed schedule never double-claims an in-flight issue.
export function computeReadySet(issues, doneIds, running = new Set()) {
  return issues.filter(
    (issue) => !doneIds.has(issue.id) && !running.has(issue.id) && dependenciesSatisfied(issue, doneIds),
  );
}

// The set of files an issue claims. Optional `claims`/`claimed_files` on the issue
// (explicit claim) take precedence; otherwise the claim falls back to the issue's
// graph_refs, which the method already requires to be explicit and which the
// extraction makes disjoint for independent slices. Returned as a Set for O(1)
// intersection checks.
export function issueClaim(issue) {
  const explicit = Array.isArray(issue.claims)
    ? issue.claims
    : Array.isArray(issue.claimed_files)
      ? issue.claimed_files
      : null;
  const refs = explicit ?? (Array.isArray(issue.graph_refs) ? issue.graph_refs : []);
  return new Set(refs);
}

// Do two sets share any member?
function setsIntersect(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) return true;
  }
  return false;
}

// Are two issues independent enough to run CONCURRENTLY? Two guards, both must
// hold:
//   1. No dependency path between them — neither (transitively) depends on the
//      other. We resolve transitive deps from the index so a deep chain can never
//      be split across worktrees and integrated out of order.
//   2. Disjoint claims — their claimed files / graph_refs do not overlap, so two
//      parallel implementers never touch the same node and their worktrees merge
//      back cleanly.
export function issuesIndependent(a, b, depsClosureById) {
  if (a.id === b.id) return false;
  const aDeps = depsClosureById.get(a.id) ?? new Set();
  const bDeps = depsClosureById.get(b.id) ?? new Set();
  if (aDeps.has(b.id) || bDeps.has(a.id)) return false; // dependency path between them
  return !setsIntersect(issueClaim(a), issueClaim(b)); // disjoint claim
}

// Transitive dependency closure for every issue id: id -> Set of all ids it
// (directly or indirectly) depends on. Tolerant of unknown/missing deps. Used by
// the independence check so a multi-hop chain is never run in parallel.
export function buildDepsClosure(issues) {
  const direct = new Map(issues.map((issue) => [issue.id, Array.isArray(issue.depends_on) ? issue.depends_on : []]));
  const closure = new Map();
  const resolveFor = (id, stack) => {
    if (closure.has(id)) return closure.get(id);
    if (stack.has(id)) return new Set(); // cycle guard (the index should be a DAG)
    stack.add(id);
    const all = new Set();
    for (const dep of direct.get(id) ?? []) {
      all.add(dep);
      for (const deep of resolveFor(dep, stack)) all.add(deep);
    }
    stack.delete(id);
    closure.set(id, all);
    return all;
  };
  for (const issue of issues) resolveFor(issue.id, new Set());
  return closure;
}

// Select up to `limit` issues to run CONCURRENTLY from `ready`, such that every
// selected issue is pairwise-independent from every other AND from each
// already-`running` issue. Greedy in index order (deterministic): take the first
// ready issue compatible with the whole current batch, repeat until full or the
// ready set is exhausted. With limit = 1 this returns exactly one issue (the
// first ready), making the sequential path fall out unchanged.
export function selectIndependentBatch(ready, runningIssues, limit, depsClosureById) {
  const batch = [];
  const slots = Math.max(1, limit) - runningIssues.length;
  if (slots <= 0) return batch;
  for (const candidate of ready) {
    if (batch.length >= slots) break;
    const compatible =
      runningIssues.every((r) => issuesIndependent(candidate, r, depsClosureById)) &&
      batch.every((b) => issuesIndependent(candidate, b, depsClosureById));
    if (compatible) batch.push(candidate);
  }
  return batch;
}

export function composePrompt(template, issue, extra = {}) {
  const values = {
    issue_id: issue.id,
    issue_path: issue.path ?? issue.issue_path ?? "",
    graph_refs: (issue.graph_refs ?? []).join(", "),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

// Build the provider-specific model + thinking-level + fast CLI flags appended to
// an agent leg's argv. Pure (no spawn) so it is unit-tested directly.
//   - claude (implementer): `--model <id> --effort <level>` and, when fast is on
//     for a fast-capable model, `--settings {"fastMode":true}` (the documented
//     headless way to enable fast mode for `claude -p`).
//     level ∈ {low, medium, high, xhigh, max}
//   - codex  (reviewer):    `-m <id> -c model_reasoning_effort="<level>"` and, when
//     fast is on for a fast-capable model, `-c fast_mode=true` (the stable Codex
//     feature flag honored by `codex exec`).
//     level ∈ {minimal, low, medium, high, xhigh}
// A falsy model or effort omits just that flag pair (never emits a bare flag), so a
// partially-configured leg degrades gracefully to the CLI's own default. The fast
// flag is emitted ONLY when `fast` is truthy AND the model genuinely supports fast
// (authoritative gate) — a non-functional fast run is never requested.
export function agentCliArgs(provider, { model, effort, fast } = {}) {
  const args = [];
  const useFast = Boolean(fast) && Boolean(model) && modelSupportsFast(provider, model);
  if (provider === "claude") {
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    // Headless fast mode: `claude -p` reads `fastMode` from the settings it is
    // handed via --settings (a JSON string is accepted), so this turns on fast for
    // the non-interactive run the loop drives.
    if (useFast) args.push("--settings", JSON.stringify({ fastMode: true }));
  } else if (provider === "codex") {
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    // Codex fast mode: the stable `fast_mode` feature flag, settable per-run via -c.
    if (useFast) args.push("-c", "fast_mode=true");
  }
  return args;
}

// --------------------------------------------------------------------------
// Quota / rate-limit detection (pure, unit-tested)
// --------------------------------------------------------------------------

// Scan a FAILED leg's captured output for a rate-limit / quota signal.
//
// Two guards keep this honest, both ways:
//   - exitCode: a rate-limit ALWAYS coincides with a failed leg (the CLI exits
//     non-zero when quota-exhausted). A leg that exited 0 is never a quota hit,
//     so a SUCCESSFUL leg that merely *mentions* quota/429/rate-limit in its
//     summary (Naight OS is a product about exactly that) is left alone. Pass a
//     null/undefined exitCode to scan unconditionally (used in pure pattern
//     tests); production always passes the real code.
//   - patterns target provider ERROR shapes, not the bare nouns — so a normal
//     test failure ("FAIL", "TypeError") is never mistaken for a quota hit and
//     retried forever.
// Returns { hit, message } where message is the first matching line (trimmed,
// length-capped) for the quota-state record.
export function detectRateLimit(output, patterns = DEFAULT_QUOTA_PATTERNS, exitCode = null) {
  // A successful leg is never rate-limited, regardless of its prose.
  if (exitCode === 0) return { hit: false, message: null };
  const text = String(output ?? "");
  if (!text) return { hit: false, message: null };
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    // Report the whole line the signal landed on, so the state record is honest
    // about what was actually seen.
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = text.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const line = text.slice(lineStart, lineEnd).trim().slice(0, 300);
    return { hit: true, message: line || match[0] };
  }
  return { hit: false, message: null };
}

// Parse a reset time from a rate-limit message into an absolute epoch-ms, given
// the current epoch-ms (`nowMs`). Recognizes, in priority order:
//   - retry-after: <seconds>            (relative seconds)
//   - resets in 2h14m / try again in 90s (relative duration)
//   - resets at 15:30 / try again at 3pm (absolute clock time today/next day)
//   - an ISO-8601 timestamp                (absolute)
// Returns the absolute reset epoch-ms, or null when nothing parseable is found.
export function parseResetMs(message, nowMs) {
  const text = String(message ?? "");
  if (!text) return null;

  // retry-after header style: "retry-after: 120" / "retry after 120 seconds".
  const retryAfter = /retry[\s_-]?after[:\s]+(\d+)\s*(?:s|sec|secs|seconds)?\b/i.exec(text);
  if (retryAfter) return nowMs + Number(retryAfter[1]) * 1000;

  // Relative duration: "resets in 2h 14m", "try again in 90s", "in 45 minutes".
  const relMs = parseRelativeDurationMs(text);
  if (relMs !== null) return nowMs + relMs;

  // ISO-8601 absolute timestamp anywhere in the message.
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (iso) {
    const ms = new Date(iso[0]).getTime();
    if (Number.isFinite(ms)) return ms;
  }

  // Absolute clock time today (roll to tomorrow if already past): "resets at 15:30",
  // "try again at 3pm", "available again at 9:05 AM".
  const clock = /\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock) {
    const reset = clockToEpochMs(clock, nowMs);
    if (reset !== null) return reset;
  }
  return null;
}

// "2h 14m", "90s", "45 minutes", "in 1 hour 30 min" -> total milliseconds, or null.
function parseRelativeDurationMs(text) {
  // Anchor on an "in"/"resets"/"try again" cue so a stray "5m" elsewhere is ignored.
  const cued = /(?:in|resets?(?:\s+in)?|try again(?:\s+in)?|wait)\s+([\dhms\s.minutesecorhuday]+)/i.exec(text);
  const span = cued ? cued[1] : text;
  let total = 0;
  let matched = false;
  const units = [
    [/(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hour|hours)\b/i, 3600 * 1000],
    [/(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\b/i, 60 * 1000],
    [/(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/i, 1000],
  ];
  for (const [re, factor] of units) {
    const m = re.exec(span);
    if (m) {
      total += Number(m[1]) * factor;
      matched = true;
    }
  }
  return matched ? total : null;
}

// Convert a matched "(at) HH(:MM) (am|pm)" to the next absolute epoch-ms >= now.
function clockToEpochMs(match, nowMs) {
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;
  if (hour > 23 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const reset = new Date(nowMs);
  reset.setHours(hour, minute, 0, 0);
  let ms = reset.getTime();
  if (ms <= nowMs) ms += 24 * 60 * 60 * 1000; // already past today -> tomorrow
  return ms;
}

// Decide how long to wait before re-running a rate-limited leg.
//   - A parseable reset time wins (clamped to [0, cap]); we add a small pad so
//     we retry just *after* the window reopens, not on the exact boundary.
//   - Otherwise back off exponentially from `start`, doubling per consecutive
//     hit, capped at `cap`.
// Returns { waitMs, resetAtMs|null } — resetAtMs is the absolute time we expect
// the quota to reopen (for the "throttled" state record), null when unknown.
export function computeWaitMs({ message, nowMs, attempt, cfg }) {
  const cap = cfg.quotaBackoffCapMs;
  const start = cfg.quotaBackoffStartMs;
  const resetAtMs = parseResetMs(message, nowMs);
  if (resetAtMs !== null) {
    const pad = 5000; // retry just after the boundary
    // Respect the provider's reported reset, but floor it at QUOTA_MIN_WAIT_MS:
    // a provider that reports a ~0s reset while still 429-ing must not turn into
    // a multi-thousand-spawn busy loop hammering it. The floor is small (30s) so
    // a genuine short reset like "90s" is still honored closely.
    const raw = Math.max(resetAtMs - nowMs, 0) + pad;
    const waitMs = Math.min(Math.max(raw, QUOTA_MIN_WAIT_MS), cap);
    return { waitMs, resetAtMs: nowMs + waitMs };
  }
  // attempt is 1-based: first hit waits `start`, then 2x, 4x ... capped.
  const backoff = Math.min(start * 2 ** Math.max(0, attempt - 1), cap);
  return { waitMs: backoff, resetAtMs: nowMs + backoff };
}

// --------------------------------------------------------------------------
// Real quota-window extraction (pure, unit-tested)
//
// PROVEN by probing each CLI (see the R8 probe): the two providers expose very
// different surfaces, so we extract from each honestly and never fabricate.
//
//   Codex   — emits a `token_count` event in its session ROLLOUT JSONL whose
//             payload carries real `rate_limits` percentages:
//               rate_limits.primary   = { used_percent, window_minutes: 300,   resets_at }  -> "5h"
//               rate_limits.secondary = { used_percent, window_minutes: 10080, resets_at }  -> "weekly"
//             (Not present on `codex exec` stdout — only in the rollout, which the
//             dev loop already copies into its transcript store.) => real % both windows.
//
//   Claude  — exposes its REAL subscription percentages ONLY through the
//             documented status-line stdin contract
//             (https://code.claude.com/docs/en/statusline): a `rate_limits`
//             object with
//               rate_limits.five_hour = { used_percentage (0-100), resets_at (epoch s) } -> "5h"
//               rate_limits.seven_day = { used_percentage (0-100), resets_at (epoch s) } -> "weekly"
//             (present only for Pro/Max subscribers, after the first API
//             response). The status line is interactive-only — `claude -p` never
//             emits it — so the dev loop captures it with a tiny side probe
//             (see captureClaudeStatusLine) and feeds the captured JSON here.
//             `claude -p --output-format stream-json` instead emits a
//             `rate_limit_event` { status, resetsAt (epoch s), rateLimitType:
//             "five_hour" } that carries the 5h RESET but NO percentage and no
//             weekly window; we use it as an honest fallback when no status-line
//             capture is available. => with capture: real % for 5h + weekly;
//             without: 5h reset only (null %), weekly unknown.
//
// Each window record is { used_pct: number|null, remaining: number|null,
// reset_at: ISO|null } or the whole window is absent (=> unknown). A null
// used_pct is the honest "we don't have a real number" signal the footer shows
// as "—".
// --------------------------------------------------------------------------

// Build a single window record from a real used_percent + epoch-seconds reset.
// used_pct null => unknown percentage (still honest about the reset if present).
function windowRecord({ usedPct = null, resetAtSec = null } = {}) {
  const pct = Number.isFinite(usedPct) ? Math.max(0, Math.min(100, usedPct)) : null;
  const reset_at = Number.isFinite(resetAtSec) ? new Date(resetAtSec * 1000).toISOString() : null;
  return {
    used_pct: pct,
    remaining: pct === null ? null : Math.round((100 - pct) * 10) / 10,
    reset_at,
  };
}

// Parse Codex `rate_limits` (real percentages for both windows) out of a session
// rollout JSONL. Scans for the LAST `token_count` event (newest state wins) and
// maps primary->5h, secondary->weekly. Returns a partial windows map; an absent
// window means we found no data for it (unknown), never a zero.
export function parseCodexQuotaWindows(rolloutText) {
  const text = String(rolloutText ?? "");
  if (!text) return {};
  let limits = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limits")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits ?? obj?.rate_limits;
    if (rl && typeof rl === "object") limits = rl; // keep the last seen
  }
  if (!limits) return {};
  const windows = {};
  if (limits.primary && typeof limits.primary === "object") {
    windows["5h"] = windowRecord({
      usedPct: Number(limits.primary.used_percent),
      resetAtSec: Number(limits.primary.resets_at),
    });
  }
  if (limits.secondary && typeof limits.secondary === "object") {
    windows["weekly"] = windowRecord({
      usedPct: Number(limits.secondary.used_percent),
      resetAtSec: Number(limits.secondary.resets_at),
    });
  }
  return windows;
}

// Build a window record from a status-line `rate_limits` window object
// ({ used_percentage, resets_at }). Real percentage + real reset. Absent or
// malformed input yields null (=> the caller skips the window).
function claudeStatusWindow(win) {
  if (!win || typeof win !== "object") return null;
  return windowRecord({
    usedPct: Number(win.used_percentage),
    resetAtSec: Number(win.resets_at),
  });
}

// Parse a Claude status-line `rate_limits` payload (the documented interactive
// surface) into REAL 5h + weekly windows. Accepts either the full status-line
// JSON object (with a top-level `rate_limits`) or a bare `rate_limits` object.
// five_hour -> "5h", seven_day -> "weekly", each with a real used_percentage +
// resets_at. Returns a partial windows map; a null/absent rate_limits => {}.
export function parseClaudeStatusRateLimits(rateLimitsOrStatus) {
  const root = rateLimitsOrStatus;
  if (!root || typeof root !== "object") return {};
  const rl = root.rate_limits && typeof root.rate_limits === "object" ? root.rate_limits : root;
  if (!rl || typeof rl !== "object") return {};
  const windows = {};
  const fiveHour = claudeStatusWindow(rl.five_hour);
  if (fiveHour) windows["5h"] = fiveHour;
  const sevenDay = claudeStatusWindow(rl.seven_day);
  if (sevenDay) windows.weekly = sevenDay;
  return windows;
}

// Parse the REAL Claude quota windows out of a captured leg surface. Two honest
// sources, tried in priority order:
//
//   1. The documented status-line `rate_limits` JSON (captured by the side probe
//      in captureClaudeStatusLine) — REAL used_percentage + resets_at for the
//      five_hour ("5h") AND seven_day ("weekly") windows. This is the only
//      surface that carries Claude's subscription percentages.
//      (https://code.claude.com/docs/en/statusline)
//   2. The `rate_limit_event` line from `claude -p --output-format stream-json` —
//      a REAL 5h reset + status but NO percentage and no weekly window. Used as a
//      fallback when no status-line capture is present, so we still surface an
//      honest 5h reset (used_pct null => the footer shows "—" for the number).
//
// Returns a partial windows map; absent windows are honestly unknown, never zero.
export function parseClaudeQuotaWindows(transcriptText) {
  const text = String(transcriptText ?? "");
  if (!text) return {};

  // 1. Prefer a captured status-line rate_limits payload (real percentages).
  //    Scan every JSON line for the LAST one carrying a `rate_limits` object with
  //    a `five_hour` or `seven_day` window (newest state wins), so a transcript
  //    that interleaves status-line captures with other lines still resolves.
  let statusRateLimits = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limits")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rl = obj?.rate_limits && typeof obj.rate_limits === "object" ? obj.rate_limits : null;
    if (rl && (rl.five_hour || rl.seven_day)) statusRateLimits = rl; // last wins
  }
  if (statusRateLimits) {
    const windows = parseClaudeStatusRateLimits(statusRateLimits);
    if (Object.keys(windows).length > 0) return windows;
  }

  // 2. Fallback: the stream-json rate_limit_event (real 5h reset, NO percentage).
  let info = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limit_event")) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type === "rate_limit_event" && obj.rate_limit_info) info = obj.rate_limit_info; // last wins
  }
  if (!info) return {};
  const windows = {};
  if (info.rateLimitType === "five_hour" || info.resetsAt) {
    windows["5h"] = windowRecord({ usedPct: null, resetAtSec: Number(info.resetsAt) });
  }
  return windows;
}

// Dispatch to the right per-provider parser. `text` is the captured transcript /
// rollout content for this leg. Falsy/unreadable input => no windows (unknown),
// which keeps quota state honestly empty rather than fabricated.
export function parseQuotaWindows(actor, text) {
  if (actor === "codex") return parseCodexQuotaWindows(text);
  if (actor === "claude") return parseClaudeQuotaWindows(text);
  return {};
}

// Read a captured transcript/rollout file for a leg, tolerantly. Returns "" when
// the path is missing or unreadable — quota windows are advisory, never
// load-bearing, so a missing transcript just means "unknown", not an error.
function readTranscriptText(relPath) {
  if (!relPath) return "";
  try {
    return readFileSync(abs(relPath), "utf8");
  } catch {
    return "";
  }
}

// --------------------------------------------------------------------------
// Claude real-percentage capture (status-line side probe)
//
// Claude's REAL subscription percentages live ONLY in the documented status-line
// stdin contract (https://code.claude.com/docs/en/statusline): a `rate_limits`
// object with `five_hour`/`seven_day` { used_percentage, resets_at }. The status
// line fires only in the interactive TUI — `claude -p` (what the legs use) never
// emits it, and the captured session transcript JSONL carries nothing — so we
// run a tiny SIDE PROBE that drives one trivial interactive turn and reads the
// status line's stdin.
//
// The probe is dependency-free: it allocates a pty via the system `script`
// binary (present on macOS + Linux) rather than a native pty module. We point
// Claude at an isolated `--settings` whose statusLine command dumps its stdin
// JSON, send a one-word prompt, wait for the first API response (which is when
// `rate_limits` is populated), then exit. Everything lands in a private temp dir
// that we delete. Honest by construction: any failure (no pty, not a subscriber,
// timeout) yields no windows, so the footer shows "—" rather than a fabricated
// number.
// --------------------------------------------------------------------------

// Drive one minimal interactive Claude turn through a `script`-allocated pty and
// return the captured status-line `rate_limits` object (or null). Pure IO at the
// edges; the parsing lives in parseClaudeStatusRateLimits so it stays unit
// tested. `cfg` supplies the model/effort (same as a real leg) and the run dir.
function captureClaudeStatusLine(cfg, leg) {
  // Only on platforms with a usable `script` pty. Windows has no `script`.
  if (platform() === "win32") return null;
  let dir;
  try {
    dir = mkdtempSync(resolve(tmpdir(), "vivicy-claude-quota-"));
  } catch {
    return null;
  }
  try {
    const dumpPath = resolve(dir, "dump-statusline.sh");
    const capturePath = resolve(dir, "statusline.json");
    const settingsPath = resolve(dir, "settings.json");
    // A status-line command that writes its full stdin JSON to capturePath. It
    // overwrites each render; the last render (after the first API response) is
    // the one carrying a populated rate_limits.
    writeFileSync(
      dumpPath,
      `#!/bin/sh\ncat > ${JSON.stringify(capturePath)}\necho ""\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: dumpPath } }),
    );
    // Model + effort match a real Claude leg so the probe reflects the same plan.
    const modelArgs = agentCliArgs("claude", leg);
    const claudeArgs = ["--settings", settingsPath, ...modelArgs];
    // Drive `script`'s stdin with timed input: wait for boot, send a one-word
    // prompt, wait for the first API response + a status render, then exit. The
    // brace group is fed as a single pipe so there is no subshell fd race.
    const bootMs = cfg.claudeQuotaProbeBootMs ?? 8;
    const replyMs = cfg.claudeQuotaProbeReplyMs ?? 38;
    const driver =
      `sleep ${bootMs}; printf 'say ok\\r'; ` +
      `sleep ${replyMs}; printf '/exit\\r'; ` +
      `sleep 3; printf '\\004'; sleep 2`;
    // Quote the claude argv for the inner `script` command line.
    const quoted = claudeArgs.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(" ");
    const scriptCmd = `claude ${quoted}`;
    const result = spawnSync(
      "sh",
      ["-c", `{ ${driver}; } | script -q ${JSON.stringify(resolve(dir, "script.log"))} ${scriptCmd}`],
      {
        cwd: execRootOf(cfg),
        env: { ...process.env },
        encoding: "utf8",
        timeout: cfg.claudeQuotaProbeTimeoutMs ?? 70_000,
      },
    );
    void result;
    let raw;
    try {
      raw = readFileSync(capturePath, "utf8");
    } catch {
      return null;
    }
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    const rl = obj?.rate_limits;
    return rl && typeof rl === "object" ? rl : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

// When did the status-line probe last run for `actor`? Read from the durable
// quota-state file (`agents.<actor>.last_probe_at`, ISO) so the once-per-window
// throttle survives across loop process restarts instead of resetting each run.
// Returns epoch ms, or 0 when never probed / unreadable.
function lastClaudeProbeMs(cfg) {
  if (!cfg.quotaStatePath) return 0;
  const ts = readQuotaState(cfg).agents?.claude?.last_probe_at;
  const ms = ts ? new Date(ts).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

// Opportunistically refresh Claude's REAL percentages and merge them into the
// quota-state windows. Returns the existing `windows` augmented with the
// status-line 5h + weekly percentages when a probe succeeds, or unchanged when
// the probe is disabled, rate-limited by the min-interval, or yields nothing.
// Tests inject cfg.claudeQuotaProbe to avoid spawning a real CLI.
function refreshClaudeQuotaWindows(cfg, leg, windows) {
  if (!cfg.claudeQuotaProbeEnabled) return windows;
  const now = nowMsOf(cfg);
  const minInterval = cfg.claudeQuotaProbeMinIntervalMs ?? 0;
  // A positive interval throttles the probe to once per window, using the durable
  // last_probe_at marker in the quota-state file. minInterval <= 0 disables the
  // throttle (always probe) — used by tests and operators who opt out.
  if (minInterval > 0) {
    const last = lastClaudeProbeMs(cfg);
    if (last && now - last < minInterval) return windows;
    // Record the attempt time up front so a slow/failed probe still counts toward
    // the throttle (we never hammer the CLI if a probe errors repeatedly).
    writeQuotaState(cfg, "claude", { last_probe_at: new Date(now).toISOString() });
  }
  const probe = cfg.claudeQuotaProbe ?? captureClaudeStatusLine;
  let rateLimits;
  try {
    rateLimits = probe(cfg, leg);
  } catch {
    return windows;
  }
  const probed = parseClaudeStatusRateLimits(rateLimits);
  if (Object.keys(probed).length === 0) return windows;
  // Real probed percentages win over the reset-only fallback for the same window.
  return { ...windows, ...probed };
}

// --------------------------------------------------------------------------
// IO helpers
// --------------------------------------------------------------------------

function abs(relPath) {
  return resolve(requireRepoRoot(), relPath);
}

// The EXECUTION root for an issue: where its agent legs (cwd), its gate command
// (cwd), and its commit/clean-tree checks run. In the sequential path this is the
// main repo root (cfg.execRoot unset => requireRepoRoot()). For a parallel issue
// it is that issue's dedicated git worktree, so concurrent implementers never
// collide in the filesystem. SHARED orchestration artifacts (ledger, gate
// evidence, blocked reports, done/ moves, transcripts, quota-state) always resolve
// against the MAIN root via abs() — never the worktree — so the one source of
// truth stays singular under any concurrency.
function execRootOf(cfg) {
  return cfg.execRoot ? cfg.execRoot : requireRepoRoot();
}

function readJson(relPath) {
  return JSON.parse(readFileSync(abs(relPath), "utf8"));
}

function readLedger(cfg) {
  if (!existsSync(abs(cfg.progressLedgerPath))) return { graph_item_states: [], active_items: [] };
  return readJson(cfg.progressLedgerPath);
}

function listDoneFiles(cfg) {
  const doneAbs = abs(cfg.doneDir);
  if (!existsSync(doneAbs)) return new Set();
  return new Set(readdirSync(doneAbs).filter((name) => name.endsWith(".md")));
}

function readPrompt(cfg, name) {
  // Role prompts are bundled with the factory (cfg.promptsDir is an absolute
  // factory path), independent of which target project the loop is building.
  return readFileSync(resolve(cfg.promptsDir, `${name}.md`), "utf8");
}

// --------------------------------------------------------------------------
// Real steps (default implementations; overridable for tests)
// --------------------------------------------------------------------------

// Spawn an agent leg capturing stdout+stderr while still TEEing them to the
// console (so the live view is never lost) — we need the text to scan for a
// rate-limit signal. Returns the spawnSync-style result with `.stdout`/`.stderr`
// populated (combined text available via `combinedOutput(result)`).
function spawnTee(command, args, options) {
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
function spawnTeeAsync(command, args, options) {
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
function combinedOutput(result) {
  return `${result?.stdout ?? ""}\n${result?.stderr ?? ""}`;
}

// Env injected into each agent leg so its lifecycle hooks know the issue, actor,
// role, session, and ledger paths to report against — identity is config-driven,
// not chosen by the agent.
function agentEnv(issue, cfg, leg) {
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

function ensureTranscriptDir(issue, cfg) {
  mkdirSync(abs(`${cfg.transcriptsDir}/${issue.id}`), { recursive: true });
}

// Locate the Claude session transcript JSONL by its session id across the CLI's
// project dirs (the dir-name encoding varies), and copy it into our store.
function captureClaudeTranscript(uuid, destAbs) {
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

// Spawn ONE leg with the Claude Code CLI, for whichever role it was assigned
// (R12). Claude headless writes the full native session transcript keyed by
// --session-id; we copy it into our gitignored store. The transcript is named
// `claude-<role>-…` so the file reflects the actual CLI + role pairing.
function runClaudeLeg(leg, issue, cfg) {
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const uuid = randomUUID();
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/claude-${leg.role}-${uuid}.jsonl`;
  const args = ["-p", prompt, "--dangerously-skip-permissions", "--session-id", uuid];
  if (cfg.mcpConfigPath) args.push("--mcp-config", cfg.mcpConfigPath);
  // Latest model + user-chosen thinking level: `--model <id> --effort <level>`.
  args.push(...agentCliArgs("claude", leg));
  // Run in the issue's EXECUTION root: the worktree for a parallel issue, the main
  // root in the sequential path. The transcript is captured by --session-id (a
  // per-leg UUID), so concurrent claude legs never cross-capture.
  const result = spawnTee("claude", args, { cwd: execRootOf(cfg), env: agentEnv(issue, cfg, leg), encoding: "utf8" });
  ensureTranscriptDir(issue, cfg);
  const captured = captureClaudeTranscript(uuid, abs(transcriptRel));
  return { result, output: combinedOutput(result), transcriptRel: captured ? transcriptRel : undefined };
}

// Spawn ONE leg with the Codex CLI, for whichever role it was assigned (R12).
// Codex writes a full JSONL rollout per session under ~/.codex/sessions/<date>/;
// we copy the leg's rollout into our store. This is more robust than
// `codex exec --json` (which can hang) and lands the transcript at the path/format
// we want instead of the date-partitioned default.
function runCodexLeg(leg, issue, cfg) {
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/codex-${leg.role}-${randomUUID()}.jsonl`;
  // Run codex in the issue's EXECUTION root (worktree for a parallel issue, main
  // root sequentially); -C pins the same dir so the rollout records that cwd.
  const root = execRootOf(cfg);
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  // Latest model + user-chosen thinking level: `-m <id> -c model_reasoning_effort="<level>"`.
  args.push(...agentCliArgs("codex", leg));
  const startMs = Date.now();
  const result = spawnTee("codex", args, { cwd: root, env: agentEnv(issue, cfg, leg), encoding: "utf8" });
  ensureTranscriptDir(issue, cfg);
  const output = combinedOutput(result);
  // Codex has no per-run rollout id flag, so we locate this leg's rollout by mtime
  // since the spawn AND (under concurrency) by the worktree cwd it recorded, so a
  // sibling codex leg's rollout in another worktree is never mis-captured. The cwd
  // filter is only applied when parallel (cfg.execRoot set); sequentially the
  // original newest-since-start heuristic is unchanged.
  const rollout = findNewestCodexRollout(startMs, cfg.execRoot ? root : null);
  if (rollout) {
    copyFileSync(rollout, abs(transcriptRel));
    return { result, output, transcriptRel };
  }
  return { result, output, transcriptRel: undefined };
}

// Dispatch a leg to the CLI assigned to its role (R12). The CLI is `leg.provider`
// — NOT the role — so either CLI can fill either role. A leg with an unknown
// provider is a config error the loop should never reach (resolveAgentLegs only
// ever produces claude/codex).
function runAssignedLeg(leg, issue, cfg) {
  if (leg.provider === "claude") return runClaudeLeg(leg, issue, cfg);
  if (leg.provider === "codex") return runCodexLeg(leg, issue, cfg);
  throw new Error(`dev-loop: ${leg.role} assigned to an unknown CLI: ${leg.provider}`);
}

// The implementer/reviewer entry points dispatch by the ASSIGNED CLI, so the role
// stays fixed (it picks the prompt + hook identity) while which CLI runs it is
// the configurable knob.
export function defaultRunImplementer(issue, cfg) {
  return runAssignedLeg(cfg.implementer, issue, cfg);
}

export function defaultRunReviewer(issue, cfg) {
  return runAssignedLeg(cfg.reviewer, issue, cfg);
}

// --------------------------------------------------------------------------
// Async leg runners (parallel path)
//
// Identical to the sync runners except the CLI is spawned NON-BLOCKING (spawn,
// not spawnSync), so N parallel issues can each have a child CLI running at once.
// The argv, transcript naming, capture, and execution root are exactly the same —
// only the spawn primitive differs — so a parallel leg behaves like a sequential
// one in every respect but blocking.
// --------------------------------------------------------------------------

async function runClaudeLegAsync(leg, issue, cfg) {
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const uuid = randomUUID();
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/claude-${leg.role}-${uuid}.jsonl`;
  const args = ["-p", prompt, "--dangerously-skip-permissions", "--session-id", uuid];
  if (cfg.mcpConfigPath) args.push("--mcp-config", cfg.mcpConfigPath);
  args.push(...agentCliArgs("claude", leg));
  const result = await spawnTeeAsync("claude", args, {
    cwd: execRootOf(cfg),
    env: agentEnv(issue, cfg, leg),
    encoding: "utf8",
  });
  ensureTranscriptDir(issue, cfg);
  const captured = captureClaudeTranscript(uuid, abs(transcriptRel));
  return { result, output: combinedOutput(result), transcriptRel: captured ? transcriptRel : undefined };
}

async function runCodexLegAsync(leg, issue, cfg) {
  const prompt = composePrompt(readPrompt(cfg, leg.role), issue);
  const transcriptRel = `${cfg.transcriptsDir}/${issue.id}/codex-${leg.role}-${randomUUID()}.jsonl`;
  const root = execRootOf(cfg);
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  args.push(...agentCliArgs("codex", leg));
  const startMs = Date.now();
  const result = await spawnTeeAsync("codex", args, {
    cwd: root,
    env: agentEnv(issue, cfg, leg),
    encoding: "utf8",
  });
  ensureTranscriptDir(issue, cfg);
  const output = combinedOutput(result);
  const rollout = findNewestCodexRollout(startMs, cfg.execRoot ? root : null);
  if (rollout) {
    copyFileSync(rollout, abs(transcriptRel));
    return { result, output, transcriptRel };
  }
  return { result, output, transcriptRel: undefined };
}

function runAssignedLegAsync(leg, issue, cfg) {
  if (leg.provider === "claude") return runClaudeLegAsync(leg, issue, cfg);
  if (leg.provider === "codex") return runCodexLegAsync(leg, issue, cfg);
  throw new Error(`dev-loop: ${leg.role} assigned to an unknown CLI: ${leg.provider}`);
}

export function defaultRunImplementerAsync(issue, cfg) {
  return runAssignedLegAsync(cfg.implementer, issue, cfg);
}

export function defaultRunReviewerAsync(issue, cfg) {
  return runAssignedLegAsync(cfg.reviewer, issue, cfg);
}

// The rollout created during this leg = newest .jsonl under ~/.codex/sessions with
// mtime at or after the run start. Sequentially (one codex at a time) the newest
// since start is unambiguous. Under concurrency, pass `cwdFilter` (the leg's
// worktree root): we then only accept a rollout whose recorded session cwd matches
// that worktree, so a SIBLING codex leg running in another worktree is never
// mis-captured. A rollout that records no cwd still matches (best-effort) so the
// filter never drops a legitimately-empty capture.
function findNewestCodexRollout(sinceMs, cwdFilter = null) {
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
function rolloutMatchesCwd(rolloutPath, cwdFilter) {
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

// The orchestrator runs the gate ITSELF — the authoritative verdict — and writes
// a gate-run record evidence file the ledger requires for gate_passed.
export function defaultRunGate(issue, cfg) {
  const gateCommand = issue.gate_command ?? cfg.defaultGateCommand;
  // The gate runs against the issue's CODE — its execution root (the worktree for
  // a parallel issue). The evidence RECORD is shared orchestration state and is
  // written to the MAIN root (abs()), where the ledger's gate_passed validation
  // reads it back; the two roots are deliberately split here.
  const result = spawnSync(gateCommand, { cwd: execRootOf(cfg), encoding: "utf8", shell: true });
  return writeGateEvidence(issue, cfg, gateCommand, result.status ?? 1);
}

// Async sibling of defaultRunGate for the parallel path: spawn the gate
// NON-BLOCKING (spawn, not spawnSync) so a slow gate never freezes the event loop
// and stalls the other parallel issues (or ages out the integration lock while a
// sibling holds it). Identical evidence record; only the spawn primitive differs.
export async function defaultRunGateAsync(issue, cfg) {
  const gateCommand = issue.gate_command ?? cfg.defaultGateCommand;
  const result = await spawnTeeAsync(gateCommand, [], {
    cwd: execRootOf(cfg),
    encoding: "utf8",
    shell: true,
  });
  return writeGateEvidence(issue, cfg, gateCommand, result.status ?? 1);
}

// Write the gate-run evidence record to the MAIN root and return the verdict. One
// source of truth shared by the sync + async gate runners.
function writeGateEvidence(issue, cfg, gateCommand, exitCode) {
  const gateId = (issue.verification_gate_ids ?? [])[0] ?? `gate:issue:${issue.id}`;
  mkdirSync(abs(cfg.gatesDir), { recursive: true });
  const evidenceRel = `${cfg.gatesDir}/${issue.id}-gate.json`;
  const record = {
    gate_id: gateId,
    issue_id: issue.id,
    command: gateCommand,
    exit_code: exitCode,
    status: exitCode === 0 ? "pass" : "fail",
    finished_at: cfg.now ?? new Date().toISOString(),
    baseline_id: cfg.baselineId ?? readIndexBaselineId(cfg),
  };
  writeFileSync(abs(evidenceRel), `${JSON.stringify(record, null, 2)}\n`);
  return { pass: exitCode === 0, evidenceRel, exitCode };
}

function readIndexBaselineId(cfg) {
  try {
    return readJson(cfg.issueIndexPath).baseline_id ?? "unknown";
  } catch {
    return "unknown";
  }
}

function defaultCommit(issue, cfg) {
  // Commit the issue's code in its EXECUTION root — the worktree branch for a
  // parallel issue, the main root sequentially. A parallel issue's commit is then
  // integrated onto the main branch by the integration step; sequentially this IS
  // the checkpoint on the main branch, exactly as before.
  const root = execRootOf(cfg);
  spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  const message = `${issue.id}: ${issue.title ?? "implement vertical slice"}\n\nGate green; reviewed by ${cfg.reviewer.actor}.`;
  return spawnSync("git", ["commit", "-m", message], { cwd: root, encoding: "utf8" });
}

// --------------------------------------------------------------------------
// Worktree lifecycle + integration (parallel path; default impls invoke git)
//
// Each concurrently-running issue executes in its OWN git worktree, branched from
// the current integration head, so parallel implementers never collide in the
// filesystem. After the worktree goes green and its branch is committed, the
// branch is INTEGRATED (merged) onto the integration branch on the MAIN root.
// Because parallel issues are independent (disjoint claims), the merge is a clean
// fast-forward-or-trivial merge; an UNEXPECTED conflict blocks ONLY that issue.
// --------------------------------------------------------------------------

// The branch name the main repo is currently on (the integration branch the loop
// commits checkpoints onto). Falls back to a detached-HEAD sha if there is no
// branch (still mergeable). Run from the main root.
function currentBranch(root) {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  const name = (r.stdout ?? "").trim();
  if (name && name !== "HEAD") return name;
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return (sha.stdout ?? "").trim();
}

// Create (or reuse) a dedicated worktree for an issue, branched from the current
// integration HEAD. Returns { worktreeRoot, branch }. Idempotent on resume: an
// existing worktree dir is reused, and a leftover branch from a prior crashed run
// is reset to the current HEAD so the issue always starts from the latest
// integration state. Run from the main root.
export function defaultCreateWorktree(issue, cfg) {
  const root = requireRepoRoot();
  const worktreeRel = `${cfg.worktreesDir}/${issue.id}`;
  const worktreeRoot = resolve(root, worktreeRel);
  const branch = `vivicy/${issue.id}`;
  // Clean up any stale worktree/branch from a prior crashed run so we always
  // branch fresh from the current integration head.
  spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
  if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  mkdirSync(resolve(root, cfg.worktreesDir), { recursive: true });
  const add = spawnSync("git", ["worktree", "add", "-b", branch, worktreeRoot, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if ((add.status ?? 1) !== 0) {
    throw new Error(`dev-loop: failed to create worktree for ${issue.id}: ${add.stderr || add.stdout}`);
  }
  return { worktreeRoot, branch };
}

// Integrate a green worktree branch onto the integration branch on the MAIN root.
// Returns { ok, conflict, message }. A non-clean merge is ABORTED (leaving main
// untouched) and reported as a conflict so the caller blocks only this issue and
// leaves the integration branch and the other issues intact. Serialize calls to
// this with the integration lock (one merge onto main at a time).
export function defaultIntegrateWorktree(issue, cfg, branch) {
  const root = requireRepoRoot();
  const merge = spawnSync(
    "git",
    ["merge", "--no-ff", "-m", `${issue.id}: integrate green worktree`, branch],
    { cwd: root, encoding: "utf8" },
  );
  if ((merge.status ?? 1) === 0) {
    return { ok: true, conflict: false, message: (merge.stdout ?? "").trim() };
  }
  // Abort the failed merge so the integration branch is left exactly as it was.
  spawnSync("git", ["merge", "--abort"], { cwd: root, encoding: "utf8" });
  return { ok: false, conflict: true, message: (merge.stderr || merge.stdout || "merge failed").trim() };
}

// Remove an issue's worktree and delete its branch once integrated (or on block).
// Best-effort: a leftover worktree is reclaimed on the next create. Run from main.
export function defaultRemoveWorktree(issue, cfg, worktreeRoot, branch) {
  const root = requireRepoRoot();
  spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: root, encoding: "utf8" });
  if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  if (branch) spawnSync("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
}

// Commit the done/-move (and index update) on the MAIN integration branch after a
// parallel issue's worktree has been merged. Staged narrowly to the orchestration
// paths (issues/, done/, issue-index) so unrelated tracked files are never folded
// into the bookkeeping commit. A no-op `git commit` (nothing staged) is tolerated.
function commitDoneMove(issue, cfg) {
  const root = requireRepoRoot();
  spawnSync("git", ["add", "--", cfg.issuesDir, cfg.doneDir, cfg.issueIndexPath], { cwd: root, encoding: "utf8" });
  return spawnSync("git", ["commit", "-m", `${issue.id}: move to done/ (integrated)`], { cwd: root, encoding: "utf8" });
}

function moveIssueToDone(issue, cfg) {
  const fromRel = issue.path ?? issue.issue_path ?? `${cfg.issuesDir}/${issue.id}.md`;
  const fromAbs = abs(fromRel);
  if (!existsSync(fromAbs)) return null;
  mkdirSync(abs(cfg.doneDir), { recursive: true });
  const toRel = `${cfg.doneDir}/${issue.id}.md`;
  renameSync(fromAbs, abs(toRel));
  // Keep the index path truthful for external readers (the viewer, tools). The
  // ledger + done/ folder remain the resume source of truth, so this is best-effort.
  try {
    const index = readJson(cfg.issueIndexPath);
    const entry = Array.isArray(index.issues) ? index.issues.find((item) => item.id === issue.id) : null;
    if (entry && entry.path) {
      entry.path = toRel;
      writeFileSync(abs(cfg.issueIndexPath), `${JSON.stringify(index, null, 2)}\n`);
    } else if (entry && entry.issue_path) {
      entry.issue_path = toRel;
      writeFileSync(abs(cfg.issueIndexPath), `${JSON.stringify(index, null, 2)}\n`);
    }
  } catch {
    // index path update is non-critical; resume relies on the ledger and done/.
  }
  return toRel;
}

// The loop commits each issue with `git add -A`, so it must start from a clean
// tree — otherwise unrelated or stray changes would be folded into an issue's
// commit. Each issue commits its own work, leaving the tree clean for the next.
// The worktrees dir itself is ignored: parallel worktrees live under it and are
// not "stray changes" in the main tree (it is gitignored, see ensureWorktreesIgnored).
function assertCleanTree() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: requireRepoRoot(), encoding: "utf8" });
  if ((result.stdout ?? "").trim().length > 0) {
    throw new Error(
      "dev-loop refuses to start on a dirty working tree: commit or stash existing changes first, so each issue commits only its own changes.",
    );
  }
}

// --------------------------------------------------------------------------
// Shared-state serialization (supervisor-owned integration lock)
//
// The progress ledger has its own cross-process lock + revision CAS, so ledger
// writes from N worktree workers are already safe. But the COMPLETION sequence —
// merge the worktree onto the integration branch on the MAIN root, then move the
// issue to done/ and commit that move on main — touches the SAME git index and
// the SAME done/ + issue-index files, and must run as one critical section so two
// concurrent completions never interleave a `git merge`/`git commit` on main. A
// O_EXCL lockfile (the same hand-rolled pattern the ledger uses) serializes all
// integration-side writes; only one issue integrates onto main at a time.
//
// Two layers, by design:
//   - An IN-PROCESS async mutex (a promise chain) serializes the critical section
//     within THIS process. The parallel loop runs all issues in one Node process,
//     so this is the authoritative serializer and — unlike a wall-clock lock — it
//     can never falsely reclaim from a live holder whose work simply ran long.
//   - The O_EXCL FILE lock guards against a *separate* process touching the same
//     repo (e.g. a stray manual run). It is acquired + released entirely INSIDE
//     the in-process mutex's hold, so within one process it is uncontended and is
//     never aged out by a sibling (the sibling waits on the mutex, not the file).
// --------------------------------------------------------------------------

const INTEGRATION_LOCK_STALE_MS = 120_000;

// Per-config in-process integration mutex (a tail promise we chain onto). Keyed by
// the absolute lock path so distinct targets/scratch dirs get independent mutexes
// (the test suite runs many fixtures in one process; the map holds one tiny entry
// per distinct lock path, which is bounded by the number of targets).
const integrationMutexes = new Map();

// Run `fn` (sync or async) as the sole holder of the integration critical section:
// first serialize in-process via the mutex, then take the cross-process file lock
// for the duration of `fn`. Always releases both, in order, even on throw.
async function withIntegrationLock(cfg, fn) {
  const lockPath = abs(`${cfg.gatesDir}/.integration.lock`);
  const prior = integrationMutexes.get(lockPath) ?? Promise.resolve();
  let release;
  const mine = new Promise((r) => {
    release = r;
  });
  // The next caller waits for `mine`; swallow rejections so one failed critical
  // section never poisons the queue.
  integrationMutexes.set(lockPath, prior.then(() => mine, () => mine));
  await prior.catch(() => {});
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
    acquireExclusiveLock(lockPath);
    try {
      return await fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // already removed (e.g. reclaimed as stale); ignore
      }
    }
  } finally {
    release();
  }
}

function acquireExclusiveLock(lockPath) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, epoch_ms: Date.now() }));
      closeSync(fd);
      return;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      if (reclaimStaleExclusiveLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring integration lock: ${lockPath}`);
      busyWaitMs(25);
    }
  }
}

function reclaimStaleExclusiveLock(lockPath) {
  let owner = null;
  let stat = null;
  try {
    stat = statSync(lockPath);
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return true; // vanished or unreadable mid-check => retry the acquire
  }
  const epoch = owner && typeof owner.epoch_ms === "number" ? owner.epoch_ms : stat.mtimeMs;
  const tooOld = Date.now() - epoch > INTEGRATION_LOCK_STALE_MS;
  const dead = owner && typeof owner.pid === "number" && owner.pid !== process.pid && !isPidAlive(owner.pid);
  if (!tooOld && !dead) return false;
  try {
    unlinkSync(lockPath);
  } catch {
    // someone else reclaimed first; retry anyway
  }
  return true;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && error.code === "EPERM";
  }
}

function busyWaitMs(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // short spin; integration holds the lock only for a merge + commit
  }
}

// Ensure the worktrees dir is gitignored in the main repo so per-issue worktrees
// never show up as stray changes in the main tree (and are never folded into an
// issue's `git add -A`). Idempotent; only needed on the parallel path.
function ensureWorktreesIgnored(cfg) {
  const root = requireRepoRoot();
  const gitignorePath = resolve(root, ".gitignore");
  const entry = `${cfg.worktreesDir}/`;
  let body = "";
  try {
    body = readFileSync(gitignorePath, "utf8");
  } catch {
    body = "";
  }
  const lines = body.split("\n").map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(cfg.worktreesDir)) return;
  const next = body && !body.endsWith("\n") ? `${body}\n${entry}\n` : `${body}${entry}\n`;
  writeFileSync(gitignorePath, next);
}

function emit(cfg, event) {
  return recordProgressEvent(
    { session_ref: `dev-loop:${event.issue_id}`, ...event },
    { issueIndexPath: cfg.issueIndexPath, progressLedgerPath: cfg.progressLedgerPath },
  );
}

// --------------------------------------------------------------------------
// Quota state + quota-aware leg execution
// --------------------------------------------------------------------------

const nowIso = (cfg) => new Date(cfg.now?.() ?? Date.now()).toISOString();
const nowMsOf = (cfg) => cfg.now?.() ?? Date.now();
const sleepOf = (cfg) => cfg.sleep ?? defaultSleep;

// Default blocking wait. The dev-loop is a deterministic sequential orchestrator
// (one agent at a time), so a real synchronous wait is correct and simple here;
// tests inject a fake `sleep` so they never actually wait.
function defaultSleep(ms) {
  const end = Date.now() + ms;
  // Coarse busy-wait via Atomics so the wait is honored without async plumbing.
  const sab = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < end) {
    Atomics.wait(sab, 0, 0, Math.min(1000, end - Date.now()));
  }
}

// Read the current quota-state file (or a fresh skeleton). Tolerant of a missing
// or corrupt file — quota state is advisory, never load-bearing for correctness.
function readQuotaState(cfg) {
  try {
    const parsed = JSON.parse(readFileSync(abs(cfg.quotaStatePath), "utf8"));
    if (parsed && typeof parsed === "object" && parsed.agents) return parsed;
  } catch {
    // fall through to a fresh skeleton
  }
  return { updated_at: null, agents: {} };
}

// Merge one agent's quota status into the file and write it atomically so a
// concurrent reader (the status probe / Vivicy SSE) never sees a partial write.
// A falsy quotaStatePath disables persistence (used in pure control-flow tests);
// quota state is advisory and never load-bearing, so skipping the write is safe.
function writeQuotaState(cfg, actor, agentState) {
  if (!cfg.quotaStatePath) return null;
  const state = readQuotaState(cfg);
  state.agents = state.agents ?? {};
  state.agents[actor] = { ...(state.agents[actor] ?? {}), ...agentState };
  state.updated_at = nowIso(cfg);
  mkdirSync(abs(dirname(cfg.quotaStatePath)), { recursive: true });
  atomicWriteJson(abs(cfg.quotaStatePath), state);
  return state;
}

// Record an agent as available (the steady state after a non-rate-limited leg).
// The single top-level updated_at (set by writeQuotaState) timestamps the file.
// `windows` carries the REAL per-window usage extracted from the leg's transcript
// (Codex %, Claude reset-only); an empty/absent windows map keeps the prior
// windows (or none) rather than overwriting real data with nothing.
function markAgentAvailable(cfg, leg, windows) {
  writeQuotaState(cfg, leg.actor, {
    model: leg.model ?? null,
    status: "available",
    reset_at: null,
    last_message: null,
    ...(windows && Object.keys(windows).length > 0 ? { windows } : {}),
  });
}

// Record an agent as throttled while we wait out its quota window.
function markAgentThrottled(cfg, leg, { message, resetAtMs, windows }) {
  writeQuotaState(cfg, leg.actor, {
    model: leg.model ?? null,
    status: "throttled",
    reset_at: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    last_message: message ?? null,
    ...(windows && Object.keys(windows).length > 0 ? { windows } : {}),
  });
}

// Run ONE agent leg with quota-aware retry. The leg is re-run on every
// rate-limit hit (never counted as a gate attempt, never throws); we wait the
// parsed reset time or a capped backoff between tries. Stops with
// `{ quotaBlocked: true }` only when the cumulative wait exceeds
// cfg.quotaMaxWaitMs — a human-intervention signal, not a crash.
//
// Returns { result, output, transcriptRel, quotaBlocked, totalWaitedMs }.
export function runLegWithQuota(runLeg, leg, issue, cfg) {
  const patterns = cfg.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS;
  const sleep = sleepOf(cfg);
  let totalWaitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const legResult = runLeg(issue, cfg);
    const output = legResult?.output ?? combinedOutput(legResult?.result);
    // Extract the REAL per-window quota usage from the leg's captured transcript
    // (Codex rollout -> real %; Claude stream-json -> reset-only). Falls back to
    // scanning the leg's stdout when no transcript file was captured. Honest by
    // construction: a provider that exposes nothing yields no windows (unknown).
    const transcriptText = readTranscriptText(legResult?.transcriptRel) || output;
    const windows = parseQuotaWindows(leg.actor, transcriptText);
    // A rate-limit always coincides with a non-zero exit, so a SUCCESSFUL leg is
    // never throttled — even when its summary mentions quota/429/rate-limit. The
    // exit code is the spawnSync status; an undefined status (e.g. a test stub
    // returning no result) is treated as a failure so detection still runs.
    const exitCode = legResult?.result?.status ?? null;
    const detection = detectRateLimit(output, patterns, exitCode);
    if (!detection.hit) {
      // On a successful Claude leg, opportunistically refresh the REAL 5h + weekly
      // percentages from the documented status-line surface (the leg's own `-p`
      // output carries only a reset). Rate-limited internally so it costs at most
      // one trivial turn per refresh window.
      const finalWindows = leg.actor === "claude" ? refreshClaudeQuotaWindows(cfg, leg, windows) : windows;
      markAgentAvailable(cfg, leg, finalWindows);
      return { ...legResult, quotaBlocked: false, totalWaitedMs };
    }

    const nowMs = nowMsOf(cfg);
    const { waitMs, resetAtMs } = computeWaitMs({ message: detection.message, nowMs, attempt, cfg });
    // Give up only if waiting would push us past the hard cap; never count this
    // against the issue's gate retries.
    if (totalWaitedMs + waitMs > cfg.quotaMaxWaitMs) {
      markAgentThrottled(cfg, leg, { message: detection.message, resetAtMs, windows });
      return { ...legResult, quotaBlocked: true, totalWaitedMs };
    }
    markAgentThrottled(cfg, leg, { message: detection.message, resetAtMs, windows });
    process.stderr.write(
      `[quota] ${leg.actor} rate-limited (${detection.message}); waiting ${Math.round(waitMs / 1000)}s then retrying the same leg\n`,
    );
    sleep(waitMs);
    totalWaitedMs += waitMs;
  }
}

// Non-blocking sleep for the async (parallel) path: a real setTimeout so waiting
// out one issue's quota window never blocks the other parallel issues' event loop
// progress. Tests inject cfg.sleepAsync to fast-forward.
function defaultSleepAsync(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Async sibling of runLegWithQuota: identical retry/quota logic, but it AWAITS the
// async leg runner and AWAITS the wait, so a rate-limited parallel issue yields
// the event loop to its siblings instead of busy-blocking. One source of truth for
// the pure decisions (detectRateLimit, computeWaitMs, parseQuotaWindows) — shared
// with the sync path; only the spawn + wait primitives differ.
export async function runLegWithQuotaAsync(runLeg, leg, issue, cfg) {
  const patterns = cfg.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS;
  const sleep = cfg.sleepAsync ?? defaultSleepAsync;
  let totalWaitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const legResult = await runLeg(issue, cfg);
    const output = legResult?.output ?? combinedOutput(legResult?.result);
    const transcriptText = readTranscriptText(legResult?.transcriptRel) || output;
    const windows = parseQuotaWindows(leg.actor, transcriptText);
    const exitCode = legResult?.result?.status ?? null;
    const detection = detectRateLimit(output, patterns, exitCode);
    if (!detection.hit) {
      const finalWindows = leg.actor === "claude" ? refreshClaudeQuotaWindows(cfg, leg, windows) : windows;
      markAgentAvailable(cfg, leg, finalWindows);
      return { ...legResult, quotaBlocked: false, totalWaitedMs };
    }
    const nowMs = nowMsOf(cfg);
    const { waitMs, resetAtMs } = computeWaitMs({ message: detection.message, nowMs, attempt, cfg });
    if (totalWaitedMs + waitMs > cfg.quotaMaxWaitMs) {
      markAgentThrottled(cfg, leg, { message: detection.message, resetAtMs, windows });
      return { ...legResult, quotaBlocked: true, totalWaitedMs };
    }
    markAgentThrottled(cfg, leg, { message: detection.message, resetAtMs, windows });
    process.stderr.write(
      `[quota] ${leg.actor} rate-limited (${detection.message}); waiting ${Math.round(waitMs / 1000)}s then retrying the same leg\n`,
    );
    await sleep(waitMs);
    totalWaitedMs += waitMs;
  }
}

// --------------------------------------------------------------------------
// Cycle + loop
// --------------------------------------------------------------------------

// Runs one issue through implement -> review&fix -> gate, up to maxRetries.
// Returns { status: "verified" | "blocked", evidenceRel? }.
export function runIssueCycle(issue, cfg, steps) {
  const { runImplementer, runReviewer, runGate } = steps;
  const allTranscripts = [];
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt += 1) {
    emit(cfg, {
      event_type: "issue_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
    });
    // Each leg is wrapped in quota-aware retry: a rate-limit hit waits for the
    // quota to reopen and re-runs the SAME leg — it never burns a gate attempt
    // and never throws. A leg only gives up (quotaBlocked) past the hard cap.
    const implResult = runLegWithQuota(runImplementer, cfg.implementer, issue, cfg);
    if (implResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.implementer, allTranscripts);

    emit(cfg, {
      event_type: "review_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.reviewer.actor,
      role: cfg.reviewer.role,
    });
    const reviewResult = runLegWithQuota(runReviewer, cfg.reviewer, issue, cfg);
    if (reviewResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.reviewer, allTranscripts);

    // Only reference transcripts that landed as a non-empty file, so the ledger
    // never points the viewer at a missing or partial transcript (capture can
    // race on the first leg in a cold workspace).
    const transcripts = [implResult?.transcriptRel, reviewResult?.transcriptRel]
      .filter(Boolean)
      .filter((rel) => {
        try {
          return statSync(abs(rel)).size > 0;
        } catch {
          return false;
        }
      });
    allTranscripts.push(...transcripts);

    const gate = runGate(issue, cfg);
    if (gate.pass) {
      // In the parallel path the verified state is recorded only AFTER the
      // worktree integrates cleanly onto main (so a merge conflict never leaves a
      // node verified for code that never landed). cfg.deferVerified lets the
      // caller emit gate_passed post-integration; the sequential path emits it
      // here, exactly as before.
      if (!cfg.deferVerified) {
        emit(cfg, {
          event_type: "gate_passed",
          issue_id: issue.id,
          graph_refs: issue.graph_refs,
          actor: cfg.implementer.actor,
          role: cfg.implementer.role,
          evidence_refs: [gate.evidenceRel],
          transcript_refs: transcripts,
        });
      }
      return {
        status: "verified",
        evidenceRel: gate.evidenceRel,
        attempts: attempt,
        transcripts: allTranscripts,
        gateTranscripts: transcripts,
      };
    }
    emit(cfg, {
      event_type: "gate_failed",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
      transcript_refs: transcripts,
    });
  }
  emit(cfg, {
    event_type: "issue_blocked",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: cfg.implementer.role,
    evidence_refs: [writeBlockedEvidence(issue, cfg)],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", attempts: cfg.maxRetries, transcripts: allTranscripts };
}

// Async sibling of runIssueCycle for the parallel path: same implement -> review
// -> gate flow and the SAME emits/blocks, but it awaits the async quota runner so
// the leg spawns are non-blocking. The parallel caller always runs with
// cfg.deferVerified set (verified is emitted only after a clean integration), so
// on a green gate this returns { status: "verified", ... } WITHOUT having emitted
// gate_passed — the integration step does that under the integration lock.
export async function runIssueCycleAsync(issue, cfg, steps) {
  const { runImplementer, runReviewer, runGate } = steps;
  const allTranscripts = [];
  for (let attempt = 1; attempt <= cfg.maxRetries; attempt += 1) {
    emit(cfg, {
      event_type: "issue_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
    });
    const implResult = await runLegWithQuotaAsync(runImplementer, cfg.implementer, issue, cfg);
    if (implResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.implementer, allTranscripts);

    emit(cfg, {
      event_type: "review_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.reviewer.actor,
      role: cfg.reviewer.role,
    });
    const reviewResult = await runLegWithQuotaAsync(runReviewer, cfg.reviewer, issue, cfg);
    if (reviewResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.reviewer, allTranscripts);

    const transcripts = [implResult?.transcriptRel, reviewResult?.transcriptRel]
      .filter(Boolean)
      .filter((rel) => {
        try {
          return statSync(abs(rel)).size > 0;
        } catch {
          return false;
        }
      });
    allTranscripts.push(...transcripts);

    const gate = await runGate(issue, cfg);
    if (gate.pass) {
      if (!cfg.deferVerified) {
        emit(cfg, {
          event_type: "gate_passed",
          issue_id: issue.id,
          graph_refs: issue.graph_refs,
          actor: cfg.implementer.actor,
          role: cfg.implementer.role,
          evidence_refs: [gate.evidenceRel],
          transcript_refs: transcripts,
        });
      }
      return {
        status: "verified",
        evidenceRel: gate.evidenceRel,
        attempts: attempt,
        transcripts: allTranscripts,
        gateTranscripts: transcripts,
      };
    }
    emit(cfg, {
      event_type: "gate_failed",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
      transcript_refs: transcripts,
    });
  }
  emit(cfg, {
    event_type: "issue_blocked",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: cfg.implementer.role,
    evidence_refs: [writeBlockedEvidence(issue, cfg)],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", attempts: cfg.maxRetries, transcripts: allTranscripts };
}

function writeBlockedEvidence(issue, cfg) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify({ issue_id: issue.id, reason: `gate red after ${cfg.maxRetries} attempts`, at: cfg.now ?? new Date().toISOString() }, null, 2)}\n`,
  );
  return rel;
}

// A leg gave up after exceeding the quota hard cap: record an issue_blocked with
// a quota-specific reason and stop for a human (the same terminal shape as a
// red-gate block, so the loop halts rather than crashing).
function quotaBlock(issue, cfg, leg, allTranscripts) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      {
        issue_id: issue.id,
        reason: `${leg.actor} quota exhausted: waited past the ${Math.round(cfg.quotaMaxWaitMs / 3600000)}h cap without the quota reopening`,
        actor: leg.actor,
        kind: "quota",
        at: typeof cfg.now === "string" ? cfg.now : nowIso(cfg),
      },
      null,
      2,
    )}\n`,
  );
  emit(cfg, {
    event_type: "issue_blocked",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: leg.actor,
    role: leg.role,
    evidence_refs: [rel],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", reason: "quota", attempts: 0, transcripts: allTranscripts };
}

// Reject absolute config sub-paths up front (recordProgressEvent requires
// repository-relative paths) so a bad config fails loudly instead of mid-cycle.
function assertRelativeConfig(cfg) {
  for (const key of ["issueIndexPath", "progressLedgerPath", "issuesDir", "doneDir", "gatesDir", "reportsDir"]) {
    if (typeof cfg[key] === "string" && isAbsolute(cfg[key])) {
      throw new Error(`dev-loop config ${key} must be repository-relative, not absolute: ${cfg[key]}`);
    }
  }
}

export function runLoop(userConfig = {}, steps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  // Concurrency dispatch: maxParallel > 1 runs the async parallel loop (worktree
  // isolation + integration). maxParallel <= 1 keeps the byte-for-byte sequential
  // path below — a single worktree-free issue at a time against the main root,
  // exactly as before. The default (env-driven) is 1, so existing callers are
  // unchanged.
  if (clampConcurrency(cfg.maxParallel) > 1) {
    return runLoopParallel(userConfig, steps);
  }
  assertRelativeConfig(cfg);
  const resolvedSteps = {
    runImplementer: steps.runImplementer ?? ((issue) => defaultRunImplementer(issue, cfg)),
    runReviewer: steps.runReviewer ?? ((issue) => defaultRunReviewer(issue, cfg)),
    runGate: steps.runGate ?? ((issue) => defaultRunGate(issue, cfg)),
    commit: steps.commit ?? ((issue) => defaultCommit(issue, cfg)),
  };
  const index = readJson(cfg.issueIndexPath);
  const issues = Array.isArray(index.issues) ? index.issues : [];
  const processed = [];

  for (;;) {
    const doneIds = computeDoneIds(issues, readLedger(cfg), listDoneFiles(cfg));
    const issue = pickNextIssue(issues, doneIds);
    if (!issue) break;

    const result = runIssueCycle(issue, cfg, resolvedSteps);
    if (result.status === "verified") {
      // Move to done/ BEFORE committing so the green checkpoint records the move
      // (and the index path update) atomically; a kill between the two then never
      // leaves an issue verified-in-ledger but missing from done/.
      moveIssueToDone(issue, cfg);
      resolvedSteps.commit(issue, cfg);
      processed.push({ id: issue.id, status: "verified" });
      continue;
    }
    processed.push({ id: issue.id, status: "blocked" });
    break; // sequential loop stops at a real blocker for a human.
  }
  return processed;
}

// --------------------------------------------------------------------------
// Parallel loop (N independent issues at once, each in its own git worktree)
//
// The scheduler keeps up to cfg.maxParallel mutually-independent issues running
// concurrently, each in a dedicated worktree branched from the integration HEAD.
// When a worktree goes green, the loop re-runs the gate itself (the authoritative
// verdict, exactly as the sequential path), then — UNDER THE INTEGRATION LOCK so
// only one issue touches main at a time — merges the worktree onto the integration
// branch, moves the issue to done/, commits the move, and emits the verified
// state. A merge conflict or a still-red gate blocks ONLY that issue (its
// issue_blocked is recorded) and never blocks the independent others, which keep
// running and integrating. The worktree is always removed when the issue settles.
//
// Shared state (ledger, gate evidence, blocked reports, done/ moves, quota-state)
// always lives on the MAIN root: the ledger writer already serializes cross-process
// via its O_EXCL lock + revision CAS, and the integration lock serializes the
// merge + done/ move + verified emit so concurrent completions never corrupt the
// git index or the ledger.
// --------------------------------------------------------------------------
export async function runLoopParallel(userConfig = {}, steps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  assertRelativeConfig(cfg);
  const maxParallel = clampConcurrency(cfg.maxParallel);
  const index = readJson(cfg.issueIndexPath);
  const issues = Array.isArray(index.issues) ? index.issues : [];
  const depsClosure = buildDepsClosure(issues);

  // Injectable worktree/integration steps (defaults invoke real git); parallel
  // legs default to the ASYNC runners so spawns don't block the event loop.
  const wt = {
    createWorktree: steps.createWorktree ?? ((issue) => defaultCreateWorktree(issue, cfg)),
    integrateWorktree: steps.integrateWorktree ?? ((issue, branch) => defaultIntegrateWorktree(issue, cfg, branch)),
    removeWorktree:
      steps.removeWorktree ?? ((issue, worktreeRoot, branch) => defaultRemoveWorktree(issue, cfg, worktreeRoot, branch)),
  };

  // Keep parallel worktrees out of the main tree's status/`git add -A`.
  if (!steps.skipWorktreeIgnore) ensureWorktreesIgnored(cfg);

  const processed = [];
  const running = new Map(); // issue.id -> Promise of its settled result
  const runningIssueById = new Map(); // issue.id -> issue (for independence checks)
  const blocked = new Set(); // issue ids that settled blocked (and never run again)

  // Per-issue task: worktree -> async cycle (deferred verified) -> integrate +
  // done + verified emit (under the integration lock) -> remove worktree. Returns
  // { id, status }. A merge conflict or red gate blocks ONLY this issue; the
  // independent others keep running and integrating.
  const runOne = async (issue) => {
    let created = null;
    try {
      // Worktree creation reads/writes the main repo's .git/worktrees metadata and
      // its HEAD, so it runs under the integration lock — both to avoid two
      // concurrent `git worktree add` racing and to branch each worktree from the
      // LATEST integration head (after any sibling that integrated meanwhile).
      created = await withIntegrationLock(cfg, () => wt.createWorktree(issue));
    } catch (error) {
      // Could not even create the worktree (e.g. git error): block this issue
      // alone with a clear report; the others keep running.
      writeIntegrationBlock(issue, cfg, `worktree setup failed: ${error?.message ?? error}`);
      return { id: issue.id, status: "blocked" };
    }
    const issueCfg = { ...cfg, execRoot: created.worktreeRoot, deferVerified: true };
    const issueSteps = {
      runImplementer: steps.runImplementer ?? ((iss, c) => defaultRunImplementerAsync(iss, c ?? issueCfg)),
      runReviewer: steps.runReviewer ?? ((iss, c) => defaultRunReviewerAsync(iss, c ?? issueCfg)),
      // The gate is ASYNC on the parallel path so a slow gate never freezes the
      // event loop (which would stall every other issue and age out the lock).
      runGate: steps.runGate ?? ((iss, c) => defaultRunGateAsync(iss, c ?? issueCfg)),
    };
    try {
      const result = await runIssueCycleAsync(issue, issueCfg, issueSteps);
      if (result.status !== "verified") {
        return { id: issue.id, status: "blocked" };
      }
      // Commit the green code on the worktree branch, then integrate + finalize
      // under the integration lock (one issue onto main at a time).
      const commit = steps.commit ?? ((iss, c) => defaultCommit(iss, c ?? issueCfg));
      commit(issue, issueCfg);
      return await withIntegrationLock(cfg, () => {
        const merge = wt.integrateWorktree(issue, created.branch);
        if (!merge.ok) {
          writeIntegrationBlock(issue, cfg, `integration conflict: ${merge.message}`);
          return { id: issue.id, status: "blocked" };
        }
        // Move to done/ BEFORE the orchestration commit + verified emit so a kill
        // between them never leaves an issue verified-in-ledger but missing from
        // done/ (the same move-before-commit invariant the sequential path keeps).
        moveIssueToDone(issue, cfg);
        // Commit the done/-move on the integration branch so the next worktree
        // branches from a clean HEAD that already reflects this issue's completion
        // (the merge commit carried the code; this records the bookkeeping move).
        if (steps.commitDoneMove !== false) commitDoneMove(issue, cfg);
        emit(cfg, {
          event_type: "gate_passed",
          issue_id: issue.id,
          graph_refs: issue.graph_refs,
          actor: cfg.implementer.actor,
          role: cfg.implementer.role,
          evidence_refs: [result.evidenceRel],
          transcript_refs: result.gateTranscripts ?? [],
        });
        return { id: issue.id, status: "verified" };
      });
    } finally {
      // Cleanup is best-effort: a removal failure must NEVER mask a verified result
      // (or it would mislabel a fully-integrated issue as blocked) or crash the
      // scheduler. Swallow it; a leftover worktree is reclaimed on the next create.
      try {
        wt.removeWorktree(issue, created.worktreeRoot, created.branch);
      } catch (error) {
        process.stderr.write(`[parallel] worktree cleanup failed for ${issue.id}: ${error?.message ?? error}\n`);
      }
    }
  };

  // Scheduler: keep filling slots with INDEPENDENT ready issues until no issue can
  // ever become ready again. A per-issue block prunes only that issue (and, via the
  // dependency check, its dependents — their deps never become done) — it NEVER
  // stops scheduling unrelated independent issues. The loop terminates when nothing
  // is in flight and nothing is schedulable (everything is done or transitively
  // depends on a blocked issue).
  for (;;) {
    const doneIds = computeDoneIds(issues, readLedger(cfg), listDoneFiles(cfg));
    const excluded = new Set([...running.keys(), ...blocked]);
    const ready = computeReadySet(issues, doneIds, excluded);
    const batch = selectIndependentBatch(ready, [...runningIssueById.values()], maxParallel, depsClosure);
    for (const issue of batch) {
      runningIssueById.set(issue.id, issue);
      const task = runOne(issue)
        .catch((error) => ({ id: issue.id, status: "blocked", error: String(error?.message ?? error) }))
        .then((settled) => {
          running.delete(issue.id);
          runningIssueById.delete(issue.id);
          processed.push({ id: settled.id, status: settled.status });
          // A blocked issue is remembered so it (and only it) is never re-scheduled;
          // the independent others keep flowing.
          if (settled.status === "blocked") blocked.add(settled.id);
          return settled;
        });
      running.set(issue.id, task);
    }
    if (running.size === 0) {
      // Nothing in flight AND nothing schedulable this turn (the batch is empty —
      // a just-scheduled batch would have made running.size > 0): the run is done.
      // Any remaining not-done issues are blocked or transitively depend on a
      // blocked issue, so they can never become ready.
      break;
    }
    // Wait for the NEXT issue to settle, then re-schedule: slots may have freed and
    // a freshly-integrated dependency may have unlocked new independent ready issues.
    await Promise.race(running.values());
  }
  return processed;
}

// Record an integration-time block (merge conflict or worktree setup failure) for
// ONE issue and emit its issue_blocked, mirroring the gate-block shape so the loop
// surfaces it without blocking the independent others. Written to the MAIN root.
function writeIntegrationBlock(issue, cfg, reason) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      { issue_id: issue.id, reason, kind: "integration", at: typeof cfg.now === "string" ? cfg.now : nowIso(cfg) },
      null,
      2,
    )}\n`,
  );
  // issue_blocked requires the node be linkable; emit against the issue's graph
  // refs so the map lights it blocked. Best-effort: a ledger emit failure here
  // must not crash the whole parallel loop and strand the other issues.
  try {
    emit(cfg, {
      event_type: "issue_blocked",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
      evidence_refs: [rel],
    });
  } catch (error) {
    process.stderr.write(`[parallel] failed to emit issue_blocked for ${issue.id}: ${error?.message ?? error}\n`);
  }
  return rel;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertCleanTree();
  const skills = checkSkills();
  if (!skills.ok) {
    process.stderr.write(`dev-loop preflight: ${skills.reason}\n  missing skills: ${skills.missing.join(", ")}\n  see AGENTS.md > Development Skills\n`);
    process.exit(1);
  }
  // runLoop returns a Promise on the parallel path (maxParallel > 1) and an array
  // sequentially; await handles both, and a clean tree is required either way.
  Promise.resolve(runLoop())
    .then((processed) => {
      process.stdout.write(`${JSON.stringify({ processed }, null, 2)}\n`);
      if (processed.some((entry) => entry.status === "blocked")) process.exit(2);
    })
    .catch((error) => {
      process.stderr.write(`dev-loop failed: ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
