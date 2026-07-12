#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { franc } from "franc-min";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig, LegDeps } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { notify } from "./notify.ts";
import { resolveTargetRoot, FACTORY_PROMPTS_DIR } from "./target-root.ts";
import { BINARY_DOC_EXTENSIONS, extractBinaryDocText } from "./text-extract.ts";
import { pruneGitkeeps } from "../lib/skeleton.ts";

export const DOC_PREP_REPORT_REL = ".vivicy/development/reports/doc-prep-report.json";
const UPLOADS_REL = ".vivicy/uploads";
const MANIFEST_FILE = "manifest.json";
const SCRATCH_REL = ".vivicy/development/reports/doc-prep-scratch";
const PREP_ISSUE_ID = "DOC-PREP";
const UNDETERMINED = "und";

export type DocPrepPhase = "classifying" | "extracting" | "placing" | "green" | "failed" | "skipped";
export type DocPrepRoute = "canonical" | "explode";
export type DocPrepRejectReason = "invalid_canonical" | "extract_failed" | "outside_target" | "empty_output" | "leg_no_output";

interface ManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface BatchManifest {
  batchId: string;
  createdAt: string;
  language: string;
  files: ManifestFile[];
}

export interface LatestBatch {
  batchId: string;
  batchDir: string;
  manifest: BatchManifest;
}

export interface PlacedDoc {
  target: string;
  source?: string;
  route: DocPrepRoute;
  translated: boolean;
}

export interface RejectedDoc {
  source: string;
  reason: DocPrepRejectReason;
  detail?: string;
}

export interface DocPrepReport {
  phase: DocPrepPhase;
  batch_id: string | null;
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

const TEXT_LANGUAGE_EXTENSIONS = new Set([
  ".md", ".markdown", ".txt", ".html", ".htm", ".csv", ".tsv", ".json", ".yaml", ".yml", ".xml", ".adoc", ".asciidoc", ".rst", ".tex", ".eml",
]);

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
  findLatestBatch?: (repoRoot: string) => LatestBatch | null;
  now?: () => Date;
}

// The batch-complete marker is manifest.json (written LAST by import); a batch dir without it is an interrupted, non-consumable batch.
export function latestCompleteBatch(repoRoot: string): LatestBatch | null {
  const uploadsDir = resolve(repoRoot, UPLOADS_REL);
  if (!existsSync(uploadsDir)) return null;
  const ids = readdirSync(uploadsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(uploadsDir, name, MANIFEST_FILE)))
    .sort((a, b) => a.localeCompare(b));
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const batchDir = join(uploadsDir, ids[i]);
    const manifest = readManifest(join(batchDir, MANIFEST_FILE));
    if (manifest) return { batchId: ids[i], batchDir, manifest };
  }
  return null;
}

function readManifest(abs: string): BatchManifest | null {
  const parsed = readJsonOrNull(abs) as Partial<BatchManifest> | null;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.files)) return null;
  return {
    batchId: String(parsed.batchId ?? ""),
    createdAt: String(parsed.createdAt ?? ""),
    language: typeof parsed.language === "string" && parsed.language.length > 0 ? parsed.language : UNDETERMINED,
    files: parsed.files.filter((f): f is ManifestFile => Boolean(f) && typeof f === "object" && typeof (f as ManifestFile).path === "string"),
  };
}

export function docPrepStageNeeded(batch: { batchId: string } | null, report: { phase?: unknown; batch_id?: unknown } | null): boolean {
  if (!batch) return false;
  if (!report) return true;
  const settled = report.phase === "green" || report.phase === "skipped";
  return !settled || report.batch_id !== batch.batchId;
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
  const findLatestBatch = options.findLatestBatch ?? latestCompleteBatch;

  const batch = findLatestBatch(repoRoot);
  const priorReport = readJsonOrNull(resolve(repoRoot, DOC_PREP_REPORT_REL)) as Partial<DocPrepReport> | null;

  const report: DocPrepReport = {
    phase: "classifying",
    batch_id: batch?.batchId ?? null,
    language: batch?.manifest.language ?? UNDETERMINED,
    placed: [],
    rejected: [],
    summary: "",
    updated_at: "",
  };
  const emit = (): void => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
  };

  if (!batch) {
    report.phase = "skipped";
    report.summary = "no upload batch to prepare — the pipeline proceeds on the owner-authored canonical (nothing was imported).";
    emit();
    return report;
  }
  if (batch.manifest.files.length === 0) {
    report.phase = "skipped";
    report.summary = `batch ${batch.batchId} carries no files; nothing to prepare.`;
    emit();
    return report;
  }
  if (!docPrepStageNeeded(batch, priorReport)) {
    report.phase = "skipped";
    report.placed = Array.isArray(priorReport?.placed) ? (priorReport!.placed as PlacedDoc[]) : [];
    report.summary = `doc-prep already settled for batch ${batch.batchId}; nothing to do. A new import batch re-runs the stage.`;
    emit();
    return report;
  }

  report.summary = `classifying ${batch.manifest.files.length} file(s) from batch ${batch.batchId} (language: ${report.language})`;
  emit();

  const legInputs: Array<{ source: string; text: string }> = [];
  for (const file of batch.manifest.files) {
    const rel = file.path;
    const ext = extname(rel).toLowerCase();
    const abs = join(batch.batchDir, ...rel.split("/"));
    if (!existsSync(abs)) {
      report.rejected.push({ source: rel, reason: "extract_failed", detail: "file listed in the manifest is missing on disk" });
      continue;
    }
    const bytes = readFileSync(abs);
    const located = routeByLocation(rel);
    if (located) {
      const text = TEXT_LANGUAGE_EXTENSIONS.has(ext) ? bytes.toString("utf8") : "";
      if (text.trim().length === 0) {
        report.rejected.push({ source: rel, reason: "invalid_canonical", detail: "a document in a canonical location must be non-empty parseable text" });
        continue;
      }
      if (ext === ".json" && !isParseableJson(text)) {
        report.rejected.push({ source: rel, reason: "invalid_canonical", detail: "requirements .json is not valid JSON" });
        continue;
      }
      if (isDominant(detectLanguage(text), report.language)) {
        placeFile(repoRoot, located.targetRel, bytes);
        report.placed.push({ target: located.targetRel, source: rel, route: "canonical", translated: false });
        continue;
      }
      legInputs.push({ source: rel, text: `${translateBanner(located.targetRel)}\n\n${text}` });
      continue;
    }
    let text: string;
    try {
      text = BINARY_DOC_EXTENSIONS.has(ext) ? await extractBinaryDocText(ext, bytes) : bytes.toString("utf8");
    } catch (error) {
      report.rejected.push({ source: rel, reason: "extract_failed", detail: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (text.trim().length === 0) {
      report.rejected.push({ source: rel, reason: "extract_failed", detail: "extracted text is empty" });
      continue;
    }
    legInputs.push({ source: rel, text });
  }

  if (legInputs.length > 0) {
    report.phase = "extracting";
    report.summary = `exploding/translating ${legInputs.length} document(s) into canonical form (dominant language ${report.language})`;
    emit();
    const spawnLeg = options.spawnLeg ?? makeDefaultSpawnLeg(options);
    const legOutcome = await runLeg({ repoRoot, language: report.language, inputs: legInputs, spawnLeg });
    if (!legOutcome.ok) {
      clearScratch(repoRoot);
      report.phase = "failed";
      report.summary = `document-preparation leg produced no valid canonical documents after a bounded re-prompt: ${legOutcome.problems.join("; ")}`;
      report.rejected.push(...legInputs.map((i) => ({ source: i.source, reason: "leg_no_output" as const, detail: "the leg wrote nothing placeable for this source" })));
      emit();
      return report;
    }
    report.phase = "placing";
    report.summary = `placing ${legOutcome.outputs.length} canonical document(s) from the leg`;
    emit();
    for (const out of legOutcome.outputs) {
      const target = targetForOutput(out.rel);
      if (!target) {
        report.rejected.push({ source: `leg:${out.rel}`, reason: "outside_target", detail: "leg output is not a valid canonical target path/extension" });
        continue;
      }
      if (out.bytes.length === 0) {
        report.rejected.push({ source: `leg:${out.rel}`, reason: "empty_output" });
        continue;
      }
      placeFile(repoRoot, out.rel, out.bytes);
      report.placed.push({ target: out.rel, route: "explode", translated: true });
    }
    clearScratch(repoRoot);
  }

  report.phase = "green";
  report.summary =
    `doc-prep green: ${report.placed.length} canonical document(s) placed, ${report.rejected.length} rejected, from batch ${batch.batchId} (language ${report.language})` +
    (report.placed.length === 0 && report.rejected.length === 0 ? " (empty batch is a legitimate outcome)" : "");
  emit();
  return report;
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
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
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
