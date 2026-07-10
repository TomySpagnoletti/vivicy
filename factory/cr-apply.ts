#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { pruneGitkeeps } from "../lib/skeleton.ts";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Config } from "./dev-loop.ts";
import { readChangeRequest, stampChangeRequestApplied } from "./change-control.ts";
import type { ChangeRequestRecord, CrFrontmatterValue } from "./change-control.ts";
import { runReferenceCheck as runReferenceCheckImpl } from "./reference-check.ts";
import { readSpikes } from "./spike-check.ts";
import { flipSpikeStatus } from "./spike-prover.ts";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";

const BASELINE_DIR = ".vivicy/baselines";
const REPORTS_DIR = ".vivicy/development/reports";
const CHANGE_REQUESTS_DIR = ".vivicy/change-requests";
const APPLIER_GRAPH_REF = "node:cr-apply";
const DEFAULT_APPLY_ATTEMPTS = 2;

interface AgentLegs {
  implementer: AgentLeg;
  reviewer: AgentLeg;
}

export interface Baseline {
  manifestPath: string;
  baselineId: string;
  version: string;
  documentSetHash: string;
  manifestHash: string;
}

interface ReferenceResult {
  exitCode: number;
  errors?: string[];
}

export interface Extraction {
  status: string;
  summary?: string;
  reopened?: string[];
  exitCode?: number;
}

interface ExtractionStatus {
  phase?: string;
  summary?: string;
  reopened?: string[];
}

interface CommitResult {
  committed: boolean;
}

export interface ApplierContext {
  repoRoot: string;
  cr: ChangeRequestRecord;
  cfg: Config;
  attempt: number;
  feedback: string | null;
}

export interface FreezeArgs {
  repoRoot: string;
  version: string;
  previousVersion: string;
  approvedBy: string;
  approvalRef: string;
}

type ReportSnapshot = Record<string, unknown>;
type RecordReport = (report: ReportSnapshot) => void;

interface TerminalReport {
  status: "green" | "blocked";
  phase: string;
  cr: string;
  baseline?: Baseline;
  extraction?: Extraction;
  reference?: ReferenceResult | null;
  retired?: string[];
  summary: string;
}

export interface ApplyChangeRequestArgs {
  repoRoot?: string;
  id?: string;
  cfg?: Partial<Config>;
  legs?: AgentLegs;
  now?: () => string;
  spawnApplier?: (ctx: ApplierContext) => Promise<unknown>;
  runReferenceCheck?: (args: { repoRoot: string }) => ReferenceResult;
  runFreeze?: (args: FreezeArgs) => Baseline | Promise<Baseline>;
  commitApplied?: (args: { repoRoot: string; id: string }) => CommitResult;
  runExtraction?: (args: { repoRoot: string }) => Extraction | Promise<Extraction>;
  recordReport?: RecordReport;
}

export async function applyChangeRequest(args: ApplyChangeRequestArgs = {}): Promise<TerminalReport> {
  const repoRoot = args.repoRoot;
  if (!repoRoot) {
    throw new Error("No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project, or pass repoRoot.");
  }
  const id = args.id;
  if (!id) throw new Error("applyChangeRequest: a CR id (e.g. CR-0001) is required");

  const cfg: Config = { ...DEFAULT_CONFIG, ...(args.cfg ?? {}) };
  const legs: AgentLegs = args.legs ?? resolveAgentLegs(process.env);
  const now = args.now ?? (() => new Date().toISOString());
  const spawnApplier = args.spawnApplier ?? makeDefaultSpawnApplier(cfg, legs);
  const runReferenceCheck = args.runReferenceCheck ?? ((a: { repoRoot: string }) => runReferenceCheckImpl(a) as ReferenceResult);
  const runFreeze = args.runFreeze ?? defaultRunFreeze;
  const commitApplied = args.commitApplied ?? defaultCommitApplied;
  const runExtraction = args.runExtraction ?? defaultRunExtraction;
  const recordReport = args.recordReport ?? ((report: ReportSnapshot) => defaultRecordReport(repoRoot, id, report));

  const found = readChangeRequest(repoRoot, id);
  if (!found) {
    return terminal(recordReport, "blocked", "resolve", id, { summary: `cr-apply: no CR with id ${id} under .vivicy/change-requests/` });
  }
  // readChangeRequest returns a bare filename in `file`; normalize to repo-relative so the transcript key and any display show the real path.
  const cr: ChangeRequestRecord = { ...found, file: `${CHANGE_REQUESTS_DIR}/${found.file}` };
  const status = String(cr.fm?.status ?? "");
  if (status !== "accepted_current_build") {
    return terminal(recordReport, "blocked", "resolve", id, { summary: `cr-apply: CR ${id} is "${status}", the application chain only runs on accepted_current_build` });
  }

  recordReport({ phase: "apply", cr: id, attempt: 1, started_at: now() });
  let referenceOk = false;
  let reference: ReferenceResult | null = null;
  let feedback: string | null = null;
  for (let attempt = 1; attempt <= DEFAULT_APPLY_ATTEMPTS; attempt += 1) {
    recordReport({ phase: "apply", cr: id, attempt, updated_at: now() });
    await spawnApplier({ repoRoot, cr, cfg, attempt, feedback });

    recordReport({ phase: "verify", cr: id, attempt, updated_at: now() });
    reference = runReferenceCheck({ repoRoot });
    if (reference.exitCode === 0) {
      referenceOk = true;
      break;
    }
    feedback = formatReferenceFailure(reference);
  }
  if (!referenceOk) {
    return terminal(recordReport, "blocked", "verify", id, {
      reference,
      summary: `cr-apply: reference-check stayed red after ${DEFAULT_APPLY_ATTEMPTS} apply attempt(s) — the canonical edit for ${id} broke a doc link. CR left accepted_current_build.`,
    });
  }

  const previousVersion = String(cr.fm?.previous_baseline_version ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(previousVersion)) {
    return terminal(recordReport, "blocked", "freeze", id, { summary: `cr-apply: CR ${id} has no valid previous_baseline_version to bump from (got "${previousVersion}")` });
  }
  const newVersion = patchBump(previousVersion);
  const approvedBy = String(cr.fm?.owner_decision_by ?? "owner:cr-apply");

  // Must write before commitApplied below: doc-baseline refuses to freeze a dirty tree, and this report file is tracked — writing it after the commit would re-dirty the tree and fail the freeze.
  recordReport({ phase: "freeze", cr: id, from_version: previousVersion, to_version: newVersion, updated_at: now() });

  const committed = commitApplied({ repoRoot, id });
  if (!committed.committed) {
    return terminal(recordReport, "blocked", "commit", id, { summary: `cr-apply: could not commit the applied canonical edit for ${id} before freezing (git add/commit failed)` });
  }
  let baseline: Baseline;
  try {
    baseline = await runFreeze({ repoRoot, version: newVersion, previousVersion, approvedBy, approvalRef: id });
  } catch (error) {
    return terminal(recordReport, "blocked", "freeze", id, { summary: `cr-apply: freeze failed for ${id}: ${error instanceof Error ? error.message : String(error)}` });
  }

  try {
    stampChangeRequestApplied({
      repoRoot,
      id,
      resulting: {
        resulting_baseline_id: baseline.baselineId,
        resulting_baseline_version: baseline.version,
        resulting_baseline_manifest_path: baseline.manifestPath,
        resulting_document_set_hash: baseline.documentSetHash,
        resulting_manifest_hash: baseline.manifestHash,
      },
      now,
    });
  } catch (error) {
    return terminal(recordReport, "blocked", "stamp", id, { baseline, summary: `cr-apply: could not stamp ${id} docs_applied: ${error instanceof Error ? error.message : String(error)}` });
  }
  recordReport({ phase: "stamped", cr: id, baseline, updated_at: now() });

  // Must run before extraction spawns and be committed before it: flips failed spikes to deferred (never re-authors) so the child's gate check doesn't see them as still-failed and block, and so a child freeze doesn't hit a dirty tree.
  const retired = retireAffectedSpikes({ repoRoot, cr });
  if (retired.length > 0) {
    recordReport({ phase: "retire_spikes", cr: id, retired, updated_at: now() });
    const committedRetire = commitApplied({ repoRoot, id });
    if (!committedRetire.committed) {
      return terminal(recordReport, "blocked", "retire_spikes", id, { baseline, retired, summary: `cr-apply: could not commit the retired spike(s) ${retired.join(", ")} for ${id} before re-extraction (git add/commit failed)` });
    }
  }

  // Extraction reopens impacted done issues internally (see extract-issues.ts) — do not reopen here too, or issues double-reopen.
  recordReport({ phase: "extract", cr: id, updated_at: now() });
  const extraction = await runExtraction({ repoRoot });
  if (extraction.status !== "green") {
    return terminal(recordReport, "blocked", "extract", id, {
      baseline,
      extraction,
      summary: `cr-apply: ${id} applied + re-frozen (baseline ${baseline.baselineId}), but re-extraction did not reach green: ${extraction.summary ?? extraction.status}`,
    });
  }

  return terminal(recordReport, "green", "green", id, {
    baseline,
    extraction,
    summary: `cr-apply: ${id} applied — canonical folded, re-frozen as ${baseline.baselineId}, re-extracted green${extraction.reopened?.length ? ` (reopened ${extraction.reopened.length} impacted issue(s))` : ""}.`,
  });
}

function terminal(recordReport: RecordReport, status: "green" | "blocked", phase: string, cr: string, extra: Omit<TerminalReport, "status" | "phase" | "cr">): TerminalReport {
  const report: TerminalReport = { status, phase, cr, ...extra };
  recordReport(report as unknown as ReportSnapshot);
  return report;
}

function makeDefaultSpawnApplier(baseCfg: Config, legs: AgentLegs): (ctx: ApplierContext) => Promise<unknown> {
  const implementer = legs?.implementer ?? { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg: AgentLeg = { ...implementer, role: "cr-applier" };
  return async ({ repoRoot, cr, cfg, attempt, feedback }) => {
    const legCfg = { ...cfg, promptsDir: cfg?.promptsDir ?? FACTORY_PROMPTS_DIR, execRoot: repoRoot } as LegConfig;
    const issue = applierIssue(cr);
    const context = applierContext({ cr, attempt, feedback });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg, deps) : runClaudeLeg(leg, issue, legCfg, deps);
  };
}

function applierIssue(cr: ChangeRequestRecord): AgentIssue {
  const number = ((cr.fm?.id ?? "") as string).replace(/^CR-/, "");
  return { id: `CR-APPLY-${number}`, graph_refs: [APPLIER_GRAPH_REF], path: cr.file };
}

function applierContext({ cr, attempt, feedback }: { cr: ChangeRequestRecord; attempt: number; feedback: string | null }): string {
  return (
    `\n\n---\n\n## CR application context for this run\n\n` +
    `- Change Request to fold: \`${cr.file}\` (id \`${cr.fm?.id}\`, status \`${cr.fm?.status}\`).\n` +
    `- Read its DECIDED intent (the Idea / Required Documentation Changes and the owner decision) and fold it into ` +
    `\`.vivicy/canonical/**\` with the SMALLEST faithful edit. The canonical becomes the single consolidated intention — ` +
    `never an old spec plus an annex. Touch NO other file (no issues, no baselines, no map, no other CR).\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback
      ? `\n### Repair this — the previous edit failed the read-only reference gate\n\n` + "```text\n" + feedback + "\n```\n"
      : "")
  );
}

function legDepsForTarget(legCfg: LegConfig, issue: AgentIssue, repoRoot: string, context: string): LegDeps {
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

// git add -A is safe here: the scaffold .gitignore covers the never-commit set.
function defaultCommitApplied({ repoRoot, id }: { repoRoot: string; id: string }): CommitResult {
  const add = spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
  if ((add.status ?? 1) !== 0) {
    process.stderr.write(`cr-apply: git add -A failed: ${add.stderr || add.stdout}\n`);
    return { committed: false };
  }
  const message = `change-request: fold ${id} into the canonical`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf8" });
  const out = `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`;
  if ((commit.status ?? 1) !== 0 && !/nothing to commit/i.test(out)) {
    process.stderr.write(`cr-apply: applied-edit commit failed: ${out.trim()}\n`);
    return { committed: false };
  }
  return { committed: true };
}

// Shells out to doc-baseline.ts (not imported) so its corpus-policy/git-clean/approval/bump-class guards run exactly as production.
function defaultRunFreeze({ repoRoot, version, previousVersion, approvedBy, approvalRef }: FreezeArgs): Baseline {
  const tool = resolve(FACTORY_DIR, "doc-baseline.ts");
  const baselineId = `baseline-v${version}`;
  const args = [
    tool, "generate",
    "--version", version,
    "--status", "frozen",
    "--bump", "patch",
    "--previous-version", previousVersion,
    "--approved-by", approvedBy,
    "--approval-ref", approvalRef,
  ];
  const result = spawnSync("node", args, { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`freeze failed (exit ${result.status}):\n${out}`);
  }
  const manifestPath = `${BASELINE_DIR}/${baselineId}.json`;
  const abs = resolve(repoRoot, manifestPath);
  if (!existsSync(abs)) throw new Error(`freeze reported success but ${manifestPath} is missing`);
  const manifest = JSON.parse(readFileSync(abs, "utf8")) as { document_set_hash: string; manifest_hash: string };
  return {
    manifestPath,
    baselineId,
    version,
    documentSetHash: manifest.document_set_hash,
    manifestHash: manifest.manifest_hash,
  };
}

// Shells out to extract-issues.ts (not imported) so the child runs the full real path (freeze reuse, spike gating, commit); reads its terminal state back from the status file the control plane also reads.
function defaultRunExtraction({ repoRoot }: { repoRoot: string }): Extraction {
  const tool = resolve(FACTORY_DIR, "extract-issues.ts");
  const result = spawnSync("node", [tool], { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" });
  const status = readExtractionStatus(repoRoot);
  return {
    status: status?.phase ?? (result.status === 0 ? "green" : "error"),
    summary: status?.summary ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").filter(Boolean).at(-1) ?? "",
    ...(Array.isArray(status?.reopened) ? { reopened: status.reopened } : {}),
    exitCode: result.status ?? 1,
  };
}

function readExtractionStatus(repoRoot: string): ExtractionStatus | null {
  const abs = resolve(repoRoot, `${REPORTS_DIR}/extraction-status.json`);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as ExtractionStatus;
  } catch {
    return null;
  }
}

function defaultRecordReport(repoRoot: string, id: string, report: ReportSnapshot): void {
  const abs = resolve(repoRoot, `${REPORTS_DIR}/apply-${id}.json`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ ...report, updated_at: (report as Record<string, unknown>).updated_at ?? new Date().toISOString() }, null, 2)}\n`);
  pruneGitkeeps(repoRoot);
}

function retireAffectedSpikes({ repoRoot, cr }: { repoRoot: string; cr: ChangeRequestRecord }): string[] {
  const gates = toGateList(cr.fm?.affected_verification_gates);
  if (gates.length === 0) return [];
  const spikeByGate = new Map(readSpikes(repoRoot).map((spike) => [spike.gate_id, spike]));
  const retired: string[] = [];
  for (const gate of gates) {
    const spike = spikeByGate.get(gate);
    if (!spike || spike.status !== "failed") continue;
    flipSpikeStatus(repoRoot, spike, "deferred");
    retired.push(gate);
  }
  return retired;
}

function toGateList(value: CrFrontmatterValue | undefined): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function patchBump(version: string): string {
  const [M, m, p] = version.split(".").map(Number);
  return `${M}.${m}.${p + 1}`;
}

function formatReferenceFailure(reference: ReferenceResult): string {
  const errors = (reference?.errors ?? []).join("\n");
  return `reference-check FAILED (exit ${reference?.exitCode}). A canonical doc link no longer resolves — repair the link(s) you broke:\n${errors}`;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const id = opt("cr");
  if (!id) {
    console.error("usage: cr-apply.ts --cr CR-#### [--dir <target>]");
    process.exit(2);
  }
  const dir = opt("dir");
  const repoRoot = dir ? resolve(dir) : resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT or pass --dir <target>.");
    process.exit(2);
  }
  applyChangeRequest({ repoRoot, id })
    .then((result) => {
      console.log(result.summary);
      process.exit(result.status === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
