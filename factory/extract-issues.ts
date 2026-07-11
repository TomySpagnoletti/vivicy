#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { notify } from "./notify.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { runSemanticExtractionCheck } from "./semantic-extraction-check.ts";
import { runTraceabilityCheck } from "./traceability-check.ts";
import { readSpikes, runSpikeCheck as runSpikeCheckImpl, transitivelyVerifiedGates } from "./spike-check.ts";
import { runSpikeProving } from "./spike-prover.ts";
import { runReferenceCheck as runReferenceCheckImpl } from "./reference-check.ts";
import { runChangeControlCheck as runChangeControlCheckImpl } from "./change-control.ts";
import { runReopen } from "./reopen.ts";
import { formatMapReviewFix, mapReviewLensContext, mapReviewReportRel, runMapReview } from "./map-review.ts";
import type { MapReviewLens, MapReviewResult as LensFindings, TaggedFinding } from "./map-review.ts";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";
import { pruneGitkeeps } from "../lib/skeleton.ts";
import { clearSpecCycle, readSpecCycle } from "../lib/spec-cycle.ts";
import { detectSpecKind, type SpecKind } from "../lib/spec-kind.ts";
import { isGateCommandEstablished, loadProjectConfig, normalizeGateCommand, setGateCommand } from "./project-config.ts";

const BASELINE_DIR = ".vivicy/baselines";
const ISSUE_INDEX_REL = ".vivicy/development/issue-index.json";
const EXTRACTION_STATUS_REL = ".vivicy/development/reports/extraction-status.json";
const VERDICT_REL = ".vivicy/development/reports/extraction-fidelity-verdict.json";
const GATE_COMMAND_REL = ".vivicy/development/reports/extraction-gate-command.json";
const DEFAULT_FREEZE_VERSION = "1.0.0";

export function resolveFreezeVersion(repoRoot: string): string {
  const dir = resolve(repoRoot, BASELINE_DIR);
  if (!existsSync(dir)) return DEFAULT_FREEZE_VERSION;
  let best: [number, number, number] | null = null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let version: unknown;
    try {
      version = (JSON.parse(readFileSync(resolve(dir, entry), "utf8")) as { version?: unknown }).version;
    } catch {
      continue;
    }
    const m = typeof version === "string" ? version.match(/^(\d+)\.(\d+)\.(\d+)$/) : null;
    if (!m) continue;
    const parsed: [number, number, number] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!best || parsed[0] > best[0] || (parsed[0] === best[0] && (parsed[1] > best[1] || (parsed[1] === best[1] && parsed[2] > best[2])))) {
      best = parsed;
    }
  }
  if (!best) return DEFAULT_FREEZE_VERSION;
  return `${best[0]}.${best[1] + 1}.0`;
}
const DEFAULT_MAX_RETRIES = 3;

const EXTRACTOR_ISSUE_ID = "EXTRACTION";

interface ResolvedLegs {
  implementer: Leg;
  reviewer: Leg;
}

interface ExtractionIssue {
  id: string;
  graph_refs: string[];
  path: string;
}

interface CheckResult {
  exitCode: number;
  errors?: string[];
  warnings?: string[];
  placeholder?: boolean;
  summary?: string;
}

interface Checks {
  semantic: CheckResult;
  traceability: CheckResult;
  spike?: CheckResult;
  reference?: CheckResult;
  changeControl?: CheckResult;
  attempt?: number;
}

interface MapResult {
  code: number;
  output?: string;
}

interface VerdictProblem {
  issue?: string;
  kind?: string;
  detail?: string;
}

interface Verdict {
  faithful: boolean;
  problems: VerdictProblem[];
}

interface MapReviewAggregate {
  findings: TaggedFinding[];
  actionable: TaggedFinding[];
  legs: LegResult[];
}

interface SpikeProvingResult {
  proved: unknown[];
  failed: unknown[];
  skipped: unknown[];
  changeRequests?: unknown[];
}

interface SpikeProvingArgs {
  repoRoot: string;
  legs: ResolvedLegs;
  cfg: Record<string, unknown>;
  recordEvent: null;
}

interface FrozenBaseline {
  manifestPath: string;
  baselineId: string;
}

interface ExtractIssuesOptions {
  repoRoot?: string;
  maxRetries?: number;
  version?: string;
  cfg?: Record<string, unknown>;
  promptsDir?: string;
  spawnExtractor?: (args: SpawnExtractorArgs) => Promise<LegResult>;
  spawnAgent?: (args: SpawnExtractorArgs) => Promise<LegResult>;
  spawnVerifier?: (args: SpawnVerifierArgs) => Promise<LegResult>;
  runFreeze?: (args: { repoRoot: string; version: string; approvalRef?: string }) => FrozenBaseline | Promise<FrozenBaseline>;
  verifyFrozenManifest?: (args: { repoRoot: string; manifestPath: string; baselineId: string }) => boolean;
  runSemanticCheck?: (args: { repoRoot: string }) => CheckResult;
  runTraceability?: (args: { repoRoot: string }) => CheckResult;
  runSpikeCheck?: (args: { repoRoot: string }) => CheckResult;
  runReferenceCheck?: (args: { repoRoot: string }) => CheckResult;
  runChangeControl?: (args: { repoRoot: string }) => CheckResult;
  readVerdict?: (args: { repoRoot: string }) => Verdict | null;
  runGenerateMap?: (args: { repoRoot: string; reconcileAgainst?: string | null }) => MapResult;
  mapReview?: (args: MapReviewArgs) => Promise<MapReviewAggregate>;
  emitStatus?: (status: StatusEvent, repoRoot: string) => void;
  commitCorpus?: (args: { repoRoot: string; baselineId: string }) => { committed?: boolean } | undefined;
  commitSpecSnapshot?: (args: { repoRoot: string }) => { committed: boolean };
  runSpikeProving?: (args: SpikeProvingArgs) => Promise<SpikeProvingResult>;
}

interface SpawnExtractorArgs {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  cfg: Record<string, unknown>;
  attempt: number;
  checkOutput: string | null;
  isFix: boolean;
  spikeMode: string;
  mapMode: string;
}

interface SpawnVerifierArgs {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  cfg: Record<string, unknown>;
  attempt: number;
}

interface MapReviewArgs {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  cfg: Record<string, unknown>;
  attempt: number;
}

interface SpawnLensArgs {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  cfg: unknown;
  attempt: number;
  lens: MapReviewLens;
}

interface StatusEvent {
  phase: string;
  attempt?: number;
  spike_mode?: string;
  map_mode?: string;
  spike_proving?: SpikeProvingSummary;
  unverified_spike_gate_ids?: string[];
  summary?: string;
}

interface SpikeProvingSummary {
  proved: number;
  failed: number;
  skipped: number;
}

interface ExtractionResult {
  status: "green" | "extraction_blocked" | "blocked_on_unverified_spikes";
  attempts: number;
  manifestPath: string;
  baselineId: string;
  froze: boolean;
  spike_mode: string;
  map_mode: string;
  spike_proving: SpikeProvingSummary;
  transcripts: string[];
  summary: string;
  checks?: { semantic: CheckResult; traceability: CheckResult } | null;
  verdict?: Verdict | null;
  map?: MapResult | null;
  unverified_spike_gate_ids?: string[];
  reopened?: string[];
  committed?: boolean;
  timeoutReason?: string;
}

export async function extractIssues(options: ExtractIssuesOptions = {}): Promise<ExtractionResult> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to extract, or pass options.repoRoot.",
    );
  }
  const maxRetries = Number.isInteger(options.maxRetries) ? (options.maxRetries as number) : DEFAULT_MAX_RETRIES;
  const version = options.version ?? resolveFreezeVersion(repoRoot);
  const openCycle = readSpecCycle(repoRoot);
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  // resolveAgentLegs enforces implementer != reviewer CLI: the fidelity verifier must never be the extractor, or the check becomes self-review.
  const legs: ResolvedLegs = resolveAgentLegs(process.env);
  const spawnExtractor =
    options.spawnExtractor ?? options.spawnAgent ?? makeDefaultSpawnExtractor(options, cfg, legs);
  const spawnVerifier = options.spawnVerifier ?? makeDefaultSpawnVerifier(options, cfg, legs);
  const runFreeze = options.runFreeze ?? defaultRunFreeze;
  const verifyFrozenManifest = options.verifyFrozenManifest ?? defaultVerifyFrozenManifest;
  const runSemanticCheck = options.runSemanticCheck ?? defaultRunSemanticCheck;
  const runTraceability = options.runTraceability ?? defaultRunTraceability;
  const runSpikeCheck = options.runSpikeCheck ?? defaultRunSpikeCheck;
  const runReferenceCheck = options.runReferenceCheck ?? defaultRunReferenceCheck;
  const runChangeControl = options.runChangeControl ?? defaultRunChangeControl;
  const readVerdict = options.readVerdict ?? defaultReadVerdict;
  const runGenerateMap = options.runGenerateMap ?? defaultRunGenerateMap;
  const mapReview = options.mapReview ?? makeDefaultMapReview(options, cfg, legs);
  const emitStatus = options.emitStatus ?? defaultEmitStatus;
  const commitCorpus = options.commitCorpus ?? defaultCommitCorpus;
  const commitSpecSnapshot = options.commitSpecSnapshot ?? defaultCommitSpecSnapshot;
  const runSpikeProvingStage: (args: SpikeProvingArgs) => Promise<SpikeProvingResult> =
    options.runSpikeProving ?? (runSpikeProving as unknown as (args: SpikeProvingArgs) => Promise<SpikeProvingResult>);

  const transcripts: string[] = [];
  const record = (status: StatusEvent) => emitStatus(status, repoRoot);

  const spikeProving = await runSpikeProvingStage({ repoRoot, legs, cfg, recordEvent: null });
  const spikeProvingSummary: SpikeProvingSummary = {
    proved: spikeProving.proved.length,
    failed: spikeProving.failed.length,
    skipped: spikeProving.skipped.length,
  };

  // Freeze must precede any record(): extraction-status.json lives under a tracked path, and doc-baseline refuses to freeze a dirty tree.
  let frozen: FrozenBaseline | null = findFrozenManifest(repoRoot);
  let froze = false;
  if (frozen && !verifyFrozenManifest({ repoRoot, manifestPath: frozen.manifestPath, baselineId: frozen.baselineId })) {
    frozen = null;
  }
  if (openCycle && frozen) {
    throw new Error(
      `extract-issues: drafting cycle ${openCycle.id} is open but the canonical has not changed — write the spec evolution (via Vivi) before extracting, or cancel the cycle`,
    );
  }
  if (!frozen) {
    commitSpecSnapshot({ repoRoot });
    frozen = await runFreeze({ repoRoot, version, approvalRef: openCycle?.id });
    froze = true;
  }
  if (froze && openCycle) {
    clearSpecCycle(repoRoot);
    notify({
      level: "info",
      stage: "cycle",
      event: "cycle_closed_by_freeze",
      message: `drafting cycle ${openCycle.id} closed by the freeze (${frozen.baselineId})`,
    });
  }
  let { manifestPath, baselineId } = frozen;

  let lastChecks: Checks | null = null;
  let lastMap: MapResult | null = null;
  let lastVerdict: Verdict | null = null;
  let lastMapReview: MapReviewAggregate | null = null;
  let lastTimeoutReason: string | null = null;
  const maxAttempts = maxRetries + 1;
  // Snapshot taken before the extractor can touch the map, so runGenerateMap's reconcileAgainst can self-heal layout_* fields back to it afterward.
  const mapAbs = resolve(repoRoot, ".vivicy/architecture-map/architecture-map.yml");
  let layoutBaselinePath: string | null = null;
  const mapMode = existsSync(mapAbs) ? "reused" : "authored";
  if (mapMode === "reused") {
    layoutBaselinePath = join(mkdtempSync(join(tmpdir(), "vivicy-map-")), "baseline.yml");
    writeFileSync(layoutBaselinePath, readFileSync(mapAbs, "utf8"));
  }
  const spikeMode = readSpikes(repoRoot).length > 0 ? "integrate" : "extract";
  // Snapshot taken before re-authoring overwrites source-map.json, so Change-Control reopening (runReopen) can diff prior vs current deterministically.
  const sourceMapAbs = resolve(repoRoot, ".vivicy/requirements/source-map.json");
  const priorSourceMap = readJsonOrNull(sourceMapAbs);

  const verifiedGates = transitivelyVerifiedGates(repoRoot);
  const unverifiedRequiredGates = readSpikes(repoRoot)
    .filter((spike) => spike.status !== "deferred" && !verifiedGates.has(spike.gate_id))
    .map((spike) => spike.gate_id);
  if (unverifiedRequiredGates.length > 0) {
    const status: ExtractionResult = {
      status: "blocked_on_unverified_spikes",
      attempts: 0,
      manifestPath,
      baselineId,
      froze,
      spike_mode: spikeMode,
      map_mode: mapMode,
      spike_proving: spikeProvingSummary,
      unverified_spike_gate_ids: unverifiedRequiredGates,
      transcripts,
      summary:
        `blocked_on_unverified_spikes: issue extraction refuses to run while ${unverifiedRequiredGates.length} ` +
        `required spike(s) are not transitively verified: ${unverifiedRequiredGates.join(", ")}. ` +
        `Prove or defer them (S3) before extraction (S6).`,
    };
    record({ phase: "blocked_on_unverified_spikes", spike_proving: spikeProvingSummary, unverified_spike_gate_ids: unverifiedRequiredGates, summary: status.summary });
    return status;
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isFix = attempt > 1;
    record({ phase: isFix ? "fixing" : "authoring", attempt });

    const fixContext = isFix
      ? [
          formatFixContext(lastChecks, lastVerdict, lastMap),
          lastMapReview?.actionable?.length ? formatMapReviewFix(lastMapReview.actionable) : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : null;
    const leg = await spawnExtractor({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput: fixContext, isFix, spikeMode, mapMode });
    if (leg?.transcriptRel) transcripts.push(leg.transcriptRel);
    lastTimeoutReason = legTimeoutReason(leg) ?? lastTimeoutReason;

    if (!verifyFrozenManifest({ repoRoot, manifestPath, baselineId })) {
      record({ phase: "refreezing", attempt });
      commitSpecSnapshot({ repoRoot });
      const refrozen = await runFreeze({ repoRoot, version: resolveFreezeVersion(repoRoot), approvalRef: openCycle?.id });
      if (openCycle && readSpecCycle(repoRoot)) {
        clearSpecCycle(repoRoot);
        notify({
          level: "info",
          stage: "cycle",
          event: "cycle_closed_by_freeze",
          message: `drafting cycle ${openCycle.id} closed by the freeze (${refrozen.baselineId})`,
        });
      }
      manifestPath = refrozen.manifestPath;
      baselineId = refrozen.baselineId;
      lastChecks = null;
      lastMap = null;
      lastVerdict = null;
      continue;
    }

    record({ phase: "validating", attempt });
    const semantic = runSemanticCheck({ repoRoot });
    const traceability = runTraceability({ repoRoot });
    const spike = runSpikeCheck({ repoRoot });
    const reference = runReferenceCheck({ repoRoot });
    const changeControl = runChangeControl({ repoRoot });
    lastChecks = { semantic, traceability, spike, reference, changeControl, attempt };
    const deterministicGreen =
      semantic.exitCode === 0 &&
      traceability.exitCode === 0 &&
      spike.exitCode === 0 &&
      reference.exitCode === 0 &&
      changeControl.exitCode === 0 &&
      !semantic.placeholder;
    if (!deterministicGreen) {
      lastMap = null;
      lastVerdict = null;
      lastMapReview = null;
      continue;
    }

    // Hard gate, not a post-green afterthought: a non-parsing architecture-map.yml (exit != 0) is NOT green — its error feeds back to the extractor.
    record({ phase: "mapping", attempt });
    const map = runGenerateMap({ repoRoot, reconcileAgainst: layoutBaselinePath });
    lastMap = map;
    if (map.code !== 0) {
      lastVerdict = null;
      lastMapReview = null;
      continue;
    }

    record({ phase: "verifying", attempt });
    clearVerdict(repoRoot);
    const verifierLeg = await spawnVerifier({ repoRoot, manifestPath, baselineId, cfg, attempt });
    if (verifierLeg?.transcriptRel) transcripts.push(verifierLeg.transcriptRel);
    lastTimeoutReason = legTimeoutReason(verifierLeg) ?? lastTimeoutReason;
    const verdict = readVerdict({ repoRoot });
    lastVerdict = verdict;
    clearVerdict(repoRoot);
    const faithful = verdict?.faithful === true;
    if (!faithful) {
      lastMapReview = null;
      continue;
    }

    record({ phase: "map-review", attempt });
    const review = await mapReview({ repoRoot, manifestPath, baselineId, cfg, attempt });
    for (const lensLeg of review.legs ?? []) {
      if (lensLeg?.transcriptRel) transcripts.push(lensLeg.transcriptRel);
    }
    lastMapReview = review;
    if (review.actionable.length > 0) {
      continue;
    }

    let reopened: string[] = [];
    if (priorSourceMap) {
      const currentSourceMap = readJsonOrNull(sourceMapAbs);
      if (currentSourceMap) reopened = runReopen({ repoRoot, priorSourceMap, currentSourceMap }).reopened;
    }

    const status: ExtractionResult = {
      status: "green",
      attempts: attempt,
      manifestPath,
      baselineId,
      froze,
      spike_mode: spikeMode,
      map_mode: mapMode,
      spike_proving: spikeProvingSummary,
      checks: { semantic, traceability },
      verdict,
      map,
      transcripts,
      ...(reopened.length ? { reopened } : {}),
      summary: `extraction green after ${attempt} attempt(s): ${countIssues(repoRoot)} issue(s); deterministic checks pass; map regenerated; verifier faithful:true; map review clean${reopened.length ? `; reopened ${reopened.length} impacted issue(s)` : ""}; corpus committed`,
    };
    record({ phase: "green", attempt, spike_mode: spikeMode, map_mode: mapMode, summary: status.summary });
    recordExtractedGateCommand(repoRoot);
    const commit = commitCorpus({ repoRoot, baselineId });
    status.committed = commit?.committed ?? false;
    return status;
  }

  const status: ExtractionResult = {
    status: "extraction_blocked",
    attempts: maxAttempts,
    manifestPath,
    baselineId,
    froze,
    spike_mode: spikeMode,
    map_mode: mapMode,
    spike_proving: spikeProvingSummary,
    checks: lastChecks ? { semantic: lastChecks.semantic, traceability: lastChecks.traceability } : null,
    map: lastMap,
    verdict: lastVerdict,
    transcripts,
    ...(lastTimeoutReason ? { timeoutReason: lastTimeoutReason } : {}),
    summary:
      `extraction_blocked: the extraction was still not green after ${maxAttempts} attempt(s). ` +
      (lastTimeoutReason ? `A leg was killed: ${lastTimeoutReason}. ` : "") +
      formatFixContext(lastChecks, lastVerdict, lastMap),
  };
  record({ phase: "extraction_blocked", attempt: maxAttempts, spike_mode: spikeMode, map_mode: mapMode, summary: status.summary });
  return status;
}

function legTimeoutReason(leg: LegResult | undefined): string | null {
  return leg?.result?.timedOut ? leg.result.timeoutReason || "leg timed out" : null;
}

function extractionIssue(): ExtractionIssue {
  return { id: EXTRACTOR_ISSUE_ID, graph_refs: ["node:extraction"], path: ISSUE_INDEX_REL };
}

function makeDefaultSpawnExtractor(options: ExtractIssuesOptions, baseCfg: Record<string, unknown>, legs: ResolvedLegs): (args: SpawnExtractorArgs) => Promise<LegResult> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const implementer = legs?.implementer ?? { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg = { ...implementer, role: "extractor" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput, isFix, spikeMode, mapMode }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const specKind = readManifestSpecKind(repoRoot, manifestPath);
    const context = extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix, spikeMode, mapMode, specKind });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

function readManifestSpecKind(repoRoot: string, manifestPath: string): SpecKind {
  try {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8")) as { spec_kind?: unknown };
    if (manifest.spec_kind === "project" || manifest.spec_kind === "feature") return manifest.spec_kind;
  } catch {
  }
  return detectSpecKind(repoRoot);
}

function makeDefaultSpawnVerifier(options: ExtractIssuesOptions, baseCfg: Record<string, unknown>, legs: ResolvedLegs): (args: SpawnVerifierArgs) => Promise<LegResult> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const reviewer = legs?.reviewer ?? { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false };
  const leg = { ...reviewer, role: "extraction-verifier" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = verifierContext({ manifestPath, baselineId, attempt });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

function runLegForProvider(leg: Leg, issue: ExtractionIssue, legCfg: Record<string, unknown>, deps: LegDeps): LegRunResult {
  const cfg = legCfg as unknown as LegConfig;
  if (leg.provider === "codex") return runCodexLeg(leg, issue, cfg, deps);
  return runClaudeLeg(leg, issue, cfg, deps);
}

function makeDefaultSpawnLens(options: ExtractIssuesOptions, baseCfg: Record<string, unknown>, legs: ResolvedLegs): (args: SpawnLensArgs) => Promise<LegRunResult> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const reviewer = legs?.reviewer ?? { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false };
  const leg = { ...reviewer, role: "map-review" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, lens }) => {
    const legCfg = { ...(cfg as Record<string, unknown>), promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = mapReviewLensContext({ lens, manifestPath, baselineId });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function defaultReadMapFindings({ repoRoot, lensKey }: { repoRoot: string; lensKey: string }): LensFindings {
  const abs = resolve(repoRoot, mapReviewReportRel(lensKey));
  if (!existsSync(abs)) return { findings: [] };
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as LensFindings;
  } catch {
    return { findings: [] };
  }
}

function makeDefaultMapReview(options: ExtractIssuesOptions, cfg: Record<string, unknown>, legs: ResolvedLegs): (args: MapReviewArgs) => Promise<MapReviewAggregate> {
  const spawnLens = makeDefaultSpawnLens(options, cfg, legs);
  return async (args) => (await runMapReview({ ...args, spawnLens, readFindings: defaultReadMapFindings })) as MapReviewAggregate;
}

function extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix, spikeMode, mapMode, specKind }: { manifestPath: string; baselineId: string; attempt: number; checkOutput: string | null; isFix: boolean; spikeMode: string; mapMode: string; specKind?: SpecKind }): string {
  return (
    `\n\n---\n\n## Extraction context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). ` +
    `Read it for the exact corpus files + hashes to pin.\n` +
    (specKind
      ? `- Spec kind: **${specKind}** — ` +
        (specKind === "feature"
          ? `this repository already carries product code; the spec is an EVOLUTION of it. Scope issues to what the spec changes, respect the existing codebase's structure/conventions in issue plans, and never generate issues that re-specify what already exists outside the frozen canonical.\n`
          : `this repository carries no product code; the spec defines the whole product from scratch.\n`)
      : "") +
    `- Attempt: ${attempt}${isFix ? " (FIX pass)" : " (initial author)"}.\n` +
    `- Spike mode (S2): **${spikeMode}** — ` +
    (spikeMode === "integrate"
      ? `existing spikes are the authority; LINK them (back-fill requirement_ids, fix stale refs), NEVER rewrite/renumber/recreate them (see "Phase 0 spikes").\n`
      : `no spikes on disk; MINT any the spec requires following the Spike file shape (see "Phase 0 spikes").\n`) +
    `- Map mode (S5): **${mapMode}** — ` +
    (mapMode === "reused"
      ? `an architecture-map.yml already exists; UPDATE it in place, preserving every layout_* field verbatim, NEVER re-author from scratch (see "Architecture map").\n`
      : `no map on disk; AUTHOR one from the frozen canonical (see "Architecture map").\n`) +
    (checkOutput
      ? `\n### What to FIX this run\n\nThe previous corpus did NOT reach green — either a deterministic ` +
        `check failed or the INDEPENDENT fidelity verifier rejected it. Read every line, locate the exact ` +
        `file/field, and correct it without regressing the rest:\n\n` +
        "```text\n" +
        checkOutput +
        "\n```\n"
      : "")
  );
}

function verifierContext({ manifestPath, baselineId, attempt }: { manifestPath: string; baselineId: string; attempt: number }): string {
  return (
    `\n\n---\n\n## Fidelity verification context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). ` +
    `Read it for the authoritative corpus files + line numbers.\n` +
    `- Attempt under review: ${attempt}.\n` +
    `- Write your STRUCTURED verdict — and nothing else — to \`${VERDICT_REL}\`, ` +
    `as JSON \`{ "faithful": boolean, "problems": [{ "issue": string, "kind": string, "detail": string }] }\`. ` +
    `Do NOT edit any corpus file; report problems for the extractor to fix.\n`
  );
}

function legDepsForTarget(legCfg: Record<string, unknown>, issue: ExtractionIssue, repoRoot: string, context: string): LegDeps {
  const abs = (rel: string) => resolve(repoRoot, rel);
  return {
    composePrompt: (template: string, iss: AgentIssue) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot: repoRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir as string}/${issue.id}`),
    cwdFilter: null,
  };
}

function defaultVerifyFrozenManifest({ repoRoot, manifestPath, baselineId }: { repoRoot: string; manifestPath: string; baselineId: string }): boolean {
  const tool = resolve(FACTORY_DIR, "doc-baseline.ts");
  const r = spawnSync(
    "node",
    [tool, "verify", "--manifest", manifestPath, "--require-status", "frozen", "--require-baseline-id", baselineId, "--require-min-version", "1.0.0"],
    { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" },
  );
  return (r.status ?? 1) === 0;
}

function defaultRunFreeze({ repoRoot, version, approvalRef }: { repoRoot: string; version: string; approvalRef?: string }): FrozenBaseline {
  const tool = resolve(FACTORY_DIR, "doc-baseline.ts");
  const baselineId = `baseline-v${version}`;
  const args = [
    tool,
    "generate",
    "--version",
    version,
    "--status",
    "frozen",
    "--approved-by",
    "vivicy:extraction-orchestrator",
    "--approval-ref",
    approvalRef ?? `vivicy-extract-${new Date().toISOString()}`,
  ];
  const result = spawnSync("node", args, {
    cwd: repoRoot,
    env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`extract-issues: freeze failed (exit ${result.status}):\n${out}`);
  }
  const manifestPath = `${BASELINE_DIR}/${baselineId}.json`;
  if (!existsSync(resolve(repoRoot, manifestPath))) {
    throw new Error(`extract-issues: freeze reported success but ${manifestPath} is missing`);
  }
  return { manifestPath, baselineId };
}

function defaultRunSemanticCheck({ repoRoot }: { repoRoot: string }): CheckResult {
  return runSemanticExtractionCheck({ repoRoot });
}

function defaultRunTraceability({ repoRoot }: { repoRoot: string }): CheckResult {
  return runTraceabilityCheck({ repoRoot });
}

function defaultRunSpikeCheck({ repoRoot }: { repoRoot: string }): CheckResult {
  return runSpikeCheckImpl({ repoRoot });
}

function defaultRunChangeControl({ repoRoot }: { repoRoot: string }): CheckResult {
  return runChangeControlCheckImpl({ repoRoot });
}

function defaultRunReferenceCheck({ repoRoot }: { repoRoot: string }): CheckResult {
  return runReferenceCheckImpl({ repoRoot });
}

export function defaultReadVerdict({ repoRoot }: { repoRoot: string }): Verdict {
  const abs = resolve(repoRoot, VERDICT_REL);
  if (!existsSync(abs)) {
    return { faithful: false, problems: [{ issue: "*", kind: "no_verdict", detail: `verifier wrote no verdict at ${VERDICT_REL}` }] };
  }
  let parsed: { faithful?: unknown; problems?: unknown };
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    return {
      faithful: false,
      problems: [{ issue: "*", kind: "unparseable_verdict", detail: `verdict JSON is invalid: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  const faithful = parsed?.faithful === true;
  const problems = Array.isArray(parsed?.problems) ? (parsed.problems as VerdictProblem[]) : [];
  return { faithful, problems };
}

// Cleared both before a verifier leg and after each read: without the pre-clear, a dead/non-writing verifier leg would read back a stale faithful:true from a PRIOR attempt.
function clearVerdict(repoRoot: string): void {
  rmSync(resolve(repoRoot, VERDICT_REL), { force: true });
}

function defaultRunGenerateMap({ repoRoot, reconcileAgainst }: { repoRoot: string; reconcileAgainst?: string | null }): MapResult {
  const tool = resolve(FACTORY_DIR, "generate-viewer-data.ts");
  const args = [tool];
  if (reconcileAgainst) args.push("--reconcile-against", reconcileAgainst);
  const result = spawnSync("node", args, {
    cwd: repoRoot,
    env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot },
    encoding: "utf8",
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}

const NOTIFY_BY_PHASE: Record<string, { level: "info" | "success" | "warning" | "error"; stage: string; message: string }> = {
  spike_proving: { level: "info", stage: "S3", message: "proving spikes in the target repo" },
  authoring: { level: "info", stage: "S6", message: "extracting issues from the frozen canonical" },
  fixing: { level: "warning", stage: "S6", message: "re-prompting the extractor after red checks" },
  blocked_on_unverified_spikes: { level: "error", stage: "S3", message: "extraction refused: unverified spikes" },
  extraction_blocked: { level: "error", stage: "S6", message: "extraction blocked after bounded retries" },
  green: { level: "success", stage: "S7", message: "extraction green — corpus committed" },
};

function defaultEmitStatus(status: StatusEvent, repoRoot: string): void {
  const abs = resolve(repoRoot, EXTRACTION_STATUS_REL);
  mkdirSync(dirname(abs), { recursive: true });
  const payload = { ...status, updated_at: new Date().toISOString() };
  writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
  pruneGitkeeps(repoRoot);
  const mapped = NOTIFY_BY_PHASE[status?.phase];
  if (mapped) notify({ ...mapped, event: `extraction_${status.phase}` });
}

// If the extractor stated the project's real gate command from the canonical, fill vivicy.json — but only while it is the sentinel; never override an established command, never guess when the extractor stated nothing.
export function recordExtractedGateCommand(repoRoot: string): boolean {
  const reportAbs = resolve(repoRoot, GATE_COMMAND_REL);
  if (!existsSync(reportAbs)) return false;
  let stated: string | null;
  try {
    const parsed = JSON.parse(readFileSync(reportAbs, "utf8")) as { gateCommand?: unknown };
    stated = normalizeGateCommand(parsed?.gateCommand, GATE_COMMAND_REL);
  } catch {
    return false;
  }
  if (stated === null) return false;
  try {
    if (isGateCommandEstablished(loadProjectConfig(repoRoot))) return false;
    setGateCommand(repoRoot, stated);
    return true;
  } catch {
    return false;
  }
}

function defaultCommitCorpus({ repoRoot, baselineId }: { repoRoot: string; baselineId: string }): { committed: boolean } {
  ensureGitRepo(repoRoot);
  ensureLocalGitIdentity(repoRoot);
  pruneGitkeeps(repoRoot);
  const add = spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
  if ((add.status ?? 1) !== 0) {
    process.stderr.write(`extract-issues: git add -A failed: ${add.stderr || add.stdout}\n`);
    return { committed: false };
  }
  const message = `extraction: author corpus from frozen baseline ${baselineId}\n\nFrozen baseline + issues + catalog/matrix/index + architecture map; deterministic checks pass, fidelity verified.`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf8" });
  const out = `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`;
  if ((commit.status ?? 1) !== 0 && !/nothing to commit/i.test(out)) {
    process.stderr.write(`extract-issues: corpus commit failed: ${out.trim()}\n`);
    return { committed: false };
  }
  return { committed: true };
}

function runGit(repoRoot: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function ensureGitRepo(repoRoot: string): boolean {
  if (runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]).status === 0) return true;
  return runGit(repoRoot, ["init"]).status === 0;
}

function ensureLocalGitIdentity(repoRoot: string): void {
  if (runGit(repoRoot, ["config", "user.email"]).stdout.trim() === "") {
    runGit(repoRoot, ["config", "user.email", "vivicy@local"]);
  }
  if (runGit(repoRoot, ["config", "user.name"]).stdout.trim() === "") {
    runGit(repoRoot, ["config", "user.name", "Vivicy"]);
  }
}

function defaultCommitSpecSnapshot({ repoRoot }: { repoRoot: string }): { committed: boolean } {
  if (!ensureGitRepo(repoRoot)) {
    process.stderr.write("extract-issues: could not initialize a git repo for the spec snapshot\n");
    return { committed: false };
  }
  ensureLocalGitIdentity(repoRoot);
  const add = runGit(repoRoot, ["add", "-A"]);
  if (add.status !== 0) {
    process.stderr.write(`extract-issues: spec-snapshot git add -A failed: ${add.stderr || add.stdout}\n`);
    return { committed: false };
  }
  if (runGit(repoRoot, ["diff", "--cached", "--quiet"]).status === 0) {
    return { committed: false };
  }
  const message =
    "spec snapshot: commit canonical spec before freeze\n\n" +
    "Owner-authored .vivicy/canonical/** (+ any skeleton additions) committed mechanically " +
    "so the doc-baseline freeze sees a clean, committed tree. No human git step.";
  const commit = runGit(repoRoot, ["commit", "-m", message]);
  const out = `${commit.stdout}\n${commit.stderr}`;
  if (commit.status !== 0 && !/nothing to commit/i.test(out)) {
    process.stderr.write(`extract-issues: spec-snapshot commit failed: ${out.trim()}\n`);
    return { committed: false };
  }
  return { committed: true };
}

export function findFrozenManifest(repoRoot: string): FrozenBaseline | null {
  const dir = resolve(repoRoot, BASELINE_DIR);
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let manifest: { status?: unknown; superseded?: unknown; baseline_id?: unknown };
    try {
      manifest = JSON.parse(readFileSync(resolve(dir, entry), "utf8"));
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
      return { manifestPath: `${BASELINE_DIR}/${entry}`, baselineId: manifest.baseline_id };
    }
  }
  return null;
}

export function formatCheckOutput(checks: Checks | null): string {
  if (!checks) return "(no check output)";
  const parts: string[] = [];
  const { semantic, traceability } = checks;
  if (semantic) {
    parts.push(`semantic-extraction-check: ${semantic.summary ?? `exit ${semantic.exitCode}`}`);
    for (const e of semantic.errors ?? []) parts.push(`  error: ${e}`);
    for (const w of semantic.warnings ?? []) parts.push(`  warning: ${w}`);
    if (semantic.placeholder) parts.push("  note: issue index is still the pending-extraction placeholder (nothing authored)");
  }
  if (traceability) {
    parts.push(`traceability-check: ${traceability.summary ?? `exit ${traceability.exitCode}`}`);
    for (const e of traceability.errors ?? []) parts.push(`  error:\n${e}`);
  }
  const remaining: Array<[string, CheckResult | undefined]> = [
    ["spike-check", checks.spike],
    ["reference-check", checks.reference],
    ["change-control", checks.changeControl],
  ];
  for (const [name, check] of remaining) {
    if (!check || check.exitCode === 0) continue;
    parts.push(`${name}: ${check.summary ?? `exit ${check.exitCode}`}`);
    for (const e of check.errors ?? []) parts.push(`  error:\n${e}`);
  }
  return parts.join("\n");
}

export function formatVerdict(verdict: Verdict | null): string | null {
  if (!verdict) return null;
  if (verdict.faithful === true) return "fidelity-verifier: faithful:true";
  const parts = ["fidelity-verifier: faithful:false (independent verifier rejected the corpus)"];
  for (const p of verdict.problems ?? []) {
    const issue = p?.issue ?? "?";
    const kind = p?.kind ?? "fidelity";
    const detail = p?.detail ?? "";
    parts.push(`  problem [${issue}] ${kind}: ${detail}`);
  }
  if ((verdict.problems ?? []).length === 0) {
    parts.push("  problem: verifier reported faithful:false but listed no specific problems");
  }
  return parts.join("\n");
}

export function formatMapError(map: MapResult | null | undefined): string | null {
  if (!map || map.code === 0) return null;
  const detail = (map.output ?? "").trim();
  return (
    `architecture-map generation (generate-viewer-data.ts): FAILED (exit ${map.code})\n` +
    `  The authored .vivicy/architecture-map/architecture-map.yml did NOT parse into viewer data. ` +
    `Fix the map so generate-viewer-data.ts exits 0. Exact generator output:\n` +
    (detail ? `${detail.split("\n").map((l) => `  ${l}`).join("\n")}` : "  (no generator output captured)")
  );
}

export function formatFixContext(checks: Checks | null, verdict: Verdict | null, map?: MapResult | null): string {
  const blocks: string[] = [];
  if (checks) {
    const anyFailed =
      (checks.semantic && (checks.semantic.exitCode !== 0 || checks.semantic.placeholder)) ||
      [checks.traceability, checks.spike, checks.reference, checks.changeControl].some((c) => c && c.exitCode !== 0);
    if (anyFailed) blocks.push(formatCheckOutput(checks));
  }
  const mapBlock = formatMapError(map);
  if (mapBlock) blocks.push(mapBlock);
  const verdictBlock = formatVerdict(verdict);
  if (verdictBlock && verdict?.faithful !== true) blocks.push(verdictBlock);
  if (blocks.length === 0) return "(no check, map, or verdict output)";
  return blocks.join("\n\n");
}

function countIssues(repoRoot: string): number {
  try {
    const index = JSON.parse(readFileSync(resolve(repoRoot, ISSUE_INDEX_REL), "utf8")) as { issues?: unknown };
    return Array.isArray(index.issues) ? index.issues.length : 0;
  } catch {
    return 0;
  }
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to extract.",
    );
    process.exit(2);
  }
  extractIssues({ repoRoot })
    .then((result) => {
      console.log(result.summary);
      process.exit(result.status === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
