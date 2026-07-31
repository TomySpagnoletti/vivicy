#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, extname, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { franc } from "franc-min"

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts"
import type { AgentIssue, LegConfig } from "./agent-spawn.ts"
import { legDepsForTarget } from "./leg-deps.ts"
import { atomicWriteJson } from "./atomic-write.ts"
import { cleanupTree } from "./cleanup-tree.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import type { Leg, LegResult } from "./dev-loop.ts"
import { notify } from "./notify.ts"
import { resolveTargetRoot, FACTORY_PROMPTS_DIR } from "./target-root.ts"
import { resolveBatchLanguage } from "./detect-language.ts"
import type { LanguageResolution } from "./detect-language.ts"
import { BINARY_DOC_EXTENSIONS, TEXT_LANGUAGE_EXTENSIONS, extractBinaryDocText } from "../lib/text-extract.ts"
import { countForm, countOf } from "../lib/count-form.ts"
import { dominantLanguage } from "../lib/dominant-language.ts"
import { describeFinding, highConfidenceFindings, scanText, type SecretFinding } from "../lib/secret-scan.ts"
import { pruneGitkeeps } from "../lib/skeleton.ts"
import { activeCycleId, activeCycleKind, completeBatches, consumedSet, unconsumedActiveCycleBatches } from "../lib/spec-cycle.ts"
import type { Batch } from "../lib/spec-cycle.ts"
import type { SpecKind } from "../lib/spec-kind.ts"

export { completeBatches, unconsumedActiveCycleBatches }
export type { Batch }

export const DOC_PREP_REPORT_REL = ".vivicy/development/reports/doc-prep-report.json"
const SCRATCH_REL = ".vivicy/development/reports/doc-prep-scratch"
const UNDETERMINED = "und"

export type DocPrepPhase = "classifying" | "extracting" | "placing" | "green" | "failed" | "skipped"
export type DocPrepRoute = "canonical" | "explode"
export type DocPrepRejectReason =
  "invalid_canonical" | "extract_failed" | "outside_target" | "empty_output" | "leg_no_output" | "secret_detected"

export interface PlacedDoc {
  batch: string
  target: string
  source?: string
  route: DocPrepRoute
  translated: boolean
}

export interface RejectedDoc {
  batch: string
  source: string
  reason: DocPrepRejectReason
  detail?: string
}

export interface SecretWarning {
  batch: string
  target: string
  source?: string
  line: number
  detector: string
  redacted: string
}

export interface DocPrepReport {
  phase: DocPrepPhase
  cycle_id: string | null
  cycle_kind: SpecKind | null
  batches_consumed: string[]
  batches_pending: string[]
  language: string
  placed: PlacedDoc[]
  rejected: RejectedDoc[]
  warnings: SecretWarning[]
  summary: string
  updated_at: string
}

interface CanonicalTarget {
  marker: string
  dir: string
  exts: Set<string>
}

const CANONICAL_TARGETS: CanonicalTarget[] = [
  { marker: "canonical", dir: "canonical", exts: new Set([".md", ".markdown"]) },
  { marker: "architecture-map", dir: "architecture-map", exts: new Set([".yml", ".yaml"]) },
  { marker: "spikes", dir: "development/spikes", exts: new Set([".md", ".markdown"]) },
  { marker: "requirements", dir: "requirements", exts: new Set([".json", ".md", ".yml", ".yaml"]) },
]

export class DocPrepConfigError extends Error {}

interface SpawnLegArgs {
  repoRoot: string
  inputDir: string
  outputDir: string
  language: string
  attempt: number
  feedback: string | null
}

export interface PrepareDocsOptions {
  repoRoot?: string
  cfg?: Record<string, unknown>
  promptsDir?: string
  env?: NodeJS.ProcessEnv
  spawnLeg?: (args: SpawnLegArgs) => Promise<LegResult | void>
  emitReport?: (report: DocPrepReport, repoRoot: string) => void
  resolveLanguage?: (args: { repoRoot: string; batchDir: string }) => Promise<LanguageResolution>
  now?: () => Date
}

export function docPrepStageNeeded(repoRoot: string, report: DocPrepReport | null): boolean {
  return unconsumedActiveCycleBatches(repoRoot, report).length > 0
}

export function routeByLocation(rel: string): { targetRel: string } | null {
  const segments = rel.split("/").filter((s) => s.length > 0)
  const ext = extname(rel).toLowerCase()
  for (const target of CANONICAL_TARGETS) {
    const idx = segments.indexOf(target.marker)
    if (idx === -1) continue
    const tail = segments.slice(idx + 1)
    if (tail.length === 0 || !target.exts.has(ext)) continue
    return { targetRel: `${target.dir}/${tail.join("/")}` }
  }
  return null
}

function targetForOutput(rel: string): CanonicalTarget | null {
  const ext = extname(rel).toLowerCase()
  for (const target of CANONICAL_TARGETS) {
    if ((rel === target.dir || rel.startsWith(`${target.dir}/`)) && target.exts.has(ext)) return target
  }
  return null
}

function detectLanguage(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length < 24) return UNDETERMINED
  return franc(trimmed)
}

function isDominant(docLanguage: string, batchLanguage: string): boolean {
  return docLanguage === UNDETERMINED || batchLanguage === UNDETERMINED || docLanguage === batchLanguage
}

export async function prepareDocs(options: PrepareDocsOptions = {}): Promise<DocPrepReport> {
  const repoRoot = options.repoRoot
  if (!repoRoot) {
    throw new DocPrepConfigError(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project, or pass options.repoRoot."
    )
  }
  const now = options.now ?? (() => new Date())
  const emitReport = options.emitReport ?? defaultEmitReport

  const priorReport = readReport(repoRoot)
  const cycleId = activeCycleId(repoRoot)
  const cycleKind = activeCycleKind(repoRoot)
  const consumed = consumedSet(priorReport)
  const sameCycle = priorReport?.cycle_id != null && priorReport.cycle_id === cycleId

  const report: DocPrepReport = {
    phase: "classifying",
    cycle_id: cycleId,
    cycle_kind: cycleKind,
    batches_consumed: [...consumed],
    batches_pending: [],
    language: UNDETERMINED,
    placed: carryForward(sameCycle ? priorReport?.placed : undefined, consumed),
    rejected: carryForward(sameCycle ? priorReport?.rejected : undefined, consumed),
    warnings: carryForward(sameCycle ? priorReport?.warnings : undefined, consumed),
    summary: "",
    updated_at: "",
  }
  const emit = (): void => {
    report.updated_at = now().toISOString()
    emitReport(report, repoRoot)
  }

  if (cycleId === null) {
    const seeds = completeBatches(repoRoot).length
    report.phase = "skipped"
    report.summary =
      seeds > 0
        ? `the canonical is frozen — ${countForm(seeds, "1 imported batch seeds", `${seeds} imported batches seed`)} the next cycle and will be prepared when it opens.`
        : "no active cycle and no upload batch to prepare — the workflow proceeds on the owner-authored canonical."
    emit()
    return report
  }

  const pending = unconsumedActiveCycleBatches(repoRoot, priorReport)
  report.batches_pending = pending.map((b) => b.batchId)
  if (pending.length === 0) {
    report.phase = "skipped"
    report.summary =
      report.batches_consumed.length > 0
        ? `doc-prep already settled for cycle ${cycleId}; every active-cycle batch is consumed. A new import re-runs the stage.`
        : `no upload batch bound to cycle ${cycleId} to prepare — the workflow proceeds on the owner-authored canonical.`
    emit()
    return report
  }

  let cycleLanguage = establishedCanonicalLanguage(repoRoot)
  report.language = cycleLanguage
  report.summary = `preparing ${countOf(pending.length, "batch", "batches")} for cycle ${cycleId}`
  emit()

  const spawnLeg = options.spawnLeg ?? makeDefaultSpawnLeg(options)
  for (const batch of pending) {
    if (cycleLanguage === UNDETERMINED) {
      cycleLanguage = await batchLanguage(batch, options, repoRoot)
      report.language = cycleLanguage
    }
    const outcome = await prepareBatch({ repoRoot, batch, cycleLanguage, spawnLeg, report, emit })
    if (!outcome.ok) {
      report.phase = "failed"
      report.summary = `document-preparation failed on batch ${batch.batchId} for cycle ${cycleId}: ${outcome.problem}`
      emit()
      return report
    }
    report.batches_consumed.push(batch.batchId)
    report.batches_pending = report.batches_pending.filter((id) => id !== batch.batchId)
    emit()
  }

  report.phase = "green"
  const secretRejects = report.rejected.filter((r) => r.reason === "secret_detected").length
  report.summary =
    `doc-prep green for cycle ${cycleId}: ${countOf(report.placed.length, "canonical document", "canonical documents")} placed, ${report.rejected.length} rejected, across ${countOf(pending.length, "batch", "batches")} (language ${cycleLanguage})` +
    (report.placed.length === 0 && report.rejected.length === 0 ? " (empty batch is a legitimate outcome)" : "") +
    (secretRejects > 0
      ? ` — ${secretRejects} kept out of the canonical for a suspected secret (remove or rotate the key, then re-import)`
      : "") +
    (report.warnings.length > 0 ? ` — ${report.warnings.length} placed with a possible-secret warning` : "")
  emit()
  return report
}

function carryForward<T extends { batch?: string }>(prior: T[] | undefined, consumed: Set<string>): T[] {
  return Array.isArray(prior) ? prior.filter((e) => typeof e.batch === "string" && consumed.has(e.batch)) : []
}

async function batchLanguage(batch: Batch, options: PrepareDocsOptions, repoRoot: string): Promise<string> {
  const declared = typeof batch.manifest.language === "string" ? batch.manifest.language : UNDETERMINED
  if (declared !== UNDETERMINED) return declared
  const resolveLanguage =
    options.resolveLanguage ??
    ((args) => resolveBatchLanguage({ ...args, env: options.env, cfg: options.cfg, promptsDir: options.promptsDir }))
  const resolution = await resolveLanguage({ repoRoot, batchDir: batch.batchDir })
  return resolution.resolved ? resolution.language : UNDETERMINED
}

function establishedCanonicalLanguage(repoRoot: string): string {
  const dir = resolve(repoRoot, ".vivicy", "canonical")
  if (!existsSync(dir)) return UNDETERMINED
  const weights = new Map<string, number>()
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const abs = join(d, entry.name)
      if (entry.isDirectory()) {
        walk(abs)
        continue
      }
      if (!entry.isFile() || !TEXT_LANGUAGE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue
      const text = readFileSync(abs, "utf8")
      const lang = detectLanguage(text)
      if (lang !== UNDETERMINED) weights.set(lang, (weights.get(lang) ?? 0) + text.length)
    }
  }
  walk(dir)
  return dominantLanguage(weights)
}

async function prepareBatch(args: {
  repoRoot: string
  batch: Batch
  cycleLanguage: string
  spawnLeg: (a: SpawnLegArgs) => Promise<LegResult | void>
  report: DocPrepReport
  emit: () => void
}): Promise<{ ok: true } | { ok: false; problem: string }> {
  const { repoRoot, batch, cycleLanguage, spawnLeg, report, emit } = args
  const batchId = batch.batchId
  report.phase = "classifying"
  report.summary = `classifying ${countOf(batch.manifest.files.length, "file", "files")} from batch ${batchId} (language ${cycleLanguage})`
  emit()

  const legInputs: Array<{ source: string; text: string }> = []
  for (const file of batch.manifest.files) {
    const rel = file.path
    const ext = extname(rel).toLowerCase()
    const abs = join(batch.batchDir, ...rel.split("/"))
    if (!existsSync(abs)) {
      report.rejected.push({
        batch: batchId,
        source: rel,
        reason: "extract_failed",
        detail: "file listed in the manifest is missing on disk",
      })
      continue
    }
    const bytes = readFileSync(abs)
    const located = routeByLocation(rel)
    if (located) {
      const text = TEXT_LANGUAGE_EXTENSIONS.has(ext) ? bytes.toString("utf8") : ""
      if (text.trim().length === 0) {
        report.rejected.push({
          batch: batchId,
          source: rel,
          reason: "invalid_canonical",
          detail: "a document in a canonical location must be non-empty parseable text",
        })
        continue
      }
      if (ext === ".json" && !isParseableJson(text)) {
        report.rejected.push({ batch: batchId, source: rel, reason: "invalid_canonical", detail: "requirements .json is not valid JSON" })
        continue
      }
      if (isDominant(detectLanguage(text), cycleLanguage)) {
        const findings = scanText(text)
        const high = highConfidenceFindings(findings)
        if (high.length > 0) {
          report.rejected.push({ batch: batchId, source: rel, reason: "secret_detected", detail: secretDetail(high) })
          continue
        }
        placeFile(repoRoot, located.targetRel, bytes)
        report.placed.push({ batch: batchId, target: located.targetRel, source: rel, route: "canonical", translated: false })
        recordSecretWarnings(report, batchId, located.targetRel, rel, findings)
        continue
      }
      legInputs.push({ source: rel, text: `${translateBanner(located.targetRel)}\n\n${text}` })
      continue
    }
    let text: string
    try {
      text = BINARY_DOC_EXTENSIONS.has(ext) ? await extractBinaryDocText(ext, bytes) : bytes.toString("utf8")
    } catch (error) {
      report.rejected.push({
        batch: batchId,
        source: rel,
        reason: "extract_failed",
        detail: error instanceof Error ? error.message : String(error),
      })
      continue
    }
    if (text.trim().length === 0) {
      report.rejected.push({ batch: batchId, source: rel, reason: "extract_failed", detail: "extracted text is empty" })
      continue
    }
    legInputs.push({ source: rel, text })
  }

  if (legInputs.length === 0) return { ok: true }

  report.phase = "extracting"
  report.summary = `exploding/translating ${countOf(legInputs.length, "document", "documents")} from batch ${batchId} into canonical form (dominant language ${cycleLanguage})`
  emit()
  const legOutcome = await runLeg({ repoRoot, language: cycleLanguage, inputs: legInputs, spawnLeg })
  if (!legOutcome.ok) {
    clearScratch(repoRoot)
    if (!legOutcome.scratchBlocked) {
      report.rejected.push(
        ...legInputs.map((i) => ({
          batch: batchId,
          source: i.source,
          reason: "leg_no_output" as const,
          detail: "the leg wrote nothing placeable for this source",
        }))
      )
    }
    return { ok: false, problem: legOutcome.problems.join("; ") }
  }
  report.phase = "placing"
  report.summary = `placing ${countOf(legOutcome.outputs.length, "canonical document", "canonical documents")} from batch ${batchId}`
  emit()
  for (const out of legOutcome.outputs) {
    const target = targetForOutput(out.rel)
    if (!target) {
      report.rejected.push({
        batch: batchId,
        source: `leg:${out.rel}`,
        reason: "outside_target",
        detail: "leg output is not a valid canonical target path/extension",
      })
      continue
    }
    if (out.bytes.length === 0) {
      report.rejected.push({ batch: batchId, source: `leg:${out.rel}`, reason: "empty_output" })
      continue
    }
    const findings = scanText(out.bytes.toString("utf8"))
    const high = highConfidenceFindings(findings)
    if (high.length > 0) {
      report.rejected.push({ batch: batchId, source: `leg:${out.rel}`, reason: "secret_detected", detail: secretDetail(high) })
      continue
    }
    placeFile(repoRoot, out.rel, out.bytes)
    report.placed.push({ batch: batchId, target: out.rel, route: "explode", translated: true })
    recordSecretWarnings(report, batchId, out.rel, `leg:${out.rel}`, findings)
  }
  clearScratch(repoRoot)
  return { ok: true }
}

function secretDetail(findings: SecretFinding[]): string {
  return `a suspected secret credential was kept out of the canonical — remove or rotate it and re-import the cleaned file: ${findings.slice(0, 5).map(describeFinding).join("; ")}`
}

function recordSecretWarnings(report: DocPrepReport, batch: string, target: string, source: string, findings: SecretFinding[]): void {
  for (const f of findings.filter((x) => x.confidence === "generic").slice(0, 10)) {
    report.warnings.push({ batch, target, source, line: f.line, detector: f.detector, redacted: f.redacted })
  }
}

function readReport(repoRoot: string): DocPrepReport | null {
  return readJsonOrNull(resolve(repoRoot, DOC_PREP_REPORT_REL)) as DocPrepReport | null
}

function translateBanner(targetRel: string): string {
  return `<!-- vivicy:doc-prep translate this document into the dominant language and write it to ${targetRel} preserving its structure -->`
}

async function runLeg({
  repoRoot,
  language,
  inputs,
  spawnLeg,
}: {
  repoRoot: string
  language: string
  inputs: Array<{ source: string; text: string }>
  spawnLeg: (args: SpawnLegArgs) => Promise<LegResult | void>
}): Promise<{ ok: true; outputs: Array<{ rel: string; bytes: Buffer }> } | { ok: false; problems: string[]; scratchBlocked?: true }> {
  const inputDir = resolve(repoRoot, SCRATCH_REL, "input")
  const outputDir = resolve(repoRoot, SCRATCH_REL, "output")
  let problems: string[] = []
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // The scratch clear must WIN before the leg writes: a survivor is read back as this run's output and placed into the canonical.
    if (!clearScratch(repoRoot)) {
      return {
        ok: false,
        scratchBlocked: true,
        problems: [
          `the leg scratch ${SCRATCH_REL} could not be cleared before the run, so nothing written there could be attributed to this batch (the removal failure was announced on stderr)`,
        ],
      }
    }
    mkdirSync(inputDir, { recursive: true })
    mkdirSync(outputDir, { recursive: true })
    for (const input of inputs) writeFileSync(join(inputDir, sourceToInputName(input.source)), input.text)
    await spawnLeg({ repoRoot, inputDir, outputDir, language, attempt, feedback: problems.length > 0 ? problems.join("; ") : null })
    const outputs = readScratchOutputs(outputDir)
    if (outputs.length > 0) return { ok: true, outputs }
    problems = [`no files were written under ${relative(repoRoot, outputDir)}`]
  }
  return { ok: false, problems }
}

function sourceToInputName(source: string): string {
  return `${source.replace(/[\\/]/g, "__")}.txt`
}

function readScratchOutputs(outputDir: string): Array<{ rel: string; bytes: Buffer }> {
  if (!existsSync(outputDir)) return []
  const out: Array<{ rel: string; bytes: Buffer }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) walk(abs)
      else if (entry.isFile()) out.push({ rel: relative(outputDir, abs).split("\\").join("/"), bytes: readFileSync(abs) })
    }
  }
  walk(outputDir)
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

function placeFile(repoRoot: string, targetRel: string, bytes: Buffer | Uint8Array): void {
  const abs = resolve(repoRoot, ".vivicy", targetRel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
}

function clearScratch(repoRoot: string): boolean {
  return cleanupTree(resolve(repoRoot, SCRATCH_REL))
}

function isParseableJson(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

function makeDefaultSpawnLeg(options: PrepareDocsOptions): (args: SpawnLegArgs) => Promise<LegResult | void> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) }
  const legs = resolveAgentLegs(options.env ?? process.env)
  const implementer: Leg = legs?.implementer ?? {
    actor: "claude",
    role: "implementer",
    provider: "claude",
    model: CLI_DEFAULTS.claude.model,
    effort: CLI_DEFAULTS.claude.effort,
    fast: false,
  }
  const leg: Leg = { ...implementer, role: "doc-prep" }
  return async ({ repoRoot, inputDir, outputDir, language, attempt, feedback }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot }
    const issue: AgentIssue = {
      id: TRANSCRIPT_DIRS.importDocs,
      transcript_dir: TRANSCRIPT_DIRS.importDocs,
      graph_refs: ["node:doc-prep"],
      path: DOC_PREP_REPORT_REL,
    }
    const context = legContext({ repoRoot, inputDir, outputDir, language, attempt, feedback })
    const deps = legDepsForTarget(repoRoot, context)
    return leg.provider === "codex"
      ? runCodexLeg(leg, issue, legCfg as LegConfig, deps)
      : runClaudeLeg(leg, issue, legCfg as LegConfig, deps)
  }
}

function legContext({
  repoRoot,
  inputDir,
  outputDir,
  language,
  attempt,
  feedback,
}: {
  repoRoot: string
  inputDir: string
  outputDir: string
  language: string
  attempt: number
  feedback: string | null
}): string {
  return (
    `\n\n---\n\n## Document-preparation context for this run\n\n` +
    `- Raw source documents (already converted to plain text) are in: \`${relative(repoRoot, inputDir) || inputDir}\`. Read them all.\n` +
    `- The DOMINANT language of this batch is the ISO 639-3 code \`${language}\`. EVERY canonical document you write MUST be in this language; translate any source that is in another language.\n` +
    `- Write your canonical documents ONLY under: \`${relative(repoRoot, outputDir) || outputDir}\`, mirroring the \`.vivicy/\` layout (e.g. \`canonical/…\`, \`development/spikes/…\`, \`requirements/…\`, \`architecture-map/architecture-map.yml\`). Write NOTHING outside this directory and NEVER touch \`.vivicy/uploads/\`.\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback ? `\n### What was INVALID last time\n\n\`\`\`text\n${feedback}\n\`\`\`\n` : "")
  )
}

export function docPrepNotification(
  report: DocPrepReport
): { level: "info" | "success" | "warning" | "error"; stage: string; event: string; message: string } | null {
  if (report.phase === "failed") {
    return { level: "error", stage: "SP", event: "doc_prep_failed", message: report.summary || "document-preparation stage failed" }
  }
  if (report.phase !== "green") return null
  const flagged = (report.rejected?.length ?? 0) + (report.warnings?.length ?? 0)
  if (flagged === 0) return null
  return {
    level: "warning",
    stage: "SP",
    event: "doc_prep_findings",
    message: report.summary || "document preparation kept documents out of the canonical",
  }
}

function defaultEmitReport(report: DocPrepReport, repoRoot: string): void {
  const abs = resolve(repoRoot, DOC_PREP_REPORT_REL)
  mkdirSync(dirname(abs), { recursive: true })
  atomicWriteJson(abs, report)
  pruneGitkeeps(repoRoot)
  const mapped = docPrepNotification(report)
  if (mapped) notify(mapped)
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null
  try {
    return JSON.parse(readFileSync(abs, "utf8"))
  } catch {
    return null
  }
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null
if (cliEntry === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const json = argv.includes("--json")
  const repoRoot = resolveTargetRoot()
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.")
    process.exit(2)
  }
  prepareDocs({ repoRoot })
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2))
      else console.log(report.summary)
      process.exit(report.phase === "failed" ? 1 : 0)
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(error instanceof DocPrepConfigError ? 2 : 1)
    })
}
