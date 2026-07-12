#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { franc } from "franc-min";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig, LegDeps } from "./agent-spawn.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { notify } from "./notify.ts";
import { resolveTargetRoot, FACTORY_PROMPTS_DIR } from "./target-root.ts";
import { resolveBatchLanguage } from "./detect-language.ts";
import type { LanguageResolution } from "./detect-language.ts";
import { BINARY_DOC_EXTENSIONS, TEXT_LANGUAGE_EXTENSIONS, extractBinaryDocText } from "../lib/text-extract.ts";
import { dominantLanguage } from "../lib/dominant-language.ts";
import { pruneGitkeeps } from "../lib/skeleton.ts";
import {
  activeCycleId,
  activeCycleKind,
  completeBatches,
  consumedSet,
  unconsumedActiveCycleBatches,
} from "../lib/spec-cycle.ts";
import type { Batch } from "../lib/spec-cycle.ts";
import type { SpecKind } from "../lib/spec-kind.ts";

export { completeBatches, unconsumedActiveCycleBatches };
export type { Batch };

export const DOC_PREP_REPORT_REL = ".vivicy/development/reports/doc-prep-report.json";
const SCRATCH_REL = ".vivicy/development/reports/doc-prep-scratch";
const PREP_ISSUE_ID = "DOC-PREP";
const UNDETERMINED = "und";

export type DocPrepPhase = "classifying" | "extracting" | "placing" | "green" | "failed" | "skipped";
export type DocPrepRoute = "canonical" | "explode";
export type DocPrepRejectReason = "invalid_canonical" | "extract_failed" | "outside_target" | "empty_output" | "leg_no_output";

export interface PlacedDoc {
  batch: string;
  target: string;
  source?: string;
  route: DocPrepRoute;
  translated: boolean;
}

export interface RejectedDoc {
  batch: string;
  source: string;
  reason: DocPrepRejectReason;
  detail?: string;
}

export interface DocPrepReport {
  phase: DocPrepPhase;
  cycle_id: string | null;
  cycle_kind: SpecKind | null;
  batches_consumed: string[];
  batches_pending: string[];
  language: string;
  placed: PlacedDoc[];
  rejected: RejectedDoc[];
  summary: string;
  updated_at: string;
}

interface CanonicalTarget {
  marker: string;
  dir: string;
  exts: Set<string>;
}

// One source of truth for canonical placement: the router (upload rel -> target) and the leg-output validator both read it.
const CANONICAL_TARGETS: CanonicalTarget[] = [
  { marker: "canonical", dir: "canonical", exts: new Set([".md", ".markdown"]) },
  { marker: "architecture-map", dir: "architecture-map", exts: new Set([".yml", ".yaml"]) },
  { marker: "spikes", dir: "development/spikes", exts: new Set([".md", ".markdown"]) },
  { marker: "requirements", dir: "requirements", exts: new Set([".json", ".md", ".yml", ".yaml"]) },
];

export class DocPrepConfigError extends Error {}

interface SpawnLegArgs {
  repoRoot: string;
  inputDir: string;
  outputDir: string;
  language: string;
  attempt: number;
  feedback: string | null;
}

export interface PrepareDocsOptions {
  repoRoot?: string;
  cfg?: Record<string, unknown>;
  promptsDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnLeg?: (args: SpawnLegArgs) => Promise<LegResult | void>;
  emitReport?: (report: DocPrepReport, repoRoot: string) => void;
  resolveLanguage?: (args: { repoRoot: string; batchDir: string }) => Promise<LanguageResolution>;
  now?: () => Date;
}

export function docPrepStageNeeded(repoRoot: string, report: DocPrepReport | null): boolean {
  return unconsumedActiveCycleBatches(repoRoot, report).length > 0;
}

// Deterministic router: an upload whose relative path sits under a canonical dir marker with a valid extension is a path-(a) candidate; everything else is path (b).
export function routeByLocation(rel: string): { targetRel: string } | null {
  const segments = rel.split("/").filter((s) => s.length > 0);
  const ext = extname(rel).toLowerCase();
  for (const target of CANONICAL_TARGETS) {
    const idx = segments.indexOf(target.marker);
    if (idx === -1) continue;
    const tail = segments.slice(idx + 1);
    if (tail.length === 0 || !target.exts.has(ext)) continue;
    return { targetRel: `${target.dir}/${tail.join("/")}` };
  }
  return null;
}

function targetForOutput(rel: string): CanonicalTarget | null {
  const ext = extname(rel).toLowerCase();
  for (const target of CANONICAL_TARGETS) {
    if ((rel === target.dir || rel.startsWith(`${target.dir}/`)) && target.exts.has(ext)) return target;
  }
  return null;
}

function detectLanguage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 24) return UNDETERMINED;
  return franc(trimmed);
}

function isDominant(docLanguage: string, batchLanguage: string): boolean {
  return docLanguage === UNDETERMINED || batchLanguage === UNDETERMINED || docLanguage === batchLanguage;
}

export async function prepareDocs(options: PrepareDocsOptions = {}): Promise<DocPrepReport> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new DocPrepConfigError("No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project, or pass options.repoRoot.");
  }
  const now = options.now ?? (() => new Date());
  const emitReport = options.emitReport ?? defaultEmitReport;

  const priorReport = readReport(repoRoot);
  const cycleId = activeCycleId(repoRoot);
  const cycleKind = activeCycleKind(repoRoot);
  const consumed = consumedSet(priorReport);
  const sameCycle = priorReport?.cycle_id != null && priorReport.cycle_id === cycleId;

  const report: DocPrepReport = {
    phase: "classifying",
    cycle_id: cycleId,
    cycle_kind: cycleKind,
    batches_consumed: [...consumed],
    batches_pending: [],
    language: UNDETERMINED,
    placed: carryForward(sameCycle ? priorReport?.placed : undefined, consumed),
    rejected: carryForward(sameCycle ? priorReport?.rejected : undefined, consumed),
    summary: "",
    updated_at: "",
  };
  const emit = (): void => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
  };

  if (cycleId === null) {
    const seeds = completeBatches(repoRoot).length;
    report.phase = "skipped";
    report.summary =
      seeds > 0
        ? `the canonical is frozen — ${seeds} imported batch(es) seed the next cycle and will be prepared when it opens.`
        : "no active cycle and no upload batch to prepare — the pipeline proceeds on the owner-authored canonical.";
    emit();
    return report;
  }

  const pending = unconsumedActiveCycleBatches(repoRoot, priorReport);
  report.batches_pending = pending.map((b) => b.batchId);
  if (pending.length === 0) {
    report.phase = "skipped";
    report.summary =
      report.batches_consumed.length > 0
        ? `doc-prep already settled for cycle ${cycleId}; every active-cycle batch is consumed. A new import re-runs the stage.`
        : `no upload batch bound to cycle ${cycleId} to prepare — the pipeline proceeds on the owner-authored canonical.`;
    emit();
    return report;
  }

  // The cycle's language is the project's ALREADY-ESTABLISHED canonical language; until one exists (greenfield), the first batch of the run fixes it.
  let cycleLanguage = establishedCanonicalLanguage(repoRoot);
  report.language = cycleLanguage;
  report.summary = `preparing ${pending.length} batch(es) for cycle ${cycleId}`;
  emit();

  const spawnLeg = options.spawnLeg ?? makeDefaultSpawnLeg(options);
  for (const batch of pending) {
    if (cycleLanguage === UNDETERMINED) {
      cycleLanguage = await batchLanguage(batch, options, repoRoot);
      report.language = cycleLanguage;
    }
    const outcome = await prepareBatch({ repoRoot, batch, cycleLanguage, spawnLeg, report, emit });
    if (!outcome.ok) {
      report.phase = "failed";
      report.summary = `document-preparation failed on batch ${batch.batchId} for cycle ${cycleId}: ${outcome.problem}`;
      emit();
      return report;
    }
    report.batches_consumed.push(batch.batchId);
    report.batches_pending = report.batches_pending.filter((id) => id !== batch.batchId);
    emit();
  }

  report.phase = "green";
  report.summary =
    `doc-prep green for cycle ${cycleId}: ${report.placed.length} canonical document(s) placed, ${report.rejected.length} rejected, across ${pending.length} batch(es) (language ${cycleLanguage})` +
    (report.placed.length === 0 && report.rejected.length === 0 ? " (empty batch is a legitimate outcome)" : "");
  emit();
  return report;
}

// Only the outcomes of fully-consumed batches persist across runs; a failed or in-flight batch leaves no stale placed/rejected entry to retry against.
function carryForward<T extends { batch?: string }>(prior: T[] | undefined, consumed: Set<string>): T[] {
  return Array.isArray(prior) ? prior.filter((e) => typeof e.batch === "string" && consumed.has(e.batch)) : [];
}

async function batchLanguage(batch: Batch, options: PrepareDocsOptions, repoRoot: string): Promise<string> {
  const declared = typeof batch.manifest.language === "string" ? batch.manifest.language : UNDETERMINED;
  if (declared !== UNDETERMINED) return declared;
  const resolveLanguage =
    options.resolveLanguage ??
    ((args) => resolveBatchLanguage({ ...args, env: options.env, cfg: options.cfg, promptsDir: options.promptsDir }));
  const resolution = await resolveLanguage({ repoRoot, batchDir: batch.batchDir });
  return resolution.resolved ? resolution.language : UNDETERMINED;
}

// The dominant language already carried by the placed canonical corpus (weighted by text length); UNDETERMINED when the corpus is empty.
function establishedCanonicalLanguage(repoRoot: string): string {
  const dir = resolve(repoRoot, ".vivicy", "canonical");
  if (!existsSync(dir)) return UNDETERMINED;
  const weights = new Map<string, number>();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile() || !TEXT_LANGUAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      const text = readFileSync(abs, "utf8");
      const lang = detectLanguage(text);
      if (lang !== UNDETERMINED) weights.set(lang, (weights.get(lang) ?? 0) + text.length);
    }
  };
  walk(dir);
  return dominantLanguage(weights);
}

async function prepareBatch(args: {
  repoRoot: string;
  batch: Batch;
  cycleLanguage: string;
  spawnLeg: (a: SpawnLegArgs) => Promise<LegResult | void>;
  report: DocPrepReport;
  emit: () => void;
}): Promise<{ ok: true } | { ok: false; problem: string }> {
  const { repoRoot, batch, cycleLanguage, spawnLeg, report, emit } = args;
  const batchId = batch.batchId;
  report.phase = "classifying";
  report.summary = `classifying ${batch.manifest.files.length} file(s) from batch ${batchId} (language ${cycleLanguage})`;
  emit();

  const legInputs: Array<{ source: string; text: string }> = [];
  for (const file of batch.manifest.files) {
    const rel = file.path;
    const ext = extname(rel).toLowerCase();
    const abs = join(batch.batchDir, ...rel.split("/"));
    if (!existsSync(abs)) {
      report.rejected.push({ batch: batchId, source: rel, reason: "extract_failed", detail: "file listed in the manifest is missing on disk" });
      continue;
    }
    const bytes = readFileSync(abs);
    const located = routeByLocation(rel);
    if (located) {
      const text = TEXT_LANGUAGE_EXTENSIONS.has(ext) ? bytes.toString("utf8") : "";
      if (text.trim().length === 0) {
        report.rejected.push({ batch: batchId, source: rel, reason: "invalid_canonical", detail: "a document in a canonical location must be non-empty parseable text" });
        continue;
      }
      if (ext === ".json" && !isParseableJson(text)) {
        report.rejected.push({ batch: batchId, source: rel, reason: "invalid_canonical", detail: "requirements .json is not valid JSON" });
        continue;
      }
      if (isDominant(detectLanguage(text), cycleLanguage)) {
        placeFile(repoRoot, located.targetRel, bytes);
        report.placed.push({ batch: batchId, target: located.targetRel, source: rel, route: "canonical", translated: false });
        continue;
      }
      legInputs.push({ source: rel, text: `${translateBanner(located.targetRel)}\n\n${text}` });
      continue;
    }
    let text: string;
    try {
      text = BINARY_DOC_EXTENSIONS.has(ext) ? await extractBinaryDocText(ext, bytes) : bytes.toString("utf8");
    } catch (error) {
      report.rejected.push({ batch: batchId, source: rel, reason: "extract_failed", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (text.trim().length === 0) {
      report.rejected.push({ batch: batchId, source: rel, reason: "extract_failed", detail: "extracted text is empty" });
      continue;
    }
    legInputs.push({ source: rel, text });
  }

  if (legInputs.length === 0) return { ok: true };

  report.phase = "extracting";
  report.summary = `exploding/translating ${legInputs.length} document(s) from batch ${batchId} into canonical form (dominant language ${cycleLanguage})`;
  emit();
  const legOutcome = await runLeg({ repoRoot, language: cycleLanguage, inputs: legInputs, spawnLeg });
  if (!legOutcome.ok) {
    clearScratch(repoRoot);
    report.rejected.push(...legInputs.map((i) => ({ batch: batchId, source: i.source, reason: "leg_no_output" as const, detail: "the leg wrote nothing placeable for this source" })));
    return { ok: false, problem: legOutcome.problems.join("; ") };
  }
  report.phase = "placing";
  report.summary = `placing ${legOutcome.outputs.length} canonical document(s) from batch ${batchId}`;
  emit();
  for (const out of legOutcome.outputs) {
    const target = targetForOutput(out.rel);
    if (!target) {
      report.rejected.push({ batch: batchId, source: `leg:${out.rel}`, reason: "outside_target", detail: "leg output is not a valid canonical target path/extension" });
      continue;
    }
    if (out.bytes.length === 0) {
      report.rejected.push({ batch: batchId, source: `leg:${out.rel}`, reason: "empty_output" });
      continue;
    }
    placeFile(repoRoot, out.rel, out.bytes);
    report.placed.push({ batch: batchId, target: out.rel, route: "explode", translated: true });
  }
  clearScratch(repoRoot);
  return { ok: true };
}

function readReport(repoRoot: string): DocPrepReport | null {
  return readJsonOrNull(resolve(repoRoot, DOC_PREP_REPORT_REL)) as DocPrepReport | null;
}

function translateBanner(targetRel: string): string {
  return `<!-- vivicy:doc-prep translate this document into the dominant language and write it to ${targetRel} preserving its structure -->`;
}

async function runLeg({
  repoRoot,
  language,
  inputs,
  spawnLeg,
}: {
  repoRoot: string;
  language: string;
  inputs: Array<{ source: string; text: string }>;
  spawnLeg: (args: SpawnLegArgs) => Promise<LegResult | void>;
}): Promise<{ ok: true; outputs: Array<{ rel: string; bytes: Buffer }> } | { ok: false; problems: string[] }> {
  const inputDir = resolve(repoRoot, SCRATCH_REL, "input");
  const outputDir = resolve(repoRoot, SCRATCH_REL, "output");
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    clearScratch(repoRoot);
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
    for (const input of inputs) writeFileSync(join(inputDir, sourceToInputName(input.source)), input.text);
    await spawnLeg({ repoRoot, inputDir, outputDir, language, attempt, feedback: problems.length > 0 ? problems.join("; ") : null });
    const outputs = readScratchOutputs(outputDir);
    if (outputs.length > 0) return { ok: true, outputs };
    problems = [`no files were written under ${relative(repoRoot, outputDir)}`];
  }
  return { ok: false, problems };
}

function sourceToInputName(source: string): string {
  return `${source.replace(/[\\/]/g, "__")}.txt`;
}

function readScratchOutputs(outputDir: string): Array<{ rel: string; bytes: Buffer }> {
  if (!existsSync(outputDir)) return [];
  const out: Array<{ rel: string; bytes: Buffer }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile()) out.push({ rel: relative(outputDir, abs).split("\\").join("/"), bytes: readFileSync(abs) });
    }
  };
  walk(outputDir);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

function placeFile(repoRoot: string, targetRel: string, bytes: Buffer | Uint8Array): void {
  const abs = resolve(repoRoot, ".vivicy", targetRel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, bytes);
}

function clearScratch(repoRoot: string): void {
  rmSync(resolve(repoRoot, SCRATCH_REL), { recursive: true, force: true });
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// Mirrors install-skills' makeDefaultSpawnScout — reuse the implementer leg binding, keep both in sync.
function makeDefaultSpawnLeg(options: PrepareDocsOptions): (args: SpawnLegArgs) => Promise<LegResult | void> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  const legs = resolveAgentLegs(options.env ?? process.env);
  const implementer: Leg = legs?.implementer ?? { actor: "claude", role: "implementer", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg: Leg = { ...implementer, role: "doc-prep" };
  return async ({ repoRoot, inputDir, outputDir, language, attempt, feedback }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue: AgentIssue = { id: PREP_ISSUE_ID, graph_refs: ["node:doc-prep"], path: DOC_PREP_REPORT_REL };
    const context = legContext({ repoRoot, inputDir, outputDir, language, attempt, feedback });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg as LegConfig, deps) : runClaudeLeg(leg, issue, legCfg as LegConfig, deps);
  };
}

function legContext({ repoRoot, inputDir, outputDir, language, attempt, feedback }: { repoRoot: string; inputDir: string; outputDir: string; language: string; attempt: number; feedback: string | null }): string {
  return (
    `\n\n---\n\n## Document-preparation context for this run\n\n` +
    `- Raw source documents (already converted to plain text) are in: \`${relative(repoRoot, inputDir) || inputDir}\`. Read them all.\n` +
    `- The DOMINANT language of this batch is the ISO 639-3 code \`${language}\`. EVERY canonical document you write MUST be in this language; translate any source that is in another language.\n` +
    `- Write your canonical documents ONLY under: \`${relative(repoRoot, outputDir) || outputDir}\`, mirroring the \`.vivicy/\` layout (e.g. \`canonical/…\`, \`development/spikes/…\`, \`requirements/…\`, \`architecture-map/architecture-map.yml\`). Write NOTHING outside this directory and NEVER touch \`.vivicy/uploads/\`.\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback ? `\n### What was INVALID last time\n\n\`\`\`text\n${feedback}\n\`\`\`\n` : "")
  );
}

// Mirrors install-skills' legDepsForTarget — keep both in sync.
function legDepsForTarget(legCfg: Record<string, unknown>, issue: AgentIssue, repoRoot: string, context: string): LegDeps {
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

const NOTIFY_BY_PHASE: Record<string, { level: "info" | "success" | "warning" | "error"; stage: string; message: string }> = {
  classifying: { level: "info", stage: "SP", message: "preparing imported documents (classifying the latest batch)" },
  green: { level: "success", stage: "SP", message: "document-preparation stage green" },
  failed: { level: "error", stage: "SP", message: "document-preparation stage failed" },
  skipped: { level: "info", stage: "SP", message: "document-preparation had nothing to prepare" },
};

function defaultEmitReport(report: DocPrepReport, repoRoot: string): void {
  const abs = resolve(repoRoot, DOC_PREP_REPORT_REL);
  mkdirSync(dirname(abs), { recursive: true });
  atomicWriteJson(abs, report);
  pruneGitkeeps(repoRoot);
  const mapped = NOTIFY_BY_PHASE[report.phase];
  if (mapped) notify({ ...mapped, event: `doc_prep_${report.phase}` });
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.");
    process.exit(2);
  }
  prepareDocs({ repoRoot })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(report.summary);
      process.exit(report.phase === "failed" ? 1 : 0);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof DocPrepConfigError ? 2 : 1);
    });
}
