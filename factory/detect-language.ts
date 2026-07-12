import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

import { runCodexLegAsync } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps } from "./agent-spawn.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { agentCliArgs, composePrompt, DEFAULT_CONFIG } from "./dev-loop.ts";
import { notify } from "./notify.ts";
import { FACTORY_PROMPTS_DIR } from "./target-root.ts";
import { extractScannableText } from "../lib/text-extract.ts";

const UNDETERMINED = "und";
const MANIFEST_FILE = "manifest.json";
const SCRATCH_REL = ".vivicy/development/reports/lang-detect-scratch";
const VERDICT_FILE = "language.json";
const LANG_ISSUE_ID = "DETECT-LANGUAGE";
const SAMPLE_LINE_CAP = 40;
const SAMPLE_CHAR_CAP = 4000;

// Verified Codex model family (gpt-5.6 Sol/Terra/Luna): Luna is the fast, cheap tier — the right fit for a one-shot language verdict.
const DEFAULT_LANG_MODEL = "gpt-5.6-luna";
const DEFAULT_LANG_EFFORT = "low";

const ISO_639_3 = /^[a-z]{3}$/;

export interface LanguageResolution {
  resolved: boolean;
  language: string;
  perFile?: Record<string, string>;
  reason?: string;
}

interface LangSpawnArgs {
  repoRoot: string;
  inputDir: string;
  outputDir: string;
}

export interface ResolveBatchLanguageOptions {
  repoRoot: string;
  batchDir: string;
  env?: NodeJS.ProcessEnv;
  cfg?: Record<string, unknown>;
  promptsDir?: string;
  spawnLeg?: (args: LangSpawnArgs) => Promise<unknown>;
  notifyFn?: (payload: { level: "info" | "success" | "warning" | "error"; stage: string; event: string; message: string }) => void;
}

// P5: the leg proposes a per-file + dominant ISO 639-3 verdict; this orchestrator validates it and writes the manifest.
// The manifest language field is updated in place (temp+rename via atomicWriteJson) so a crash mid-update never leaves a
// half-written manifest: the batch-complete marker (manifest present + parseable) holds at every instant, only `language` flips.
export async function resolveBatchLanguage(options: ResolveBatchLanguageOptions): Promise<LanguageResolution> {
  const { repoRoot, batchDir } = options;
  const notifyFn = options.notifyFn ?? ((payload) => { notify(payload); });
  const manifestPath = join(batchDir, MANIFEST_FILE);
  const manifest = readJsonObject(manifestPath);
  if (!manifest) return { resolved: false, language: UNDETERMINED, reason: "manifest unreadable" };

  const current = typeof manifest.language === "string" ? manifest.language : UNDETERMINED;
  if (current !== UNDETERMINED) return { resolved: false, language: current };

  const samples = await collectSamples(batchDir, manifest);
  if (samples.length === 0) {
    notifyFn({
      level: "warning",
      stage: "SP",
      event: "language_unresolved",
      message: "no scannable text in the batch — language stays 'und' (documents will be treated as language-agnostic)",
    });
    return { resolved: false, language: UNDETERMINED, reason: "no scannable text" };
  }

  const inputDir = resolve(repoRoot, SCRATCH_REL, "input");
  const outputDir = resolve(repoRoot, SCRATCH_REL, "output");
  clearScratch(repoRoot);
  mkdirSync(inputDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  for (const sample of samples) writeFileSync(join(inputDir, sample.name), sample.text);

  const spawnLeg = options.spawnLeg ?? makeDefaultLangLeg(options);
  try {
    await spawnLeg({ repoRoot, inputDir, outputDir });
  } catch {
    // A crashed leg is a failed verdict, never a thrown orchestrator — fall through to the und fallback.
  }

  const verdict = readVerdict(join(outputDir, VERDICT_FILE));
  clearScratch(repoRoot);
  if (!verdict) {
    notifyFn({
      level: "warning",
      stage: "SP",
      event: "language_unresolved",
      message: "the language leg produced no valid verdict — language stays 'und'",
    });
    return { resolved: false, language: UNDETERMINED, reason: "no valid leg verdict" };
  }

  manifest.language = verdict.dominant;
  try {
    atomicWriteJson(manifestPath, manifest);
  } catch {
    notifyFn({
      level: "warning",
      stage: "SP",
      event: "language_unresolved",
      message: "could not persist the resolved language to the manifest — it stays 'und'",
    });
    return { resolved: false, language: UNDETERMINED, reason: "manifest write failed" };
  }
  notifyFn({
    level: "success",
    stage: "SP",
    event: "language_resolved",
    message: `document language resolved to '${verdict.dominant}' by the language leg`,
  });
  return { resolved: true, language: verdict.dominant, perFile: verdict.perFile };
}

async function collectSamples(batchDir: string, manifest: Record<string, unknown>): Promise<Array<{ name: string; text: string }>> {
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  const samples: Array<{ name: string; text: string }> = [];
  for (const entry of files) {
    const rel = typeof (entry as { path?: unknown }).path === "string" ? (entry as { path: string }).path : "";
    if (!rel) continue;
    const abs = join(batchDir, ...rel.split("/"));
    if (!existsSync(abs)) continue;
    const text = await extractScannableText(extname(rel), readFileSync(abs));
    const sample = capSample(text);
    if (sample.length > 0) samples.push({ name: sourceToInputName(rel), text: sample });
  }
  return samples;
}

function capSample(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  const capped = trimmed.split("\n").slice(0, SAMPLE_LINE_CAP).join("\n");
  return capped.length > SAMPLE_CHAR_CAP ? capped.slice(0, SAMPLE_CHAR_CAP) : capped;
}

function sourceToInputName(source: string): string {
  return `${source.replace(/[\\/]/g, "__")}.txt`;
}

function readVerdict(verdictPath: string): { dominant: string; perFile?: Record<string, string> } | null {
  const parsed = readJsonObject(verdictPath);
  if (!parsed) return null;
  const dominant = typeof parsed.dominant === "string" ? parsed.dominant.toLowerCase() : "";
  if (!ISO_639_3.test(dominant) || dominant === UNDETERMINED) return null;
  const perFile: Record<string, string> = {};
  const raw = parsed.perFile;
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === "string" && ISO_639_3.test(value.toLowerCase())) perFile[key] = value.toLowerCase();
    }
  }
  return { dominant, perFile: Object.keys(perFile).length > 0 ? perFile : undefined };
}

function readJsonObject(abs: string): Record<string, unknown> | null {
  if (!existsSync(abs)) return null;
  try {
    const parsed = JSON.parse(readFileSync(abs, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function clearScratch(repoRoot: string): void {
  rmSync(resolve(repoRoot, SCRATCH_REL), { recursive: true, force: true });
}

// Mirrors prepare-docs' makeDefaultSpawnLeg, but binds a fixed fast Codex leg (default gpt-5.6-luna) instead of the implementer leg.
function makeDefaultLangLeg(options: ResolveBatchLanguageOptions): (args: LangSpawnArgs) => Promise<unknown> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const env = options.env ?? process.env;
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  const model = (env.VIVICY_LANG_MODEL && env.VIVICY_LANG_MODEL.trim()) || DEFAULT_LANG_MODEL;
  const leg: AgentLeg = { actor: "codex", role: "detect-language", provider: "codex", model, effort: DEFAULT_LANG_EFFORT, fast: false };
  return async ({ repoRoot, inputDir, outputDir }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue: AgentIssue = { id: LANG_ISSUE_ID, graph_refs: ["node:detect-language"], path: relative(repoRoot, join(outputDir, VERDICT_FILE)) };
    const context = legContext({ repoRoot, inputDir, outputDir });
    const deps = legDeps(legCfg, issue, repoRoot, context);
    return runCodexLegAsync(leg, issue, legCfg as LegConfig, deps);
  };
}

function legContext({ repoRoot, inputDir, outputDir }: LangSpawnArgs): string {
  const verdictRel = relative(repoRoot, join(outputDir, VERDICT_FILE)) || join(outputDir, VERDICT_FILE);
  return (
    `\n\n---\n\n## Language-detection context for this run\n\n` +
    `- Sample text files (one per source document) are in: \`${relative(repoRoot, inputDir) || inputDir}\`. Read them all.\n` +
    `- Write your verdict as a single JSON file at: \`${verdictRel}\`.\n` +
    `- The JSON shape is EXACTLY: {"perFile": {"<sample-file-name>": "<ISO 639-3 code>"}, "dominant": "<ISO 639-3 code>"}.\n` +
    `- Codes are lowercase 3-letter ISO 639-3 (e.g. fra, eng, spa, deu). The dominant is the language of the greatest share of text across the samples.\n` +
    `- Write NOTHING else and modify nothing outside that one JSON file.\n`
  );
}

function legDeps(legCfg: Record<string, unknown>, issue: AgentIssue, repoRoot: string, context: string): LegDeps {
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
