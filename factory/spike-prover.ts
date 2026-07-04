#!/usr/bin/env node
// Vivicy spike PROVER (S3 / G3): the substance-verification stage that turns a
// `pending` spike into `verified` (or `failed`) by ACTUALLY running its experiments
// in the target repo — never a human hand-writing evidence, which would contradict
// the autonomous dev-loop. spike-check.ts proves a spike's FORM (shape, gate-id
// grammar, the six evidence LABELS at `verified`); this module proves its SUBSTANCE.
//
// It runs BEFORE the freeze (S3 precedes S4): a disproven hypothesis is a truth-model
// rule-1 event (pre-baseline) that may require a direct canonical edit, so proving
// after the freeze would force a re-freeze loop on every correction. extract-issues.ts
// therefore calls this ahead of its freeze/reuse-manifest block.
//
// Two-agent sequence per spike, preserving R12 (a CLI never verifies its own work):
//   1. PROVER    (implementer CLI, role "spike-prover") runs the spike's Must-Verify
//      experiments in the target repo, writes the six evidence fields INTO the spike
//      file's Evidence Required section (the file is the artifact), and a machine
//      verdict JSON { verdict, reason } to the reports dir.
//   2. VERIFIER  (reviewer CLI, role "spike-verifier") independently re-derives from
//      the spike + evidence + repo and writes { agree, problems } — the due-diligence
//      against a hallucinated proof (a proof rarely survives two different models).
//
// The orchestrator is deterministic and NEVER trusts a leg's word: it reads both
// JSONs and decides. agree+verified flips status IN the traceability block (single
// source of truth — no /_verified folder move, ruling §6.2). agree+failed flips to
// `failed` and drafts a Change Request (a false assumption is an intention-level
// event — truth-model rule 2). Disagreement is treated as a failed proof attempt: one
// bounded retry of the whole pair with the disagreement fed back, then a CR on
// persistent disagreement. Leg death/timeout is an honest failed attempt on the same
// path — never a silent green.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt } from "./dev-loop.ts";
import { createChangeRequest } from "./change-control.ts";
import { readSpikes } from "./spike-check.ts";
import type { Spike, SpikeStatus } from "./spike-check.ts";
import { FACTORY_PROMPTS_DIR } from "./target-root.ts";

// The subset of a leg-run result the orchestrator READS back (status + timeout
// markers, plus optional output/transcript). The real runners return a full
// LegRunResult (assignable to this); a test fake supplies only what it needs.
interface SpikeLegResult {
  result?: { status?: number | null; timedOut?: boolean; timeoutReason?: string };
  output?: string;
  transcriptRel?: string;
}

// The two resolved legs (R12 distinct-CLI): implementer runs the prover, reviewer the
// verifier. Role-less until re-roled at the spawn boundary, so Omit the `role` field.
interface Legs {
  implementer: Omit<AgentLeg, "role">;
  reviewer: Omit<AgentLeg, "role">;
}

// Leg run config (transcripts dir, prompts dir, and — once bound to a target — execRoot).
interface LegCfg {
  transcriptsDir: string;
  promptsDir?: string;
  execRoot?: string;
}

// The synthetic issue a spike's legs run against (transcript + actor/role handle).
interface SpikeIssue {
  id: string;
  graph_refs: string[];
  path: string;
}

// The PROVER's machine verdict as the orchestrator reads it back.
interface ProofReport {
  verdict: "verified" | "failed" | "no_report";
  reason: string;
}

// The independent VERIFIER's judgement as the orchestrator reads it back.
interface VerifierReport {
  agree: boolean;
  problems: unknown[];
}

// The CR a disproven/disagreed proof drafts (createChangeRequest's { id, path } re-keyed to { file }).
interface ChangeRequestRef {
  file: string;
  id: string;
}

// The seams runSpikeProving lets tests inject; each defaults to the real tooling.
type SpawnProver = (ctx: { repoRoot: string; spike: Spike; cfg: LegCfg; attempt: number; disagreement: string | null }) => Promise<SpikeLegResult>;
type SpawnSpikeVerifier = (ctx: { repoRoot: string; spike: Spike; cfg: LegCfg; attempt: number }) => Promise<SpikeLegResult>;
type WriteChangeRequest = (args: { repoRoot: string; spike: Spike; proof: string; verdict: string; reason: string; kind: string; now: () => string }) => ChangeRequestRef | null;

// The per-spike decision proveOneSpike returns to the run loop.
interface SpikeOutcome {
  status: SpikeStatus;
  reason: string;
  changeRequest: ChangeRequestRef | null;
}

// A ledger event emitted through the recordEvent sink (open-shaped: the sink stores it verbatim).
type LedgerEvent = Record<string, unknown>;

// The arguments runSpikeProving accepts; every seam defaults to the real tooling.
interface RunSpikeProvingArgs {
  repoRoot?: string;
  legs?: Legs;
  cfg?: LegCfg;
  recordEvent?: ((event: LedgerEvent) => void) | null;
  now?: () => string;
  spawnProver?: SpawnProver;
  spawnSpikeVerifier?: SpawnSpikeVerifier;
  writeChangeRequest?: WriteChangeRequest;
}

// The aggregate outcome of a whole proving run.
interface RunSpikeProvingResult {
  proved: Array<{ file: string; gate_id: string; verdict: string }>;
  failed: Array<{ file: string; gate_id: string; verdict: string; reason: string }>;
  skipped: Array<{ file: string; gate_id: string; reason: string }>;
  changeRequests: ChangeRequestRef[];
}

const REPORTS_DIR = ".vivicy/development/reports";
// The synthetic "issue" a spike's legs run against — the transcript + actor/role
// identity handle the shared spawn infra keys on, exactly like the extractor's.
// graph_refs is required by the leg deps but never consumed for a spike leg.
const SPIKE_GRAPH_REF = "node:spike-proof";

/**
 * Prove every provable `pending` spike in the target repo, in topological order of
 * the inter-spike `gated_by` graph, as a two-agent PROVER→VERIFIER pair per spike.
 * Deterministic outcome per spike; the file's traceability status is the single
 * source of truth (no folder move). A failed proof or persistent disagreement drafts
 * a Change Request (truth-model rule 2). Runs BEFORE the freeze (S3 before S4).
 *
 * Injectable seams (all default to the real tooling):
 *   spawnProver({ repoRoot, spike, cfg, attempt, disagreement })
 *       -> leg result; the PROVER runs the spike's experiments in-repo, writes the
 *          six evidence fields into the spike file, and writes spike-<stem>-proof.json.
 *   spawnSpikeVerifier({ repoRoot, spike, cfg, attempt })
 *       -> leg result; the VERIFIER writes spike-<stem>-verdict.json.
 *   writeChangeRequest({ repoRoot, spike, proof, verdict, reason })
 *       -> { file } ; drafts a `status: idea` CR capturing both reports as evidence.
 *   now()  -> ISO timestamp (tests pin it).
 *
 * `legs` are the resolved agent legs (R12); `recordEvent` is the ledger sink (may be null).
 */
export async function runSpikeProving(args: RunSpikeProvingArgs = {}): Promise<RunSpikeProvingResult> {
  const repoRoot = args.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to prove, or pass repoRoot.",
    );
  }
  const cfg: LegCfg = args.cfg ?? { transcriptsDir: ".vivicy/development/transcripts", promptsDir: FACTORY_PROMPTS_DIR };
  const legs = args.legs ?? defaultLegs();
  const now = args.now ?? (() => new Date().toISOString());
  const recordEvent = args.recordEvent ?? null;
  const spawnProver = args.spawnProver ?? makeDefaultSpawnProver(cfg, legs);
  const spawnSpikeVerifier = args.spawnSpikeVerifier ?? makeDefaultSpawnSpikeVerifier(cfg, legs);
  const writeChangeRequest = args.writeChangeRequest ?? defaultWriteChangeRequest;

  // A LIVE view of statuses that this run mutates as it proves: a spike gated by one
  // proved earlier in the same run sees the fresh status here, so the chain is
  // honoured within a single invocation, not only across runs.
  const spikes = readSpikes(repoRoot);
  const statusByGate = new Map(spikes.map((s) => [s.gate_id, s.status]));
  const byGate = new Map(spikes.map((s) => [s.gate_id, s]));

  const proved: RunSpikeProvingResult["proved"] = [];
  const failed: RunSpikeProvingResult["failed"] = [];
  const skipped: RunSpikeProvingResult["skipped"] = [];
  const changeRequests: ChangeRequestRef[] = [];

  for (const spike of topoOrder(spikes)) {
    if (spike.status !== "pending") continue; // only pending spikes are prove candidates

    // Chain gate: a spike is provable this round only if every gate in its transitive
    // gated_by chain is (or becomes, earlier in this same topo-ordered run) verified. A
    // chain member that is failed/blocked/deferred can never satisfy the chain, so the
    // dependent is skipped loudly with the offending gate named — never proved on an
    // unproven foundation.
    const chain = transitiveGatedBy(spike.gate_id, byGate);
    const blocker = chain.find((g) => statusByGate.get(g) !== "verified");
    if (blocker) {
      skipped.push({ file: spike.file, gate_id: spike.gate_id, reason: `gated_by ${blocker} is ${statusByGate.get(blocker) ?? "unknown"} (not verified)` });
      continue;
    }

    const outcome = await proveOneSpike({
      repoRoot,
      spike,
      cfg,
      spawnProver,
      spawnSpikeVerifier,
      writeChangeRequest,
      recordEvent,
      now,
    });
    // Reflect the decided status into the live view so later dependents see it.
    statusByGate.set(spike.gate_id, outcome.status);
    if (outcome.status === "verified") {
      proved.push({ file: spike.file, gate_id: spike.gate_id, verdict: "verified" });
    } else {
      failed.push({ file: spike.file, gate_id: spike.gate_id, verdict: "failed", reason: outcome.reason });
    }
    if (outcome.changeRequest) changeRequests.push(outcome.changeRequest);
  }

  return { proved, failed, skipped, changeRequests };
}

// Prove a SINGLE spike: run the PROVER→VERIFIER pair (one bounded retry on
// disagreement), then decide deterministically. Returns the decided status, the
// reason, and any drafted CR. NEVER trusts a leg: it reads both JSON files itself.
async function proveOneSpike(ctx: {
  repoRoot: string;
  spike: Spike;
  cfg: LegCfg;
  spawnProver: SpawnProver;
  spawnSpikeVerifier: SpawnSpikeVerifier;
  writeChangeRequest: WriteChangeRequest;
  recordEvent: ((event: LedgerEvent) => void) | null;
  now: () => string;
}): Promise<SpikeOutcome> {
  const { repoRoot, spike, cfg, spawnProver, spawnSpikeVerifier, writeChangeRequest, recordEvent, now } = ctx;
  const stem = spikeStem(spike.file);
  const proofRel = `${REPORTS_DIR}/spike-${stem}-proof.json`;
  const verdictRel = `${REPORTS_DIR}/spike-${stem}-verdict.json`;

  emit(recordEvent, {
    event_type: "spike_proof_started",
    actor: "spike-prover",
    // The ledger role vocabulary (progressRoles) uses underscores; the hyphenated
    // "spike-prover" is the LEG role (the prompt filename). Emit the vocabulary form.
    role: "spike_prover",
    gate_id: spike.gate_id,
    file: spike.file,
    timestamp: now(),
  });

  // Two attempts total: the initial pair, and — only on DISAGREEMENT — one retry with
  // the disagreement fed back to both legs. A leg that dies/times out authors no usable
  // JSON, so the deterministic read below treats it as an honest failed proof attempt.
  let last: { attempt: number; proof: ProofReport; verdict: VerifierReport; proverLeg: SpikeLegResult; verdictLeg: SpikeLegResult; disagreement?: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    clearFile(repoRoot, proofRel);
    clearFile(repoRoot, verdictRel);
    const proverLeg = await spawnProver({ repoRoot, spike, cfg, attempt, disagreement: last?.disagreement ?? null });
    const proof = readProofReport(repoRoot, proofRel, proverLeg);
    const verdictLeg = await spawnSpikeVerifier({ repoRoot, spike, cfg, attempt });
    const verdict = readVerifierReport(repoRoot, verdictRel, verdictLeg);

    last = { attempt, proof, verdict, proverLeg, verdictLeg };

    // Deterministic decision — the orchestrator's, never a leg's assertion:
    //   agree + verified -> flip verified (canonical untouched here; the prover edited
    //     it directly if reality forced it, per rule 1 pre-freeze).
    //   agree + failed   -> flip failed + draft a CR (rule 2: a false assumption is an
    //     intention-level event).
    //   disagree         -> a failed proof ATTEMPT; retry once feeding the disagreement
    //     back, then (on persistent disagreement) a CR.
    // A leg death/timeout collapses to !agree or a non-"verified"/"failed" verdict, so it
    // lands on the disagreement/failed path — an honest failed attempt, never a silent green.
    if (verdict.agree === true && proof.verdict === "verified") {
      flipSpikeStatus(repoRoot, spike, "verified");
      emit(recordEvent, spikeProofCompleted(spike, "verified", now, [proofRel, verdictRel]));
      return { status: "verified", reason: proof.reason ?? "proof verified", changeRequest: null };
    }
    if (verdict.agree === true && proof.verdict === "failed") {
      flipSpikeStatus(repoRoot, spike, "failed");
      const reason = proof.reason || "the prover disproved the spike's hypothesis";
      const cr = writeChangeRequest({ repoRoot, spike, proof: proofRel, verdict: verdictRel, reason, kind: "disproven", now });
      emit(recordEvent, spikeProofCompleted(spike, "failed", now, [proofRel, verdictRel, ...(cr?.file ? [cr.file] : [])]));
      return { status: "failed", reason, changeRequest: cr };
    }
    // Disagreement (or an unusable verdict/proof): retry once, feeding the verifier's
    // problems back so the next pair addresses them; keep the loop deterministic.
    last.disagreement = disagreementFeedback(proof, verdict);
  }

  // Persistent disagreement after the bounded retry: a proof that two models could not
  // agree on is not trustworthy — treat it as failed and route through change control so
  // a human sees WHY (both reports are the evidence). Never flip to verified on a
  // non-agreement.
  flipSpikeStatus(repoRoot, spike, "failed");
  const reason = `prover and spike-verifier did not agree after a bounded retry: ${last!.disagreement}`;
  const cr = writeChangeRequest({ repoRoot, spike, proof: proofRel, verdict: verdictRel, reason, kind: "disagreement", now });
  emit(recordEvent, spikeProofCompleted(spike, "failed", now, [proofRel, verdictRel, ...(cr?.file ? [cr.file] : [])]));
  return { status: "failed", reason, changeRequest: cr };
}

// ---------------------------------------------------------------------------
// Deterministic report readers — the orchestrator's trust boundary
// ---------------------------------------------------------------------------

// The PROVER's machine verdict { verdict: "verified"|"failed", reason }. A missing,
// unparseable, or off-enum verdict is NOT a proof — it collapses to a distinct
// "no_report" verdict so a dead/timed-out prover can never read as verified.
function readProofReport(repoRoot: string, rel: string, leg: SpikeLegResult): ProofReport {
  const parsed = readJsonOrNull(resolve(repoRoot, rel)) as { verdict?: unknown; reason?: unknown } | null;
  if (!parsed || (parsed.verdict !== "verified" && parsed.verdict !== "failed")) {
    return { verdict: "no_report", reason: legFailureReason(leg) ?? `prover wrote no valid verdict at ${rel}` };
  }
  return { verdict: parsed.verdict, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

// The VERIFIER's independent judgement { agree: boolean, problems: [] }. `agree` is
// true ONLY when the boolean is exactly true; anything else (missing, string "true",
// a dead leg) reads as NOT agreeing, so no proof is trusted on a malformed verdict.
function readVerifierReport(repoRoot: string, rel: string, leg: SpikeLegResult): VerifierReport {
  const parsed = readJsonOrNull(resolve(repoRoot, rel)) as { agree?: unknown; problems?: unknown } | null;
  if (!parsed) {
    return { agree: false, problems: [legFailureReason(leg) ?? `spike-verifier wrote no verdict at ${rel}`] };
  }
  return {
    agree: parsed.agree === true,
    problems: Array.isArray(parsed.problems) ? parsed.problems : [],
  };
}

// One readable line summarising why a pair disagreed (or produced no usable report),
// fed back verbatim to the retry pair so it addresses the exact objection.
function disagreementFeedback(proof: ProofReport, verdict: VerifierReport): string {
  const problems = (verdict.problems ?? []).map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("; ");
  return `prover said "${proof.verdict}" (${proof.reason || "no reason"}); spike-verifier agree=${verdict.agree}${problems ? ` — problems: ${problems}` : ""}`;
}

// A leg's own failure reason (a killed/timed-out CLI), so a "no report" carries WHY.
function legFailureReason(leg: SpikeLegResult | undefined): string | null {
  if (leg?.result?.timedOut) return leg.result.timeoutReason || "leg timed out";
  const status = leg?.result?.status;
  if (typeof status === "number" && status !== 0) return `leg exited non-zero (status ${status})`;
  return null;
}

// ---------------------------------------------------------------------------
// Spike file mutation — the file's traceability status is the single source of truth
// ---------------------------------------------------------------------------

// Flip a spike's `status:` scalar IN its Traceability block (no folder move — ruling
// §6.2: the status field is the machine truth the gating already consumes). Rewrites
// exactly the one `status:` line inside the `## Traceability` section, leaving every
// other byte — including the evidence the prover just wrote — untouched.
export function flipSpikeStatus(repoRoot: string, spike: { file: string }, status: SpikeStatus): void {
  const abs = resolve(repoRoot, spike.file);
  const text = readFileSync(abs, "utf8");
  // Preserve the file's original line ending: splitting on /\r?\n/ then re-joining with a
  // fixed "\n" would rewrite every CRLF to LF, breaking the "every other byte untouched"
  // guarantee on a Windows-authored spike. Detect the dominant ending and re-join with it.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Traceability\s*$/.test(line));
  if (headingIndex === -1) {
    throw new Error(`spike-prover: ${spike.file} has no "## Traceability" block to update`);
  }
  let updated = false;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) break; // next section — the block ended
    const m = lines[i].match(/^(\s*status:\s*)(.*)$/);
    if (m) {
      lines[i] = `${m[1]}${status}`;
      updated = true;
      break;
    }
  }
  if (!updated) {
    throw new Error(`spike-prover: ${spike.file} Traceability block has no "status:" line to update`);
  }
  writeFileSync(abs, lines.join(eol), "utf8");
}

// ---------------------------------------------------------------------------
// Change-Request drafting (truth-model rule 2)
// ---------------------------------------------------------------------------

// Draft a `status: idea` Change Request capturing a disproven (or disagreed) spike so
// the owner (P2's single touchpoint) decides. Delegates the frontmatter + id + write to
// change-control.ts's createChangeRequest (the single CR writer — G7), passing this
// stage's rich narrative body and classification; both proof reports ride as the machine
// evidence. source: agent (an agent-emitted CR — G7 source). The spike's own gate_id rides
// on affected_verification_gates: it is the link cr-apply follows to RETIRE this now-moot
// spike (failed -> deferred) once the CR is folded, so the disproven assumption no longer
// blocks re-extraction at G13. Signature preserved so the prover's injectable seam is unchanged.
export function defaultWriteChangeRequest({ repoRoot, spike, proof, verdict, reason, kind, now }: {
  repoRoot: string;
  spike: Spike;
  proof: string;
  verdict: string;
  reason: string;
  kind: string;
  now: () => string;
}): ChangeRequestRef {
  const handle = spike.gate_id.replace(/^gate:phase0:/, "");
  const title = kind === "disagreement" ? `Spike ${handle} proof unresolved` : `Spike ${handle} hypothesis disproven`;
  const body = renderChangeRequest({ title, spike, proof, verdict, reason, kind });
  const { id, path } = createChangeRequest({
    repoRoot,
    title,
    classification: "major_product_change",
    source: "agent",
    affectedVerificationGates: [spike.gate_id],
    body,
    now,
  });
  return { file: path, id };
}

// The CR narrative body (everything AFTER the frontmatter — createChangeRequest owns the
// frontmatter). classification `major_product_change` — a disproven Phase-0 assumption is
// a product-intention event, not a mere clarification or ordering tweak.
function renderChangeRequest({ title, spike, proof, verdict, reason, kind }: {
  title: string;
  spike: Spike;
  proof: string;
  verdict: string;
  reason: string;
  kind: string;
}): string {
  const outcome =
    kind === "disagreement"
      ? "The prover and the independent spike-verifier could not agree after a bounded retry, so the proof is untrustworthy."
      : "The prover ran the spike's experiments and DISPROVED its hypothesis; the independent spike-verifier agreed.";
  return [
    `# ${title}`,
    "",
    "## Idea",
    "",
    `Spike \`${spike.gate_id}\` (\`${spike.file}\`) did not survive substance verification. ${outcome} A Phase-0 assumption the product intention rested on is no longer safe to build on.`,
    "",
    "## Why It Matters",
    "",
    `A spike is the evidence gate for external behaviour the spec cannot settle on its own. When that behaviour proves different from the assumption, the product intention that depended on it must be revisited BEFORE any issue is extracted against it (truth-model rule 2: a spike discovering a real constraint is a Change Request, not a local patch). Reason recorded by the orchestrator: ${reason}`,
    "",
    "## Protected Product Truth",
    "",
    "Whatever the canonical spec states independently of this spike's assumption must remain true; only the disproven assumption and the obligations that rested on it are in question.",
    "",
    "## Current Documentation Coverage",
    "",
    `The requirement(s) this spike gates: ${formatRequirementIds(spike)}. The owner decides how to reconcile the canonical with the proven reality.`,
    "",
    "## Development Agent Recommendation",
    "",
    "Recommended status `idea` pending the owner decision. Classification `major_product_change`: a disproven Phase-0 assumption changes what the product can rely on. The owner may accept a canonical correction (then the spike is re-authored and re-proved) or reject the change.",
    "",
    "## Impact Assessment",
    "",
    "- Product behavior: the obligations gated by this spike may no longer hold as written.",
    "- Architecture / data model / protocols / security: `N/A - no impact found` unless the owner's reconciliation touches them.",
    "- Tests and verification gates: the spike's own gate stays un-verified until a corrected assumption is re-proved.",
    "",
    "## Machine Evidence",
    "",
    "The orchestrator captured both agent reports as the evidence for this CR (never an agent's unverified assertion):",
    "",
    "```text",
    `prover verdict report:        ${proof}`,
    `spike-verifier agree report:  ${verdict}`,
    `spike file (with evidence):   ${spike.file}`,
    "```",
    "",
    "## Decision",
    "",
    "Record the owner decision, date, and reason, and populate `owner_decision_by`, `owner_decision_at`, and `owner_decision_evidence`. A decided CR without this evidence is invalid.",
    "",
    "## Audit Trail",
    "",
    "```text",
    `CR created by the spike prover (source: agent) after ${kind === "disagreement" ? "an unresolved proof disagreement" : "a disproven spike hypothesis"}.`,
    "```",
    "",
  ].join("\n");
}

function formatRequirementIds(spike: Spike): string {
  const ids = spike.requirement_ids;
  if (!ids) return "(recorded in the spike's Traceability block)";
  return Array.isArray(ids) ? ids.join(", ") : String(ids);
}

// ---------------------------------------------------------------------------
// Default leg seams (the real CLIs)
// ---------------------------------------------------------------------------

// Resolve the two legs the same way extract-issues does when the caller passes none:
// implementer CLI = prover, reviewer CLI = spike-verifier (R12 distinct-CLI).
function defaultLegs(): Legs {
  return {
    implementer: { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false },
    reviewer: { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false },
  };
}

// The PROVER seam: drive the IMPLEMENTER-role CLI (Claude by default), re-roled to
// "spike-prover", against the TARGET repo so it runs the spike's experiments in the
// project it is proving. The role name selects the spike-prover.md prompt and names
// the transcript.
function makeDefaultSpawnProver(baseCfg: LegCfg, legs: Legs): SpawnProver {
  const implementer = legs?.implementer ?? defaultLegs().implementer;
  const leg: AgentLeg = { ...implementer, role: "spike-prover" };
  return async ({ repoRoot, spike, cfg, attempt, disagreement }) => {
    const legCfg = { ...cfg, promptsDir: cfg?.promptsDir ?? FACTORY_PROMPTS_DIR, execRoot: repoRoot };
    const issue = spikeIssue(spike);
    const context = proverContext({ spike, attempt, disagreement });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// The VERIFIER seam: drive the REVIEWER-role CLI (Codex by default), re-roled to
// "spike-verifier". resolveAgentLegs guarantees the reviewer CLI differs from the
// implementer CLI, so the agent that verifies a proof never established it (R12).
function makeDefaultSpawnSpikeVerifier(baseCfg: LegCfg, legs: Legs): SpawnSpikeVerifier {
  const reviewer = legs?.reviewer ?? defaultLegs().reviewer;
  const leg: AgentLeg = { ...reviewer, role: "spike-verifier" };
  return async ({ repoRoot, spike, cfg, attempt }) => {
    const legCfg = { ...cfg, promptsDir: cfg?.promptsDir ?? FACTORY_PROMPTS_DIR, execRoot: repoRoot };
    const issue = spikeIssue(spike);
    const context = verifierContext({ spike, attempt });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// Dispatch a leg to the shared spawn helper for its CLI — the SAME infra the dev-loop
// and extractor use (runClaudeLeg / runCodexLeg), so flags/transcript capture are not
// duplicated here.
function runLegForProvider(leg: AgentLeg, issue: SpikeIssue, legCfg: LegConfig, deps: LegDeps): LegRunResult {
  if (leg.provider === "codex") return runCodexLeg(leg, issue, legCfg, deps);
  return runClaudeLeg(leg, issue, legCfg, deps);
}

// The synthetic issue a spike's legs run against (transcript + actor/role handle).
// Keyed by the spike stem so the two legs' transcripts land under a per-spike dir.
function spikeIssue(spike: Spike): SpikeIssue {
  return { id: `SPIKE-${spikeStem(spike.file)}`, graph_refs: [SPIKE_GRAPH_REF], path: spike.file };
}

// Extra prompt context for the PROVER leg: which spike file to prove, where to write
// the six evidence fields and the machine verdict, and — on a retry — the exact
// disagreement to address.
function proverContext({ spike, attempt, disagreement }: { spike: Spike; attempt: number; disagreement: string | null }): string {
  const stem = spikeStem(spike.file);
  return (
    `\n\n---\n\n## Spike proving context for this run\n\n` +
    `- Spike to prove: \`${spike.file}\` (gate_id \`${spike.gate_id}\`).\n` +
    `- Run its **Must Verify** experiments IN THIS TARGET REPO and record the six evidence fields ` +
    `(environment, commands, observed output, decision, documentation updates, unresolved risks) INTO the spike file's ` +
    `\`## Evidence Required\` section. Never fabricate output.\n` +
    `- Write your machine verdict — and nothing else — to \`${REPORTS_DIR}/spike-${stem}-proof.json\` as JSON ` +
    `\`{ "verdict": "verified" | "failed", "reason": string }\`. \`verified\` only if the hypothesis held; \`failed\` if reality differed.\n` +
    `- Attempt: ${attempt}.\n` +
    (disagreement
      ? `\n### Address this — the previous attempt did not survive independent verification\n\n` +
        "```text\n" +
        disagreement +
        "\n```\n"
      : "")
  );
}

// Extra prompt context for the VERIFIER leg: the spike + evidence to re-derive from,
// and where to write its independent agree verdict (it edits nothing).
function verifierContext({ spike, attempt }: { spike: Spike; attempt: number }): string {
  const stem = spikeStem(spike.file);
  return (
    `\n\n---\n\n## Proof verification context for this run\n\n` +
    `- Spike under review: \`${spike.file}\` (gate_id \`${spike.gate_id}\`), including the evidence the prover recorded ` +
    `in its \`## Evidence Required\` section, and the prover's verdict at \`${REPORTS_DIR}/spike-${stem}-proof.json\`.\n` +
    `- Re-derive INDEPENDENTLY in this repo: does the recorded evidence actually support the verdict? Are the commands plausible ` +
    `against the repo's reality? Do NOT edit the spike or any other file.\n` +
    `- Write your verdict — and nothing else — to \`${REPORTS_DIR}/spike-${stem}-verdict.json\` as JSON ` +
    `\`{ "agree": boolean, "problems": [string] }\`. \`agree\` true only when the evidence genuinely supports the prover's verdict.\n` +
    `- Attempt under review: ${attempt}.\n`
  );
}

// Bind the shared leg runner to the TARGET repo's roots and inject the run-specific
// prompt context by wrapping composePrompt, exactly as extract-issues' legDepsForTarget.
function legDepsForTarget(legCfg: LegConfig, issue: SpikeIssue, repoRoot: string, context: string): LegDeps {
  const abs = (rel: string) => resolve(repoRoot, rel);
  return {
    composePrompt: (template: string, iss: AgentIssue) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot: repoRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir}/${issue.id}`),
    cwdFilter: null,
  };
}

// ---------------------------------------------------------------------------
// Ledger events
// ---------------------------------------------------------------------------

// Emit a ledger event when a sink is provided; the extraction path may pass null
// (spikes have no graph-item states yet), so guard it. The event carries the spike
// identity, not a graph_ref, since the spike is not yet a mapped node.
function emit(recordEvent: ((event: LedgerEvent) => void) | null, event: LedgerEvent): void {
  if (typeof recordEvent === "function") recordEvent(event);
}

function spikeProofCompleted(spike: Spike, verdict: string, now: () => string, evidence: string[]): LedgerEvent {
  return {
    event_type: "spike_proof_completed",
    actor: "spike-verifier",
    role: "spike_verifier",
    gate_id: spike.gate_id,
    file: spike.file,
    verdict,
    evidence_refs: evidence,
    timestamp: now(),
  };
}

// ---------------------------------------------------------------------------
// Topological ordering over the inter-spike gated_by graph
// ---------------------------------------------------------------------------

// Order the spikes so each appears AFTER every spike in its gated_by chain — a spike
// gated by a still-pending spike is proved only after that gate, within the same run.
// The graph is validated acyclic by spike-check upstream; a defensive cycle break
// (append leftovers) keeps this total even on a malformed corpus rather than looping.
function topoOrder(spikes: Spike[]): Spike[] {
  const byGate = new Map(spikes.map((s) => [s.gate_id, s]));
  const visited = new Set<string>();
  const order: Spike[] = [];
  const visit = (gate: string, stack: Set<string>) => {
    if (visited.has(gate) || !byGate.has(gate) || stack.has(gate)) return;
    stack.add(gate);
    for (const dep of byGate.get(gate)!.gated_by ?? []) visit(dep, stack);
    stack.delete(gate);
    visited.add(gate);
    order.push(byGate.get(gate)!);
  };
  for (const spike of spikes) visit(spike.gate_id, new Set());
  return order;
}

// The set of gate_ids in a spike's transitive gated_by chain (excludes itself), used to
// decide provability. Mirrors spike-check's transitiveGatedBy, kept local so this
// module owns no cross-module private import.
function transitiveGatedBy(gate: string, byGate: Map<string, Spike>): string[] {
  const seen = new Set<string>();
  const stack = [...(byGate.get(gate)?.gated_by ?? [])];
  while (stack.length) {
    const g = stack.pop()!;
    if (seen.has(g) || !byGate.has(g)) continue;
    seen.add(g);
    stack.push(...(byGate.get(g)!.gated_by ?? []));
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

// The spike filename stem (e.g. ".vivicy/development/spikes/03-codex-auth.md" ->
// "03-codex-auth"), the join key shared by the gate id and the report file names.
function spikeStem(file: string): string {
  const base = file.split("/").pop() ?? file;
  return base.replace(/\.md$/i, "");
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

// The proof/verdict JSONs are transient leg->orchestrator handoffs: cleared before each
// attempt (a dead leg then reads as no_report, never a stale pass from a prior attempt).
function clearFile(repoRoot: string, rel: string): void {
  rmSync(resolve(repoRoot, rel), { force: true });
}

// Ensure the reports dir exists before a real leg writes into it (tests' fake legs
// create it themselves; the real legs rely on it being present).
export function ensureReportsDir(repoRoot: string): void {
  mkdirSync(resolve(repoRoot, REPORTS_DIR), { recursive: true });
}
