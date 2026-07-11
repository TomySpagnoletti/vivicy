#!/usr/bin/env node
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
import { atomicWriteJson } from "./atomic-write.ts";
import { notify } from "./notify.ts";
import { sleepSync } from "./sleep-sync.ts";
import { recordProgressEvent } from "./progress-ledger.ts";
import type { ProgressEvent } from "./progress-ledger.ts";
import { checkSkills } from "./dev-preflight.ts";
import { pruneGitkeeps } from "../lib/skeleton.ts";
import { runTraceabilityCheck } from "./traceability-check.ts";
import { runSpikeCheck, transitivelyVerifiedGates } from "./spike-check.ts";
import { runReferenceCheck } from "./reference-check.ts";
import { resolveTargetRoot, FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.ts";
import { resolveGateCommand, ProjectConfigError } from "./project-config.ts";
import {
  combinedOutput,
  runClaudeLeg as sharedRunClaudeLeg,
  runClaudeLegAsync as sharedRunClaudeLegAsync,
  runCodexLeg as sharedRunCodexLeg,
  runCodexLegAsync as sharedRunCodexLegAsync,
} from "./agent-spawn.ts";
import type { AgentLeg } from "./agent-spawn.ts";
import type { LegResult as TimeoutLegResult } from "./leg-timeout.ts";

export interface Issue {
  id: string;
  title?: string;
  path?: string;
  issue_path?: string;
  depends_on?: string[];
  spike_gates?: string[];
  graph_refs?: string[];
  claims?: string[];
  claimed_files?: string[];
  source_line_refs?: string[];
  verification_gate_ids?: string[];
  gate_command?: string;
}

type DependsInput = Pick<Issue, "depends_on">;
type SpikeGatesInput = Pick<Issue, "spike_gates">;
type ClaimInput = Pick<Issue, "claims" | "claimed_files" | "graph_refs">;
type FootprintInput = Pick<Issue, "claims" | "claimed_files" | "graph_refs" | "source_line_refs">;

export type Leg = AgentLeg;

export interface LegProcessResult extends Partial<Omit<TimeoutLegResult, "error">> {
  error?: unknown;
}

export interface LegResult {
  result?: LegProcessResult;
  output?: string;
  transcriptRel?: string;
  quotaBlocked?: boolean;
  totalWaitedMs?: number;
}

type LegStepReturn = LegResult | void;

export interface QuotaWindow {
  used_pct: number | null;
  remaining: number | null;
  reset_at: string | null;
}

type QuotaWindows = Record<string, QuotaWindow>;

export interface GateResult {
  pass: boolean;
  evidenceRel: string;
  exitCode: number;
  reason?: string;
}

interface GateEvidenceSnapshot {
  path: string;
  record: unknown;
}

interface ReadinessVerdict {
  verdict: string;
  reason?: string;
  updates?: { body_patch?: string };
}

type ReadinessOutcome =
  | { status: "implementable" }
  | { status: "parked"; reason: string; parkedRel?: string };

type ReadinessRunner = (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;

interface CycleSteps {
  runImplementer: (issue: Issue, cfg: Config) => LegStepReturn;
  runReviewer: (issue: Issue, cfg: Config) => LegStepReturn;
  runGate: (issue: Issue, cfg: Config) => GateResult;
}

interface AsyncCycleSteps {
  runImplementer: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;
  runReviewer: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;
  runGate: (issue: Issue, cfg: Config) => GateResult | Promise<GateResult>;
}

interface CycleResult {
  status: "verified" | "blocked";
  evidenceRel?: string;
  reason?: string;
  attempts: number;
  transcripts: string[];
  gateTranscripts?: string[];
}

export interface ProcessedIssue {
  id: string;
  status: string;
  error?: string;
}

type NotifyLevel = "info" | "success" | "warning" | "error";

interface EmitEvent {
  event_type: string;
  issue_id: string;
  graph_refs?: string[];
  actor: string;
  role?: string;
  evidence_refs?: string[];
  transcript_refs?: string[];
}

interface WorktreeHandle {
  worktreeRoot: string;
  branch: string;
}

interface IntegrationResult {
  ok: boolean;
  conflict: boolean;
  message: string;
}

interface GraphItemState {
  graph_ref: string;
  status?: string;
  issue_states?: Record<string, string>;
}

interface Ledger {
  graph_item_states?: GraphItemState[];
  active_items?: unknown[];
  revision?: number;
}

export interface ArchitectureIndex {
  clusterByNode: Map<string, string>;
  adjacencyByNode: Map<string, Set<string>>;
}

interface AgentQuotaState {
  model?: string | null;
  status?: string;
  reset_at?: string | null;
  last_message?: string | null;
  windows?: QuotaWindows;
  last_probe_at?: string;
}

interface QuotaState {
  updated_at: string | null;
  agents: Record<string, AgentQuotaState>;
}

interface ParkedReport {
  issue_id?: string;
  issue_path?: string;
  issue_hash?: string | null;
}

interface IssueFileIdentity {
  hash: string;
  mtimeMs: number;
  path: string;
}

interface LegDeps {
  composePrompt: typeof composePrompt;
  agentCliArgs: typeof agentCliArgs;
  abs: typeof abs;
  execRoot: string;
  transcriptDirAbs: string | undefined;
  cwdFilter: string | null;
}

export interface Footprint {
  files: Set<string>;
  sources: Set<string>;
  clusters: Set<string>;
  nodes: Set<string>;
}

export interface LoopSteps {
  runImplementer?: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;
  runReviewer?: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;
  runGate?: (issue: Issue, cfg: Config) => GateResult | Promise<GateResult>;
  runReadiness?: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>;
  runMergeResolver?: ((issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>) | false;
  commit?: (issue: Issue, cfg?: Config) => unknown;
  commitDoneMove?: false;
  verifyBaseline?: (cfg?: Config) => unknown;
  verifyTraceability?: (cfg?: Config) => unknown;
  verifySpike?: (cfg?: Config) => unknown;
  verifyReference?: (cfg?: Config) => unknown;
  createWorktree?: (issue: Issue) => WorktreeHandle;
  integrateWorktree?: (issue: Issue, branch: string) => IntegrationResult;
  removeWorktree?: (issue: Issue, worktreeRoot: string, branch: string) => void;
  resetFrozenArtifacts?: (issue: Issue, worktreeRoot: string) => boolean;
  captureHead?: () => string;
  resetHard?: (sha: string) => LegProcessResult | void;
  rebaseWorktree?: (issue: Issue, worktreeRoot: string) => { ok: boolean; message: string };
  skipWorktreeIgnore?: boolean;
}

export interface Config {
  issueIndexPath?: string;
  progressLedgerPath?: string;
  issuesDir?: string;
  doneDir?: string;
  gatesDir?: string;
  reportsDir?: string;
  readiness?: boolean;
  promptsDir?: string;
  transcriptsDir?: string;
  maxRetries?: number;
  defaultGateCommand?: string;
  maxParallel?: number | string;
  worktreesDir?: string;
  architectureDataPath?: string;
  implementer: Leg;
  reviewer: Leg;
  quotaStatePath?: string | null;
  quotaBackoffStartMs?: number;
  quotaBackoffCapMs?: number;
  quotaMaxWaitMs?: number;
  claudeQuotaProbeEnabled?: boolean;
  claudeQuotaProbeMinIntervalMs?: number;
  claudeQuotaProbeBootMs?: number;
  claudeQuotaProbeReplyMs?: number;
  claudeQuotaProbeTimeoutMs?: number;
  claudeQuotaProbe?: (cfg: Config, leg: Leg) => Record<string, unknown> | null;
  quotaPatterns?: RegExp[];
  baselineId?: string;
  execRoot?: string;
  deferVerified?: boolean;
  now?: () => number;
  sleep?: (ms: number) => void;
  sleepAsync?: (ms: number) => Promise<void>;
}

const repoRootOrNull = resolveTargetRoot();

function requireRepoRoot(): string {
  if (!repoRootOrNull) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project Vivicy should build.",
    );
  }
  return repoRootOrNull;
}

// Mirrors lib/settings.ts — keep the two in sync.
export const CLI_DEFAULTS: Record<string, { model: string; effort: string }> = {
  claude: { model: "claude-opus-4-8", effort: "xhigh" },
  codex: { model: "gpt-5.5", effort: "high" },
};

export const KNOWN_CLIS = ["claude", "codex"];

// Mirrors lib/settings.ts — keep the two in sync.
export const FAST_CAPABLE_MODELS: Record<string, Set<string>> = {
  claude: new Set(["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6"]),
  codex: new Set(["gpt-5.5", "gpt-5.4"]),
};

function modelSupportsFast(provider: string, model: string): boolean {
  return FAST_CAPABLE_MODELS[provider]?.has(model) ?? false;
}

// Mirrors lib/settings.ts — keep the two in sync.
const VALID_EFFORTS: Record<string, Set<string>> = {
  claude: new Set(["low", "medium", "high", "xhigh", "max"]),
  codex: new Set(["minimal", "low", "medium", "high", "xhigh"]),
};

function isValidEffortFor(provider: string, effort: string | undefined): boolean {
  if (!effort) return true;
  return VALID_EFFORTS[provider]?.has(effort) ?? false;
}

function isKnownCli(value: string | undefined): value is string {
  return value === "claude" || value === "codex";
}

// Mirrors lib/settings.ts MIN_PARALLEL/MAX_PARALLEL — keep the two in sync.
export const MIN_CONCURRENCY = 1;
export const MAX_CONCURRENCY = 12;

export function clampConcurrency(value: unknown): number {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < MIN_CONCURRENCY) return MIN_CONCURRENCY;
  return n > MAX_CONCURRENCY ? MAX_CONCURRENCY : n;
}

export function resolveAgentLegs(env: Record<string, string | undefined> = {}): { implementer: Leg; reviewer: Leg } {
  const implementerCli = isKnownCli(env.VIVICY_IMPLEMENTER_CLI)
    ? env.VIVICY_IMPLEMENTER_CLI
    : "claude";
  let reviewerCli = isKnownCli(env.VIVICY_REVIEWER_CLI) ? env.VIVICY_REVIEWER_CLI : "codex";
  // Implementer and reviewer must be different CLIs — a CLI never reviews its own work.
  if (reviewerCli === implementerCli) {
    reviewerCli = implementerCli === "claude" ? "codex" : "claude";
  }
  const leg = (role: string, cli: string): Leg => {
    const model = env[`VIVICY_${cli.toUpperCase()}_MODEL`] || CLI_DEFAULTS[cli].model;
    const fastRequested = env[`VIVICY_${cli.toUpperCase()}_FAST`] === "1";
    const rawEffort = env[`VIVICY_${cli.toUpperCase()}_EFFORT`];
    const effort = isValidEffortFor(cli, rawEffort) && rawEffort ? rawEffort : CLI_DEFAULTS[cli].effort;
    return {
      actor: cli,
      role,
      provider: cli,
      model,
      effort,
      fast: fastRequested && modelSupportsFast(cli, model),
    };
  };
  return {
    implementer: leg("implementer", implementerCli),
    reviewer: leg("reviewer", reviewerCli),
  };
}

export const DEFAULT_CONFIG: Config = {
  issueIndexPath: ".vivicy/development/issue-index.json",
  progressLedgerPath: ".vivicy/development/progress-ledger.json",
  issuesDir: ".vivicy/development/issues",
  doneDir: ".vivicy/development/issues/done",
  gatesDir: ".vivicy/development/gates",
  reportsDir: ".vivicy/development/reports",
  readiness: true,
  promptsDir: FACTORY_PROMPTS_DIR,
  transcriptsDir: ".vivicy/development/transcripts",
  maxRetries: 2,
  // Deliberately unset: the target project must declare its own gate in vivicy.json — no hidden npm-test default.
  defaultGateCommand: undefined,
  maxParallel: clampConcurrency(process.env.VIVICY_MAX_PARALLEL),
  worktreesDir: ".vivicy-worktrees",
  architectureDataPath: ".vivicy/architecture-map/architecture-data.json",
  ...resolveAgentLegs(process.env),
  quotaStatePath: ".vivicy/development/reports/quota-state.json",
  quotaBackoffStartMs: 5 * 60 * 1000,
  quotaBackoffCapMs: 5 * 60 * 60 * 1000,
  quotaMaxWaitMs: 8 * 60 * 60 * 1000,
  claudeQuotaProbeEnabled: process.env.VIVICY_CLAUDE_QUOTA_PROBE !== "0",
  claudeQuotaProbeMinIntervalMs: 30 * 60 * 1000,
};

export function frozenIntegrationPaths(cfg: Pick<Config, "issueIndexPath">): string[] {
  // package.json is deliberately NOT frozen: a legitimate new runtime dependency must survive integration.
  return [
    ".vivicy/canonical/",
    ".vivicy/baselines/",
    ".vivicy/requirements/",
    ".vivicy/architecture-map/architecture-map.yml",
    cfg.issueIndexPath ?? DEFAULT_CONFIG.issueIndexPath!,
  ];
}

export const DEFAULT_QUOTA_PATTERNS: RegExp[] = [
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

const QUOTA_MIN_WAIT_MS = 30 * 1000;

export function dependenciesSatisfied(issue: DependsInput, doneIds: Set<string>): boolean {
  const deps = Array.isArray(issue.depends_on) ? issue.depends_on : [];
  return deps.every((dep) => doneIds.has(dep));
}

export function spikeGatesSatisfied(issue: SpikeGatesInput, verifiedGates: Set<string>): boolean {
  const gates = Array.isArray(issue.spike_gates) ? issue.spike_gates : [];
  return gates.every((gate) => verifiedGates.has(gate));
}

export function computeDoneIds(issues: Issue[], ledger: Ledger, doneFileNames: Set<string>): Set<string> {
  const done = new Set<string>();
  const verifiedIssuesByRef = new Map<string, Set<string>>();
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

export function pickNextIssue(
  issues: Issue[],
  doneIds: Set<string>,
  verifiedGates: Set<string> = new Set(),
  parkedIds: Set<string> = new Set(),
): Issue | null {
  for (const issue of issues) {
    if (doneIds.has(issue.id)) continue;
    if (parkedIds.has(issue.id)) continue;
    if (dependenciesSatisfied(issue, doneIds) && spikeGatesSatisfied(issue, verifiedGates)) return issue;
  }
  return null;
}

export function extractTraceabilityBlock(body: string | null | undefined): string | null {
  const text = String(body ?? "");
  const heading = /^##\s+Traceability\s*$/m.exec(text);
  if (!heading) return null;
  const after = text.slice(heading.index + heading[0].length);
  const fence = /```(?:\w+)?\n([\s\S]*?)\n```/.exec(after);
  return fence ? fence[1] : null;
}

export function issueUpdatePreservesTraceability(oldBody: string, newBody: string): boolean {
  const before = extractTraceabilityBlock(oldBody);
  const after = extractTraceabilityBlock(newBody);
  if (before === null || after === null) return false;
  return before === after;
}

export function computeReadySet(
  issues: Issue[],
  doneIds: Set<string>,
  running: Set<string> = new Set(),
  verifiedGates: Set<string> = new Set(),
  parkedIds: Set<string> = new Set(),
): Issue[] {
  return issues.filter(
    (issue) =>
      !doneIds.has(issue.id) &&
      !running.has(issue.id) &&
      !parkedIds.has(issue.id) &&
      dependenciesSatisfied(issue, doneIds) &&
      spikeGatesSatisfied(issue, verifiedGates),
  );
}

export function issueClaim(issue: ClaimInput): Set<string> {
  const explicit = Array.isArray(issue.claims)
    ? issue.claims
    : Array.isArray(issue.claimed_files)
      ? issue.claimed_files
      : null;
  const refs = explicit ?? (Array.isArray(issue.graph_refs) ? issue.graph_refs : []);
  return new Set(refs);
}

function setsIntersect(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) {
    if (large.has(item)) return true;
  }
  return false;
}

export function issuesIndependent(a: Issue, b: Issue, depsClosureById: Map<string, Set<string>>): boolean {
  if (a.id === b.id) return false;
  const aDeps = depsClosureById.get(a.id) ?? new Set<string>();
  const bDeps = depsClosureById.get(b.id) ?? new Set<string>();
  if (aDeps.has(b.id) || bDeps.has(a.id)) return false;
  return !setsIntersect(issueClaim(a), issueClaim(b));
}

export function buildDepsClosure(issues: Issue[]): Map<string, Set<string>> {
  const direct = new Map<string, string[]>(
    issues.map((issue) => [issue.id, Array.isArray(issue.depends_on) ? issue.depends_on : []]),
  );
  const closure = new Map<string, Set<string>>();
  const resolveFor = (id: string, stack: Set<string>): Set<string> => {
    if (closure.has(id)) return closure.get(id)!;
    if (stack.has(id)) return new Set();
    stack.add(id);
    const all = new Set<string>();
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

function sourceRefFile(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const colon = ref.lastIndexOf(":");
  return colon > 0 ? ref.slice(0, colon) : ref;
}

function nodeIdOfGraphRef(ref: unknown): string | null {
  if (typeof ref === "string" && ref.startsWith("node:")) return ref.slice("node:".length);
  return null;
}

export function buildArchitectureIndex(architecture: unknown): ArchitectureIndex {
  const clusterByNode = new Map<string, string>();
  const adjacencyByNode = new Map<string, Set<string>>();
  if (!architecture || typeof architecture !== "object") {
    return { clusterByNode, adjacencyByNode };
  }
  const arch = architecture as { nodes?: unknown; edges?: unknown };
  const nodes = (Array.isArray(arch.nodes) ? arch.nodes : []) as { id?: unknown; layout_cluster?: unknown }[];
  for (const node of nodes) {
    if (!node || typeof node.id !== "string") continue;
    if (typeof node.layout_cluster === "string" && node.layout_cluster.length > 0) {
      clusterByNode.set(node.id, node.layout_cluster);
    }
    if (!adjacencyByNode.has(node.id)) adjacencyByNode.set(node.id, new Set());
  }
  const edges = (Array.isArray(arch.edges) ? arch.edges : []) as { from?: unknown; to?: unknown }[];
  for (const edge of edges) {
    if (!edge || typeof edge.from !== "string" || typeof edge.to !== "string") continue;
    if (!adjacencyByNode.has(edge.from)) adjacencyByNode.set(edge.from, new Set());
    if (!adjacencyByNode.has(edge.to)) adjacencyByNode.set(edge.to, new Set());
    adjacencyByNode.get(edge.from)!.add(edge.to);
    adjacencyByNode.get(edge.to)!.add(edge.from);
  }
  return { clusterByNode, adjacencyByNode };
}

const EMPTY_ARCHITECTURE_INDEX: ArchitectureIndex = { clusterByNode: new Map(), adjacencyByNode: new Map() };

export function issueFootprint(issue: FootprintInput, archIndex: ArchitectureIndex = EMPTY_ARCHITECTURE_INDEX): Footprint {
  const { clusterByNode, adjacencyByNode } = archIndex ?? EMPTY_ARCHITECTURE_INDEX;
  const files = new Set<string>();
  const sources = new Set<string>();
  const clusters = new Set<string>();
  const nodes = new Set<string>();

  for (const claim of issueClaim(issue)) files.add(`file:${claim}`);

  const sourceRefs = Array.isArray(issue.source_line_refs) ? issue.source_line_refs : [];
  for (const ref of sourceRefs) {
    const file = sourceRefFile(ref);
    if (file) sources.add(`src:${file}`);
  }

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

function tokenSetsIntersect(a: Set<string>, b: Set<string>): boolean {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) return true;
  return false;
}

export const CONFLICT_DISTANCE_FAR = 4;
export function footprintDistance(a: Footprint, b: Footprint): number {
  if (tokenSetsIntersect(a.files, b.files)) return 0;
  if (tokenSetsIntersect(a.sources, b.sources)) return 1;
  if (tokenSetsIntersect(a.clusters, b.clusters)) return 2;
  if (tokenSetsIntersect(a.nodes, b.nodes)) return 3;
  return CONFLICT_DISTANCE_FAR;
}

export function selectIndependentBatch(
  ready: Issue[],
  runningIssues: Issue[],
  limit: number,
  depsClosureById: Map<string, Set<string>>,
  archIndex: ArchitectureIndex = EMPTY_ARCHITECTURE_INDEX,
): Issue[] {
  const batch: Issue[] = [];
  const slots = Math.max(1, limit) - runningIssues.length;
  if (slots <= 0) return batch;

  const footprintById = new Map<string, Footprint>();
  for (const issue of ready) footprintById.set(issue.id, issueFootprint(issue, archIndex));

  const eligible = (candidate: Issue): boolean =>
    runningIssues.every((r) => issuesIndependent(candidate, r, depsClosureById)) &&
    batch.every((b) => issuesIndependent(candidate, b, depsClosureById));

  const seed = ready.find((candidate) => eligible(candidate));
  if (!seed) return batch;
  batch.push(seed);

  while (batch.length < slots) {
    let best: Issue | null = null;
    let bestMinDist = -1;
    for (const candidate of ready) {
      if (batch.includes(candidate) || !eligible(candidate)) continue;
      const cf = footprintById.get(candidate.id)!;
      let minDist = Infinity;
      for (const chosen of batch) {
        const d = footprintDistance(cf, footprintById.get(chosen.id)!);
        if (d < minDist) minDist = d;
      }
      if (minDist > bestMinDist) {
        bestMinDist = minDist;
        best = candidate;
      }
    }
    if (!best) break;
    batch.push(best);
  }
  return batch;
}

export function composePrompt(template: string, issue: Issue, extra: Record<string, unknown> = {}): string {
  const values: Record<string, unknown> = {
    issue_id: issue.id,
    issue_path: issue.path ?? issue.issue_path ?? "",
    graph_refs: (issue.graph_refs ?? []).join(", "),
    ...extra,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

const GATE_COMMAND_DIRECTIVE = [
  "## Establish the verification gate command (this issue owes it)",
  "",
  "`vivicy.json#gateCommand` is still the not-yet-established sentinel (`null`): the pipeline cannot verify any issue until it is a real command. Establishing it is IN SCOPE here and overrides the general rule against editing `vivicy.json`.",
  "",
  "As part of completing this issue, the implementer MUST set `vivicy.json#gateCommand` (preserving every other field) to this project's real verification command — the exact runner its tests execute under (for example `go test ./...`, `cargo test`, `pytest -q`, `phpunit`, `swift test`, or `npm test`). This is the single legitimate `gateCommand` edit; it must NOT be reverted by the reviewer. Never invent a placeholder or an `echo`; use the project's genuine test runner. The orchestrator refuses to mark this issue done while the sentinel stands.",
].join("\n");

export function gateCommandDirective(cfg: Config, issue: Issue | undefined): string {
  try {
    resolveGateCommand({ issue, targetRoot: execRootOf(cfg), explicitDefault: cfg.defaultGateCommand });
    return "";
  } catch (error) {
    if (error instanceof ProjectConfigError && error.code === "invalid_gate_command") return GATE_COMMAND_DIRECTIVE;
    return "";
  }
}

export function agentCliArgs(
  provider: string,
  { model, effort, fast }: { model?: string; effort?: string; fast?: boolean } = {},
): string[] {
  const args: string[] = [];
  const useFast = Boolean(fast) && Boolean(model) && modelSupportsFast(provider, model!);
  if (provider === "claude") {
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);
    if (useFast) args.push("--settings", JSON.stringify({ fastMode: true }));
  } else if (provider === "codex") {
    if (model) args.push("-m", model);
    if (effort) args.push("-c", `model_reasoning_effort="${effort}"`);
    if (useFast) args.push("-c", "fast_mode=true");
  }
  return args;
}

export function detectRateLimit(
  output: unknown,
  patterns: RegExp[] = DEFAULT_QUOTA_PATTERNS,
  exitCode: number | null = null,
): { hit: boolean; message: string | null } {
  if (exitCode === 0) return { hit: false, message: null };
  const text = String(output ?? "");
  if (!text) return { hit: false, message: null };
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    const lineStart = text.lastIndexOf("\n", match.index) + 1;
    const lineEndRaw = text.indexOf("\n", match.index);
    const lineEnd = lineEndRaw === -1 ? text.length : lineEndRaw;
    const line = text.slice(lineStart, lineEnd).trim().slice(0, 300);
    return { hit: true, message: line || match[0] };
  }
  return { hit: false, message: null };
}

export function parseResetMs(message: string | null | undefined, nowMs: number): number | null {
  const text = String(message ?? "");
  if (!text) return null;

  const retryAfter = /retry[\s_-]?after[:\s]+(\d+)\s*(?:s|sec|secs|seconds)?\b/i.exec(text);
  if (retryAfter) return nowMs + Number(retryAfter[1]) * 1000;

  const relMs = parseRelativeDurationMs(text);
  if (relMs !== null) return nowMs + relMs;

  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/.exec(text);
  if (iso) {
    const ms = new Date(iso[0]).getTime();
    if (Number.isFinite(ms)) return ms;
  }

  const clock = /\b(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i.exec(text);
  if (clock) {
    const reset = clockToEpochMs(clock, nowMs);
    if (reset !== null) return reset;
  }
  return null;
}

function parseRelativeDurationMs(text: string): number | null {
  const cued = /(?:in|resets?(?:\s+in)?|try again(?:\s+in)?|wait)\s+([\dhms\s.minutesecorhuday]+)/i.exec(text);
  const span = cued ? cued[1] : text;
  let total = 0;
  let matched = false;
  const units: [RegExp, number][] = [
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

function clockToEpochMs(match: RegExpExecArray, nowMs: number): number | null {
  let hour = Number(match[1]);
  const minute = match[2] ? Number(match[2]) : 0;
  const meridiem = match[3] ? match[3].toLowerCase() : null;
  if (hour > 23 || minute > 59) return null;
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  const reset = new Date(nowMs);
  reset.setHours(hour, minute, 0, 0);
  let ms = reset.getTime();
  if (ms <= nowMs) ms += 24 * 60 * 60 * 1000;
  return ms;
}

export function computeWaitMs({
  message,
  nowMs,
  attempt,
  cfg,
}: {
  message: string | null | undefined;
  nowMs: number;
  attempt: number;
  cfg: Pick<Config, "quotaBackoffCapMs" | "quotaBackoffStartMs">;
}): { waitMs: number; resetAtMs: number } {
  const cap = cfg.quotaBackoffCapMs!;
  const start = cfg.quotaBackoffStartMs!;
  const resetAtMs = parseResetMs(message, nowMs);
  if (resetAtMs !== null) {
    const pad = 5000;
    const raw = Math.max(resetAtMs - nowMs, 0) + pad;
    const waitMs = Math.min(Math.max(raw, QUOTA_MIN_WAIT_MS), cap);
    return { waitMs, resetAtMs: nowMs + waitMs };
  }
  const backoff = Math.min(start * 2 ** Math.max(0, attempt - 1), cap);
  return { waitMs: backoff, resetAtMs: nowMs + backoff };
}

function windowRecord({
  usedPct = null,
  resetAtSec = null,
}: { usedPct?: number | null; resetAtSec?: number | null } = {}): QuotaWindow {
  const pct = Number.isFinite(usedPct) ? Math.max(0, Math.min(100, usedPct!)) : null;
  const reset_at = Number.isFinite(resetAtSec) ? new Date(resetAtSec! * 1000).toISOString() : null;
  return {
    used_pct: pct,
    remaining: pct === null ? null : Math.round((100 - pct) * 10) / 10,
    reset_at,
  };
}

export function parseCodexQuotaWindows(rolloutText: string | null | undefined): QuotaWindows {
  const text = String(rolloutText ?? "");
  if (!text) return {};
  let limits: { primary?: unknown; secondary?: unknown } | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limits")) continue;
    let obj: { payload?: { rate_limits?: unknown }; rate_limits?: unknown };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rl = obj?.payload?.rate_limits ?? obj?.rate_limits;
    if (rl && typeof rl === "object") limits = rl as { primary?: unknown; secondary?: unknown };
  }
  if (!limits) return {};
  const windows: QuotaWindows = {};
  if (limits.primary && typeof limits.primary === "object") {
    const primary = limits.primary as { used_percent?: unknown; resets_at?: unknown };
    windows["5h"] = windowRecord({
      usedPct: Number(primary.used_percent),
      resetAtSec: Number(primary.resets_at),
    });
  }
  if (limits.secondary && typeof limits.secondary === "object") {
    const secondary = limits.secondary as { used_percent?: unknown; resets_at?: unknown };
    windows["weekly"] = windowRecord({
      usedPct: Number(secondary.used_percent),
      resetAtSec: Number(secondary.resets_at),
    });
  }
  return windows;
}

function claudeStatusWindow(win: unknown): QuotaWindow | null {
  if (!win || typeof win !== "object") return null;
  const w = win as { used_percentage?: unknown; resets_at?: unknown };
  return windowRecord({
    usedPct: Number(w.used_percentage),
    resetAtSec: Number(w.resets_at),
  });
}

export function parseClaudeStatusRateLimits(rateLimitsOrStatus: unknown): QuotaWindows {
  const root = rateLimitsOrStatus as { rate_limits?: unknown } | null | undefined;
  if (!root || typeof root !== "object") return {};
  const rl = (root.rate_limits && typeof root.rate_limits === "object" ? root.rate_limits : root) as {
    five_hour?: unknown;
    seven_day?: unknown;
  };
  if (!rl || typeof rl !== "object") return {};
  const windows: QuotaWindows = {};
  const fiveHour = claudeStatusWindow(rl.five_hour);
  if (fiveHour) windows["5h"] = fiveHour;
  const sevenDay = claudeStatusWindow(rl.seven_day);
  if (sevenDay) windows.weekly = sevenDay;
  return windows;
}

export function parseClaudeQuotaWindows(transcriptText: string | null | undefined): QuotaWindows {
  const text = String(transcriptText ?? "");
  if (!text) return {};

  let statusRateLimits: { five_hour?: unknown; seven_day?: unknown } | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limits")) continue;
    let obj: { rate_limits?: unknown };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rl = (obj?.rate_limits && typeof obj.rate_limits === "object" ? obj.rate_limits : null) as {
      five_hour?: unknown;
      seven_day?: unknown;
    } | null;
    if (rl && (rl.five_hour || rl.seven_day)) statusRateLimits = rl;
  }
  if (statusRateLimits) {
    const windows = parseClaudeStatusRateLimits(statusRateLimits);
    if (Object.keys(windows).length > 0) return windows;
  }

  let info: { rateLimitType?: unknown; resetsAt?: unknown } | null = null;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.includes("rate_limit_event")) continue;
    let obj: { type?: unknown; rate_limit_info?: unknown };
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (obj?.type === "rate_limit_event" && obj.rate_limit_info) {
      info = obj.rate_limit_info as { rateLimitType?: unknown; resetsAt?: unknown };
    }
  }
  if (!info) return {};
  const windows: QuotaWindows = {};
  if (info.rateLimitType === "five_hour" || info.resetsAt) {
    windows["5h"] = windowRecord({ usedPct: null, resetAtSec: Number(info.resetsAt) });
  }
  return windows;
}

export function parseQuotaWindows(actor: string, text: string | null | undefined): QuotaWindows {
  if (actor === "codex") return parseCodexQuotaWindows(text);
  if (actor === "claude") return parseClaudeQuotaWindows(text);
  return {};
}

function readTranscriptText(relPath: string | undefined): string {
  if (!relPath) return "";
  try {
    return readFileSync(abs(relPath), "utf8");
  } catch {
    return "";
  }
}

function captureClaudeStatusLine(cfg: Config, leg: Leg): Record<string, unknown> | null {
  // No `script` pty on Windows.
  if (platform() === "win32") return null;
  let dir: string;
  try {
    dir = mkdtempSync(resolve(tmpdir(), "vivicy-claude-quota-"));
  } catch {
    return null;
  }
  try {
    const dumpPath = resolve(dir, "dump-statusline.sh");
    const capturePath = resolve(dir, "statusline.json");
    const settingsPath = resolve(dir, "settings.json");
    writeFileSync(
      dumpPath,
      `#!/bin/sh\ncat > ${JSON.stringify(capturePath)}\necho ""\n`,
      { mode: 0o755 },
    );
    writeFileSync(
      settingsPath,
      JSON.stringify({ statusLine: { type: "command", command: dumpPath } }),
    );
    const modelArgs = agentCliArgs("claude", leg);
    const claudeArgs = ["--settings", settingsPath, ...modelArgs];
    const bootMs = cfg.claudeQuotaProbeBootMs ?? 8;
    const replyMs = cfg.claudeQuotaProbeReplyMs ?? 38;
    const driver =
      `sleep ${bootMs}; printf 'say ok\\r'; ` +
      `sleep ${replyMs}; printf '/exit\\r'; ` +
      `sleep 3; printf '\\004'; sleep 2`;
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
    let raw: string;
    try {
      raw = readFileSync(capturePath, "utf8");
    } catch {
      return null;
    }
    let obj: { rate_limits?: unknown };
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
    const rl = obj?.rate_limits;
    return rl && typeof rl === "object" ? (rl as Record<string, unknown>) : null;
  } catch {
    return null;
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  }
}

function lastClaudeProbeMs(cfg: Config): number {
  if (!cfg.quotaStatePath) return 0;
  const ts = readQuotaState(cfg).agents?.claude?.last_probe_at;
  const ms = ts ? new Date(ts).getTime() : 0;
  return Number.isFinite(ms) ? ms : 0;
}

function refreshClaudeQuotaWindows(cfg: Config, leg: Leg, windows: QuotaWindows): QuotaWindows {
  if (!cfg.claudeQuotaProbeEnabled) return windows;
  const now = nowMsOf(cfg);
  const minInterval = cfg.claudeQuotaProbeMinIntervalMs ?? 0;
  if (minInterval > 0) {
    const last = lastClaudeProbeMs(cfg);
    if (last && now - last < minInterval) return windows;
    writeQuotaState(cfg, "claude", { last_probe_at: new Date(now).toISOString() });
  }
  const probe = cfg.claudeQuotaProbe ?? captureClaudeStatusLine;
  let rateLimits: Record<string, unknown> | null;
  try {
    rateLimits = probe(cfg, leg);
  } catch {
    return windows;
  }
  const probed = parseClaudeStatusRateLimits(rateLimits);
  if (Object.keys(probed).length === 0) return windows;
  return { ...windows, ...probed };
}

function abs(relPath: string): string {
  return resolve(requireRepoRoot(), relPath);
}

function verifiedSpikeGates(): Set<string> {
  return transitivelyVerifiedGates(requireRepoRoot());
}

function execRootOf(cfg: Config): string {
  return cfg.execRoot ? cfg.execRoot : requireRepoRoot();
}

function readJson<T = unknown>(relPath: string): T {
  return JSON.parse(readFileSync(abs(relPath), "utf8")) as T;
}

function readLedger(cfg: Config): Ledger {
  if (!existsSync(abs(cfg.progressLedgerPath!))) return { graph_item_states: [], active_items: [] };
  return readJson<Ledger>(cfg.progressLedgerPath!);
}

function readArchitectureIndex(cfg: Config): ArchitectureIndex {
  try {
    if (!cfg.architectureDataPath || !existsSync(abs(cfg.architectureDataPath))) {
      return EMPTY_ARCHITECTURE_INDEX;
    }
    return buildArchitectureIndex(readJson(cfg.architectureDataPath));
  } catch {
    return EMPTY_ARCHITECTURE_INDEX;
  }
}

function listDoneFiles(cfg: Config): Set<string> {
  const doneAbs = abs(cfg.doneDir!);
  if (!existsSync(doneAbs)) return new Set();
  return new Set(readdirSync(doneAbs).filter((name) => name.endsWith(".md")));
}

function readParkedIssueIds(cfg: Config): Set<string> {
  const reportsAbs = abs(cfg.reportsDir!);
  if (!existsSync(reportsAbs)) return new Set();
  const parked = new Set<string>();
  for (const name of readdirSync(reportsAbs)) {
    if (!name.endsWith("-parked.json")) continue;
    let report: ParkedReport;
    try {
      report = JSON.parse(readFileSync(resolve(reportsAbs, name), "utf8"));
    } catch {
      continue;
    }
    if (!report || typeof report.issue_id !== "string") continue;
    const identity = issueFileIdentity(cfg, report);
    if (identity && report.issue_hash === identity.hash) {
      parked.add(report.issue_id);
    } else {
      try {
        unlinkSync(resolve(reportsAbs, name));
      } catch {
      }
    }
  }
  return parked;
}

function issueFileIdentity(cfg: Config, report: ParkedReport): IssueFileIdentity | null {
  const rel = report.issue_path ?? `${cfg.issuesDir}/${report.issue_id}.md`;
  let abspath: string;
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

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function runClaudeLeg(leg: Leg, issue: Issue, cfg: Config): LegResult {
  return sharedRunClaudeLeg(leg, issue, cfg, legDeps(cfg, issue));
}

function runCodexLeg(leg: Leg, issue: Issue, cfg: Config): LegResult {
  return sharedRunCodexLeg(leg, issue, cfg, legDeps(cfg, issue));
}

function legDeps(cfg: Config, issue: Issue | undefined): LegDeps {
  const root = execRootOf(cfg);
  const directive = gateCommandDirective(cfg, issue);
  return {
    composePrompt: (template, iss) => composePrompt(template, iss, { gate_command_directive: directive }),
    agentCliArgs,
    abs,
    execRoot: root,
    transcriptDirAbs: issue ? abs(`${cfg.transcriptsDir}/${issue.id}`) : undefined,
    cwdFilter: cfg.execRoot ? root : null,
  };
}

function runAssignedLeg(leg: Leg, issue: Issue, cfg: Config): LegResult {
  if (leg.provider === "claude") return runClaudeLeg(leg, issue, cfg);
  if (leg.provider === "codex") return runCodexLeg(leg, issue, cfg);
  throw new Error(`dev-loop: ${leg.role} assigned to an unknown CLI: ${leg.provider}`);
}

export function defaultRunImplementer(issue: Issue, cfg: Config): LegResult {
  return runAssignedLeg(cfg.implementer, issue, cfg);
}

export function defaultRunReviewer(issue: Issue, cfg: Config): LegResult {
  return runAssignedLeg(cfg.reviewer, issue, cfg);
}

function runClaudeLegAsync(leg: Leg, issue: Issue, cfg: Config): Promise<LegResult> {
  return sharedRunClaudeLegAsync(leg, issue, cfg, legDeps(cfg, issue));
}

function runCodexLegAsync(leg: Leg, issue: Issue, cfg: Config): Promise<LegResult> {
  return sharedRunCodexLegAsync(leg, issue, cfg, legDeps(cfg, issue));
}

function runAssignedLegAsync(leg: Leg, issue: Issue, cfg: Config): Promise<LegResult> {
  if (leg.provider === "claude") return runClaudeLegAsync(leg, issue, cfg);
  if (leg.provider === "codex") return runCodexLegAsync(leg, issue, cfg);
  throw new Error(`dev-loop: ${leg.role} assigned to an unknown CLI: ${leg.provider}`);
}

export function defaultRunImplementerAsync(issue: Issue, cfg: Config): Promise<LegResult> {
  return runAssignedLegAsync(cfg.implementer, issue, cfg);
}

export function defaultRunReviewerAsync(issue: Issue, cfg: Config): Promise<LegResult> {
  return runAssignedLegAsync(cfg.reviewer, issue, cfg);
}

function readinessLeg(cfg: Config): Leg {
  return { ...cfg.implementer, role: "readiness-checker" };
}
function mergeResolverLeg(cfg: Config): Leg {
  return { ...cfg.implementer, role: "merge-resolver" };
}

export function defaultRunReadiness(issue: Issue, cfg: Config): LegResult {
  return runAssignedLeg(readinessLeg(cfg), issue, cfg);
}
export function defaultRunReadinessAsync(issue: Issue, cfg: Config): Promise<LegResult> {
  return runAssignedLegAsync(readinessLeg(cfg), issue, cfg);
}
export function defaultRunMergeResolver(issue: Issue, cfg: Config): LegResult {
  return runAssignedLeg(mergeResolverLeg(cfg), issue, cfg);
}
export function defaultRunMergeResolverAsync(issue: Issue, cfg: Config): Promise<LegResult> {
  return runAssignedLegAsync(mergeResolverLeg(cfg), issue, cfg);
}

function resolveGateCommandForRun(issue: Issue, cfg: Config): { command: string } | { unresolved: string } {
  try {
    return {
      command: resolveGateCommand({ issue, targetRoot: execRootOf(cfg), explicitDefault: cfg.defaultGateCommand }),
    };
  } catch (error) {
    if (error instanceof ProjectConfigError && error.code === "invalid_gate_command") return { unresolved: error.message };
    throw error;
  }
}

export function defaultRunGate(issue: Issue, cfg: Config): GateResult {
  const resolved = resolveGateCommandForRun(issue, cfg);
  if ("unresolved" in resolved) return writeGateEvidence(issue, cfg, null, 1, resolved.unresolved);
  const result = spawnSync(resolved.command, { cwd: execRootOf(cfg), encoding: "utf8", shell: true });
  return writeGateEvidence(issue, cfg, resolved.command, result.status ?? 1);
}

export async function defaultRunGateAsync(issue: Issue, cfg: Config): Promise<GateResult> {
  const resolved = resolveGateCommandForRun(issue, cfg);
  if ("unresolved" in resolved) return writeGateEvidence(issue, cfg, null, 1, resolved.unresolved);
  const result = await spawnShellAsync(resolved.command, { cwd: execRootOf(cfg) });
  return writeGateEvidence(issue, cfg, resolved.command, result.status ?? 1);
}

function spawnShellAsync(command: string, options: { cwd?: string } = {}): Promise<LegProcessResult> {
  return new Promise((resolveGate) => {
    let child;
    try {
      child = spawn(command, [], { ...options, shell: true, stdio: ["inherit", "pipe", "pipe"] });
    } catch (error) {
      resolveGate({ status: null, stdout: "", stderr: String((error as Error)?.message ?? error), error });
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

function writeGateEvidence(issue: Issue, cfg: Config, gateCommand: string | null, exitCode: number, reason?: string): GateResult {
  const gateId = (issue.verification_gate_ids ?? [])[0] ?? `gate:issue:${issue.id}`;
  mkdirSync(abs(cfg.gatesDir!), { recursive: true });
  const evidenceRel = `${cfg.gatesDir}/${issue.id}-gate.json`;
  const record = {
    gate_id: gateId,
    issue_id: issue.id,
    command: gateCommand,
    exit_code: exitCode,
    status: exitCode === 0 ? "pass" : "fail",
    ...(reason ? { reason } : {}),
    finished_at: nowIso(cfg),
    baseline_id: cfg.baselineId ?? readIndexBaselineId(cfg),
  };
  writeFileSync(abs(evidenceRel), `${JSON.stringify(record, null, 2)}\n`);
  return { pass: exitCode === 0, evidenceRel, exitCode, ...(reason ? { reason } : {}) };
}

function readIndexBaselineId(cfg: Config): string {
  try {
    return readJson<{ baseline_id?: string }>(cfg.issueIndexPath!).baseline_id ?? "unknown";
  } catch {
    return "unknown";
  }
}

function defaultCommit(issue: Issue, cfg: Config) {
  const root = execRootOf(cfg);
  pruneGitkeeps(root);
  // -A is safe: .gitignore covers the full never-commit set (transcripts, runtime, worktrees, node_modules).
  spawnSync("git", ["add", "-A"], { cwd: root, encoding: "utf8" });
  const message = `${issue.id}: ${issue.title ?? "implement vertical slice"}\n\nGate green; reviewed by ${cfg.reviewer.actor}.`;
  return spawnSync("git", ["commit", "-m", message], { cwd: root, encoding: "utf8" });
}

export function findFrozenManifestRel(cfg: Config): { manifestRel: string; baselineId: string } | null {
  const dirRel = ".vivicy/baselines";
  const dirAbs = abs(dirRel);
  if (!existsSync(dirAbs)) return null;
  for (const entry of readdirSync(dirAbs)) {
    if (!entry.endsWith(".json")) continue;
    let manifest: { status?: unknown; superseded?: unknown; baseline_id?: unknown };
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

export function defaultVerifyBaseline(cfg: Config): string {
  const found = findFrozenManifestRel(cfg);
  if (!found) {
    throw new Error(
      "dev-loop refuses to develop: no frozen baseline manifest found under .vivicy/baselines/. Run extraction to freeze the canonical spec first.",
    );
  }
  const tool = resolve(FACTORY_DIR, "doc-baseline.ts");
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

export function defaultVerifyTraceability(cfg: Config): boolean {
  const root = requireRepoRoot();
  const result = runTraceabilityCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop on a failing traceability check:\n${detail}`);
  }
  return true;
}

export function defaultVerifySpike(cfg: Config): boolean {
  const root = requireRepoRoot();
  const result = runSpikeCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop with malformed spikes:\n${detail}`);
  }
  return true;
}

export function defaultVerifyReference(cfg: Config): boolean {
  const root = requireRepoRoot();
  const result = runReferenceCheck({ repoRoot: root });
  if ((result.exitCode ?? 1) !== 0) {
    const detail = (result.errors ?? []).join("\n") || result.summary || `exit ${result.exitCode}`;
    throw new Error(`dev-loop refuses to develop on broken doc references:\n${detail}`);
  }
  return true;
}

function currentBranch(root: string): string {
  const r = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" });
  const name = (r.stdout ?? "").trim();
  if (name && name !== "HEAD") return name;
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return (sha.stdout ?? "").trim();
}

export function defaultCreateWorktree(issue: Issue, cfg: Config): WorktreeHandle {
  const root = requireRepoRoot();
  const worktreeRel = `${cfg.worktreesDir}/${issue.id}`;
  const worktreeRoot = resolve(root, worktreeRel);
  const branch = `vivicy/${issue.id}`;
  spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: root, encoding: "utf8" });
  spawnSync("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
  if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  mkdirSync(resolve(root, cfg.worktreesDir!), { recursive: true });
  const add = spawnSync("git", ["worktree", "add", "-b", branch, worktreeRoot, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  if ((add.status ?? 1) !== 0) {
    throw new Error(`dev-loop: failed to create worktree for ${issue.id}: ${add.stderr || add.stdout}`);
  }
  return { worktreeRoot, branch };
}

export function defaultResetWorktreeFrozenArtifacts(issue: Issue, cfg: Config, worktreeRoot: string): boolean {
  const root = requireRepoRoot();
  const base = currentBranch(root);
  const paths = frozenIntegrationPaths(cfg);
  // Per-path, never batched: `git checkout <base> -- <a> <b>` aborts entirely if any one pathspec is absent from <base>.
  for (const path of paths) {
    spawnSync("git", ["checkout", base, "--", path], { cwd: worktreeRoot, encoding: "utf8" });
  }
  const staged = spawnSync("git", ["diff", "--cached", "--name-only"], {
    cwd: worktreeRoot,
    encoding: "utf8",
  });
  const changed = (staged.stdout ?? "").trim();
  if (changed.length === 0) {
    return false;
  }
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

export function defaultIntegrateWorktree(issue: Issue, cfg: Config, branch: string): IntegrationResult {
  const root = requireRepoRoot();
  const merge = spawnSync(
    "git",
    ["merge", "--no-ff", "-m", `${issue.id}: integrate green worktree`, branch],
    { cwd: root, encoding: "utf8" },
  );
  if ((merge.status ?? 1) === 0) {
    return { ok: true, conflict: false, message: (merge.stdout ?? "").trim() };
  }
  spawnSync("git", ["merge", "--abort"], { cwd: root, encoding: "utf8" });
  return { ok: false, conflict: true, message: (merge.stderr || merge.stdout || "merge failed").trim() };
}

export function defaultCaptureHead(cfg: Config): string {
  const root = requireRepoRoot();
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

export function defaultResetHard(cfg: Config, sha: string): LegProcessResult {
  const root = requireRepoRoot();
  return spawnSync("git", ["reset", "--hard", sha], { cwd: root, encoding: "utf8" });
}

export function defaultRebaseWorktree(issue: Issue, cfg: Config, worktreeRoot: string): { ok: boolean; message: string } {
  const base = currentBranch(requireRepoRoot());
  const r = spawnSync("git", ["rebase", base], { cwd: worktreeRoot, encoding: "utf8" });
  return { ok: (r.status ?? 1) === 0, message: (r.stderr || r.stdout || "").trim() };
}

export function defaultRemoveWorktree(issue: Issue, cfg: Config, worktreeRoot: string, branch: string): void {
  const root = requireRepoRoot();
  spawnSync("git", ["worktree", "remove", "--force", worktreeRoot], { cwd: root, encoding: "utf8" });
  if (existsSync(worktreeRoot)) rmSync(worktreeRoot, { recursive: true, force: true });
  if (branch) spawnSync("git", ["branch", "-D", branch], { cwd: root, encoding: "utf8" });
}

function commitDoneMove(issue: Issue, cfg: Config) {
  const root = requireRepoRoot();
  const paths = [
    cfg.issuesDir,
    cfg.doneDir,
    cfg.issueIndexPath,
    cfg.progressLedgerPath,
    cfg.gatesDir,
    cfg.reportsDir,
  ].filter((p): p is string => Boolean(p));
  pruneGitkeeps(root);
  spawnSync("git", ["add", "--", ...paths], { cwd: root, encoding: "utf8" });
  return spawnSync("git", ["commit", "-m", `${issue.id}: move to done/ (integrated; live progress in ledger)`], { cwd: root, encoding: "utf8" });
}

function moveIssueToDone(issue: Issue, cfg: Config): string | null {
  const fromRel = issue.path ?? issue.issue_path ?? `${cfg.issuesDir}/${issue.id}.md`;
  const fromAbs = abs(fromRel);
  if (!existsSync(fromAbs)) return null;
  mkdirSync(abs(cfg.doneDir!), { recursive: true });
  const toRel = `${cfg.doneDir}/${issue.id}.md`;
  renameSync(fromAbs, abs(toRel));
  try {
    const index = readJson<{ issues?: Issue[] }>(cfg.issueIndexPath!);
    const entry = Array.isArray(index.issues) ? index.issues.find((item) => item.id === issue.id) : null;
    if (entry && entry.path) {
      entry.path = toRel;
      writeFileSync(abs(cfg.issueIndexPath!), `${JSON.stringify(index, null, 2)}\n`);
    } else if (entry && entry.issue_path) {
      entry.issue_path = toRel;
      writeFileSync(abs(cfg.issueIndexPath!), `${JSON.stringify(index, null, 2)}\n`);
    }
  } catch {
  }
  return toRel;
}

function assertCleanTree(): void {
  const result = spawnSync("git", ["status", "--porcelain"], { cwd: requireRepoRoot(), encoding: "utf8" });
  if ((result.stdout ?? "").trim().length > 0) {
    throw new Error(
      "dev-loop refuses to start on a dirty working tree: commit or stash existing changes first, so each issue commits only its own changes.",
    );
  }
}

const INTEGRATION_LOCK_STALE_MS = 120_000;

const integrationMutexes = new Map<string, Promise<void>>();

async function withIntegrationLock<T>(cfg: Config, fn: () => T | Promise<T>): Promise<T> {
  const lockPath = abs(`${cfg.gatesDir}/.integration.lock`);
  const prior = integrationMutexes.get(lockPath) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((r) => {
    release = r;
  });
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
      }
    }
  } finally {
    release();
  }
}

function acquireExclusiveLock(lockPath: string): void {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, epoch_ms: Date.now() }));
      closeSync(fd);
      return;
    } catch (error) {
      if (!error || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (reclaimStaleExclusiveLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out acquiring integration lock: ${lockPath}`);
      busyWaitMs(25);
    }
  }
}

function reclaimStaleExclusiveLock(lockPath: string): boolean {
  let owner: { epoch_ms?: unknown; pid?: unknown } | null = null;
  let stat = null;
  try {
    stat = statSync(lockPath);
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    return true;
  }
  const epoch = owner && typeof owner.epoch_ms === "number" ? owner.epoch_ms : stat.mtimeMs;
  const tooOld = Date.now() - epoch > INTEGRATION_LOCK_STALE_MS;
  const dead = owner && typeof owner.pid === "number" && owner.pid !== process.pid && !isPidAlive(owner.pid);
  if (!tooOld && !dead) return false;
  try {
    unlinkSync(lockPath);
  } catch {
  }
  return true;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function busyWaitMs(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
  }
}

function ensureWorktreesIgnored(cfg: Config): void {
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
  if (lines.includes(entry) || lines.includes(cfg.worktreesDir!)) return;
  const next = body && !body.endsWith("\n") ? `${body}\n${entry}\n` : `${body}${entry}\n`;
  writeFileSync(gitignorePath, next);
}

const NOTIFY_BY_EVENT: Record<string, { level: NotifyLevel; stage: string; label: string }> = {
  gate_passed: { level: "success", stage: "S9", label: "gate green" },
  gate_failed: { level: "warning", stage: "S9", label: "gate red" },
  issue_blocked: { level: "error", stage: "S9", label: "issue blocked" },
  issue_parked_on_cr: { level: "warning", stage: "S8", label: "parked on CR" },
  issue_reopened: { level: "info", stage: "S11", label: "issue reopened" },
  readiness_update_applied: { level: "info", stage: "S8", label: "issue updated by readiness" },
  merge_conflict_resolved: { level: "success", stage: "S10", label: "merge conflict resolved" },
  merge_conflict_unresolved: { level: "error", stage: "S10", label: "merge conflict unresolved" },
  post_merge_gate_failed: { level: "error", stage: "S10", label: "post-merge gate red — merge reverted" },
};

function emit(cfg: Config, event: EmitEvent): ReturnType<typeof recordProgressEvent> {
  const mapped = NOTIFY_BY_EVENT[event.event_type];
  if (mapped) {
    notify({
      level: mapped.level,
      stage: mapped.stage,
      event: event.event_type,
      message: `${event.issue_id}: ${mapped.label}`,
    });
  }
  return recordProgressEvent(
    { session_ref: `dev-loop:${event.issue_id}`, ...event } as ProgressEvent,
    { issueIndexPath: cfg.issueIndexPath, progressLedgerPath: cfg.progressLedgerPath },
  );
}

const nowIso = (cfg: Config): string => new Date(cfg.now?.() ?? Date.now()).toISOString();
const nowMsOf = (cfg: Config): number => cfg.now?.() ?? Date.now();
const sleepOf = (cfg: Config): ((ms: number) => void) => cfg.sleep ?? defaultSleep;

const defaultSleep = sleepSync;

function readQuotaState(cfg: Config): QuotaState {
  try {
    const parsed = JSON.parse(readFileSync(abs(cfg.quotaStatePath!), "utf8")) as QuotaState;
    if (parsed && typeof parsed === "object" && parsed.agents) return parsed;
  } catch {
  }
  return { updated_at: null, agents: {} };
}

function writeQuotaState(cfg: Config, actor: string, agentState: AgentQuotaState): QuotaState | null {
  if (!cfg.quotaStatePath) return null;
  const state = readQuotaState(cfg);
  state.agents = state.agents ?? {};
  state.agents[actor] = { ...(state.agents[actor] ?? {}), ...agentState };
  state.updated_at = nowIso(cfg);
  mkdirSync(abs(dirname(cfg.quotaStatePath)), { recursive: true });
  atomicWriteJson(abs(cfg.quotaStatePath), state);
  return state;
}

function markAgentAvailable(cfg: Config, leg: Leg, windows: QuotaWindows): void {
  writeQuotaState(cfg, leg.actor, {
    model: leg.model ?? null,
    status: "available",
    reset_at: null,
    last_message: null,
    ...(windows && Object.keys(windows).length > 0 ? { windows } : {}),
  });
}

function markAgentThrottled(
  cfg: Config,
  leg: Leg,
  { message, resetAtMs, windows }: { message: string | null; resetAtMs: number | null; windows: QuotaWindows },
): void {
  writeQuotaState(cfg, leg.actor, {
    model: leg.model ?? null,
    status: "throttled",
    reset_at: resetAtMs ? new Date(resetAtMs).toISOString() : null,
    last_message: message ?? null,
    ...(windows && Object.keys(windows).length > 0 ? { windows } : {}),
  });
}

export function runLegWithQuota(
  runLeg: (issue: Issue, cfg: Config) => LegStepReturn,
  leg: Leg,
  issue: Issue,
  cfg: Config,
): LegResult {
  const patterns = cfg.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS;
  const sleep = sleepOf(cfg);
  let totalWaitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const legResult = runLeg(issue, cfg) as LegResult | undefined;
    const output = legResult?.output ?? combinedOutput(legResult?.result as Parameters<typeof combinedOutput>[0]);
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
    if (totalWaitedMs + waitMs > cfg.quotaMaxWaitMs!) {
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

function defaultSleepAsync(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runLegWithQuotaAsync(
  runLeg: (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>,
  leg: Leg,
  issue: Issue,
  cfg: Config,
): Promise<LegResult> {
  const patterns = cfg.quotaPatterns ?? DEFAULT_QUOTA_PATTERNS;
  const sleep = cfg.sleepAsync ?? defaultSleepAsync;
  let totalWaitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const legResult = (await runLeg(issue, cfg)) as LegResult | undefined;
    const output = legResult?.output ?? combinedOutput(legResult?.result as Parameters<typeof combinedOutput>[0]);
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
    if (totalWaitedMs + waitMs > cfg.quotaMaxWaitMs!) {
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

const READINESS_VERDICTS = new Set(["implementable", "issue_update", "needs_cr"]);

function readReadinessVerdict(issue: Issue, cfg: Config): ReadinessVerdict | null {
  const rel = `${cfg.reportsDir}/${issue.id}-readiness.json`;
  let parsed: ReadinessVerdict;
  try {
    parsed = JSON.parse(readFileSync(abs(rel), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || !READINESS_VERDICTS.has(parsed.verdict)) return null;
  return parsed;
}

function applyReadinessUpdate(issue: Issue, cfg: Config, verdict: ReadinessVerdict): boolean {
  const patch = verdict?.updates?.body_patch;
  if (typeof patch !== "string" || patch.length === 0) return false;
  const rel = issue.path ?? issue.issue_path ?? `${cfg.issuesDir}/${issue.id}.md`;
  let current: string;
  try {
    current = readFileSync(abs(rel), "utf8");
  } catch {
    return false;
  }
  if (!issueUpdatePreservesTraceability(current, patch)) return false;
  writeFileSync(abs(rel), patch.endsWith("\n") ? patch : `${patch}\n`);
  return true;
}

function parkIssueOnCr(issue: Issue, cfg: Config, reason: string): ReadinessOutcome {
  mkdirSync(abs(cfg.reportsDir!), { recursive: true });
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
        issue_hash: identity?.hash ?? null,
        issue_mtime_ms: identity?.mtimeMs ?? null,
        at: nowIso(cfg),
      },
      null,
      2,
    )}\n`,
  );
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
    process.stderr.write(`[readiness] failed to emit issue_parked_on_cr for ${issue.id}: ${(error as Error)?.message ?? error}\n`);
  }
  return { status: "parked", reason, parkedRel: rel };
}

function emitReadinessStarted(issue: Issue, cfg: Config): void {
  emit(cfg, {
    event_type: "readiness_check_started",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: "readiness-checker",
  });
}

function routeReadinessVerdict(issue: Issue, cfg: Config, verdict: ReadinessVerdict | null): ReadinessOutcome {
  emit(cfg, {
    event_type: "readiness_check_completed",
    issue_id: issue.id,
    graph_refs: issue.graph_refs,
    actor: cfg.implementer.actor,
    role: "readiness-checker",
  });
  if (!verdict) return parkIssueOnCr(issue, cfg, "readiness_leg_failed");
  if (verdict.verdict === "needs_cr") {
    return parkIssueOnCr(issue, cfg, verdict.reason || "readiness verdict needs_cr");
  }
  if (verdict.verdict === "issue_update") {
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

function runReadinessSync(issue: Issue, cfg: Config, runReadinessStep: ReadinessRunner): ReadinessOutcome {
  emitReadinessStarted(issue, cfg);
  let verdict: ReadinessVerdict | null = null;
  for (let attempt = 1; attempt <= 2 && !verdict; attempt += 1) {
    const legResult = runLegWithQuota(runReadinessStep as (issue: Issue, cfg: Config) => LegStepReturn, readinessLeg(cfg), issue, cfg);
    if (!legResult.quotaBlocked) verdict = readReadinessVerdict(issue, cfg);
  }
  return routeReadinessVerdict(issue, cfg, verdict);
}

async function runReadinessAsync(issue: Issue, cfg: Config, runReadinessStep: ReadinessRunner): Promise<ReadinessOutcome> {
  emitReadinessStarted(issue, cfg);
  let verdict: ReadinessVerdict | null = null;
  for (let attempt = 1; attempt <= 2 && !verdict; attempt += 1) {
    const legResult = await runLegWithQuotaAsync(runReadinessStep, readinessLeg(cfg), issue, cfg);
    if (!legResult.quotaBlocked) verdict = readReadinessVerdict(issue, cfg);
  }
  return routeReadinessVerdict(issue, cfg, verdict);
}

function resolveReadinessRunner(cfg: Config, steps: LoopSteps, { async: wantAsync }: { async: boolean }): ReadinessRunner | null {
  if (cfg.readiness === false) return null;
  if (steps.runReadiness) return steps.runReadiness;
  return wantAsync ? (iss, c) => defaultRunReadinessAsync(iss, c ?? cfg) : (iss, c) => defaultRunReadiness(iss, c ?? cfg);
}

export function runIssueCycle(issue: Issue, cfg: Config, steps: CycleSteps): CycleResult {
  const { runImplementer, runReviewer, runGate } = steps;
  const allTranscripts: string[] = [];
  let lastTimeoutReason: string | null = null;
  let lastGateReason: string | null = null;
  for (let attempt = 1; attempt <= cfg.maxRetries!; attempt += 1) {
    emit(cfg, {
      event_type: "issue_started",
      issue_id: issue.id,
      graph_refs: issue.graph_refs,
      actor: cfg.implementer.actor,
      role: cfg.implementer.role,
    });
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

    const transcripts = [implResult?.transcriptRel, reviewResult?.transcriptRel]
      .filter((rel): rel is string => Boolean(rel))
      .filter((rel) => {
        try {
          return statSync(abs(rel)).size > 0;
        } catch {
          return false;
        }
      });
    allTranscripts.push(...transcripts);

    const gate = runGate(issue, cfg);
    lastGateReason = gate.reason ?? lastGateReason;
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
    evidence_refs: [writeBlockedEvidence(issue, cfg, lastTimeoutReason, lastGateReason)],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", attempts: cfg.maxRetries!, transcripts: allTranscripts };
}

export async function runIssueCycleAsync(issue: Issue, cfg: Config, steps: AsyncCycleSteps): Promise<CycleResult> {
  const { runImplementer, runReviewer, runGate } = steps;
  const allTranscripts: string[] = [];
  let lastTimeoutReason: string | null = null;
  let lastGateReason: string | null = null;
  for (let attempt = 1; attempt <= cfg.maxRetries!; attempt += 1) {
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
      .filter((rel): rel is string => Boolean(rel))
      .filter((rel) => {
        try {
          return statSync(abs(rel)).size > 0;
        } catch {
          return false;
        }
      });
    allTranscripts.push(...transcripts);

    const gate = await runGate(issue, cfg);
    lastGateReason = gate.reason ?? lastGateReason;
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
    evidence_refs: [writeBlockedEvidence(issue, cfg, lastTimeoutReason, lastGateReason)],
    transcript_refs: allTranscripts,
  });
  return { status: "blocked", attempts: cfg.maxRetries!, transcripts: allTranscripts };
}

function legTimeoutReason(legResult: LegResult): string | null {
  return legResult?.result?.timedOut ? legResult.result.timeoutReason || "leg timed out" : null;
}

function writeBlockedEvidence(
  issue: Issue,
  cfg: Config,
  timeoutReason: string | null = null,
  gateReason: string | null = null,
): string {
  mkdirSync(abs(cfg.reportsDir!), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  const reason = timeoutReason
    ? `${timeoutReason}; still red after ${cfg.maxRetries} attempts`
    : gateReason
      ? `${gateReason} (still unresolved after ${cfg.maxRetries} attempts)`
      : `gate red after ${cfg.maxRetries} attempts`;
  const kind = timeoutReason ? "timeout" : gateReason ? "gate_command_unset" : null;
  writeFileSync(
    abs(rel),
    `${JSON.stringify({ issue_id: issue.id, reason, ...(kind ? { kind } : {}), at: nowIso(cfg) }, null, 2)}\n`,
  );
  return rel;
}

function quotaBlock(issue: Issue, cfg: Config, leg: Leg, allTranscripts: string[]): CycleResult {
  mkdirSync(abs(cfg.reportsDir!), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      {
        issue_id: issue.id,
        reason: `${leg.actor} quota exhausted: waited past the ${Math.round(cfg.quotaMaxWaitMs! / 3600000)}h cap without the quota reopening`,
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

function assertRelativeConfig(cfg: Config): void {
  const keys: (keyof Config)[] = ["issueIndexPath", "progressLedgerPath", "issuesDir", "doneDir", "gatesDir", "reportsDir"];
  for (const key of keys) {
    const value = cfg[key];
    if (typeof value === "string" && isAbsolute(value)) {
      throw new Error(`dev-loop config ${key} must be repository-relative, not absolute: ${value}`);
    }
  }
}

export function runLoop(
  userConfig: Partial<Config> = {},
  steps: LoopSteps = {},
): ProcessedIssue[] | Promise<ProcessedIssue[]> {
  const cfg: Config = { ...DEFAULT_CONFIG, ...userConfig };
  if (clampConcurrency(cfg.maxParallel) > 1) {
    return runLoopParallel(userConfig, steps);
  }
  assertRelativeConfig(cfg);
  const resolvedSteps = {
    runImplementer: (steps.runImplementer ?? ((issue) => defaultRunImplementer(issue, cfg))) as (issue: Issue, cfg: Config) => LegStepReturn,
    runReviewer: (steps.runReviewer ?? ((issue) => defaultRunReviewer(issue, cfg))) as (issue: Issue, cfg: Config) => LegStepReturn,
    runGate: (steps.runGate ?? ((issue) => defaultRunGate(issue, cfg))) as (issue: Issue, cfg: Config) => GateResult,
    commit: steps.commit ?? ((issue: Issue) => defaultCommit(issue, cfg)),
    verifyBaseline: steps.verifyBaseline ?? (() => defaultVerifyBaseline(cfg)),
    verifyTraceability: steps.verifyTraceability ?? (() => defaultVerifyTraceability(cfg)),
    verifySpike: steps.verifySpike ?? (() => defaultVerifySpike(cfg)),
    verifyReference: steps.verifyReference ?? (() => defaultVerifyReference(cfg)),
  };
  const readinessRunner = resolveReadinessRunner(cfg, steps, { async: false });
  resolvedSteps.verifyBaseline(cfg);
  resolvedSteps.verifyTraceability(cfg);
  resolvedSteps.verifySpike(cfg);
  resolvedSteps.verifyReference(cfg);
  const index = readJson<{ issues?: Issue[] }>(cfg.issueIndexPath!);
  const issues: Issue[] = Array.isArray(index.issues) ? index.issues : [];
  const processed: ProcessedIssue[] = [];

  for (;;) {
    const doneIds = computeDoneIds(issues, readLedger(cfg), listDoneFiles(cfg));
    const parkedIds = readParkedIssueIds(cfg);
    const issue = pickNextIssue(issues, doneIds, verifiedSpikeGates(), parkedIds);
    if (!issue) break;

    if (readinessRunner) {
      const readiness = runReadinessSync(issue, cfg, readinessRunner);
      if (readiness.status === "parked") {
        processed.push({ id: issue.id, status: "parked" });
        continue;
      }
    }

    const result = runIssueCycle(issue, cfg, resolvedSteps);
    if (result.status === "verified") {
      // Before commit: a crash between the two must never leave an issue committed but missing from done/.
      moveIssueToDone(issue, cfg);
      resolvedSteps.commit(issue, cfg);
      processed.push({ id: issue.id, status: "verified" });
      continue;
    }
    processed.push({ id: issue.id, status: "blocked" });
    break;
  }
  return processed;
}

export async function runLoopParallel(userConfig: Partial<Config> = {}, steps: LoopSteps = {}): Promise<ProcessedIssue[]> {
  const cfg: Config = { ...DEFAULT_CONFIG, ...userConfig };
  assertRelativeConfig(cfg);
  const maxParallel = clampConcurrency(cfg.maxParallel);
  const index = readJson<{ issues?: Issue[] }>(cfg.issueIndexPath!);
  const issues: Issue[] = Array.isArray(index.issues) ? index.issues : [];
  const depsClosure = buildDepsClosure(issues);
  const archIndex = readArchitectureIndex(cfg);

  const wt = {
    createWorktree: steps.createWorktree ?? ((issue) => defaultCreateWorktree(issue, cfg)),
    integrateWorktree: steps.integrateWorktree ?? ((issue, branch) => defaultIntegrateWorktree(issue, cfg, branch)),
    removeWorktree:
      steps.removeWorktree ?? ((issue, worktreeRoot, branch) => defaultRemoveWorktree(issue, cfg, worktreeRoot, branch)),
    resetFrozenArtifacts:
      steps.resetFrozenArtifacts ??
      ((issue, worktreeRoot) => defaultResetWorktreeFrozenArtifacts(issue, cfg, worktreeRoot)),
    captureHead: steps.captureHead ?? (() => defaultCaptureHead(cfg)),
    resetHard: steps.resetHard ?? ((sha) => defaultResetHard(cfg, sha)),
    rebaseWorktree: steps.rebaseWorktree ?? ((issue, worktreeRoot) => defaultRebaseWorktree(issue, cfg, worktreeRoot)),
  };

  const verifyBaseline = steps.verifyBaseline ?? (() => defaultVerifyBaseline(cfg));
  const verifyTraceability = steps.verifyTraceability ?? (() => defaultVerifyTraceability(cfg));
  const verifySpike = steps.verifySpike ?? (() => defaultVerifySpike(cfg));
  const verifyReference = steps.verifyReference ?? (() => defaultVerifyReference(cfg));
  verifyBaseline(cfg);
  verifyTraceability(cfg);
  verifySpike(cfg);
  verifyReference(cfg);

  const readinessRunner = resolveReadinessRunner(cfg, steps, { async: true });

  if (!steps.skipWorktreeIgnore) ensureWorktreesIgnored(cfg);

  const processed: ProcessedIssue[] = [];
  const running = new Map<string, Promise<ProcessedIssue>>();
  const runningIssueById = new Map<string, Issue>();
  const blocked = new Set<string>();
  const parkedThisRun = new Set<string>();

  const runOne = async (issue: Issue): Promise<ProcessedIssue> => {
    let created: WorktreeHandle | null = null;
    try {
      created = await withIntegrationLock(cfg, () => wt.createWorktree(issue));
    } catch (error) {
      writeIntegrationBlock(issue, cfg, `worktree setup failed: ${(error as Error)?.message ?? error}`);
      return { id: issue.id, status: "blocked" };
    }
    const issueCfg: Config = { ...cfg, execRoot: created.worktreeRoot, deferVerified: true };
    const integrationCfg: Config = { ...cfg, deferVerified: true };
    const issueSteps = {
      runImplementer: steps.runImplementer ?? ((iss: Issue, c?: Config) => defaultRunImplementerAsync(iss, c ?? issueCfg)),
      runReviewer: steps.runReviewer ?? ((iss: Issue, c?: Config) => defaultRunReviewerAsync(iss, c ?? issueCfg)),
      runGate: steps.runGate ?? ((iss: Issue, c?: Config) => defaultRunGateAsync(iss, c ?? issueCfg)),
      runMergeResolver:
        steps.runMergeResolver ?? ((iss: Issue, c?: Config) => defaultRunMergeResolverAsync(iss, c ?? issueCfg)),
    };
    const runGateAt = async (c: Config): Promise<GateResult> => {
      const step = issueSteps.runGate;
      return await step(issue, c);
    };
    try {
      const result = await runIssueCycleAsync(issue, issueCfg, issueSteps);
      if (result.status !== "verified") {
        return { id: issue.id, status: "blocked" };
      }
      const commit = steps.commit ?? ((iss: Issue, c?: Config) => defaultCommit(iss, c ?? issueCfg));
      commit(issue, issueCfg);
      return await withIntegrationLock(cfg, async (): Promise<ProcessedIssue> => {
        // Captured under the integration lock so it is the exact pre-merge sha a failed post-merge gate reverts to.
        const preMergeSha = wt.captureHead();
        wt.resetFrozenArtifacts(issue, created!.worktreeRoot);
        let merge = wt.integrateWorktree(issue, created!.branch);
        if (!merge.ok) {
          if (steps.runMergeResolver !== false) {
            wt.rebaseWorktree(issue, created!.worktreeRoot);
            await runLegWithQuotaAsync(
              issueSteps.runMergeResolver as (issue: Issue, cfg: Config) => LegStepReturn | Promise<LegStepReturn>,
              mergeResolverLeg(cfg),
              issue,
              issueCfg,
            );
            const verdict = readMergeResolutionVerdict(issue, cfg);
            const worktreeGate = await runGateAt(issueCfg);
            if (verdict?.resolved === true && worktreeGate.pass) {
              wt.resetFrozenArtifacts(issue, created!.worktreeRoot);
              merge = wt.integrateWorktree(issue, created!.branch);
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
              process.stderr.write(`[parallel] failed to emit merge_conflict_unresolved for ${issue.id}: ${(error as Error)?.message ?? error}\n`);
            }
            return { id: issue.id, status: "blocked" };
          }
        }
        const preMergeEvidence = readGateEvidenceSnapshot(cfg, result.evidenceRel);
        const postMergeGate = await runGateAt(integrationCfg);
        if (!postMergeGate.pass) {
          const postMergeEvidence = readGateEvidenceSnapshot(cfg, postMergeGate.evidenceRel);
          const reset = wt.resetHard(preMergeSha);
          if (reset && typeof reset.status === "number" && reset.status !== 0) {
            process.stderr.write(
              `[parallel] CRITICAL: failed to revert damaging merge for ${issue.id} (reset --hard ${preMergeSha} exited ${reset.status}); the integration branch may be left red — manual intervention required:\n${`${reset.stdout ?? ""}\n${reset.stderr ?? ""}`.trim()}\n`,
            );
          }
          writePostMergeIntegrationBlock(issue, cfg, {
            preMergeEvidence,
            postMergeEvidence,
            preMergeSha,
          });
          return { id: issue.id, status: "blocked" };
        }
        // Same move-before-commit invariant as the sequential path.
        moveIssueToDone(issue, cfg);
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
      try {
        wt.removeWorktree(issue, created!.worktreeRoot, created!.branch);
      } catch (error) {
        process.stderr.write(`[parallel] worktree cleanup failed for ${issue.id}: ${(error as Error)?.message ?? error}\n`);
      }
    }
  };

  for (;;) {
    const doneIds = computeDoneIds(issues, readLedger(cfg), listDoneFiles(cfg));
    const excluded = new Set([...running.keys(), ...blocked]);
    const parkedIds = new Set([...readParkedIssueIds(cfg), ...parkedThisRun]);
    const ready = computeReadySet(issues, doneIds, excluded, verifiedSpikeGates(), parkedIds);
    const batch = selectIndependentBatch(
      ready,
      [...runningIssueById.values()],
      maxParallel,
      depsClosure,
      archIndex,
    );
    const readyToRun: Issue[] = [];
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
        .catch((error): ProcessedIssue => {
          process.stderr.write(`[parallel] ${issue.id} blocked by an unexpected error: ${(error as Error)?.stack ?? (error as Error)?.message ?? error}\n`);
          return { id: issue.id, status: "blocked", error: String((error as Error)?.message ?? error) };
        })
        .then((settled) => {
          running.delete(issue.id);
          runningIssueById.delete(issue.id);
          processed.push({ id: settled.id, status: settled.status });
          if (settled.status === "blocked") blocked.add(settled.id);
          return settled;
        });
      running.set(issue.id, task);
    }
    if (running.size === 0) {
      break;
    }
    await Promise.race(running.values());
  }
  return processed;
}

function writeIntegrationBlock(issue: Issue, cfg: Config, reason: string): string {
  mkdirSync(abs(cfg.reportsDir!), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      { issue_id: issue.id, reason, kind: "integration", at: nowIso(cfg) },
      null,
      2,
    )}\n`,
  );
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
    process.stderr.write(`[parallel] failed to emit issue_blocked for ${issue.id}: ${(error as Error)?.message ?? error}\n`);
  }
  return rel;
}

function readMergeResolutionVerdict(issue: Issue, cfg: Config): { resolved: boolean } | null {
  const rel = `${cfg.reportsDir}/${issue.id}-merge-resolution.json`;
  let parsed: { resolved?: unknown };
  try {
    parsed = JSON.parse(readFileSync(abs(rel), "utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.resolved !== "boolean") return null;
  return parsed as { resolved: boolean };
}

function readGateEvidenceSnapshot(cfg: Config, evidenceRel: string | undefined): GateEvidenceSnapshot | null {
  if (!evidenceRel) return null;
  try {
    return { path: evidenceRel, record: JSON.parse(readFileSync(abs(evidenceRel), "utf8")) };
  } catch {
    return { path: evidenceRel, record: null };
  }
}

function writePostMergeIntegrationBlock(
  issue: Issue,
  cfg: Config,
  {
    preMergeEvidence,
    postMergeEvidence,
    preMergeSha,
  }: { preMergeEvidence: GateEvidenceSnapshot | null; postMergeEvidence: GateEvidenceSnapshot | null; preMergeSha: string },
): string {
  mkdirSync(abs(cfg.reportsDir!), { recursive: true });
  const rel = `${cfg.reportsDir}/${issue.id}-integration-blocked.json`;
  writeFileSync(
    abs(rel),
    `${JSON.stringify(
      {
        issue_id: issue.id,
        reason:
          "post-merge gate red: the issue's gate was green pre-merge but red on the integration tree after merging — the merge damaged the integration state. The merge commit was reverted (reset to the pre-merge HEAD).",
        kind: "post_merge_gate",
        pre_merge_gate_evidence: preMergeEvidence ?? null,
        post_merge_gate_evidence: postMergeEvidence ?? null,
        reverted_to_sha: preMergeSha ?? null,
        at: nowIso(cfg),
      },
      null,
      2,
    )}\n`,
  );
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
    process.stderr.write(`[parallel] failed to emit post_merge_gate_failed for ${issue.id}: ${(error as Error)?.message ?? error}\n`);
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
      `dev-loop preflight: ${skills.reason}\n  missing required skills: ${(skills.missingRequired ?? []).join(", ")}\n  declare or remove them in the target project's vivicy.json "requiredSkills" (or package.json "vivicy.requiredSkills")\n`,
    );
    process.exit(1);
  }
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
