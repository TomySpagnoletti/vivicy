#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { countOf } from "../lib/count-form.ts";

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig, LegDeps } from "./agent-spawn.ts";
import { doneSetHash, issueTotals } from "./acceptance.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { findFrozenManifest } from "./extract-issues.ts";
import { notify } from "./notify.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";
import {
  RETRO_LANDINGS,
  RETRO_REPORT_FILE,
  type RetroLanding,
  type RetroProposal,
  type RetroRecurringClass,
  type RetroReport,
} from "../lib/retro-report.ts";

export const RETRO_REPORT_REL = RETRO_REPORT_FILE;
export const RETRO_VERDICT_REL = ".vivicy/development/reports/retro-verdict.json";

export class RetroConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetroConfigError";
  }
}

interface FrozenBaseline {
  manifestPath: string;
  baselineId: string;
}

export type SpawnRetroLeg = (args: {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  verdictRel: string;
}) => Promise<LegResult | void>;

export interface RunRetroOptions {
  repoRoot?: string | null;
  spawnLeg?: SpawnRetroLeg;
  findBaseline?: (repoRoot: string) => FrozenBaseline | null;
  emitReport?: (report: RetroReport, repoRoot: string) => void;
  now?: () => Date;
  force?: boolean;
  promptsDir?: string;
  cfg?: Record<string, unknown>;
}

interface RawClass {
  id?: unknown;
  kind?: unknown;
  signature?: unknown;
  evidence?: unknown;
}

interface RawProposal {
  landing?: unknown;
  title?: unknown;
  rationale?: unknown;
  detail?: unknown;
  addresses?: unknown;
}

interface RawVerdict {
  recurring_classes?: unknown;
  proposals?: unknown;
}

function readJsonOrNull(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function retroContext({ manifestPath, baselineId, verdictRel }: { manifestPath: string; baselineId: string; verdictRel: string }): string {
  return (
    `\n\n---\n\n## Retro context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). The cycle you are reviewing built the product from this baseline.\n` +
    `- Read the run's lived history: the progress ledger \`.vivicy/development/progress-ledger.json\`, every block report under \`.vivicy/development/reports/*-blocked.json\` and \`*-integration-blocked.json\`, the gate evidence under \`.vivicy/development/gates/*.json\`, the whole-product \`.vivicy/development/reports/acceptance-report.json\`, and the quota history \`.vivicy/development/reports/quota-state.json\`.\n` +
    `- A RECURRING class is the SAME failure shape seen at least TWICE across the cycle (same gate flake, same blocked cause, same review finding, same quota exhaustion). One-off failures are not recurring.\n` +
    `- Write your JSON verdict — and nothing else — to \`${verdictRel}\`. Write no other file: you propose, the orchestrator records and the owner decides.\n`
  );
}

function legDepsForTarget(repoRoot: string, context: string): LegDeps {
  return {
    composePrompt: (template: string, iss: AgentIssue) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs: (rel: string) => resolve(repoRoot, rel),
    execRoot: repoRoot,
    cwdFilter: null,
  };
}

function makeDefaultSpawnRetroLeg(options: RunRetroOptions): SpawnRetroLeg {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  const legs = resolveAgentLegs(process.env);
  const implementer: Leg = legs?.implementer ?? { actor: "claude", role: "implementer", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg: Leg = { ...implementer, role: "retro" };
  return async ({ repoRoot, manifestPath, baselineId, verdictRel }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue: AgentIssue = { id: TRANSCRIPT_DIRS.retro, transcript_dir: TRANSCRIPT_DIRS.retro, graph_refs: ["node:retro"], path: verdictRel };
    const context = retroContext({ manifestPath, baselineId, verdictRel });
    const deps = legDepsForTarget(repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg as LegConfig, deps) : runClaudeLeg(leg, issue, legCfg as LegConfig, deps);
  };
}

const NOTIFY_BY_PHASE: Record<string, { level: "info" | "success" | "warning" | "error"; message: string }> = {
  checking: { level: "info", message: "post-cycle retro: reading the run's ledger, blocks, gates, and quota for recurring failure classes" },
  quiet: { level: "success", message: "post-cycle retro: no recurring failure classes this cycle — nothing to amend" },
  proposals: { level: "info", message: "post-cycle retro found recurring failure classes and drafted method amendments for you to decide" },
  failed: { level: "warning", message: "post-cycle retro could not complete — the cycle still closed (retro never blocks); see the report" },
};

function defaultEmitReport(report: RetroReport, repoRoot: string): void {
  const abs = resolve(repoRoot, RETRO_REPORT_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  const mapped = NOTIFY_BY_PHASE[report.phase ?? ""];
  if (mapped) notify({ level: mapped.level, stage: "SR", event: `retro_${report.phase}`, message: report.summary || mapped.message });
}

function normalizeClasses(raw: unknown): RetroRecurringClass[] {
  if (!Array.isArray(raw)) return [];
  const classes: RetroRecurringClass[] = [];
  for (const entry of raw as RawClass[]) {
    if (!entry || typeof entry !== "object") continue;
    const signature = typeof entry.signature === "string" ? entry.signature.trim() : "";
    const kind = typeof entry.kind === "string" ? entry.kind.trim() : "";
    const witnesses = Array.isArray(entry.evidence)
      ? [...new Set(entry.evidence.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim()))]
      : [];
    if (!signature || !kind || witnesses.length < 2) continue;
    classes.push({
      id: typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : undefined,
      kind,
      signature,
      occurrences: witnesses.length,
      evidence: witnesses,
    });
  }
  return classes;
}

function coerceLanding(raw: unknown): RetroLanding {
  return (RETRO_LANDINGS as readonly string[]).includes(String(raw)) ? (raw as RetroLanding) : "canonical_clarification";
}

function normalizeProposals(raw: unknown): RetroProposal[] {
  if (!Array.isArray(raw)) return [];
  const proposals: RetroProposal[] = [];
  for (const entry of raw as RawProposal[]) {
    if (!entry || typeof entry !== "object") continue;
    const title = typeof entry.title === "string" ? entry.title.trim() : "";
    const detail = typeof entry.detail === "string" ? entry.detail.trim() : "";
    if (!title || !detail) continue;
    const addresses = Array.isArray(entry.addresses) ? entry.addresses.filter((a): a is string => typeof a === "string" && a.trim().length > 0) : [];
    proposals.push({
      landing: coerceLanding(entry.landing),
      title,
      rationale: typeof entry.rationale === "string" && entry.rationale.trim() ? entry.rationale.trim() : undefined,
      detail,
      addresses: addresses.length > 0 ? addresses : undefined,
    });
  }
  return proposals;
}

export async function runRetro(options: RunRetroOptions = {}): Promise<RetroReport> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new RetroConfigError("runRetro: no target project configured. Set VIVICY_TARGET_ROOT or pass options.repoRoot.");
  }
  const now = options.now ?? (() => new Date());
  const emitReport = options.emitReport ?? defaultEmitReport;
  const findBaseline = options.findBaseline ?? findFrozenManifest;
  const spawnLeg = options.spawnLeg ?? makeDefaultSpawnRetroLeg(options);

  const baseline = findBaseline(repoRoot);
  const { done, total } = issueTotals(repoRoot);
  const hash = doneSetHash(repoRoot);
  const prior = readJsonOrNull(resolve(repoRoot, RETRO_REPORT_REL)) as RetroReport | null;

  const report: RetroReport = {
    phase: "checking",
    baseline_id: baseline?.baselineId ?? null,
    done_set_hash: hash,
    recurring_classes: [],
    proposals: [],
    summary: "",
    updated_at: "",
  };
  const emit = (): RetroReport => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
    return report;
  };

  if (total <= 0 || done < total) {
    report.phase = "failed";
    report.summary = `retro runs once the cycle has closed (done ${done}/${total}); nothing to reflect on. The cycle close is not affected.`;
    return emit();
  }
  if (!baseline) {
    report.phase = "failed";
    report.summary = "no active frozen baseline to reflect against — the product was not built from a frozen canonical. The cycle close is not affected.";
    return emit();
  }

  const settled = prior && (prior.phase === "quiet" || prior.phase === "proposals");
  if (!options.force && settled && prior.baseline_id === baseline.baselineId && prior.done_set_hash === hash) {
    return prior;
  }

  report.summary = "reading the run's ledger, blocks, gate evidence, and quota history for recurring failure classes";
  emit();

  let legResult: LegResult | void;
  try {
    legResult = await spawnLeg({ repoRoot, manifestPath: baseline.manifestPath, baselineId: baseline.baselineId, verdictRel: RETRO_VERDICT_REL });
  } catch (error) {
    report.phase = "failed";
    report.summary = `retro leg errored: ${error instanceof Error ? error.message : String(error)}. The cycle close is not affected.`;
    return emit();
  }
  if (legResult && legResult.result?.timedOut) {
    report.phase = "failed";
    report.summary = `retro leg timed out (${legResult.result.timeoutReason ?? "no output"}); no amendments proposed this cycle. The cycle close is not affected.`;
    return emit();
  }

  const verdict = readJsonOrNull(resolve(repoRoot, RETRO_VERDICT_REL)) as RawVerdict | null;
  if (!verdict || typeof verdict !== "object" || (!("recurring_classes" in verdict) && !("proposals" in verdict))) {
    report.phase = "failed";
    report.summary = "retro leg produced no valid verdict (missing or malformed retro-verdict.json); no amendments proposed this cycle. The cycle close is not affected.";
    return emit();
  }

  const recurringClasses = normalizeClasses(verdict.recurring_classes);
  const proposals = normalizeProposals(verdict.proposals);
  report.recurring_classes = recurringClasses;
  report.proposals = proposals;

  if (proposals.length === 0) {
    report.phase = "quiet";
    report.summary = recurringClasses.length === 0
      ? "clean cycle: no recurring failure classes and nothing to amend."
      : `${countOf(recurringClasses.length, "recurring class", "recurring classes")} noted but no actionable amendment proposed; recorded for the owner, nothing to decide.`;
    return emit();
  }

  report.phase = "proposals";
  const byLanding = proposals.reduce<Record<string, number>>((acc, p) => {
    const key = String(p.landing);
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
  const breakdown = Object.entries(byLanding).map(([landing, n]) => `${n} ${landing}`).join(", ");
  report.summary = `${countOf(proposals.length, "method amendment", "method amendments")} proposed (${breakdown}) from ${countOf(recurringClasses.length, "recurring class", "recurring classes")}; each is owner-decided data — nothing is applied until you click.`;
  return emit();
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.");
    process.exit(2);
  }
  const json = process.argv.includes("--json");
  runRetro({ repoRoot })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(report.summary);
      process.exit(0);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof RetroConfigError ? 2 : 0);
    });
}
