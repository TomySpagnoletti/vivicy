#!/usr/bin/env node
// Vivicy semantic issue EXTRACTION orchestrator: a two-agent loop that authors
// the issue corpus from a frozen canonical spec. An EXTRACTOR agent authors,
// deterministic checks gate, then an INDEPENDENT FIDELITY VERIFIER agent (the
// reviewer CLI, never the extractor) judges source fidelity. Pipeline:
//   1. FREEZE if needed   — reuse the frozen baseline or freeze .vivicy/canonical/**.
//   2. AUTHOR (extractor) — agent writes the full corpus from the frozen baseline.
//   3. VALIDATE           — deterministic checks + architecture-map generation.
//   4. VERIFY (verifier)  — independent agent judges fidelity, writes a verdict JSON.
//   5. FIX LOOP           — feed back to the extractor; extraction_blocked if exhausted.
//
// Gotcha (freeze-before-status): the freeze runs BEFORE any status is written.
// extraction-status.json lives under a tracked path; emitting it first would
// dirty the tree and trip doc-baseline's working-tree-clean guard. A live-run
// fragility this orchestrator hit and now structurally prevents.
//
// Gotcha (map-generation-as-gate): map generation is a GATE, not a post-green
// afterthought. A corpus whose architecture-map.yml the parser rejects (e.g. a
// top-level `clusters:` section) is NOT green; its exact error is fed back to the
// extractor. A prior run reported "green with map FAILED" because the map ran only
// after green — never as a gate — so a malformed map never triggered a fix.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.mjs";
import { notify } from "./notify.mjs";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.mjs";
import { runSemanticExtractionCheck } from "./semantic-extraction-check.mjs";
import { runTraceabilityCheck } from "./traceability-check.mjs";
import { readSpikes, runSpikeCheck as runSpikeCheckImpl, transitivelyVerifiedGates } from "./spike-check.mjs";
import { runSpikeProving } from "./spike-prover.mjs";
import { runReferenceCheck as runReferenceCheckImpl } from "./reference-check.mjs";
import { runChangeControlCheck as runChangeControlCheckImpl } from "./change-control.mjs";
import { runReopen } from "./reopen.mjs";
import { formatMapReviewFix, mapReviewLensContext, mapReviewReportRel, runMapReview } from "./map-review.mjs";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.mjs";

const BASELINE_DIR = ".vivicy/baselines";
const ISSUE_INDEX_REL = ".vivicy/development/issue-index.json";
const EXTRACTION_STATUS_REL = ".vivicy/development/reports/extraction-status.json";
// Where the independent fidelity verifier writes its structured verdict. A
// dedicated evidence file (NOT committed as corpus) the orchestrator reads to
// decide green vs. feed-back-to-extractor, and that a human/the UI can inspect.
const VERDICT_REL = ".vivicy/development/reports/extraction-fidelity-verdict.json";
const DEFAULT_FREEZE_VERSION = "1.0.0";
const DEFAULT_MAX_RETRIES = 3;

// The synthetic "issue" the agent legs run against. It is NOT a product issue
// (no product issues exist yet — that is what we are authoring); it is the leg's
// identity/transcript handle, so the shared spawn infra names the transcript and
// injects the actor/role env exactly as it does for a dev-loop leg.
const EXTRACTOR_ISSUE_ID = "EXTRACTION";

/**
 * Drive freeze -> author -> validate (checks + map gen) -> verify-fidelity -> fix
 * for the target project, as a two-agent loop (extractor authors, independent
 * verifier judges fidelity). The extraction is GREEN only when the deterministic
 * checks pass AND the architecture map generates cleanly (exit 0) AND the verdict
 * is faithful:true.
 *
 * Injectable seams (all default to the real tooling):
 *   spawnExtractor({ repoRoot, manifestPath, cfg, attempt, checkOutput, isFix })
 *       -> { transcriptRel?, output?, status? }   (authors/fixes the corpus)
 *   spawnVerifier({ repoRoot, manifestPath, baselineId, cfg, attempt })
 *       -> { transcriptRel?, output? }   (writes the structured fidelity verdict)
 *   runFreeze({ repoRoot, version })               -> { manifestPath, baselineId }
 *   runSemanticCheck({ repoRoot })                 -> { exitCode, errors, warnings, summary }
 *   runTraceability({ repoRoot })                  -> { exitCode, errors, summary }
 *   readVerdict({ repoRoot })                      -> { faithful, problems } | null
 *   runGenerateMap({ repoRoot })                   -> { code, output }   (mechanical GATE: code 0 required for green)
 *   emitStatus(status, repoRoot)                   -> persists extraction status
 *
 * `options.spawnAgent` is still accepted as a back-compat alias for
 * `options.spawnExtractor` (the extractor leg), so existing callers/tests keep
 * working.
 *
 * S2 spike mode (G12) and S5 map mode (G4) are decided from the pre-run corpus and
 * recorded in extraction-status.json so the UI/CLI can display which path S2/S5 took:
 *   - `spike_mode`: "integrate" when the owner already provided spikes (uploaded via G1
 *     or Vivi-written) so the extractor LINKS them, "extract" when it mints them.
 *   - `map_mode`: "reused" when an architecture-map.yml pre-exists so the extractor
 *     refines it in place, "authored" when it authors one from scratch.
 *
 * S3 spike proving (G3) runs BEFORE the freeze and S6 is gated on its result (G13):
 *   - `options.runSpikeProving` — injectable spike-proving stage (defaults to the real
 *     prover/verifier legs). It flips pending spikes to verified/failed in-place.
 *   - `spike_proving` (in the status) — { proved, failed, skipped } summary counts.
 *   - `status: "blocked_on_unverified_spikes"` — extraction REFUSES to author issues while
 *     any non-deferred spike is not transitively verified (with the offending gate_ids).
 *
 * @returns {{ status: "green"|"extraction_blocked"|"blocked_on_unverified_spikes", attempts,
 *             manifestPath, baselineId, checks, map, verdict, spike_mode, map_mode,
 *             spike_proving, transcripts, summary }}
 */
export async function extractIssues(options = {}) {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to extract, or pass options.repoRoot.",
    );
  }
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const version = options.version ?? DEFAULT_FREEZE_VERSION;
  const cfg = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  // The two legs are assigned to distinct CLIs (R12): implementer CLI = extractor,
  // reviewer CLI = verifier. resolveAgentLegs enforces the distinct-CLI invariant
  // so the agent that verifies fidelity never authored the corpus.
  const legs = resolveAgentLegs(process.env);
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
  // The independent per-lens architecture-map review (method Review Method): a fan-out of
  // domain-expert sub-agents over the generated map. Injectable for tests.
  const mapReview = options.mapReview ?? makeDefaultMapReview(options, cfg, legs);
  const emitStatus = options.emitStatus ?? defaultEmitStatus;
  // Mechanical corpus commit (Item 2): on a green extraction the orchestrator —
  // never a human — commits the whole authored corpus (frozen baseline + issues +
  // catalog/matrix/exclusions/index + regenerated map) so the user gets a clean,
  // committed tree with the live map straight from git. Injectable for tests.
  const commitCorpus = options.commitCorpus ?? defaultCommitCorpus;
  // Mechanical SPEC-SNAPSHOT commit (Item 2, before the freeze): the owner wrote the
  // canonical spec into .vivicy/canonical/** and clicked Extract — leaving a dirty (or
  // not-even-a-repo) tree. The freeze (doc-baseline --status frozen) demands a git
  // repo with a CLEAN committed tree, so BEFORE freezing the orchestrator ensures the
  // target is a repo (defensive `git init` if somehow not — the scaffold normally did
  // it) and commits any pending changes (the spec + any skeleton additions) as a clear
  // "spec snapshot". No human ever runs git. Injectable for tests.
  const commitSpecSnapshot = options.commitSpecSnapshot ?? defaultCommitSpecSnapshot;
  // S3 spike proving (G3): the substance-verification stage that flips pending spikes
  // to verified/failed by running their experiments in the target repo. It runs BEFORE
  // the freeze (S3 precedes S4) so a disproven hypothesis can correct the canonical
  // directly (truth-model rule 1, pre-baseline) without forcing a re-freeze loop.
  // Injectable so tests fake the legs; the default wires the real prover/verifier legs.
  const runSpikeProvingStage = options.runSpikeProving ?? runSpikeProving;

  const transcripts = [];
  const record = (status) => emitStatus(status, repoRoot);

  // S3 BEFORE S4 (critical sequence): prove the spikes' SUBSTANCE before the freeze.
  // A disproven hypothesis is a pre-baseline, truth-model rule-1 event — the prover
  // may correct the canonical directly (or the orchestrator drafts a CR) — so proving
  // must precede the freeze, or every correction would force a re-freeze loop. The spike
  // files it flips are committed into the spec snapshot below, so the freeze hashes the
  // settled corpus. recordEvent is null here (spikes are not graph items yet); the
  // resulting summary counts ride on extraction-status.json once the freeze lets us emit.
  const spikeProving = await runSpikeProvingStage({ repoRoot, legs, cfg, recordEvent: null });
  const spikeProvingSummary = {
    proved: spikeProving.proved.length,
    failed: spikeProving.failed.length,
    skipped: spikeProving.skipped.length,
  };

  // Freeze must precede every record(): doc-baseline refuses to cut a frozen
  // baseline on a dirty tree, and our own extraction-status.json lives under a
  // tracked path. So we resolve/freeze the baseline before writing anything, and
  // only THEN emit the first status. (extraction-status.json is also gitignored as
  // defence in depth — see the scaffold/fixture .gitignore — so even a stale copy
  // from a prior run never dirties the freeze.)
  let frozen = findFrozenManifest(repoRoot);
  let froze = false;
  // A reused frozen baseline must still match the CURRENT spec: if the owner edited
  // .vivicy/canonical/** since the freeze, its document_set_hash no longer verifies, so
  // the stale baseline is discarded and re-frozen below. Extraction NEVER authors
  // against a baseline that no longer matches the spec on disk.
  if (frozen && !verifyFrozenManifest({ repoRoot, manifestPath: frozen.manifestPath, baselineId: frozen.baselineId })) {
    frozen = null;
  }
  if (!frozen) {
    // Snapshot the owner's just-written spec BEFORE freezing: ensure the target is a
    // git repo (defensive `git init` — the scaffold normally already did it) and
    // commit any pending changes, so the freeze sees a CLEAN committed tree. The owner
    // writes the spec and clicks Extract; Vivicy commits it. No human git step. Only
    // needed on the freeze path — if a frozen baseline already exists we never touch
    // git here. Safe: `git add -A` respects the scaffold .gitignore (transcripts /
    // runtime / worktrees / node_modules are never committed); nothing-to-commit is a
    // no-op, never an error; no remote is touched.
    commitSpecSnapshot({ repoRoot });
    frozen = await runFreeze({ repoRoot, version });
    froze = true;
  }
  let { manifestPath, baselineId } = frozen;

  let lastChecks = null;
  let lastMap = null;
  let lastVerdict = null;
  let lastMapReview = null;
  // The most recent per-leg TIMEOUT reason (set by leg-timeout.mjs when the
  // extractor or verifier CLI was killed for overrunning the cap / going idle).
  // A timed-out leg authors nothing usable, so the deterministic gate fails and
  // the loop simply retries — it never hangs. We carry the reason so an eventual
  // extraction_blocked names the stall explicitly instead of looking like a
  // mysterious empty corpus.
  let lastTimeoutReason = null;
  const maxAttempts = maxRetries + 1; // the initial author + up to maxRetries fixes
  // Snapshot the owner's architecture-map layout BEFORE the extractor touches it, so
  // map generation can self-heal any node/edge the extractor moved back to the
  // owner's placement (never lost, never a block — see generate-viewer-data).
  const mapAbs = resolve(repoRoot, ".vivicy/architecture-map/architecture-map.yml");
  let layoutBaselinePath = null;
  // S5 map mode (G4): a map already on disk pre-run is REUSED (the extractor refines it
  // in place, preserving every layout_* field; the reconcile gate restores them anyway).
  // Otherwise the extractor AUTHORS one from scratch. Decided from the pre-run state.
  const mapMode = existsSync(mapAbs) ? "reused" : "authored";
  if (mapMode === "reused") {
    layoutBaselinePath = join(mkdtempSync(join(tmpdir(), "vivicy-map-")), "baseline.yml");
    writeFileSync(layoutBaselinePath, readFileSync(mapAbs, "utf8"));
  }
  // S2 spike mode (G12): owner-provided spikes (uploaded via G1 or Vivi-written) put S2
  // in INTEGRATE mode — the extractor treats them as the authority and only back-fills /
  // corrects what is stale, never re-mints. No spikes -> EXTRACT mode (mint from the
  // canonical). readSpikes indexes only WELL-FORMED spikes, so a byte-compatible imported
  // corpus (an existing project's 21 valid spikes) selects integrate deterministically.
  const spikeMode = readSpikes(repoRoot).length > 0 ? "integrate" : "extract";
  // Snapshot the PRIOR source-map before re-authoring overwrites it, so a Change-Control
  // re-extraction can deterministically reopen exactly the issues whose requirement excerpts
  // changed (see runReopen). Null on a first extraction (no prior, nothing to reopen).
  const sourceMapAbs = resolve(repoRoot, ".vivicy/requirements/source-map.json");
  const priorSourceMap = readJsonOrNull(sourceMapAbs);

  // G13 — extraction gated on VERIFIED spikes (S6 ordering). The diagram places issue
  // extraction after spike verification: a NON-DEFERRED spike that is not transitively
  // verified (pending/failed/blocked, or verified with an unverified gated_by chain) must
  // block extraction LOUDLY rather than letting issues be authored against unproven
  // ground. Deferred spikes never block — their dependents are gated in the dev loop
  // anyway (a deferred spike is an accepted, tracked deferral, not an open question). This
  // runs AFTER proving + the freeze, so the statuses reflect this run's proving.
  const verifiedGates = transitivelyVerifiedGates(repoRoot);
  const unverifiedRequiredGates = readSpikes(repoRoot)
    .filter((spike) => spike.status !== "deferred" && !verifiedGates.has(spike.gate_id))
    .map((spike) => spike.gate_id);
  if (unverifiedRequiredGates.length > 0) {
    const status = {
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

    // On a fix pass, feed BACK whatever made the previous attempt non-green: the
    // deterministic check output, the map-gen error, and/or the fidelity verdict.
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

    // Canonical contradiction resolution (extractor Pass 1): the extractor may EDIT
    // .vivicy/canonical/** to resolve a genuine contradiction. If it did, the frozen
    // baseline no longer matches the spec on disk — re-freeze + re-pin and re-author
    // against the corrected corpus, autonomously: no human, no change-request. The
    // re-freeze consumes an attempt, so the bounded loop still terminates.
    if (!verifyFrozenManifest({ repoRoot, manifestPath, baselineId })) {
      record({ phase: "refreezing", attempt });
      commitSpecSnapshot({ repoRoot });
      const refrozen = await runFreeze({ repoRoot, version });
      manifestPath = refrozen.manifestPath;
      baselineId = refrozen.baselineId;
      lastChecks = null;
      lastMap = null;
      lastVerdict = null;
      continue;
    }

    // The first verdict is fully mechanical: coverage / pins / DAG / schema (the
    // two checks) AND that the authored architecture-map.yml actually generates
    // into viewer data (exit 0). Run the checks first, then map generation; both
    // must pass before the fidelity verifier is worth spawning.
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
    // The semantic checker treats an unchanged placeholder index as exit 0 +
    // placeholder:true — the agent authored nothing usable. Treat it as a failed
    // attempt so the fix loop re-prompts rather than declaring success. A red
    // deterministic check short-circuits map-gen and the verifier (no point
    // generating a map or judging fidelity of a corpus that fails coverage/pins)
    // and re-prompts the extractor.
    if (!deterministicGreen) {
      lastMap = null;
      lastVerdict = null;
      lastMapReview = null;
      continue;
    }

    // Map generation is a GATE, not a post-green afterthought: a corpus whose
    // architecture-map.yml the parser rejects (e.g. an unsupported top-level
    // `clusters:` section) is NOT green. Feed the exact generator error back to the
    // EXTRACTOR like any other mechanical failure.
    record({ phase: "mapping", attempt });
    const map = runGenerateMap({ repoRoot, reconcileAgainst: layoutBaselinePath });
    lastMap = map;
    if (map.code !== 0) {
      lastVerdict = null;
      lastMapReview = null;
      continue;
    }

    // Independent fidelity verifier — the second verdict (source fidelity), the
    // half the deterministic checks cannot judge.
    record({ phase: "verifying", attempt });
    clearVerdict(repoRoot);
    const verifierLeg = await spawnVerifier({ repoRoot, manifestPath, baselineId, cfg, attempt });
    if (verifierLeg?.transcriptRel) transcripts.push(verifierLeg.transcriptRel);
    lastTimeoutReason = legTimeoutReason(verifierLeg) ?? lastTimeoutReason;
    const verdict = readVerdict({ repoRoot });
    lastVerdict = verdict;
    clearVerdict(repoRoot);
    // A missing/unparseable verdict is NOT faithful — never declare green without a
    // structured faithful:true from the independent verifier.
    const faithful = verdict?.faithful === true;
    if (!faithful) {
      // Fidelity failure: re-prompt the EXTRACTOR (not the verifier) to fix.
      lastMapReview = null;
      continue;
    }

    // Final gate — the independent per-lens map review (the method's Review Method): the
    // generated map is reviewed AS A SYSTEM by independent domain-expert sub-agents, one
    // lens each, never a human reviewing their output. Real findings flow back to the
    // EXTRACTOR (which fixes the map, or per Pass 1 the canonical it cites) like a fidelity
    // problem; an empty review is the last thing between the corpus and green.
    record({ phase: "map-review", attempt });
    const review = await mapReview({ repoRoot, manifestPath, baselineId, cfg, attempt });
    for (const lensLeg of review.legs ?? []) {
      if (lensLeg?.transcriptRel) transcripts.push(lensLeg.transcriptRel);
    }
    lastMapReview = review;
    if (review.actionable.length > 0) {
      continue;
    }

    // Deterministic Change-Control reopening: if this extraction re-ran over a CHANGED
    // baseline (a prior source-map existed), reopen exactly the issues whose requirement
    // excerpts changed or were removed — the orchestrator does this mechanically, never an
    // agent's recollection. A first extraction or an unchanged corpus reopens nothing.
    let reopened = [];
    if (priorSourceMap) {
      const currentSourceMap = readJsonOrNull(sourceMapAbs);
      if (currentSourceMap) reopened = runReopen({ repoRoot, priorSourceMap, currentSourceMap }).reopened;
    }

    const status = {
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
    // Emit the final green status FIRST, then commit MECHANICALLY — so the single
    // commit captures the whole corpus (frozen baseline + authored issues +
    // catalog/matrix/exclusions/index + regenerated map + the live extraction
    // status) and leaves a CLEAN tree (only gitignored files untracked). No human
    // commit step. `git add -A` is safe: the scaffold/fixture .gitignore covers the
    // complete never-commit set (transcripts/runtime/worktrees/node_modules).
    record({ phase: "green", attempt, spike_mode: spikeMode, map_mode: mapMode, summary: status.summary });
    const commit = commitCorpus({ repoRoot, baselineId });
    status.committed = commit?.committed ?? false;
    return status;
  }

  const status = {
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

// The timeout reason a leg result carries when leg-timeout.mjs killed it for
// overrunning the per-leg cap or going idle. Null for a normally-finished leg.
function legTimeoutReason(leg) {
  return leg?.result?.timedOut ? leg.result.timeoutReason || "leg timed out" : null;
}

// ---------------------------------------------------------------------------
// Default seams (the real tooling)
// ---------------------------------------------------------------------------

// The synthetic issue both legs run against (transcript + actor/role identity handle).
function extractionIssue() {
  return { id: EXTRACTOR_ISSUE_ID, graph_refs: ["node:extraction"], path: ISSUE_INDEX_REL };
}

// Build the real EXTRACTOR seam: drive the implementer CLI (Claude by default)
// with the extractor prompt. The CLI follows the configured role assignment via
// `legs.implementer` (resolveAgentLegs), so the extractor CLI/model/effort track
// the same settings the dev-loop honors.
function makeDefaultSpawnExtractor(options, baseCfg, legs) {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  // The extractor is the IMPLEMENTER-role CLI, re-roled to "extractor" so it reads
  // extractor.md and names its transcript / actor identity for extraction.
  const implementer = legs?.implementer ?? { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg = { ...implementer, role: "extractor" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput, isFix, spikeMode, mapMode }) => {
    // The leg cfg points the shared spawn infra at the TARGET repo for the
    // transcript store and at the factory prompts for the role prompt. abs/execRoot
    // resolve against the target so the agent runs inside the project it extracts.
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix, spikeMode, mapMode });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// Build the real VERIFIER seam: drive the REVIEWER CLI (Codex by default) with
// the independent fidelity-verifier prompt. resolveAgentLegs guarantees the
// reviewer CLI differs from the implementer CLI, so the agent that judges fidelity
// never authored the corpus — the same distinct-agent invariant the dev-loop
// enforces for implement+review.
function makeDefaultSpawnVerifier(options, baseCfg, legs) {
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

// Dispatch a leg to the shared spawn helper for its assigned CLI. Both legs reuse
// the SAME reviewer/implementer-leg infra the dev-loop uses (runClaudeLeg /
// runCodexLeg via agent-spawn.mjs) — the extractor through the Claude/implementer
// path, the verifier through the Codex/reviewer path — so neither the flags, the
// MCP wiring, nor the transcript capture are duplicated here.
function runLegForProvider(leg, issue, legCfg, deps) {
  if (leg.provider === "codex") return runCodexLeg(leg, issue, legCfg, deps);
  return runClaudeLeg(leg, issue, legCfg, deps);
}

// Build the real per-lens MAP-REVIEW seam: one REVIEWER-CLI leg per lens, each reading
// map-review.md with its lens injected via context and writing a per-lens findings file.
// The reviewer CLI differs from the extractor CLI (the same distinct-agent invariant the
// fidelity verifier uses), so the agents that review the map never authored it. Each leg's
// transcript carries a unique UUID, so the shared "map-review" role does not collide.
function makeDefaultSpawnLens(options, baseCfg, legs) {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const reviewer = legs?.reviewer ?? { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false };
  const leg = { ...reviewer, role: "map-review" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, lens }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = mapReviewLensContext({ lens, manifestPath, baselineId });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// Parse a JSON file, or null if it is missing or unparseable.
function readJsonOrNull(abs) {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

// Read one lens's structured findings; a missing or unparseable file means that lens
// surfaced nothing, so it never blocks the run.
function defaultReadMapFindings({ repoRoot, lensKey }) {
  const abs = resolve(repoRoot, mapReviewReportRel(lensKey));
  if (!existsSync(abs)) return { findings: [] };
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return { findings: [] };
  }
}

// Bind the real per-lens spawn + findings read into the pure map-review fan-out.
function makeDefaultMapReview(options, cfg, legs) {
  const spawnLens = makeDefaultSpawnLens(options, cfg, legs);
  return (args) => runMapReview({ ...args, spawnLens, readFindings: defaultReadMapFindings });
}

// Extra prompt context for the EXTRACTOR leg: the frozen baseline, the resolved S2
// spike mode (G12) and S5 map mode (G4), + (on a fix pass) the exact
// deterministic-check output and/or fidelity-verdict problems.
function extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix, spikeMode, mapMode }) {
  return (
    `\n\n---\n\n## Extraction context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). ` +
    `Read it for the exact corpus files + hashes to pin.\n` +
    `- Attempt: ${attempt}${isFix ? " (FIX pass)" : " (initial author)"}.\n` +
    `- Spike mode (S2): **${spikeMode}** — ` +
    (spikeMode === "integrate"
      ? `existing spikes are the authority; LINK them (back-fill requirement_ids, fix stale refs), NEVER rewrite/renumber/recreate them (see "Phase 0 spikes").\n`
      : `no spikes on disk; MINT any the spec requires from SPIKE-TEMPLATE.md (see "Phase 0 spikes").\n`) +
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

// Extra prompt context for the VERIFIER leg: where the corpus + manifest are, and
// where to WRITE its structured verdict. The verifier writes ONLY the verdict file
// (it never edits the corpus — fixes flow back to the extractor).
function verifierContext({ manifestPath, baselineId, attempt }) {
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

// Bind the shared leg runner to the TARGET repo's roots, and inject the
// run-specific prompt context by wrapping composePrompt so the appended context
// rides on the role prompt the shared runner reads.
function legDepsForTarget(legCfg, issue, repoRoot, context) {
  const abs = (rel) => resolve(repoRoot, rel);
  return {
    composePrompt: (template, iss) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot: repoRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir}/${issue.id}`),
    cwdFilter: null,
  };
}

// Freeze .vivicy/canonical/** at the given version via the existing doc-baseline tool.
// We shell out to it (rather than import) so the corpus-policy + git-clean +
// approval guards it owns run exactly as in production. A frozen baseline needs
// owner-approval evidence; for an unattended first freeze we pass a recorded
// self-approval reference so the manifest is auditable (the owner froze by
// invoking extraction). The git-clean guard still applies — a frozen baseline must
// be cut from a committed tree.
// Verify a found frozen manifest still matches the current spec on disk: doc-baseline
// verify recomputes document_set_hash from .vivicy/canonical/** and fails on a mismatch
// (the owner edited the spec since the freeze) — the signal to re-freeze.
function defaultVerifyFrozenManifest({ repoRoot, manifestPath, baselineId }) {
  const tool = resolve(FACTORY_DIR, "doc-baseline.mjs");
  const r = spawnSync(
    "node",
    [tool, "verify", "--manifest", manifestPath, "--require-status", "frozen", "--require-baseline-id", baselineId, "--require-min-version", "1.0.0"],
    { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" },
  );
  return (r.status ?? 1) === 0;
}

function defaultRunFreeze({ repoRoot, version }) {
  const tool = resolve(FACTORY_DIR, "doc-baseline.mjs");
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
    `vivicy-extract-${new Date().toISOString()}`,
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

function defaultRunSemanticCheck({ repoRoot }) {
  return runSemanticExtractionCheck({ repoRoot });
}

function defaultRunTraceability({ repoRoot }) {
  return runTraceabilityCheck({ repoRoot });
}

function defaultRunSpikeCheck({ repoRoot }) {
  return runSpikeCheckImpl({ repoRoot });
}

function defaultRunChangeControl({ repoRoot }) {
  return runChangeControlCheckImpl({ repoRoot });
}

function defaultRunReferenceCheck({ repoRoot }) {
  return runReferenceCheckImpl({ repoRoot });
}

// Read the independent verifier's structured fidelity verdict. The verdict is the
// authority on FIDELITY (source faithfulness), the half the deterministic checks
// cannot judge. A missing or unparseable file is NOT faithful: we return a verdict
// that says so, with an explicit problem the extractor can act on, so a verifier
// that wrote nothing usable can never be mistaken for a passing run.
export function defaultReadVerdict({ repoRoot }) {
  const abs = resolve(repoRoot, VERDICT_REL);
  if (!existsSync(abs)) {
    return { faithful: false, problems: [{ issue: "*", kind: "no_verdict", detail: `verifier wrote no verdict at ${VERDICT_REL}` }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    return {
      faithful: false,
      problems: [{ issue: "*", kind: "unparseable_verdict", detail: `verdict JSON is invalid: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  // Honest shape coercion: faithful is true ONLY when the boolean is exactly true;
  // anything else (missing, truthy-but-not-true, string "true") is treated as not
  // faithful so a malformed verdict never green-lights the extraction.
  const faithful = parsed?.faithful === true;
  const problems = Array.isArray(parsed?.problems) ? parsed.problems : [];
  return { faithful, problems };
}

// The fidelity verdict is a transient verifier->orchestrator handoff, not a durable
// report — its result is folded into extraction-status.json (the single report). Cleared
// before a verifier leg (a dead verifier then reads as no_verdict, not a stale pass) and
// after each read (so the reports dir keeps only extraction-status.json).
function clearVerdict(repoRoot) {
  rmSync(resolve(repoRoot, VERDICT_REL), { force: true });
}

// Regenerate the viewer's architecture-data.json. generate-viewer-data.ts is a TS
// entry the project runs via the same node-with-TS path the rest of the factory
// uses; we shell out and surface its exit code.
function defaultRunGenerateMap({ repoRoot, reconcileAgainst }) {
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

// Persist a small, honest extraction-status report so the UI/map can show where
// extraction is (authoring / validating / fixing / green / blocked). This is a
// dedicated status surface, NOT the per-issue progress ledger (which is keyed by
// graph items of issues that do not exist until extraction finishes).
// Extraction phases mirrored to the notification log (P9) — observability only,
// a no-op unless the launcher passed VIVICY_RUNTIME_DIR; the status file stays
// the source of truth.
const NOTIFY_BY_PHASE = {
  spike_proving: { level: "info", stage: "S3", message: "proving spikes in the target repo" },
  authoring: { level: "info", stage: "S6", message: "extracting issues from the frozen canonical" },
  fixing: { level: "warning", stage: "S6", message: "re-prompting the extractor after red checks" },
  blocked_on_unverified_spikes: { level: "error", stage: "S3", message: "extraction refused: unverified spikes" },
  extraction_blocked: { level: "error", stage: "S6", message: "extraction blocked after bounded retries" },
  green: { level: "success", stage: "S7", message: "extraction green — corpus committed" },
};

function defaultEmitStatus(status, repoRoot) {
  const abs = resolve(repoRoot, EXTRACTION_STATUS_REL);
  mkdirSync(dirname(abs), { recursive: true });
  const payload = { ...status, updated_at: new Date().toISOString() };
  writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
  const mapped = NOTIFY_BY_PHASE[status?.phase];
  if (mapped) notify({ ...mapped, event: `extraction_${status.phase}` });
}

// Commit the whole authored corpus MECHANICALLY on a green extraction (Item 2): the
// frozen baseline, the authored issues, the catalog/matrix/exclusions/index, and
// the regenerated architecture-map data — everything Vivicy produced — in one
// commit, so the run ends with a committed corpus and a clean tree. Today a human
// had to commit this; now the orchestrator does. `git add -A` is safe because the
// .gitignore covers the complete never-commit set (transcripts/runtime/worktrees/
// node_modules). A no-op commit (nothing staged, e.g. re-running a green extraction
// whose corpus is already committed) is tolerated. Returns { committed } so the
// caller/tests can assert the commit happened.
function defaultCommitCorpus({ repoRoot, baselineId }) {
  ensureGitRepo(repoRoot);
  ensureLocalGitIdentity(repoRoot);
  const add = spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
  if ((add.status ?? 1) !== 0) {
    process.stderr.write(`extract-issues: git add -A failed: ${add.stderr || add.stdout}\n`);
    return { committed: false };
  }
  const message = `extraction: author corpus from frozen baseline ${baselineId}\n\nFrozen baseline + issues + catalog/matrix/index + architecture map; deterministic checks pass, fidelity verified.`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf8" });
  // A no-op commit (nothing to commit) exits non-zero; treat "nothing to commit" as
  // already-committed (still a clean tree), not a failure.
  const out = `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`;
  if ((commit.status ?? 1) !== 0 && !/nothing to commit/i.test(out)) {
    process.stderr.write(`extract-issues: corpus commit failed: ${out.trim()}\n`);
    return { committed: false };
  }
  return { committed: true };
}

// Run `git <args>` in repoRoot and report status + combined output.
function runGit(repoRoot, args) {
  const r = spawnSync("git", args, { cwd: repoRoot, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// Defensive: make sure repoRoot is a git repo before we try to commit. The scaffold
// normally `git init`-s a from-scratch target already, so this is belt-and-braces for
// the edge case where the owner pointed extraction at a never-initialized dir. We
// never touch an existing repo's history — `git init` on an already-initialized repo
// is a harmless no-op. Returns true when repoRoot is (now) a repo.
function ensureGitRepo(repoRoot) {
  if (runGit(repoRoot, ["rev-parse", "--is-inside-work-tree"]).status === 0) return true;
  return runGit(repoRoot, ["init"]).status === 0;
}

// Set a LOCAL (repo-scoped) git identity only when none is configured, so the
// mechanical commit succeeds on a fresh machine with no global git identity. We never
// clobber an existing global/local identity — we only fill the gap. `git commit` fails
// hard without an identity; this closes that failure mode without any human config.
function ensureLocalGitIdentity(repoRoot) {
  if (runGit(repoRoot, ["config", "user.email"]).stdout.trim() === "") {
    runGit(repoRoot, ["config", "user.email", "vivicy@local"]);
  }
  if (runGit(repoRoot, ["config", "user.name"]).stdout.trim() === "") {
    runGit(repoRoot, ["config", "user.name", "Vivicy"]);
  }
}

// Mechanical SPEC-SNAPSHOT commit, run BEFORE the freeze. The owner writes the
// canonical spec into .vivicy/canonical/** and clicks Extract — leaving a dirty (or
// not-even-a-repo) tree. The freeze (doc-baseline --status frozen) requires a git repo
// with a CLEAN committed tree, so here the orchestrator — never a human — ensures the
// target is a repo (defensive `git init`), configures a local identity if the machine
// has none, and commits any pending changes as a clear "spec snapshot". Safety:
//   - `git add -A` respects the scaffold/fixture .gitignore (transcripts / runtime /
//     worktrees / node_modules are never committed).
//   - "nothing to commit" (an already-clean repo, e.g. the scaffold already committed
//     the skeleton and the owner edited nothing yet, or a re-run) is a no-op, NOT an
//     error — no redundant empty commit is created.
//   - No remote is ever contacted; nothing is force-pushed.
// Returns { committed: boolean } — true when a snapshot commit was made, false when
// the tree was already clean (nothing to snapshot) or git was unavailable.
function defaultCommitSpecSnapshot({ repoRoot }) {
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
  // Nothing staged => the tree is already clean (respecting .gitignore). The freeze
  // will see a clean committed tree; do NOT create an empty commit.
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The active frozen baseline, or null. A manifest is frozen-and-active when its
// status is "frozen" and it carries no `superseded` marker.
export function findFrozenManifest(repoRoot) {
  const dir = resolve(repoRoot, BASELINE_DIR);
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let manifest;
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

// Flatten the two checks' errors/warnings into a single text block the fix prompt
// (and the blocked report) hands to the agent / human.
export function formatCheckOutput(checks) {
  if (!checks) return "(no check output)";
  const parts = [];
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
  // The remaining deterministic gates only matter to the fix prompt when they FAILED.
  for (const [name, check] of [
    ["spike-check", checks.spike],
    ["reference-check", checks.reference],
    ["change-control", checks.changeControl],
  ]) {
    if (!check || check.exitCode === 0) continue;
    parts.push(`${name}: ${check.summary ?? `exit ${check.exitCode}`}`);
    for (const e of check.errors ?? []) parts.push(`  error:\n${e}`);
  }
  return parts.join("\n");
}

// Flatten the independent verifier's structured fidelity verdict into a readable
// block the fix prompt (and the blocked report) hands to the extractor / human.
export function formatVerdict(verdict) {
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

// Flatten a FAILED architecture-map generation into a readable block the fix
// prompt hands to the extractor. The generator's output carries the exact reason
// (e.g. "Unsupported architecture-map.yml line:   - id: pipeline"), which the
// extractor needs verbatim to author a parseable map.
export function formatMapError(map) {
  if (!map || map.code === 0) return null;
  const detail = (map.output ?? "").trim();
  return (
    `architecture-map generation (generate-viewer-data.ts): FAILED (exit ${map.code})\n` +
    `  The authored .vivicy/architecture-map/architecture-map.yml did NOT parse into viewer data. ` +
    `Fix the map so generate-viewer-data.ts exits 0. Exact generator output:\n` +
    (detail ? `${detail.split("\n").map((l) => `  ${l}`).join("\n")}` : "  (no generator output captured)")
  );
}

// Build the combined feedback block for a FIX pass / the blocked report: the
// deterministic check output, the map-generation error, AND/OR the fidelity
// verdict problems, whichever made the previous attempt non-green. Any part may be
// absent (a red deterministic check short-circuits map-gen and the verifier; a
// map-gen failure short-circuits the verifier).
export function formatFixContext(checks, verdict, map) {
  const blocks = [];
  // Only include the deterministic block when it actually failed (a green
  // deterministic check that was then rejected on fidelity should not re-feed
  // passing check output as if it were the problem).
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

function countIssues(repoRoot) {
  try {
    const index = JSON.parse(readFileSync(resolve(repoRoot, ISSUE_INDEX_REL), "utf8"));
    return Array.isArray(index.issues) ? index.issues.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

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
