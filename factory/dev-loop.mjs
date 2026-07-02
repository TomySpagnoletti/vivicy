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
import { createHash } from "node:crypto";
import {
  closeSync,
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
import { platform, tmpdir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteJson } from "./atomic-write.mjs";
import { sleepSync } from "./sleep-sync.mjs";
import { recordProgressEvent } from "./progress-ledger.mjs";
import { checkSkills } from "./dev-preflight.mjs";
import { runTraceabilityCheck } from "./traceability-check.mjs";
import { runSpikeCheck, transitivelyVerifiedGates } from "./spike-check.mjs";
import { runReferenceCheck } from "./reference-check.mjs";
import { resolveTargetRoot, FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.mjs";
import { resolveGateCommand } from "./project-config.mjs";
// Shared agent-leg spawn + transcript-capture primitives (one owner, reused by
// the extractor in extract-issues.mjs). dev-loop binds them to its own root
// resolution via the `deps` it passes to the shared leg runners.
import {
  combinedOutput,
  runClaudeLeg as sharedRunClaudeLeg,
  runClaudeLegAsync as sharedRunClaudeLegAsync,
  runCodexLeg as sharedRunCodexLeg,
  runCodexLegAsync as sharedRunCodexLegAsync,
} from "./agent-spawn.mjs";

// The target project the loop drives (agents cwd, gate, paths all resolve there).
// VIVICY_TARGET_ROOT selects it; unset => no target. The loop only resolves the
// target when it actually runs against one
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

// The models whose FAST mode genuinely functions on the headless run, gated here
// so the loop never requests a fast run a CLI cannot perform (agentCliArgs omits
// the flag for anything not in this set). Mirrors lib/settings.ts. Verified 2026-06
// against https://code.claude.com/docs/en/fast-mode and
// https://developers.openai.com/codex/speed.
export const FAST_CAPABLE_MODELS = {
  claude: new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]),
  codex: new Set(["gpt-5.5", "gpt-5.4"]),
};

/** Does fast mode genuinely function for this CLI+model on the headless run? */
function modelSupportsFast(provider, model) {
  return FAST_CAPABLE_MODELS[provider]?.has(model) ?? false;
}

// Defensive gate on env-supplied effort so the loop never spawns a CLI with a flag
// it would reject (a hand-edited settings file could carry a bad value). Mirrors
// lib/settings.ts. Empty/unset effort is allowed (models with no reasoning control).
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

// Mirrors lib/settings.ts MIN_PARALLEL / MAX_PARALLEL; re-clamped here as defence
// in depth against a hand-edited or out-of-band VIVICY_MAX_PARALLEL.
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 12;

// Unparseable or < 1 falls back to 1 (sequential default) so a bad value never
// stalls the loop at 0; > 12 is capped so a runaway value never spawns an
// unbounded fleet of worktrees.
export function clampConcurrency(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  return n > MAX_CONCURRENCY ? MAX_CONCURRENCY : n;
}

// Build the two agent legs (implementer + reviewer) from the environment.
// INVARIANT (R12): the implementer and reviewer CLIs MUST be distinct — a CLI can
// never review its own implementation — so if the env assigns the same CLI to both,
// the reviewer is repaired to the other CLI. A leg's `fast` is true only when the
// env asks for it AND the resolved model supports fast on the headless run.
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
  issueIndexPath: ".vivicy/development/issue-index.json",
  progressLedgerPath: ".vivicy/development/progress-ledger.json",
  issuesDir: ".vivicy/development/issues",
  doneDir: ".vivicy/development/issues/done",
  gatesDir: ".vivicy/development/gates",
  reportsDir: ".vivicy/development/reports",
  // S8 per-issue readiness check (G5). ON by default: before an issue is implemented,
  // a readiness-checker leg (implementer CLI, prompt readiness.md) confronts it with
  // the CURRENT code tree and returns implementable / issue_update / needs_cr. Set
  // cfg.readiness = false to skip the check entirely (proceed straight to the
  // implementer) — used where no real agent legs back the check (e.g. the dry
  // rehearsal), so the default is ON precisely when real legs are configured.
  readiness: true,
  // Role prompts are Vivicy's OWN assets, bundled in factory/prompts/ — they are
  // NOT read from the target project (which only receives the dev OUTPUT: issues,
  // ledger, gates, done). Resolved factory-relative; see readPrompt.
  promptsDir: FACTORY_PROMPTS_DIR,
  // Gitignored full-transcript store (one JSONL per agent leg). Referenced from
  // the ledger so the map links node/edge -> issue -> complete transcript.
  transcriptsDir: ".vivicy/development/transcripts",
  maxRetries: 2,
  // The verification gate command is POLYGLOT and comes from the TARGET PROJECT,
  // not from a hardcoded Node default. Resolution (most specific first):
  //   issue.gate_command  ->  vivicy.json "gateCommand" at the target root  ->
  //   this explicit defaultGateCommand (only when a caller deliberately sets it,
  //   e.g. the Node rehearsal fixture or a unit test). It is `undefined` by
  //   default so a real project MUST declare its own gate in vivicy.json and the
  //   loop never silently assumes `npm test` on a Go/Rust/Python/PHP/Swift repo.
  //   See factory/project-config.mjs (resolveGateCommand) — the single owner of
  //   this resolution, used by both the sync and async gate runners.
  defaultGateCommand: undefined,
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
  // Generated viewer artifact for the TARGET project's architecture map. The
  // parallel scheduler reads node clusters + edge adjacency from here to SPREAD the
  // concurrent batch across the map (max-spread selection). Fixed repo-relative
  // path the generator owns (generate-viewer-data.ts enforces the same path); when
  // it is absent the scheduler degrades gracefully to a files-only spread.
  architectureDataPath: ".vivicy/architecture-map/architecture-data.json",
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
  quotaStatePath: ".vivicy/development/reports/quota-state.json",
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

// The FROZEN EXTRACTION CORPUS: the spec artifacts that are locked at freeze and
// MUST stay byte-identical across every parallel worktree during implementation —
// the canonical docs, the doc baselines, the requirement extraction outputs
// (catalog, traceability matrix, exclusions, source-map, coverage report), the
// issue index, and the architecture map. The implementer/reviewer prompts forbid
// editing them, but a misbehaving agent in an isolated worktree could still touch
// one; if two worktrees each edit such a shared+frozen file, their branches
// collide at integration (the real failure that motivated this guard). The loop
// therefore treats any worktree edit to these paths as out-of-scope and NEUTRALIZES
// it before merge (resetWorktreeFrozenArtifacts), so a frozen-file edit is a no-op
// at integration and can never cause spec drift OR a frozen-file merge conflict.
//
// These are repo-root-relative path PREFIXES (a trailing "/" means "the whole
// subtree"; a bare path means that exact file). They are derived from cfg so a
// project that relocates an artifact stays covered. NOT frozen here: the loop's OWN
// lifecycle files (issues/, done/, ledger, gates, reports, transcripts) — the loop
// manages those — and package.json, which a legitimate new runtime dependency may
// need (the prompt scope handles the gratuitous case; we never auto-discard it).
export function frozenIntegrationPaths(cfg) {
  return [
    ".vivicy/canonical/",
    ".vivicy/baselines/",
    ".vivicy/requirements/",
    ".vivicy/architecture-map/architecture-map.yml",
    cfg.issueIndexPath ?? DEFAULT_CONFIG.issueIndexPath,
  ];
}

// Rate-limit / quota-exhaustion signals. Neither `claude` nor `codex` exposes a
// non-interactive usage API, so the only robust signal is the failure itself:
// we scan a FAILED leg's combined stdout+stderr (case-insensitive) for these.
//
// IMPORTANT: the target project's output may legitimately mention quotas / rate
// limits / HTTP 429 (e.g. it implements rate-limiting), so a SUCCESSFUL agent leg
// can print that vocabulary in its summary ("added rate-limit middleware",
// "implemented per-account quota"). To avoid falsely throttling a green leg
// merely for describing such work, detection requires BOTH a non-zero exit AND a match,
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

// --------------------------------------------------------------------------
// Pure core (unit-tested)
// --------------------------------------------------------------------------

export function dependenciesSatisfied(issue, doneIds) {
  const deps = Array.isArray(issue.depends_on) ? issue.depends_on : [];
  return deps.every((dep) => doneIds.has(dep));
}

// The build-time evidence gate: an issue's spike gates are satisfied only when
// every spike it depends on is verified. `verifiedGates` is the set of gate ids
// whose spike status is "verified"; an issue with no spike_gates is always
// satisfied, and one that declares an unverified (or missing) spike is held back
// exactly like an unsatisfied dependency.
export function spikeGatesSatisfied(issue, verifiedGates) {
  const gates = Array.isArray(issue.spike_gates) ? issue.spike_gates : [];
  return gates.every((gate) => verifiedGates.has(gate));
}

// An issue is done if its file already lives in done/, or the ledger records
// THIS issue verified on every one of its graph refs. (Resume falls out of this
// for free.) The check is per-issue, not per-node: a shared node verified by a
// different issue must never mark this one done (the Development Traceability
// Method: one issue going green never overstates a shared node or edge).
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

export function pickNextIssue(issues, doneIds, verifiedGates = new Set(), parkedIds = new Set()) {
  for (const issue of issues) {
    if (doneIds.has(issue.id)) continue;
    // A parked issue (readiness verdict needs_cr, S8) is skipped exactly like a done
    // one until its CR is decided and re-extraction/re-drive unparks it — the loop
    // moves on to other ready issues rather than dead-ending (P4).
    if (parkedIds.has(issue.id)) continue;
    if (dependenciesSatisfied(issue, doneIds) && spikeGatesSatisfied(issue, verifiedGates)) return issue;
  }
  return null;
}

// --------------------------------------------------------------------------
// Readiness verdict routing (S8/G5, pure — unit-tested)
// --------------------------------------------------------------------------

// The traceability block is the fenced ```text``` block under the issue file's
// `## Traceability` heading — it carries issue_id / graph_refs / requirement_ids /
// source_line_refs / depends_on / spike_gates / verification_gate_ids, the issue's
// identity and its links back to the FROZEN canonical. A readiness `issue_update`
// may revise only EXECUTION prose and MUST leave this block byte-identical; the
// orchestrator enforces that by comparing this extraction before/after. Returns the
// block's inner text (between the fences), or null when no such block is present.
export function extractTraceabilityBlock(body) {
  const text = String(body ?? "");
  // Anchor on the `## Traceability` section so a stray ```text``` fence elsewhere in
  // the issue is never mistaken for it. From that heading, take the FIRST fenced block.
  const heading = /^##\s+Traceability\s*$/m.exec(text);
  if (!heading) return null;
  const after = text.slice(heading.index + heading[0].length);
  const fence = /```(?:\w+)?\n([\s\S]*?)\n```/.exec(after);
  return fence ? fence[1] : null;
}

// Is a candidate body a legal readiness `issue_update`? It is legal only when both
// the old and new bodies expose a traceability block AND the two blocks are
// byte-identical — i.e. the patch touched only execution prose, never the frozen
// traceability/identity lines (§4 rule 4: a plan edit stays on the issue prose; a
// traceability/intention change is a CR, not an issue_update). A patch that drops or
// mutates the block is refused (→ routed to needs_cr instead) so the source of
// truth can never be silently rewritten through the readiness path.
export function issueUpdatePreservesTraceability(oldBody, newBody) {
  const before = extractTraceabilityBlock(oldBody);
  const after = extractTraceabilityBlock(newBody);
  if (before === null || after === null) return false;
  return before === after;
}

// --------------------------------------------------------------------------
// Parallel scheduler (pure, unit-tested)
//
// The ready set + independence rule that decide which issues may run at once.
// Parallel work is allowed ONLY for issues that are mutually independent — no
// dependency path between them AND a disjoint claim (graph_refs / claimed files)
// — exactly the Development Traceability Method's parallel rule: a distinct claim,
// explicit graph_refs, and a dedicated worktree per concurrent issue. The same
// rule, run with maxParallel = 1, degrades to picking exactly one ready issue at
// a time (today's sequential behavior).
// --------------------------------------------------------------------------

// The READY SET: every not-done issue whose declared dependencies are all done,
// in the issue index's own order (so selection is deterministic and stable).
// `running` (a set of issue ids already executing in this wave) is excluded so a
// resumed schedule never double-claims an in-flight issue.
export function computeReadySet(issues, doneIds, running = new Set(), verifiedGates = new Set(), parkedIds = new Set()) {
  return issues.filter(
    (issue) =>
      !doneIds.has(issue.id) &&
      !running.has(issue.id) &&
      // Parked-on-CR issues (S8) are held out of the ready set just like done ones,
      // until a CR decision unparks them (see readParkedIssueIds).
      !parkedIds.has(issue.id) &&
      dependenciesSatisfied(issue, doneIds) &&
      spikeGatesSatisfied(issue, verifiedGates),
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

// --------------------------------------------------------------------------
// Max-spread batch selection (farthest-point sampling on the architecture graph)
//
// Index-order batching tends to grab CONSECUTIVE issues, which the extraction
// places in the SAME map region — so even with disjoint graph_refs their worktrees
// merge with conflicts. We instead spread the N concurrent issues across subsystems.
//
// HARD GATE (unchanged, never weakened): a candidate joins the batch ONLY if it is
// pairwise-independent (no transitive dependency path AND disjoint claims) from
// every batch member and every running issue — issuesIndependent() is the sole
// authority. Spread is a SECONDARY preference applied strictly on top of that gate.
//
// FOOTPRINT(issue) is four token sets (claimed files, source files, clusters, graph
// neighborhood) built from the architecture index; it degrades to files/source/
// graph_refs when architecture-data.json is missing, so there is always something
// to separate on. DISTANCE is an ordered risk score, larger = safer to run together:
//   0  share a claimed file   (worst: same file -> guaranteed clash)
//   1  share a source file
//   2  share a cluster        (same subsystem region)
//   3  edge-adjacent          (touch across one graph edge)
//   4  far                    (no overlap on any axis)
// Greedy farthest-point sampling, ties broken by issue index (determinism). With no
// architecture data every pair scores 4 and the tie-break collapses to index order
// — the old sequential behavior, which is why the claims-only tests still hold.
// --------------------------------------------------------------------------

// Strip the ":<line>" / ":<a-b>" suffix from a source_line_ref, leaving the file.
//   ".vivicy/canonical/02.md:7-13" -> ".vivicy/canonical/02.md"
function sourceRefFile(ref) {
  if (typeof ref !== "string") return null;
  const colon = ref.lastIndexOf(":");
  return colon > 0 ? ref.slice(0, colon) : ref;
}

// Is a graph_ref a node ref ("node:<id>") rather than an edge ref? We separate the
// node id ("node:ledger" -> "ledger") to look it up in the architecture index.
function nodeIdOfGraphRef(ref) {
  if (typeof ref === "string" && ref.startsWith("node:")) return ref.slice("node:".length);
  return null;
}

// Build a lightweight, read-only ARCHITECTURE INDEX from a parsed
// architecture-data.json: node id -> its cluster, and node id -> the set of
// edge-adjacent node ids. Pure and defensive — any missing/odd shape yields empty
// maps so footprint() degrades gracefully instead of throwing.
export function buildArchitectureIndex(architecture) {
  const clusterByNode = new Map();
  const adjacencyByNode = new Map();
  if (!architecture || typeof architecture !== "object") {
    return { clusterByNode, adjacencyByNode };
  }
  const nodes = Array.isArray(architecture.nodes) ? architecture.nodes : [];
  for (const node of nodes) {
    if (!node || typeof node.id !== "string") continue;
    if (typeof node.layout_cluster === "string" && node.layout_cluster.length > 0) {
      clusterByNode.set(node.id, node.layout_cluster);
    }
    if (!adjacencyByNode.has(node.id)) adjacencyByNode.set(node.id, new Set());
  }
  const edges = Array.isArray(architecture.edges) ? architecture.edges : [];
  for (const edge of edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!adjacencyByNode.has(edge.from)) adjacencyByNode.set(edge.from, new Set());
    if (!adjacencyByNode.has(edge.to)) adjacencyByNode.set(edge.to, new Set());
    adjacencyByNode.get(edge.from).add(edge.to);
    adjacencyByNode.get(edge.to).add(edge.from);
  }
  return { clusterByNode, adjacencyByNode };
}

// An empty index (no cluster / adjacency data) — the graceful-degradation default
// when no architecture-data.json is available.
const EMPTY_ARCHITECTURE_INDEX = { clusterByNode: new Map(), adjacencyByNode: new Map() };

// The architecture footprint of an issue, as four disjoint token sets so the
// distance ladder can tell WHICH axis two issues overlap on. See the block comment
// for the definition. `archIndex` is the buildArchitectureIndex() result (or the
// empty index for the no-data fallback).
export function issueFootprint(issue, archIndex = EMPTY_ARCHITECTURE_INDEX) {
  const { clusterByNode, adjacencyByNode } = archIndex ?? EMPTY_ARCHITECTURE_INDEX;
  const files = new Set();
  const sources = new Set();
  const clusters = new Set();
  const nodes = new Set();

  // Claimed files: the SAME set the hard gate uses (explicit claims else graph_refs).
  for (const claim of issueClaim(issue)) files.add(`file:${claim}`);

  // Source files behind the issue (docs/code the slice derives from).
  const sourceRefs = Array.isArray(issue.source_line_refs) ? issue.source_line_refs : [];
  for (const ref of sourceRefs) {
    const file = sourceRefFile(ref);
    if (file) sources.add(`src:${file}`);
  }

  // Clusters + graph neighborhood, from the issue's graph_ref NODES.
  const refs = Array.isArray(issue.graph_refs) ? issue.graph_refs : [];
  for (const ref of refs) {
    const id = nodeIdOfGraphRef(ref);
    if (!id) continue;
    nodes.add(`node:${id}`);
    const cluster = clusterByNode.get(id);
    if (cluster) clusters.add(`cluster:${cluster}`);
    const neighbors = adjacencyByNode.get(id);
    if (neighbors) for (const n of neighbors) nodes.add(`node:${n}`);
  }

  return { files, sources, clusters, nodes };
}

// Do two token sets share any member?
function tokenSetsIntersect(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) return true;
  return false;
}

// The ordered conflict-risk distance between two footprints (see the ladder in the
// block comment). Lower = closer = higher merge-conflict risk; CONFLICT_DISTANCE_FAR
// = no overlap on any axis. Symmetric. The most specific (worst) overlap wins, so
// two issues that share a file score 0 even if they also share a cluster.
export const CONFLICT_DISTANCE_FAR = 4;
export function footprintDistance(a, b) {
  if (tokenSetsIntersect(a.files, b.files)) return 0; // same claimed file
  if (tokenSetsIntersect(a.sources, b.sources)) return 1; // same source file
  if (tokenSetsIntersect(a.clusters, b.clusters)) return 2; // same cluster/subsystem
  if (tokenSetsIntersect(a.nodes, b.nodes)) return 3; // edge-adjacent in the graph
  return CONFLICT_DISTANCE_FAR; // far apart
}

// Select up to `limit` issues to run CONCURRENTLY from `ready`, maximally spread on
// the architecture graph (see the block comment above). `archIndex` is optional —
// omit it for the graceful-degradation path. Deterministic: same inputs -> same batch.
export function selectIndependentBatch(
  ready,
  runningIssues,
  limit,
  depsClosureById,
  archIndex = EMPTY_ARCHITECTURE_INDEX,
) {
  const batch = [];
  const slots = Math.max(1, limit) - runningIssues.length;
  if (slots <= 0) return batch;

  // Precompute each ready issue's footprint once (index-stable order preserved).
  const footprintById = new Map();
  for (const issue of ready) footprintById.set(issue.id, issueFootprint(issue, archIndex));

  // A candidate is eligible iff it clears the hard gate against everything running
  // and everything already chosen — this is the invariant the spread heuristic is
  // NOT allowed to bend.
  const eligible = (candidate) =>
    runningIssues.every((r) => issuesIndependent(candidate, r, depsClosureById)) &&
    batch.every((b) => issuesIndependent(candidate, b, depsClosureById));

  // Seed: the first ready issue (lowest index) that clears the gate vs running.
  // With limit = 1 this is the only pick, so the sequential behavior is unchanged.
  const seed = ready.find((candidate) => eligible(candidate));
  if (!seed) return batch;
  batch.push(seed);

  // Farthest-point sampling: each round, add the eligible candidate whose MINIMUM
  // distance to the current batch is the largest (most separated). Index order is
  // the deterministic tie-break — we only REPLACE the best on a strictly larger
  // min-distance, so among equals the lowest-index candidate (encountered first)
  // wins.
  while (batch.length < slots) {
    let best = null;
    let bestMinDist = -1;
    for (const candidate of ready) {
      if (batch.includes(candidate) || !eligible(candidate)) continue;
      const cf = footprintById.get(candidate.id);
      let minDist = Infinity;
      for (const chosen of batch) {
        const d = footprintDistance(cf, footprintById.get(chosen.id));
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = candidate;
      }
    }
    if (!best) break; // no eligible candidate left
    batch.push(best);
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
//     summary (e.g. a project that implements rate-limiting) is left alone. Pass a
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
// Real quota-window extraction (pure, unit-tested). The two providers expose
// different verified surfaces, extracted honestly — a null used_pct is the honest
// "no real number" signal (footer shows "—"); we never fabricate a percentage.
//
//   Codex  — `token_count` event in the session ROLLOUT JSONL carries real
//            rate_limits.primary (window_minutes 300 -> "5h") / .secondary
//            (10080 -> "weekly"). Not on `codex exec` stdout, only the rollout.
//   Claude — REAL percentages only via the status-line stdin contract
//            (https://code.claude.com/docs/en/statusline): rate_limits.five_hour /
//            .seven_day with used_percentage + resets_at. Interactive-only, so the
//            loop captures it with a side probe (captureClaudeStatusLine). The
//            `rate_limit_event` on `claude -p` stream-json gives the 5h RESET but
//            no percentage — an honest fallback when no status-line capture exists.
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

// The set of spike gate ids whose spike is verified, read from the MAIN root (the
// shared corpus — never a worktree). Recomputed each scheduling turn so a spike
// marked verified mid-run unblocks the issues that depend on it.
function verifiedSpikeGates() {
  // Chain-aware: a gate counts as satisfied only when the spike AND its whole transitive
  // gated_by chain are verified (E2), so a mid-run status edit can't bypass the chain.
  return transitivelyVerifiedGates(requireRepoRoot());
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

// Load the TARGET project's architecture index (node clusters + edge adjacency)
// for the max-spread scheduler. Resolved against the same MAIN root as every other
// shared artifact. Best-effort: a missing or malformed architecture-data.json
// yields the EMPTY index so selection degrades gracefully to a files-only spread —
// the scheduler must never fail because the optional map is absent.
function readArchitectureIndex(cfg) {
  try {
    if (!cfg.architectureDataPath || !existsSync(abs(cfg.architectureDataPath))) {
      return EMPTY_ARCHITECTURE_INDEX;
    }
    return buildArchitectureIndex(readJson(cfg.architectureDataPath));
  } catch {
    return EMPTY_ARCHITECTURE_INDEX;
  }
}

function listDoneFiles(cfg) {
  const doneAbs = abs(cfg.doneDir);
  if (!existsSync(doneAbs)) return new Set();
  return new Set(readdirSync(doneAbs).filter((name) => name.endsWith(".md")));
}

// The set of currently-parked issue ids (S8: readiness returned needs_cr, so the
// issue is held out of scheduling until its CR is decided). A parked issue writes a
// `<id>-parked.json` report stamping the issue file's identity (mtime + content hash)
// at park time. A park is CLEARED — the issue naturally unparks — as soon as the
// issue file CHANGES: a CR-driven re-extraction / re-drive rewrites the issue, so its
// current mtime+hash no longer match the stamped ones, and we drop the stale report.
// This is the same "the file moved on, so the block is gone" mechanism re-drive uses
// for done issues. Resolved against the MAIN root (shared orchestration state).
function readParkedIssueIds(cfg) {
  const reportsAbs = abs(cfg.reportsDir);
  if (!existsSync(reportsAbs)) return new Set();
  const parked = new Set();
  for (const name of readdirSync(reportsAbs)) {
    if (!name.endsWith("-parked.json")) continue;
    let report;
    try {
      report = JSON.parse(readFileSync(resolve(reportsAbs, name), "utf8"));
    } catch {
      continue; // an unreadable report is not authoritative; ignore it
    }
    if (!report || typeof report.issue_id !== "string") continue;
    const identity = issueFileIdentity(cfg, report);
    // No issue file on disk (e.g. it was moved to done/ or removed): the park no
    // longer applies. A matching identity keeps the park; a changed one clears it.
    if (identity && report.issue_hash === identity.hash) {
      parked.add(report.issue_id);
    } else {
      try {
        unlinkSync(resolve(reportsAbs, name));
      } catch {
        // best-effort unpark; a leftover stale report is re-checked next turn
      }
    }
  }
  return parked;
}

// The current identity (mtime-ms + content hash) of a parked issue's file, resolved
// from its recorded path, or null when the file is absent. The hash is the source of
// truth for "did the issue change"; mtime is recorded alongside for human inspection.
function issueFileIdentity(cfg, report) {
  const rel = report.issue_path ?? `${cfg.issuesDir}/${report.issue_id}.md`;
  let abspath;
  try {
    abspath = abs(rel);
  } catch {
    return null;
  }
  if (!existsSync(abspath)) return null;
  try {
    const content = readFileSync(abspath, "utf8");
    return { hash: sha256(content), mtimeMs: statSync(abspath).mtimeMs, path: rel };
  } catch {
    return null;
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}


// --------------------------------------------------------------------------
// Real steps (default implementations; overridable for tests)
// --------------------------------------------------------------------------

// The agent-leg spawn + transcript-capture primitives are shared with the
// extractor (extract-issues.mjs) so the model/effort flags, max-permission flags,
// actor/role env, and transcript capture are defined ONCE in
// agent-spawn.mjs and never diverge between the two drivers. dev-loop.mjs binds
// them to its own root resolution (abs/execRootOf) via the `deps` it passes.

// Spawn ONE leg with the Claude Code CLI, for whichever role it was assigned
// (R12). Claude headless writes the full native session transcript keyed by
// --session-id; we copy it into our gitignored store. The transcript is named
// `claude-<role>-…` so the file reflects the actual CLI + role pairing.
function runClaudeLeg(leg, issue, cfg) {
  return sharedRunClaudeLeg(leg, issue, cfg, legDeps(cfg, issue));
}

// Spawn ONE leg with the Codex CLI, for whichever role it was assigned (R12).
// Codex writes a full JSONL rollout per session under ~/.codex/sessions/<date>/;
// we copy the leg's rollout into our store. This is more robust than
// `codex exec --json` (which can hang) and lands the transcript at the path/format
// we want instead of the date-partitioned default.
function runCodexLeg(leg, issue, cfg) {
  return sharedRunCodexLeg(leg, issue, cfg, legDeps(cfg, issue));
}

// Bind the shared spawn helpers to dev-loop's own root resolution: `abs` and the
// execution root (the issue's worktree for a parallel issue, the main root in the
// sequential path), the transcript dir under that issue, and — for codex under
// concurrency — the cwd filter so a sibling leg's rollout is never mis-captured.
function legDeps(cfg, issue) {
  const root = execRootOf(cfg);
  return {
    composePrompt,
    agentCliArgs,
    abs,
    execRoot: root,
    transcriptDirAbs: issue ? abs(`${cfg.transcriptsDir}/${issue.id}`) : undefined,
    cwdFilter: cfg.execRoot ? root : null,
  };
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
// stays fixed (it picks the prompt + actor/role identity) while which CLI runs it
// is the configurable knob.
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

function runClaudeLegAsync(leg, issue, cfg) {
  return sharedRunClaudeLegAsync(leg, issue, cfg, legDeps(cfg, issue));
}

function runCodexLegAsync(leg, issue, cfg) {
  return sharedRunCodexLegAsync(leg, issue, cfg, legDeps(cfg, issue));
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

// The readiness-checker leg (S8/G5) and the merge-resolver leg (S10/G6) both run on
// the IMPLEMENTER CLI, under their own role identity so the transcript + ledger show
// which stage acted. Judgment call (documented, R12): these verdicts feed the
// implementer's own downstream work and the orchestrator treats them as ADVISORY
// routing — every outcome is re-gated deterministically (readiness → re-gated by the
// normal implement→review→gate cycle; merge-resolver → re-gated by the orchestrator's
// own worktree gate run + the post-merge re-gate) — so an independent second-CLI
// cross-check is not required here and the R12 implement≠review invariant is untouched.
// A dedicated leg object reuses the implementer's model/effort but carries the leg's
// own role; the orchestrator reads the verdict FILE these legs write, never stdout.
function readinessLeg(cfg) {
  return { ...cfg.implementer, role: "readiness-checker" };
}
function mergeResolverLeg(cfg) {
  return { ...cfg.implementer, role: "merge-resolver" };
}

export function defaultRunReadiness(issue, cfg) {
  return runAssignedLeg(readinessLeg(cfg), issue, cfg);
}
export function defaultRunReadinessAsync(issue, cfg) {
  return runAssignedLegAsync(readinessLeg(cfg), issue, cfg);
}
export function defaultRunMergeResolver(issue, cfg) {
  return runAssignedLeg(mergeResolverLeg(cfg), issue, cfg);
}
export function defaultRunMergeResolverAsync(issue, cfg) {
  return runAssignedLegAsync(mergeResolverLeg(cfg), issue, cfg);
}

// The orchestrator runs the gate ITSELF — the authoritative verdict — and writes
// a gate-run record evidence file the ledger requires for gate_passed.
export function defaultRunGate(issue, cfg) {
  const execRoot = execRootOf(cfg);
  // POLYGLOT gate: the authoritative command is resolved per issue from
  // issue.gate_command -> the target's vivicy.json -> cfg.defaultGateCommand,
  // with NO hidden Node assumption (project-config.mjs owns the resolution).
  const gateCommand = resolveGateCommand({
    issue,
    targetRoot: execRoot,
    explicitDefault: cfg.defaultGateCommand,
  });
  // The gate runs against the issue's CODE — its execution root (the worktree for
  // a parallel issue). The evidence RECORD is shared orchestration state and is
  // written to the MAIN root (abs()), where the ledger's gate_passed validation
  // reads it back; the two roots are deliberately split here.
  const result = spawnSync(gateCommand, { cwd: execRoot, encoding: "utf8", shell: true });
  return writeGateEvidence(issue, cfg, gateCommand, result.status ?? 1);
}

// Async sibling of defaultRunGate for the parallel path: spawn the gate
// NON-BLOCKING (spawn, not spawnSync) so a slow gate never freezes the event loop
// and stalls the other parallel issues (or ages out the integration lock while a
// sibling holds it). Identical evidence record; only the spawn primitive differs.
//
// The gate is a SHELL command (the project's resolved gate command), not an agent
// CLI, so it spawns directly with shell:true — it does NOT go through the
// agent-leg timeout supervisor (which exists to kill a wedged `codex`/`claude`,
// and does not run a shell). A pathological gate is still bounded by the
// surrounding loop's retries.
export async function defaultRunGateAsync(issue, cfg) {
  const execRoot = execRootOf(cfg);
  // Same polyglot resolution as the sync gate (project-config.mjs is the one owner).
  const gateCommand = resolveGateCommand({
    issue,
    targetRoot: execRoot,
    explicitDefault: cfg.defaultGateCommand,
  });
  const result = await spawnShellAsync(gateCommand, { cwd: execRoot });
  return writeGateEvidence(issue, cfg, gateCommand, result.status ?? 1);
}

// Run a shell command NON-BLOCKING, teeing its output, resolving to a
// spawnSync-shaped result. Used for the parallel gate (a shell string), kept
// separate from the agent-leg spawn so the gate keeps shell:true and is never
// subject to the agent-leg timeout policy.
function spawnShellAsync(command, options = {}) {
  return new Promise((resolveGate) => {
    let child;
    try {
      child = spawn(command, [], { ...options, shell: true, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      resolveGate({ status: null, stdout: "", stderr: String(error?.message ?? error), error });
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
      resolveGate({ status: null, stdout, stderr: `${stderr}${error?.message ?? error}`, error });
    });
    child.on("close", (code) => {
      resolveGate({ status: code, stdout, stderr });
    });
  });
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
    finished_at: nowIso(cfg),
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
  //
  // `git add -A` is SAFE because the scaffold/dev-loop .gitignore covers the
  // complete never-commit set (transcripts, runtime, worktrees, node_modules). So
  // the checkpoint mechanically lands EVERY Vivicy-produced file that is not
  // gitignored — the ledger, gate evidence, reports, and the static
  // architecture-map data (generated once at extraction, never per-issue) — while
  // transcripts stay out of history (gitignored). No Vivicy output is ever left
  // untracked-and-unignored.
  const root = execRootOf(cfg);
  spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  const message = `${issue.id}: ${issue.title ?? "implement vertical slice"}\n\nGate green; reviewed by ${cfg.reviewer.actor}.`;
  return spawnSync("git", ["commit", "-m", message], { cwd: root, encoding: "utf8" });
}

// The architecture-map viewer data (architecture-data.json) is a STATIC graph,
// generated ONCE at extraction (extract-issues.mjs) and committed there. The
// dev-loop NEVER regenerates it: the only part that changes during development is
// per-issue/per-graph-item progress, which lives in the progress ledger
// (.vivicy/development/progress-ledger.json) — the single source of truth for live
// progress. The /api/map read path overlays the live ledger onto the static graph
// at request time (lib/map-data.ts applyLiveOverlay), so loading the target always
// shows current progress with zero regeneration and zero file churn. The loop
// writes ONLY the ledger (mechanically, via the progress emitters) and commits it
// per green checkpoint; no agent ever touches the map.

// --------------------------------------------------------------------------
// Pre-development integrity gates (Item 6: enforced, never decorative)
//
// Before the loop develops a single issue it MECHANICALLY verifies the frozen
// extraction corpus is intact — extraction validated these at author time, but the
// loop must re-prove them so it NEVER develops against a tampered baseline or a
// failing traceability matrix. Each guard runs at run start in BOTH the sequential
// and parallel paths and THROWS on failure, so the loop refuses to proceed (the
// per-issue gate stays the authoritative completion verdict on top of these).
// --------------------------------------------------------------------------

// The active frozen baseline manifest under .vivicy/baselines/, or null. A manifest is
// frozen-and-active when status === "frozen" and it carries no `superseded` marker.
// Inlined here (not imported from extract-issues.mjs) to avoid an import cycle.
export function findFrozenManifestRel(cfg) {
  const dirRel = ".vivicy/baselines";
  const dirAbs = abs(dirRel);
  if (!existsSync(dirAbs)) return null;
  for (const entry of readdirSync(dirAbs)) {
    if (!entry.endsWith(".json")) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(dirAbs, entry), "utf8"));
    } catch {
      continue;
    }
    if (
      manifest &&
      manifest.status === "frozen" &&
      !manifest.superseded &&
      typeof manifest.baseline_id === "string" &&
      manifest.baseline_id.length > 0
    ) {
      return { manifestRel: `${dirRel}/${entry}`, baselineId: manifest.baseline_id };
    }
  }
  return null;
}

// Verify the frozen baseline is INTACT (hashes match the on-disk corpus) by
// shelling out to the doc-baseline verifier — the one owner of that check — exactly
// as it runs in production. Throws when no frozen baseline exists or it fails
// verification (a tampered corpus). Returns the verified baseline id.
export function defaultVerifyBaseline(cfg) {
  const found = findFrozenManifestRel(cfg);
  if (!found) {
    throw new Error(
      "dev-loop refuses to develop: no frozen baseline manifest found under .vivicy/baselines/. Run extraction to freeze the canonical spec first.",
    );
  }
  const tool = resolve(FACTORY_DIR, "doc-baseline.mjs");
  const root = requireRepoRoot();
  const result = spawnSync(
    "node",
    [tool, "verify", "--manifest", found.manifestRel, "--require-status", "frozen", "--require-baseline-id", found.baselineId],
    { cwd: root, env: { ...process.env, VIVICY_TARGET_ROOT: root }, encoding: "utf8" },
  );
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      `dev-loop refuses to develop on a tampered/invalid frozen baseline (${found.baselineId}):\n${`${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()}`,
    );
  }
  return found.baselineId;
}

// Verify the traceability matrix passes (every MVP must_implement requirement is
// covered, refs resolve, the DAG is acyclic). Throws on failure so the loop never
// develops against a broken traceability corpus.
export function defaultVerifyTraceability(cfg) {
  const root = requireRepoRoot();
  const result = runTraceabilityCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop on a failing traceability check:\n${detail}`);
  }
  return true;
}

// The spikes must be well-formed (the evidence-gate corpus is valid) before the
// loop develops against them. Verification status itself is the per-issue
// readiness gate, not this corpus-level check.
export function defaultVerifySpike(cfg) {
  const root = requireRepoRoot();
  const result = runSpikeCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop with malformed spikes:\n${detail}`);
  }
  return true;
}

// The target's doc-to-doc links must resolve: a broken canonical cross-link
// silently misleads the agents, which read AGENTS.md / README.md first.
export function defaultVerifyReference(cfg) {
  const root = requireRepoRoot();
  const result = runReferenceCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop on broken doc references:\n${detail}`);
  }
  return true;
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

// Integration guard (defense-in-depth): before merging a green worktree branch,
// DISCARD any edits it made to the FROZEN extraction corpus so a misbehaving agent
// can never cause spec drift OR a frozen-file merge conflict. We restore each
// frozen path to its version at the integration head (the merge target = the main
// repo's current HEAD, which the worktree branched from) inside the WORKTREE, then
// commit that restore on the worktree branch. After this, the worktree branch and
// the integration head agree byte-for-byte on every frozen path, so the subsequent
// merge has nothing to conflict on there — the agent's frozen edit is a clean no-op
// — while its legitimate src/test changes still merge normally. `--` is a no-op for
// paths the branch never touched. Run with the main root's HEAD as the base ref;
// callers hold the integration lock so the base does not move underneath us.
// Returns true if any frozen path was reset (a commit was made), false otherwise.
// Exported for direct unit testing of the neutralization in isolation.
export function defaultResetWorktreeFrozenArtifacts(issue, cfg, worktreeRoot) {
  const root = requireRepoRoot();
  // The merge target: the integration branch the loop commits onto, by name when
  // available (still mergeable as a detached sha otherwise). Its tree is the
  // authoritative version of every frozen path.
  const base = currentBranch(root);
  // Restore each frozen path from the integration head into the worktree's working
  // tree + index. We MUST checkout per-path, not as one batch: `git checkout <base>
  // -- <a> <b>` ABORTS the WHOLE command (restoring nothing) if ANY pathspec is
  // absent in <base>, and the frozen set is deliberately broad (a given project may
  // not have every artifact, e.g. no .vivicy/baselines/). Per-path, a path missing
  // from <base> is an isolated, benign no-op and never blocks neutralizing a path
  // that IS present. `git checkout <base> -- <path>` only reads that path, so it
  // never switches the worktree branch and is safe under the integration lock.
  const paths = frozenIntegrationPaths(cfg);
  for (const path of paths) {
    spawnSync("git", ["checkout", base, "--", path], { cwd: worktreeRoot, encoding: "utf8" });
  }
  // Whatever the per-path checkouts staged is the set of frozen edits we neutralized
  // (a path the branch never diverged on stages nothing).
  const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: worktreeRoot,
    encoding: "utf8",
  });
  const changed = (staged.stdout ?? "").trim();
  if (changed.length === 0) {
    // The branch left every frozen path untouched (the common, well-behaved case):
    // nothing to neutralize, nothing to commit. The empty staged diff is the source
    // of truth; a per-path checkout's nonzero status for an absent path is benign.
    return false;
  }
  // Commit the reset on the worktree branch so the merge sees frozen paths as
  // identical to the integration head. Scope the commit to the frozen paths only
  // (already staged by the checkout) so unrelated legitimate work is never folded in.
  spawnSync(
    "git",
    ["commit", "-m", `${issue.id}: drop out-of-scope frozen-artifact edits before integration`],
    { cwd: worktreeRoot, encoding: "utf8" },
  );
  process.stderr.write(
    `[parallel] ${issue.id}: discarded out-of-scope frozen-artifact edits before integration:\n  ${changed.split("\n").join("\n  ")}\n`,
  );
  return true;
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

// The integration branch's current HEAD sha, captured on the MAIN root under the
// integration lock so it is a stable pre-merge marker. Post-merge re-gate uses it to
// hard-reset the ONE merge commit if the merge damaged the integration tree (G6).
export function defaultCaptureHead(cfg) {
  const root = requireRepoRoot();
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

// Hard-reset the integration branch back to `sha` on the MAIN root. Called under the
// integration lock, where the just-created merge commit is the ONLY new commit since
// the captured pre-merge HEAD, so `reset --hard <preMergeSha>` cleanly REVERTS exactly
// that merge (safer than `git revert` on a merge commit) and leaves the branch green.
export function defaultResetHard(cfg, sha) {
  const root = requireRepoRoot();
  return spawnSync("git", ["reset", "--hard", sha], { cwd: root, encoding: "utf8" });
}

// Rebase this issue's worktree branch onto the current integration HEAD (the merge
// target). Run in the WORKTREE before the merge-resolver leg resolves conflicts, so
// the leg works against integration's latest code. Returns { ok, message }; a failed
// rebase (conflicts) is left in-progress for the leg to resolve, then re-checked.
export function defaultRebaseWorktree(issue, cfg, worktreeRoot) {
  const base = currentBranch(requireRepoRoot());
  const r = spawnSync("git", ["rebase", base], { cwd: worktreeRoot, encoding: "utf8" });
  return { ok: (r.status ?? 1) === 0, message: (r.stderr || r.stdout || "").trim() };
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
// parallel issue's worktree has been merged. Staged to the orchestration paths
// (issues/, done/, issue-index) and the shared evidence the orchestrator owns
// (the live ledger — the single source of truth for progress — plus gates and
// reports), which live on the main root and are not carried by the worktree merge.
// The architecture map is NOT staged here: it is a static graph committed once at
// extraction and never regenerated during development; the app overlays the live
// ledger at read time, so the just-recorded ledger update is all the live progress
// the viewer needs. Other unrelated tracked files are never folded in. A no-op
// `git commit` (nothing staged) is tolerated.
function commitDoneMove(issue, cfg) {
  const root = requireRepoRoot();
  const paths = [
    cfg.issuesDir,
    cfg.doneDir,
    cfg.issueIndexPath,
    cfg.progressLedgerPath,
    cfg.gatesDir,
    cfg.reportsDir,
  ].filter(Boolean);
  spawnSync("git", ["add", "--", ...paths], { cwd: root, encoding: "utf8" });
  return spawnSync("git", ["commit", "-m", `${issue.id}: move to done/ (integrated; live progress in ledger)`], { cwd: root, encoding: "utf8" });
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
// The completion sequence (merge worktree -> main, move issue to done/, commit)
// touches the same git index + done/ + issue-index, so only one issue may integrate
// at a time. Two layers: an IN-PROCESS async mutex is the authoritative serializer
// (the parallel loop is one Node process; unlike a wall-clock lock it never falsely
// reclaims from a live holder), and an O_EXCL FILE lock — held entirely inside the
// mutex — guards against a separate process touching the same repo.
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
const defaultSleep = sleepSync;

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
// Readiness check (S8/G5): confront an issue with the CURRENT code before it is
// implemented, and route on the verdict. Shared by the sequential path (inline,
// per issue) and the parallel path (per batch member, before any worktree spawns).
// The orchestrator reads the verdict FILE the leg writes — never its stdout — and
// re-gates every downstream outcome deterministically, so the verdict is advisory
// routing, not an authority.
// --------------------------------------------------------------------------

const READINESS_VERDICTS = new Set(["implementable", "issue_update", "needs_cr"]);

// Read + validate the readiness verdict JSON the leg wrote. Returns the parsed
// verdict object, or null when the file is missing / unparseable / malformed — the
// honest "no verdict" signal the caller treats as a transient failure (retry once,
// then park). Never trusts stdout: the file is the sole contract.
function readReadinessVerdict(issue, cfg) {
  const rel = `${cfg.reportsDir}/${issue.id}-readiness.json`;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs(rel), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !READINESS_VERDICTS.has(parsed.verdict)) return null;
  return parsed;
}

// Apply a readiness `issue_update` to the issue FILE only, after proving the patch
// left the traceability block byte-identical (execution-prose edits only, §4 rule 4).
// Returns true when the bounded update was applied; false when the patch is absent or
// would touch the traceability/identity block (the caller then routes to needs_cr and
// discards the patch — the source of truth is never rewritten through this path).
function applyReadinessUpdate(issue, cfg, verdict) {
  const patch = verdict?.updates?.body_patch;
  if (typeof patch !== "string" || patch.length === 0) return false;
  const rel = issue.path ?? issue.issue_path ?? `${cfg.issuesDir}/${issue.id}.md`;
  let current;
  try {
    current = readFileSync(abs(rel), "utf8");
  } catch {
    return false; // no issue file to update -> cannot apply; caller parks
  }
  if (!issueUpdatePreservesTraceability(current, patch)) return false;
  writeFileSync(abs(rel), patch.endsWith("\n") ? patch : `${patch}\n`);
  return true;
}

// Park an issue on a CR (readiness needs_cr, or an exhausted transient failure):
// write the `<id>-parked.json` report stamping the issue file's identity so a later
// CR-driven re-extraction naturally unparks it (readParkedIssueIds), and emit
// issue_parked_on_cr. Returns the parked cycle result. Written to the MAIN root.
function parkIssueOnCr(issue, cfg, reason) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-parked.json`;
  const issueRel = issue.path ?? issue.issue_path ?? `${cfg.issuesDir}/${issue.id}.md`;
  const identity = issueFileIdentity(cfg, { issue_id: issue.id, issue_path: issueRel });
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      {
        issue_id: issue.id,
        reason,
        issue_path: issueRel,
        // The identity stamp: the park clears the instant the issue file changes
        // (a CR re-extraction rewrites it), so the issue unparks without manual state.
        issue_hash: identity?.hash ?? null,
        issue_mtime_ms: identity?.mtimeMs ?? null,
        at: nowIso(cfg),
      },
      null,
      2,
    )}\n`,
  );
  // Emit against the issue's graph refs so the map lights the parked node. Best-effort:
  // a ledger emit failure must not crash the loop and strand the other ready issues.
  try {
    emit(cfg, {
      event_type: "issue_parked_on_cr",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: "readiness-checker",
      evidence_refs: [rel],
    });
  } catch (error) {
    process.stderr.write(`[readiness] failed to emit issue_parked_on_cr for ${issue.id}: ${error?.message ?? error}\n`);
  }
  return { status: "parked", reason, parkedRel: rel };
}

// Emit readiness_check_started for an issue (S8). Kept tiny so the sync + async
// runners stay symmetric without duplicating the event shape.
function emitReadinessStarted(issue, cfg) {
  emit(cfg, {
    event_type: "readiness_check_started",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: "readiness-checker",
  });
}

// Route on a readiness verdict (or a null "no usable verdict" after the transient
// retries) and perform the consequent side-effects. Pure of the leg spawn — the sync
// and async runners both funnel here — so the routing logic lives in ONE place.
// Returns { status: "implementable" } to proceed, or { status: "parked", reason }.
function routeReadinessVerdict(issue, cfg, verdict) {
  emit(cfg, {
    event_type: "readiness_check_completed",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: "readiness-checker",
  });
  // Transient honesty (P3): a missing/unparseable verdict OR a dead leg is NOT
  // silently treated as needs_cr — it is a transient failure. The caller already
  // retried once; a still-null verdict parks with reason "readiness_leg_failed"
  // (never proceed to implement on an unknown verdict).
  if (!verdict) return parkIssueOnCr(issue, cfg, "readiness_leg_failed");
  if (verdict.verdict === "needs_cr") {
    return parkIssueOnCr(issue, cfg, verdict.reason || "readiness verdict needs_cr");
  }
  if (verdict.verdict === "issue_update") {
    // Bounded plan edit: apply only if it left the traceability block untouched;
    // otherwise it is really an intention/traceability change -> route to needs_cr
    // and DISCARD the patch (never rewrite the source of truth through readiness).
    if (applyReadinessUpdate(issue, cfg, verdict)) {
      emit(cfg, {
        event_type: "readiness_update_applied",
        issue_id: issue.id,
        graph_refs: issue.graph_refs,
        actor: cfg.implementer.actor,
        role: "readiness-checker",
      });
      return { status: "implementable" };
    }
    return parkIssueOnCr(
      issue,
      cfg,
      "readiness issue_update touched the traceability block (intention/traceability change) — routed to needs_cr",
    );
  }
  return { status: "implementable" };
}

// Sequential readiness (S8): run the readiness leg synchronously (like every other
// sequential leg), obtaining the verdict from the FILE it writes, then route. The leg
// is re-run ONCE on a missing/unparseable verdict (a transient failure), never on a
// quotaBlocked leg. Returns { status: "implementable" | "parked", reason? }.
function runReadinessSync(issue, cfg, runReadinessStep) {
  emitReadinessStarted(issue, cfg);
  let verdict = null;
  for (let attempt = 1; attempt <= 2 && !verdict; attempt += 1) {
    const legResult = runLegWithQuota(runReadinessStep, readinessLeg(cfg), issue, cfg);
    if (!legResult.quotaBlocked) verdict = readReadinessVerdict(issue, cfg);
  }
  return routeReadinessVerdict(issue, cfg, verdict);
}

// Parallel readiness (S8): identical routing, async leg spawn. Used per batch member
// BEFORE any worktree is created, so a member that fails readiness is excluded this
// round (parked or updated) and never gets a worktree.
async function runReadinessAsync(issue, cfg, runReadinessStep) {
  emitReadinessStarted(issue, cfg);
  let verdict = null;
  for (let attempt = 1; attempt <= 2 && !verdict; attempt += 1) {
    const legResult = await runLegWithQuotaAsync(runReadinessStep, readinessLeg(cfg), issue, cfg);
    if (!legResult.quotaBlocked) verdict = readReadinessVerdict(issue, cfg);
  }
  return routeReadinessVerdict(issue, cfg, verdict);
}

// Resolve the injectable readiness leg step, or null when readiness is disabled
// (cfg.readiness === false: no real agent legs back the check, e.g. the dry
// rehearsal — the loop then proceeds straight to the implementer, as before G5).
// The default binds the real readiness leg on the sync or async runner; a test
// supplies steps.runReadiness (a fake leg that writes the verdict file).
function resolveReadinessRunner(cfg, steps, { async: wantAsync }) {
  if (cfg.readiness === false) return null;
  if (steps.runReadiness) return steps.runReadiness;
  return wantAsync ? (iss, c) => defaultRunReadinessAsync(iss, c ?? cfg) : (iss, c) => defaultRunReadiness(iss, c ?? cfg);
}

// --------------------------------------------------------------------------
// Cycle + loop
// --------------------------------------------------------------------------

// Runs one issue through implement -> review&fix -> gate, up to maxRetries.
// Returns { status: "verified" | "blocked", evidenceRel? }.
export function runIssueCycle(issue, cfg, steps) {
  const { runImplementer, runReviewer, runGate } = steps;
  const allTranscripts = [];
  let lastTimeoutReason = null;
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
    lastTimeoutReason = legTimeoutReason(implResult) ?? lastTimeoutReason;

    emit(cfg, {
      event_type: "review_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.reviewer.actor,
      role: cfg.reviewer.role,
    });
    const reviewResult = runLegWithQuota(runReviewer, cfg.reviewer, issue, cfg);
    if (reviewResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.reviewer, allTranscripts);
    lastTimeoutReason = legTimeoutReason(reviewResult) ?? lastTimeoutReason;

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
    evidence_refs: [writeBlockedEvidence(issue, cfg, lastTimeoutReason)],
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
  let lastTimeoutReason = null;
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
    lastTimeoutReason = legTimeoutReason(implResult) ?? lastTimeoutReason;

    emit(cfg, {
      event_type: "review_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.reviewer.actor,
      role: cfg.reviewer.role,
    });
    const reviewResult = await runLegWithQuotaAsync(runReviewer, cfg.reviewer, issue, cfg);
    if (reviewResult.quotaBlocked) return quotaBlock(issue, cfg, cfg.reviewer, allTranscripts);
    lastTimeoutReason = legTimeoutReason(reviewResult) ?? lastTimeoutReason;

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
    evidence_refs: [writeBlockedEvidence(issue, cfg, lastTimeoutReason)],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", attempts: cfg.maxRetries, transcripts: allTranscripts };
}

// The timeout reason a leg result carries, if it tripped the per-leg cap/idle
// watchdog (set by leg-timeout.mjs). Used so a block caused by a wedged CLI says
// WHY in its evidence, distinct from an ordinary red gate.
function legTimeoutReason(legResult) {
  return legResult?.result?.timedOut ? legResult.result.timeoutReason || "leg timed out" : null;
}

// Record the blocked evidence. When the attempts were exhausted because a leg
// kept TIMING OUT (a wedged CLI), the reason names the timeout explicitly so a
// human sees it was a stall, not a genuine failing gate.
function writeBlockedEvidence(issue, cfg, timeoutReason = null) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  const reason = timeoutReason
    ? `${timeoutReason}; still red after ${cfg.maxRetries} attempts`
    : `gate red after ${cfg.maxRetries} attempts`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify({ issue_id: issue.id, reason, ...(timeoutReason ? { kind: "timeout" } : {}), at: nowIso(cfg) }, null, 2)}\n`,
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
        at: nowIso(cfg),
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
    // Enforced pre-development integrity gates (Item 6). Injectable so tests can
    // observe/skip; default to the real frozen-baseline + traceability verifiers.
    verifyBaseline: steps.verifyBaseline ?? (() => defaultVerifyBaseline(cfg)),
    verifyTraceability: steps.verifyTraceability ?? (() => defaultVerifyTraceability(cfg)),
    verifySpike: steps.verifySpike ?? (() => defaultVerifySpike(cfg)),
    verifyReference: steps.verifyReference ?? (() => defaultVerifyReference(cfg)),
  };
  // S8 readiness leg step (G5), or null when readiness is disabled (cfg.readiness ===
  // false: proceed straight to the implementer). Sync runner on the sequential path.
  const readinessRunner = resolveReadinessRunner(cfg, steps, { async: false });
  // Refuse to develop against a tampered baseline or a failing traceability matrix
  // BEFORE touching a single issue (these THROW on failure).
  resolvedSteps.verifyBaseline(cfg);
  resolvedSteps.verifyTraceability(cfg);
  resolvedSteps.verifySpike(cfg);
  resolvedSteps.verifyReference(cfg);
  const index = readJson(cfg.issueIndexPath);
  const issues = Array.isArray(index.issues) ? index.issues : [];
  const processed = [];

  // The architecture-map data is a STATIC graph generated once at extraction; the
  // app overlays the live ledger at read time, so there is nothing to regenerate
  // here — the loop writes only the ledger and commits it per checkpoint.
  for (;;) {
    const doneIds = computeDoneIds(issues, readLedger(cfg), listDoneFiles(cfg));
    // Parked-on-CR issues (S8 needs_cr) are skipped like done ones until a CR decision
    // unparks them; the set is recomputed each turn (a report cleared by an issue-file
    // change re-admits the issue). This is how the loop moves on instead of dead-ending.
    const parkedIds = readParkedIssueIds(cfg);
    const issue = pickNextIssue(issues, doneIds, verifiedSpikeGates(), parkedIds);
    if (!issue) break;

    // S8: confront the issue with the CURRENT code BEFORE implementing it. A needs_cr
    // (or an exhausted transient failure) parks the issue and we CONTINUE to the next
    // ready issue — sequential skip-and-continue, never a break. An issue_update that
    // stayed within the execution prose is applied; then we implement.
    if (readinessRunner) {
      const readiness = runReadinessSync(issue, cfg, readinessRunner);
      if (readiness.status === "parked") {
        processed.push({ id: issue.id, status: "parked" });
        continue;
      }
    }

    const result = runIssueCycle(issue, cfg, resolvedSteps);
    if (result.status === "verified") {
      // Move to done/ BEFORE committing so the green checkpoint records the move
      // (and the index path update) atomically; a kill between the two then never
      // leaves an issue verified-in-ledger but missing from done/.
      moveIssueToDone(issue, cfg);
      // Commit the green checkpoint (code + ledger + evidence + done/-move) via
      // `git add -A`. The static map is unchanged — live progress is the ledger,
      // which the app overlays at read time, so no map regeneration is needed.
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
  // The architecture index drives max-spread batch selection (cluster + adjacency).
  // Read once up front; it is static for the run and degrades to the empty index
  // when the target has no generated architecture-data.json.
  const archIndex = readArchitectureIndex(cfg);

  // Injectable worktree/integration steps (defaults invoke real git); parallel
  // legs default to the ASYNC runners so spawns don't block the event loop.
  const wt = {
    createWorktree: steps.createWorktree ?? ((issue) => defaultCreateWorktree(issue, cfg)),
    integrateWorktree: steps.integrateWorktree ?? ((issue, branch) => defaultIntegrateWorktree(issue, cfg, branch)),
    removeWorktree:
      steps.removeWorktree ?? ((issue, worktreeRoot, branch) => defaultRemoveWorktree(issue, cfg, worktreeRoot, branch)),
    // Integration guard: neutralize out-of-scope frozen-artifact edits in the
    // worktree before merge (see defaultResetWorktreeFrozenArtifacts). Injectable
    // so tests can observe/skip it; defaults to the real git-backed reset.
    resetFrozenArtifacts:
      steps.resetFrozenArtifacts ??
      ((issue, worktreeRoot) => defaultResetWorktreeFrozenArtifacts(issue, cfg, worktreeRoot)),
    // S10/G6 merge-integrity seams (all injectable so tests script them without git):
    //   captureHead  — the pre-merge integration HEAD sha (for a post-merge revert).
    //   resetHard    — revert the merge by hard-resetting to that sha.
    //   rebaseWorktree / runMergeResolver — the conflict-resolution path (rebase the
    //     worktree branch, then a bounded merge-resolver leg reconciles + re-greens it).
    captureHead: steps.captureHead ?? (() => defaultCaptureHead(cfg)),
    resetHard: steps.resetHard ?? ((sha) => defaultResetHard(cfg, sha)),
    rebaseWorktree: steps.rebaseWorktree ?? ((issue, worktreeRoot) => defaultRebaseWorktree(issue, cfg, worktreeRoot)),
  };

  // Refuse to develop against a tampered baseline or a failing traceability matrix
  // BEFORE scheduling any issue (these THROW on failure). Injectable for tests.
  const verifyBaseline = steps.verifyBaseline ?? (() => defaultVerifyBaseline(cfg));
  const verifyTraceability = steps.verifyTraceability ?? (() => defaultVerifyTraceability(cfg));
  const verifySpike = steps.verifySpike ?? (() => defaultVerifySpike(cfg));
  const verifyReference = steps.verifyReference ?? (() => defaultVerifyReference(cfg));
  verifyBaseline(cfg);
  verifyTraceability(cfg);
  verifySpike(cfg);
  verifyReference(cfg);

  // S8 readiness leg step (G5), or null when readiness is disabled. Async runner on
  // the parallel path; run per batch member against current integration HEAD BEFORE a
  // worktree is created (a member that fails readiness is excluded this round).
  const readinessRunner = resolveReadinessRunner(cfg, steps, { async: true });

  // Keep parallel worktrees out of the main tree's status/`git add -A`.
  if (!steps.skipWorktreeIgnore) ensureWorktreesIgnored(cfg);

  // The architecture-map data is a STATIC graph generated once at extraction; the
  // app overlays the live ledger (shared state on main) at read time, so the
  // parallel loop never regenerates the map either — it commits only the ledger,
  // evidence, and done/-moves per integrated checkpoint.
  const processed = [];
  const running = new Map(); // issue.id -> Promise of its settled result
  const runningIssueById = new Map(); // issue.id -> issue (for independence checks)
  const blocked = new Set(); // issue ids that settled blocked (and never run again)
  // Issues parked on a CR this run (readiness needs_cr). Recorded once in `processed`
  // and never re-selected: the disk parked report also feeds computeReadySet below, so
  // a park survives a restart; this in-memory set just guards double-recording.
  const parkedThisRun = new Set();

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
    // A cfg whose execRoot is the MAIN root (execRoot unset => execRootOf(cfg) = main),
    // used to re-run the gate ON THE INTEGRATION TREE post-merge — exactly the gate the
    // orchestrator already runs, just against the integrated code. Same evidence writer.
    const integrationCfg = { ...cfg, deferVerified: true };
    const issueSteps = {
      runImplementer: steps.runImplementer ?? ((iss, c) => defaultRunImplementerAsync(iss, c ?? issueCfg)),
      runReviewer: steps.runReviewer ?? ((iss, c) => defaultRunReviewerAsync(iss, c ?? issueCfg)),
      // The gate is ASYNC on the parallel path so a slow gate never freezes the
      // event loop (which would stall every other issue and age out the lock).
      runGate: steps.runGate ?? ((iss, c) => defaultRunGateAsync(iss, c ?? issueCfg)),
      // The merge-resolver leg (S10) runs IN THE WORKTREE on the implementer CLI.
      runMergeResolver:
        steps.runMergeResolver ?? ((iss, c) => defaultRunMergeResolverAsync(iss, c ?? issueCfg)),
    };
    // Re-run the gate the orchestrator's own way against a given execution root (the
    // worktree, or the main integration tree). Awaits both the sync + async runners so
    // an injected sync fake and the default async gate both work; returns the verdict.
    const runGateAt = async (c) => {
      const step = issueSteps.runGate;
      return await step(issue, c);
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
      return await withIntegrationLock(cfg, async () => {
        // Capture the pre-merge integration HEAD FIRST (under the lock, so it is stable):
        // it is the exact sha to revert to if the post-merge re-gate finds the merge
        // damaged the integration tree (G6). The merge is the only new commit after it.
        const preMergeSha = wt.captureHead(cfg);
        // Defense-in-depth: under the lock (so the merge target is stable), discard
        // any out-of-scope edits this worktree made to the FROZEN extraction corpus,
        // resetting them to the integration head. This makes a frozen-artifact edit a
        // clean no-op at merge — it can never cause spec drift or a frozen-file
        // conflict — while the worktree's legitimate src/test changes still merge.
        wt.resetFrozenArtifacts(issue, created.worktreeRoot);
        let merge = wt.integrateWorktree(issue, created.branch);
        if (!merge.ok) {
          // S10 merge-resolver (G6): the merge conflicted and was aborted cleanly
          // (defaultIntegrateWorktree already ran `merge --abort`). Try ONCE to
          // reconcile: rebase the worktree onto integration HEAD, run a bounded
          // merge-resolver leg IN THE WORKTREE, then TRUST NOTHING — the orchestrator
          // re-runs the gate in the worktree itself. Only a resolver-claims-resolved
          // AND orchestrator-verified-green worktree earns a single merge retry.
          // Independent of readiness; steps.runMergeResolver === false opts a test out.
          if (steps.runMergeResolver !== false) {
            wt.rebaseWorktree(issue, created.worktreeRoot);
            await runLegWithQuotaAsync(issueSteps.runMergeResolver, mergeResolverLeg(cfg), issue, issueCfg);
            const verdict = readMergeResolutionVerdict(issue, cfg);
            const worktreeGate = await runGateAt(issueCfg); // orchestrator's own verdict, in the worktree
            if (verdict?.resolved === true && worktreeGate.pass) {
              // Re-neutralize frozen edits the rebase/resolve may have reintroduced, then
              // retry the merge exactly once.
              wt.resetFrozenArtifacts(issue, created.worktreeRoot);
              merge = wt.integrateWorktree(issue, created.branch);
              if (merge.ok) {
                emit(cfg, {
                  event_type: "merge_conflict_resolved",
                  issue_id: issue.id,
                  graph_refs: issue.graph_refs,
                  actor: cfg.implementer.actor,
                  role: "merge-resolver",
                });
              }
            }
          }
          if (!merge.ok) {
            // Resolver absent, unresolved, gate red, or the retried merge still failed:
            // block only this issue (current behavior), naming the unresolved conflict.
            writeIntegrationBlock(issue, cfg, `integration conflict (unresolved): ${merge.message}`);
            try {
              emit(cfg, {
                event_type: "merge_conflict_unresolved",
                issue_id: issue.id,
                graph_refs: issue.graph_refs,
                actor: cfg.implementer.actor,
                role: "merge-resolver",
              });
            } catch (error) {
              process.stderr.write(`[parallel] failed to emit merge_conflict_unresolved for ${issue.id}: ${error?.message ?? error}\n`);
            }
            return { id: issue.id, status: "blocked" };
          }
        }
        // POST-MERGE RE-GATE (S10, deterministic first): the merge landed; re-run this
        // issue's gate ON THE INTEGRATION TREE. Green pre-merge + red post-merge = the
        // merge damaged something. Revert the merge (reset --hard to the captured
        // pre-merge sha — the merge is the only commit since) and block only this issue,
        // never leaving the integration branch red.
        const postMergeGate = await runGateAt(integrationCfg);
        if (!postMergeGate.pass) {
          wt.resetHard(cfg, preMergeSha);
          writePostMergeIntegrationBlock(issue, cfg, {
            preMergeEvidenceRel: result.evidenceRel,
            postMergeEvidenceRel: postMergeGate.evidenceRel,
            preMergeSha,
          });
          return { id: issue.id, status: "blocked" };
        }
        // Move to done/ BEFORE the orchestration commit so a kill between them never
        // leaves an issue committed but missing from done/ (the same
        // move-before-commit invariant the sequential path keeps).
        moveIssueToDone(issue, cfg);
        // Emit verified into the ledger (the single source of truth for live
        // progress), THEN commit the done/-move + ledger on the integration branch.
        // Done under the integration lock so the next worktree branches from a clean
        // HEAD that already reflects this issue's completion. No map regeneration:
        // the static map is unchanged and the app overlays the live ledger at read
        // time, so the next worktree (and the viewer) already see this issue done.
        // The verified evidence is the POST-MERGE gate run (the integration tree is the
        // code that actually landed), which supersedes the pre-merge worktree run.
        emit(cfg, {
          event_type: "gate_passed",
          issue_id: issue.id,
          graph_refs: issue.graph_refs,
          actor: cfg.implementer.actor,
          role: cfg.implementer.role,
          evidence_refs: [postMergeGate.evidenceRel],
          transcript_refs: result.gateTranscripts ?? [],
        });
        if (steps.commitDoneMove !== false) commitDoneMove(issue, cfg);
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
    // Parked-on-CR issues are held out of the ready set (disk report + in-memory guard)
    // until a CR decision re-extraction clears the report — the same exclusion done/
    // gets, so a parked batch member is never re-selected.
    const parkedIds = new Set([...readParkedIssueIds(cfg), ...parkedThisRun]);
    const ready = computeReadySet(issues, doneIds, excluded, verifiedSpikeGates(), parkedIds);
    const batch = selectIndependentBatch(
      ready,
      [...runningIssueById.values()],
      maxParallel,
      depsClosure,
      archIndex,
    );
    // S8: readiness-check the WHOLE selected batch against current integration HEAD
    // BEFORE any worktree spawns. A member that parks (needs_cr) or whose issue_update
    // is refused is EXCLUDED this round — no worktree is ever created for it — while the
    // others proceed. Readiness runs at the MAIN root (no execRoot): it reads the live
    // integration tree, exactly what the batch would branch from. Run sequentially so a
    // readiness leg and a running implementer leg do not both fight for the same CLI
    // quota window; the batch is at most maxParallel issues.
    const readyToRun = [];
    if (readinessRunner) {
      for (const issue of batch) {
        const readiness = await runReadinessAsync(issue, cfg, readinessRunner);
        if (readiness.status === "parked") {
          if (!parkedThisRun.has(issue.id)) {
            parkedThisRun.add(issue.id);
            processed.push({ id: issue.id, status: "parked" });
          }
          continue;
        }
        readyToRun.push(issue);
      }
    } else {
      readyToRun.push(...batch);
    }
    for (const issue of readyToRun) {
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
      { issue_id: issue.id, reason, kind: "integration", at: nowIso(cfg) },
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

// --------------------------------------------------------------------------
// Merge integrity (S10/G6): post-merge re-gate + bounded merge-resolver leg.
// Both run inside runLoopParallel's integration critical section (under the lock).
// The orchestrator TRUSTS NOTHING: it re-runs the gate itself (on the integration
// tree post-merge, and in the worktree after a resolver leg) — the resolver's own
// claim is never the verdict. It never leaves the integration branch red.
// --------------------------------------------------------------------------

// Read + validate the merge-resolver verdict JSON the leg wrote. Returns the parsed
// verdict, or null when missing / unparseable / malformed (treated as unresolved).
// Never trusts stdout: the file is the sole contract.
function readMergeResolutionVerdict(issue, cfg) {
  const rel = `${cfg.reportsDir}/${issue.id}-merge-resolution.json`;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs(rel), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.resolved !== "boolean") return null;
  return parsed;
}

// Write the post-merge integration-block evidence for ONE issue: the merge went green
// pre-merge but the re-run gate on the integration tree came back red, so the merge
// damaged something. Records BOTH gate evidences (the green pre-merge run and the red
// post-merge run) so a human sees exactly what regressed. Written to the MAIN root.
function writePostMergeIntegrationBlock(issue, cfg, { preMergeEvidenceRel, postMergeEvidenceRel, preMergeSha }) {
  mkdirSync(abs(cfg.reportsDir), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-integration-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      {
        issue_id: issue.id,
        reason:
          "post-merge gate red: the issue's gate was green pre-merge but red on the integration tree after merging — the merge damaged the integration state. The merge commit was reverted (reset to the pre-merge HEAD).",
        kind: "post_merge_gate",
        pre_merge_gate_evidence: preMergeEvidenceRel ?? null,
        post_merge_gate_evidence: postMergeEvidenceRel ?? null,
        reverted_to_sha: preMergeSha ?? null,
        at: nowIso(cfg),
      },
      null,
      2,
    )}\n`,
  );
  // Light the node blocked, and record the deterministic post_merge_gate_failed event.
  // Best-effort: a ledger emit failure must not crash the loop or strand other issues.
  try {
    emit(cfg, {
      event_type: "post_merge_gate_failed",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
    });
    emit(cfg, {
      event_type: "issue_blocked",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
      evidence_refs: [rel],
    });
  } catch (error) {
    process.stderr.write(`[parallel] failed to emit post_merge_gate_failed for ${issue.id}: ${error?.message ?? error}\n`);
  }
  return rel;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  assertCleanTree();
  const skills = checkSkills();
  for (const note of skills.notes ?? []) {
    process.stderr.write(`dev-loop preflight: note: ${note}\n`);
  }
  if (!skills.ok) {
    process.stderr.write(
      `dev-loop preflight: ${skills.reason}\n  missing required skills: ${(skills.missingRequired ?? []).join(", ")}\n  declare or remove them in the target project's package.json "vivicy.requiredSkills"\n`,
    );
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
