#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig } from "./agent-spawn.ts";
import { legDepsForTarget } from "./leg-deps.ts";
import { CR_CLASSIFICATIONS, createChangeRequest } from "./change-control.ts";
import type { CrClassification } from "./change-control.ts";
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { findFrozenManifest } from "./extract-issues.ts";
import { notify } from "./notify.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";
import { countOf } from "../lib/count-form.ts";
import {
  ACCEPTANCE_REPORT_FILE,
  type AcceptanceFinding,
  type AcceptanceReport,
  type AcceptanceScenario,
} from "../lib/acceptance-report.ts";

export const ACCEPTANCE_REPORT_REL = ACCEPTANCE_REPORT_FILE;
export const ACCEPTANCE_VERDICT_REL = ".vivicy/development/reports/acceptance-verdict.json";
const ISSUE_INDEX_REL = ".vivicy/development/issue-index.json";
const DONE_DIR_REL = ".vivicy/development/issues/done";

export class AcceptanceConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AcceptanceConfigError";
  }
}

interface FrozenBaseline {
  manifestPath: string;
  baselineId: string;
}

export type SpawnAcceptanceLeg = (args: {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  verdictRel: string;
}) => Promise<LegResult | void>;

export interface RunAcceptanceOptions {
  repoRoot?: string | null;
  spawnLeg?: SpawnAcceptanceLeg;
  createCr?: typeof createChangeRequest;
  findBaseline?: (repoRoot: string) => FrozenBaseline | null;
  emitReport?: (report: AcceptanceReport, repoRoot: string) => void;
  now?: () => Date;
  force?: boolean;
  promptsDir?: string;
  cfg?: Record<string, unknown>;
}

interface RawFinding {
  obligation?: unknown;
  gap?: unknown;
  verification?: unknown;
  title?: unknown;
  classification?: unknown;
}

interface RawVerdict {
  accepted?: unknown;
  scenarios?: unknown;
  findings?: unknown;
}

function readJsonOrNull(abs: string): unknown {
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function listDoneIssueFiles(repoRoot: string): string[] {
  const dir = resolve(repoRoot, DONE_DIR_REL);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
}

export function doneSetHash(repoRoot: string): string {
  return createHash("sha256").update(listDoneIssueFiles(repoRoot).join("\n")).digest("hex").slice(0, 16);
}

export function issueTotals(repoRoot: string): { done: number; total: number } {
  const index = readJsonOrNull(resolve(repoRoot, ISSUE_INDEX_REL)) as { issues?: unknown } | null;
  const total = Array.isArray(index?.issues) ? index!.issues.length : 0;
  return { done: listDoneIssueFiles(repoRoot).length, total };
}

export function acceptanceStageNeeded(
  baseline: FrozenBaseline | null,
  report: AcceptanceReport | null,
  { done, total, doneSetHash: hash }: { done: number; total: number; doneSetHash: string },
): boolean {
  if (total <= 0 || done < total) return false;
  if (!baseline) return false;
  if (!report) return true;
  const settled = report.phase === "green" || report.phase === "findings";
  return !settled || report.baseline_id !== baseline.baselineId || report.done_set_hash !== hash;
}

function acceptanceContext({ manifestPath, baselineId, verdictRel }: { manifestPath: string; baselineId: string; verdictRel: string }): string {
  return (
    `\n\n---\n\n## Acceptance context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). The canonical corpus it pins under \`.vivicy/canonical/**\` is your only source of product truth.\n` +
    `- The assembled product is the repository's own code and tests (everything outside \`.vivicy/\`). Read what actually implements each obligation.\n` +
    `- Run the project's verification gate (\`vivicy.json#gateCommand\`) and any existing tests to execute scenarios that are runnable; read-verify the rest and mark them \`read_only\`.\n` +
    `- Write your JSON verdict — and nothing else — to \`${verdictRel}\`.\n`
  );
}

function makeDefaultSpawnAcceptanceLeg(options: RunAcceptanceOptions): SpawnAcceptanceLeg {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  const legs = resolveAgentLegs(process.env);
  const implementer: Leg = legs?.implementer ?? { actor: "claude", role: "implementer", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg: Leg = { ...implementer, role: "acceptance" };
  return async ({ repoRoot, manifestPath, baselineId, verdictRel }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue: AgentIssue = { id: TRANSCRIPT_DIRS.acceptance, transcript_dir: TRANSCRIPT_DIRS.acceptance, graph_refs: ["node:acceptance"], path: verdictRel };
    const context = acceptanceContext({ manifestPath, baselineId, verdictRel });
    const deps = legDepsForTarget(repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg as LegConfig, deps) : runClaudeLeg(leg, issue, legCfg as LegConfig, deps);
  };
}

const NOTIFY_BY_PHASE: Record<string, { level: "info" | "success" | "warning" | "error"; message: string }> = {
  checking: { level: "info", message: "whole-product acceptance: checking the assembled product against the frozen spec" },
  green: { level: "success", message: "whole-product acceptance green — the delivered product satisfies the spec end to end" },
  findings: { level: "warning", message: "whole-product acceptance is not clean — every gap it found is drafted as a change request, Done withheld" },
  failed: { level: "error", message: "whole-product acceptance could not complete — Done withheld" },
};

function defaultEmitReport(report: AcceptanceReport, repoRoot: string): void {
  const abs = resolve(repoRoot, ACCEPTANCE_REPORT_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  const mapped = NOTIFY_BY_PHASE[report.phase ?? ""];
  if (mapped) notify({ level: mapped.level, stage: "SA", event: `acceptance_${report.phase}`, message: report.summary || mapped.message });
}

function normalizeScenarios(raw: unknown): AcceptanceScenario[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is RawFinding & AcceptanceScenario => Boolean(s) && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : undefined,
      verification: s.verification === "executed" || s.verification === "read_only" ? s.verification : undefined,
      result: typeof s.result === "string" ? s.result : undefined,
    }));
}

function normalizeFindings(raw: unknown): AcceptanceFinding[] {
  if (!Array.isArray(raw)) return [];
  const findings: AcceptanceFinding[] = [];
  for (const entry of raw as RawFinding[]) {
    if (!entry || typeof entry !== "object") continue;
    const gap = typeof entry.gap === "string" ? entry.gap.trim() : "";
    if (!gap) continue;
    const obligation = typeof entry.obligation === "string" ? entry.obligation.trim() : "";
    const title = (typeof entry.title === "string" && entry.title.trim()) || `Whole-product acceptance: ${obligation || gap.slice(0, 72)}`;
    const classification = (CR_CLASSIFICATIONS as readonly string[]).includes(String(entry.classification))
      ? (entry.classification as CrClassification)
      : "minor_product_change";
    const verification = entry.verification === "executed" || entry.verification === "read_only" ? entry.verification : undefined;
    findings.push({ obligation: obligation || undefined, gap, verification, title, classification });
  }
  return findings;
}

function findingBody(finding: AcceptanceFinding): string {
  return [
    `# Acceptance finding — ${finding.title}`,
    "",
    "## Idea",
    "",
    "The whole-product acceptance leg ran once every issue was delivered and checked the assembled product against the frozen canonical. It found the product does not satisfy this obligation end to end:",
    "",
    finding.gap ?? "",
    "",
    "## Why It Matters",
    "",
    `Every per-issue gate was green, yet the assembled product fails this obligation when checked as a whole (verification: ${finding.verification ?? "read_only"}). The owner decides whether to fold a fix into the canonical — which re-freezes and reopens the impacted issues — or to reject this.`,
    "",
    "## Machine Evidence",
    "",
    "```text",
    `obligation: ${finding.obligation ?? "(whole-product)"}`,
    `source: whole-product acceptance leg`,
    `verdict: ${ACCEPTANCE_VERDICT_REL}`,
    "```",
    "",
  ].join("\n");
}

export async function runAcceptance(options: RunAcceptanceOptions = {}): Promise<AcceptanceReport> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new AcceptanceConfigError("runAcceptance: no target project configured. Set VIVICY_TARGET_ROOT or pass options.repoRoot.");
  }
  const now = options.now ?? (() => new Date());
  const emitReport = options.emitReport ?? defaultEmitReport;
  const createCr = options.createCr ?? createChangeRequest;
  const findBaseline = options.findBaseline ?? findFrozenManifest;
  const spawnLeg = options.spawnLeg ?? makeDefaultSpawnAcceptanceLeg(options);

  const baseline = findBaseline(repoRoot);
  const { done, total } = issueTotals(repoRoot);
  const hash = doneSetHash(repoRoot);
  const prior = readJsonOrNull(resolve(repoRoot, ACCEPTANCE_REPORT_REL)) as AcceptanceReport | null;

  const report: AcceptanceReport = {
    phase: "checking",
    baseline_id: baseline?.baselineId ?? null,
    done_set_hash: hash,
    scenarios: [],
    findings: [],
    drafted_crs: [],
    read_only_scenarios: 0,
    summary: "",
    updated_at: "",
  };
  const emit = (): AcceptanceReport => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
    return report;
  };

  if (total <= 0 || done < total) {
    report.phase = "failed";
    report.summary = `acceptance runs only once every issue is delivered (done ${done}/${total}); nothing to accept.`;
    return emit();
  }
  if (!baseline) {
    report.phase = "failed";
    report.summary = "no active frozen baseline to accept against — the product was not built from a frozen canonical.";
    return emit();
  }

  if (!options.force && prior && (prior.phase === "green" || prior.phase === "findings") && prior.baseline_id === baseline.baselineId && prior.done_set_hash === hash) {
    return prior;
  }

  report.summary = "checking the assembled product against the frozen canonical (obligations + end-to-end scenarios)";
  emit();

  let legResult: LegResult | void;
  try {
    legResult = await spawnLeg({ repoRoot, manifestPath: baseline.manifestPath, baselineId: baseline.baselineId, verdictRel: ACCEPTANCE_VERDICT_REL });
  } catch (error) {
    report.phase = "failed";
    report.summary = `acceptance leg errored: ${error instanceof Error ? error.message : String(error)}`;
    return emit();
  }
  if (legResult && legResult.result?.timedOut) {
    report.phase = "failed";
    report.summary = `acceptance leg timed out (${legResult.result.timeoutReason ?? "no output"}); retry the dev stage to re-run acceptance.`;
    return emit();
  }

  const verdict = readJsonOrNull(resolve(repoRoot, ACCEPTANCE_VERDICT_REL)) as RawVerdict | null;
  if (!verdict || typeof verdict.accepted !== "boolean") {
    report.phase = "failed";
    report.summary = "acceptance leg produced no valid verdict (missing or malformed acceptance-verdict.json); retry the dev stage.";
    return emit();
  }

  const scenarios = normalizeScenarios(verdict.scenarios);
  const findings = normalizeFindings(verdict.findings);
  report.scenarios = scenarios;
  report.read_only_scenarios = scenarios.filter((s) => s.verification === "read_only").length;

  if (findings.length === 0) {
    if (verdict.accepted === true) {
      report.phase = "green";
      report.summary = `accepted: the delivered product satisfies the spec end to end (${countOf(scenarios.length, "scenario", "scenarios")} checked, ${report.read_only_scenarios} read-only-verified pending the run story).`;
      return emit();
    }
    report.phase = "failed";
    report.summary = "acceptance leg reported the product not accepted but listed no actionable findings — the verdict is unusable; retry the dev stage.";
    return emit();
  }

  try {
    for (const finding of findings) {
      const { id } = createCr({
        repoRoot,
        title: finding.title!,
        classification: finding.classification as CrClassification,
        source: "agent",
        sourceEvidence: [
          `whole-product acceptance finding (obligation: ${finding.obligation ?? "whole-product"}, verification: ${finding.verification ?? "read_only"})`,
          ACCEPTANCE_VERDICT_REL,
        ],
        body: findingBody(finding),
        now: () => now().toISOString(),
      });
      finding.cr_id = id;
      report.drafted_crs!.push(id);
    }
  } catch (error) {
    report.phase = "failed";
    report.findings = findings;
    report.summary = `acceptance found gaps but could not route them into change requests: ${error instanceof Error ? error.message : String(error)}`;
    return emit();
  }

  report.phase = "findings";
  report.findings = findings;
  report.summary = `${countOf(findings.length, "whole-product gap", "whole-product gaps")} found; drafted ${report.drafted_crs!.join(", ")} for the owner to decide. Done withheld until acceptance is clean.`;
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
  runAcceptance({ repoRoot })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(report.summary);
      process.exit(report.phase === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof AcceptanceConfigError ? 2 : 1);
    });
}
