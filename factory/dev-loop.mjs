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
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
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
  codex: { model: "gpt-5.5-codex", effort: "high" },
};

/** The set of CLIs the loop knows how to spawn. */
export const KNOWN_CLIS = ["claude", "codex"];

/** Is `value` a CLI the loop can drive? */
function isKnownCli(value) {
  return value === "claude" || value === "codex";
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
 * keying, transcript naming), plus the resolved model + effort.
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
  const leg = (role, cli) => ({
    actor: cli,
    role,
    provider: cli,
    model: env[`VIVICY_${cli.toUpperCase()}_MODEL`] || CLI_DEFAULTS[cli].model,
    effort: env[`VIVICY_${cli.toUpperCase()}_EFFORT`] || CLI_DEFAULTS[cli].effort,
  });
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
  // Per-role CLI assignment + per-CLI model + thinking-level (R12 + P4). Two knobs,
  // both driven from the Vivicy settings dialog via env:
  //   - which CLI fills each ROLE: VIVICY_IMPLEMENTER_CLI / VIVICY_REVIEWER_CLI
  //     (defaults implementer=claude, reviewer=codex). The two MUST differ — a CLI
  //     can never review its own implementation; resolveAgentLegs enforces it.
  //   - each CLI's model + level: VIVICY_CLAUDE_* / VIVICY_CODEX_* (always-latest
  //     model is the default, the thinking level is the user-tunable knob).
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

export function composePrompt(template, issue, extra = {}) {
  const values = {
    issue_id: issue.id,
    issue_path: issue.path ?? issue.issue_path ?? "",
    graph_refs: (issue.graph_refs ?? []).join(", "),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

// Build the provider-specific model + thinking-level CLI flags appended to an
// agent leg's argv. Pure (no spawn) so it is unit-tested directly.
//   - claude (implementer): `--model <id> --effort <level>`
//     level ∈ {low, medium, high, xhigh, max}
//   - codex  (reviewer):    `-m <id> -c model_reasoning_effort="<level>"`
//     level ∈ {minimal, low, medium, high}
// A falsy model or effort omits just that flag pair (never emits a bare flag),
// so a partially-configured leg degrades gracefully to the CLI's own default.
export function agentCliArgs(provider, { model, effort } = {}) {
  const args = [];
  if (provider === "claude") {
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
  } else if (provider === "codex") {
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
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
//   Claude  — emits a `rate_limit_event` in its stream-json transcript:
//               { status, resetsAt (epoch s), rateLimitType: "five_hour", ... }
//             which gives a real 5h RESET + status but NO percentage, and no weekly
//             window. => 5h: used_pct null + reset; weekly: unknown.
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

// Parse Claude `rate_limit_event` (real reset + status, NO percentage) out of a
// stream-json transcript. Maps the five_hour window to "5h" with a null
// used_pct (honest: Claude does not expose a usage percentage here). The weekly
// window is left unknown. Returns a partial windows map.
export function parseClaudeQuotaWindows(transcriptText) {
  const text = String(transcriptText ?? "");
  if (!text) return {};
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
// IO helpers
// --------------------------------------------------------------------------

function abs(relPath) {
  return resolve(requireRepoRoot(), relPath);
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
  const result = spawnTee("claude", args, { cwd: requireRepoRoot(), env: agentEnv(issue, cfg, leg), encoding: "utf8" });
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
  const root = requireRepoRoot();
  const args = ["exec", prompt, "--dangerously-bypass-approvals-and-sandbox", "-C", root, "--skip-git-repo-check"];
  // Latest model + user-chosen thinking level: `-m <id> -c model_reasoning_effort="<level>"`.
  args.push(...agentCliArgs("codex", leg));
  const startMs = Date.now();
  const result = spawnTee("codex", args, { cwd: root, env: agentEnv(issue, cfg, leg), encoding: "utf8" });
  ensureTranscriptDir(issue, cfg);
  const output = combinedOutput(result);
  const rollout = findNewestCodexRollout(startMs);
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

// The rollout created during this leg = newest .jsonl under ~/.codex/sessions with
// mtime at or after the run start (sequential loop => one codex at a time).
function findNewestCodexRollout(sinceMs) {
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
        if (mtime >= sinceMs && mtime > bestMtime) {
          best = full;
          bestMtime = mtime;
        }
      }
    }
  };
  walk(base);
  return best;
}

// The orchestrator runs the gate ITSELF — the authoritative verdict — and writes
// a gate-run record evidence file the ledger requires for gate_passed.
export function defaultRunGate(issue, cfg) {
  const gateCommand = issue.gate_command ?? cfg.defaultGateCommand;
  const result = spawnSync(gateCommand, { cwd: requireRepoRoot(), encoding: "utf8", shell: true });
  const exitCode = result.status ?? 1;
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
  const root = requireRepoRoot();
  spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  const message = `${issue.id}: ${issue.title ?? "implement vertical slice"}\n\nGate green; reviewed by ${cfg.reviewer.actor}.`;
  return spawnSync("git", ["commit", "-m", message], { cwd: root, encoding: "utf8" });
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
function assertCleanTree() {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: requireRepoRoot(), encoding: "utf8" });
  if ((result.stdout ?? "").trim().length > 0) {
    throw new Error(
      "dev-loop refuses to start on a dirty working tree: commit or stash existing changes first, so each issue commits only its own changes.",
    );
  }
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
      markAgentAvailable(cfg, leg, windows);
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
      emit(cfg, {
        event_type: "gate_passed",
        issue_id: issue.id,
        graph_refs: issue.graph_refs,
        actor: cfg.implementer.actor,
        role: cfg.implementer.role,
        evidence_refs: [gate.evidenceRel],
        transcript_refs: transcripts,
      });
      return { status: "verified", evidenceRel: gate.evidenceRel, attempts: attempt, transcripts: allTranscripts };
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

export function runLoop(userConfig = {}, steps = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...userConfig };
  // recordProgressEvent requires repository-relative paths; reject absolute config
  // up front with a clear error instead of crashing mid-cycle on the first emit.
  for (const key of ["issueIndexPath", "progressLedgerPath", "issuesDir", "doneDir", "gatesDir", "reportsDir"]) {
    if (typeof cfg[key] === "string" && isAbsolute(cfg[key])) {
      throw new Error(`dev-loop config ${key} must be repository-relative, not absolute: ${cfg[key]}`);
    }
  }
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

if (import.meta.url === `file://${process.argv[1]}`) {
  assertCleanTree();
  const skills = checkSkills();
  if (!skills.ok) {
    process.stderr.write(`dev-loop preflight: ${skills.reason}\n  missing skills: ${skills.missing.join(", ")}\n  see AGENTS.md > Development Skills\n`);
    process.exit(1);
  }
  const processed = runLoop();
  process.stdout.write(`${JSON.stringify({ processed }, null, 2)}\n`);
  if (processed.some((entry) => entry.status === "blocked")) process.exit(2);
}
