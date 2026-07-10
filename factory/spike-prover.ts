#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt } from "./dev-loop.ts";
import { createChangeRequest } from "./change-control.ts";
import { readSpikes } from "./spike-check.ts";
import type { Spike, SpikeStatus } from "./spike-check.ts";
import { FACTORY_PROMPTS_DIR } from "./target-root.ts";

interface SpikeLegResult {
  result?: { status?: number | null; timedOut?: boolean; timeoutReason?: string };
  output?: string;
  transcriptRel?: string;
}

interface Legs {
  implementer: Omit<AgentLeg, "role">;
  reviewer: Omit<AgentLeg, "role">;
}

interface LegCfg {
  transcriptsDir: string;
  promptsDir?: string;
  execRoot?: string;
}

interface SpikeIssue {
  id: string;
  graph_refs: string[];
  path: string;
}

interface ProofReport {
  verdict: "verified" | "failed" | "no_report";
  reason: string;
}

interface VerifierReport {
  agree: boolean;
  problems: unknown[];
}

interface ChangeRequestRef {
  file: string;
  id: string;
}

type SpawnProver = (ctx: { repoRoot: string; spike: Spike; cfg: LegCfg; attempt: number; disagreement: string | null }) => Promise<SpikeLegResult>;
type SpawnSpikeVerifier = (ctx: { repoRoot: string; spike: Spike; cfg: LegCfg; attempt: number }) => Promise<SpikeLegResult>;
type WriteChangeRequest = (args: { repoRoot: string; spike: Spike; proof: string; verdict: string; reason: string; kind: string; now: () => string }) => ChangeRequestRef | null;

interface SpikeOutcome {
  status: SpikeStatus;
  reason: string;
  changeRequest: ChangeRequestRef | null;
}

type LedgerEvent = Record<string, unknown>;

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

interface RunSpikeProvingResult {
  proved: Array<{ file: string; gate_id: string; verdict: string }>;
  failed: Array<{ file: string; gate_id: string; verdict: string; reason: string }>;
  skipped: Array<{ file: string; gate_id: string; reason: string }>;
  changeRequests: ChangeRequestRef[];
}

const REPORTS_DIR = ".vivicy/development/reports";
// graph_refs is required by the shared leg-spawn infra but never consumed for a spike leg.
const SPIKE_GRAPH_REF = "node:spike-proof";

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

  const spikes = readSpikes(repoRoot);
  const statusByGate = new Map(spikes.map((s) => [s.gate_id, s.status]));
  const byGate = new Map(spikes.map((s) => [s.gate_id, s]));

  const proved: RunSpikeProvingResult["proved"] = [];
  const failed: RunSpikeProvingResult["failed"] = [];
  const skipped: RunSpikeProvingResult["skipped"] = [];
  const changeRequests: ChangeRequestRef[] = [];

  for (const spike of topoOrder(spikes)) {
    if (spike.status !== "pending") continue;

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
    // progressRoles requires the underscore form; "spike-prover" (hyphen) is the LEG role / prompt filename.
    role: "spike_prover",
    gate_id: spike.gate_id,
    file: spike.file,
    timestamp: now(),
  });

  let last: { attempt: number; proof: ProofReport; verdict: VerifierReport; proverLeg: SpikeLegResult; verdictLeg: SpikeLegResult; disagreement?: string } | null = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    clearFile(repoRoot, proofRel);
    clearFile(repoRoot, verdictRel);
    const proverLeg = await spawnProver({ repoRoot, spike, cfg, attempt, disagreement: last?.disagreement ?? null });
    const proof = readProofReport(repoRoot, proofRel, proverLeg);
    const verdictLeg = await spawnSpikeVerifier({ repoRoot, spike, cfg, attempt });
    const verdict = readVerifierReport(repoRoot, verdictRel, verdictLeg);

    last = { attempt, proof, verdict, proverLeg, verdictLeg };

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
    last.disagreement = disagreementFeedback(proof, verdict);
  }

  flipSpikeStatus(repoRoot, spike, "failed");
  const reason = `prover and spike-verifier did not agree after a bounded retry: ${last!.disagreement}`;
  const cr = writeChangeRequest({ repoRoot, spike, proof: proofRel, verdict: verdictRel, reason, kind: "disagreement", now });
  emit(recordEvent, spikeProofCompleted(spike, "failed", now, [proofRel, verdictRel, ...(cr?.file ? [cr.file] : [])]));
  return { status: "failed", reason, changeRequest: cr };
}

function readProofReport(repoRoot: string, rel: string, leg: SpikeLegResult): ProofReport {
  const parsed = readJsonOrNull(resolve(repoRoot, rel)) as { verdict?: unknown; reason?: unknown } | null;
  if (!parsed || (parsed.verdict !== "verified" && parsed.verdict !== "failed")) {
    return { verdict: "no_report", reason: legFailureReason(leg) ?? `prover wrote no valid verdict at ${rel}` };
  }
  return { verdict: parsed.verdict, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
}

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

function disagreementFeedback(proof: ProofReport, verdict: VerifierReport): string {
  const problems = (verdict.problems ?? []).map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("; ");
  return `prover said "${proof.verdict}" (${proof.reason || "no reason"}); spike-verifier agree=${verdict.agree}${problems ? ` — problems: ${problems}` : ""}`;
}

function legFailureReason(leg: SpikeLegResult | undefined): string | null {
  if (leg?.result?.timedOut) return leg.result.timeoutReason || "leg timed out";
  const status = leg?.result?.status;
  if (typeof status === "number" && status !== 0) return `leg exited non-zero (status ${status})`;
  return null;
}

export function flipSpikeStatus(repoRoot: string, spike: { file: string }, status: SpikeStatus): void {
  const abs = resolve(repoRoot, spike.file);
  const text = readFileSync(abs, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Traceability\s*$/.test(line));
  if (headingIndex === -1) {
    throw new Error(`spike-prover: ${spike.file} has no "## Traceability" block to update`);
  }
  let updated = false;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    if (/^#{1,2}\s/.test(lines[i])) break;
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

// spike.gate_id rides on affected_verification_gates — cr-apply reads it to retire this spike (failed -> deferred) once the CR is folded.
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

// Everything returned here goes AFTER the frontmatter; createChangeRequest prepends the frontmatter itself.
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

function defaultLegs(): Legs {
  return {
    implementer: { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false },
    reviewer: { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false },
  };
}

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

function runLegForProvider(leg: AgentLeg, issue: SpikeIssue, legCfg: LegConfig, deps: LegDeps): LegRunResult {
  if (leg.provider === "codex") return runCodexLeg(leg, issue, legCfg, deps);
  return runClaudeLeg(leg, issue, legCfg, deps);
}

function spikeIssue(spike: Spike): SpikeIssue {
  return { id: `SPIKE-${spikeStem(spike.file)}`, graph_refs: [SPIKE_GRAPH_REF], path: spike.file };
}

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

// Assumes the graph is validated acyclic upstream by spike-check; the stack-based guard below is a defensive fallback, not the primary correctness mechanism.
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

// Mirrors spike-check's own (private) transitiveGatedBy; kept local rather than imported since that one isn't exported.
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

// Cleared before each attempt so a leg that dies before writing reads back as no_report, never a stale prior-attempt result.
function clearFile(repoRoot: string, rel: string): void {
  rmSync(resolve(repoRoot, rel), { force: true });
}

export function ensureReportsDir(repoRoot: string): void {
  mkdirSync(resolve(repoRoot, REPORTS_DIR), { recursive: true });
}
