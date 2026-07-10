import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveTargetRoot } from "./target-root.ts";
import { atomicWriteJson } from "./atomic-write.ts";

const defaultPaths = {
  coverageReportJsonPath: ".vivicy/requirements/coverage-report.json",
  exclusionsPath: ".vivicy/requirements/exclusions.json",
  issueIndexPath: ".vivicy/development/issue-index.json",
  sourceMapPath: ".vivicy/requirements/source-map.json",
};

export const placeholderStatus = "pending_llm_semantic_issue_generation";
export const inProgressStatus = "llm_extraction_in_progress";

export const exclusionReasonClasses = [
  "heading",
  "narrative_context",
  "example_illustration",
  "cross_reference_pointer",
  "rationale_encoded_elsewhere",
  "toc_or_index",
];

export const requirementRefPattern = /^(\.vivicy\/canonical\/[a-z0-9-]+\.md):(\d+)(?:-(\d+))?$/;
const requirementFilePattern = /^\.vivicy\/canonical\/[a-z0-9-]+\.md$/;
const issuePathPattern = /^\.vivicy\/development\/issues\/[A-Za-z0-9._/-]+\.md$/;

// Schema must stay aligned with the viewer validator (factory/generate-viewer-data.ts); it rejects the index if a live status field appears here (progress lives only in the ledger).
const issueEntrySchema = z.object({
  depends_on: z.array(z.string().min(1)),
  graph_refs: z.array(z.string().min(1)).min(1),
  id: z.string().min(1),
  issue_path: z.string().min(1),
  requirement_ids: z.array(z.string().min(1)).min(1),
  source_line_refs: z.array(z.string().min(1)).min(1),
  spike_gates: z.array(z.string().min(1)),
  summary: z.string().min(1),
  title: z.string().min(1),
  verification_gate_ids: z.array(z.string().min(1)).min(1),
});

const issueIndexSchema = z.object({
  baseline_id: z.string().min(1),
  baseline_version: z.string().min(1),
  document_set_hash: z.string().min(1),
  issues: z.array(issueEntrySchema),
  manifest_hash: z.string().min(1),
  manifest_path: z.string().min(1),
  schema_version: z.literal(1),
  source_corpus: z.array(z.string().min(1)).min(1),
  status: z.string().min(1),
  verification_evidence_ref_grammar: z.string().min(1),
});

const manifestSchema = z.object({
  baseline_id: z.string().min(1),
  document_set_hash: z.string().min(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().min(1) })).min(1),
  manifest_hash: z.string().min(1),
  status: z.string().min(1),
  version: z.string().min(1),
});

const exclusionsFileSchema = z.object({
  exclusions: z.array(
    z.object({
      end: z.int().min(1),
      file: z.string().min(1),
      note: z.string().min(1),
      reason_class: z.enum(exclusionReasonClasses),
      start: z.int().min(1),
    }),
  ),
  schema_version: z.literal(1),
});

type IssueEntry = z.infer<typeof issueEntrySchema>;
type IssueIndex = z.infer<typeof issueIndexSchema>;
type Manifest = z.infer<typeof manifestSchema>;
type ManifestFile = Manifest["files"][number];

interface FileReport {
  auto_lines: number;
  covered_lines: number;
  excluded_lines: number;
  path: string;
  total_lines: number;
  uncovered_lines: number;
  uncovered_ranges: string[];
}

interface Totals {
  auto_lines: number;
  covered_lines: number;
  doc_files: number;
  excluded_lines: number;
  total_lines: number;
  uncovered_lines: number;
}

type Classification = "auto" | "covered" | "excluded" | "uncovered";

interface LineClass {
  classification: Classification;
  reason_class?: string;
}

interface ClassifiedRange {
  classification: Classification;
  end: number;
  start: number;
  reason_class?: string;
}

interface LineRange {
  end: number;
  start: number;
}

type TraceabilityBlock = Record<string, string | string[]>;

interface SemanticCheckOptions {
  repoRoot?: string;
  strict?: boolean;
  coverageReportJsonPath?: string;
  exclusionsPath?: string;
  issueIndexPath?: string;
  sourceMapPath?: string;
}

interface SemanticCheckResult {
  coverage: { files: FileReport[]; totals: Totals } | null;
  errors: string[];
  exitCode: number;
  placeholder: boolean;
  reportsWritten: boolean;
  summary: string;
  warnings: string[];
}

export function runSemanticExtractionCheck(options: SemanticCheckOptions = {}): SemanticCheckResult {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check, or pass options.repoRoot.",
    );
  }
  const strict = options.strict === true;
  const paths = { ...defaultPaths };
  for (const key of Object.keys(defaultPaths) as (keyof typeof defaultPaths)[]) {
    const value = options[key];
    if (typeof value === "string") paths[key] = value;
  }

  const errors: string[] = [];
  const warnings: string[] = [];
  const fail = () => ({
    coverage: null,
    errors,
    exitCode: 1,
    placeholder: false,
    reportsWritten: false,
    summary: `semantic-extraction-check: failed with ${errors.length} error(s), no reports written`,
    warnings,
  });

  let indexRaw;
  try {
    indexRaw = readJson(repoRoot, paths.issueIndexPath, "issue index");
  } catch (error) {
    errors.push((error as Error).message);
    return fail();
  }
  const indexParsed = issueIndexSchema.safeParse(indexRaw);
  if (!indexParsed.success) {
    errors.push(...zodIssueMessages(`issue index ${paths.issueIndexPath}`, indexParsed.error));
    return fail();
  }
  const index = indexParsed.data;

  let manifestRaw;
  try {
    manifestRaw = readJson(repoRoot, index.manifest_path, "baseline manifest");
  } catch (error) {
    errors.push((error as Error).message);
    return fail();
  }
  const manifestParsed = manifestSchema.safeParse(manifestRaw);
  if (!manifestParsed.success) {
    errors.push(...zodIssueMessages(`baseline manifest ${index.manifest_path}`, manifestParsed.error));
    return fail();
  }
  const manifest = manifestParsed.data;
  if (manifest.status !== "frozen") {
    errors.push(`pin mismatch: pinned manifest ${index.manifest_path} has status "${manifest.status}", expected "frozen"`);
  }
  for (const [indexField, manifestField] of [
    ["baseline_id", "baseline_id"],
    ["baseline_version", "version"],
    ["manifest_hash", "manifest_hash"],
    ["document_set_hash", "document_set_hash"],
  ] as [keyof IssueIndex, keyof Manifest][]) {
    if (index[indexField] !== manifest[manifestField]) {
      errors.push(
        `pin mismatch: issue index ${indexField} "${index[indexField]}" != manifest ${manifestField} "${manifest[manifestField]}"`,
      );
    }
  }
  if (errors.length > 0) return fail();

  const corpusMatchers = index.source_corpus.map(globToRegExp);
  const corpusFiles = manifest.files.filter((file) => corpusMatchers.some((matcher) => matcher.test(file.path)));
  if (corpusFiles.length === 0) {
    errors.push(`no manifest files[] match source_corpus ${JSON.stringify(index.source_corpus)}`);
    return fail();
  }
  const corpusPaths = new Set(corpusFiles.map((file) => file.path));

  // Line counts are read from the working tree; valid only because the baseline gate elsewhere guarantees tree content matches the manifest hashes.
  const docLinesCache = new Map<string, string[]>();
  const loadDocLines = (path: string): string[] => {
    if (docLinesCache.has(path)) return docLinesCache.get(path)!;
    const lines = readFileSync(resolveRepoPath(repoRoot, path), "utf8").split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    docLinesCache.set(path, lines);
    return lines;
  };

  if (!existsSync(resolveRepoPath(repoRoot, paths.exclusionsPath))) {
    errors.push(
      `exclusions file missing: create ${paths.exclusionsPath} with { "schema_version": 1, "exclusions": [] }`,
    );
    return fail();
  }
  let exclusionsRaw;
  try {
    exclusionsRaw = readJson(repoRoot, paths.exclusionsPath, "exclusions");
  } catch (error) {
    errors.push((error as Error).message);
    return fail();
  }
  const exclusionsParsed = exclusionsFileSchema.safeParse(exclusionsRaw);
  if (!exclusionsParsed.success) {
    errors.push(...zodIssueMessages(`exclusions ${paths.exclusionsPath}`, exclusionsParsed.error));
    return fail();
  }
  const excludedByFile = new Map<string, Map<number, string>>();
  exclusionsParsed.data.exclusions.forEach((exclusion, position) => {
    const label = `exclusions[${position}]`;
    if (!requirementFilePattern.test(exclusion.file)) {
      errors.push(`${label}: file "${exclusion.file}" does not match the canonical doc grammar ${requirementFilePattern}`);
      return;
    }
    if (!corpusPaths.has(exclusion.file)) {
      errors.push(`${label}: file "${exclusion.file}" is not in the pinned manifest corpus`);
      return;
    }
    if (exclusion.start > exclusion.end) {
      errors.push(`${label}: inverted range ${exclusion.start}-${exclusion.end}`);
      return;
    }
    const lineCount = loadDocLines(exclusion.file).length;
    if (exclusion.end > lineCount) {
      errors.push(`${label}: range ${exclusion.start}-${exclusion.end} is out of range (${exclusion.file} has ${lineCount} line(s))`);
      return;
    }
    const lines = excludedByFile.get(exclusion.file) ?? new Map();
    for (let line = exclusion.start; line <= exclusion.end; line += 1) {
      if (!lines.has(line)) lines.set(line, exclusion.reason_class);
    }
    excludedByFile.set(exclusion.file, lines);
  });
  if (errors.length > 0) return fail();

  const placeholder = index.issues.length === 0 && index.status === placeholderStatus;
  if (index.issues.length === 0 && index.status !== placeholderStatus) {
    errors.push(`issue index has no issues but status is "${index.status}" (expected "${placeholderStatus}")`);
    return fail();
  }
  if (index.issues.length > 0 && index.status === placeholderStatus) {
    errors.push(`issue index carries ${index.issues.length} issue(s) but status is still "${placeholderStatus}"`);
    return fail();
  }
  if (placeholder) {
    if (strict) {
      errors.push("--strict: semantic issue extraction has not produced issues yet (issue index is the placeholder)");
      return fail();
    }
    return {
      coverage: null,
      errors,
      exitCode: 0,
      placeholder: true,
      reportsWritten: false,
      summary: "semantic-extraction-check: nothing to check yet (issue index is the pending-extraction placeholder)",
      warnings,
    };
  }

  const issueIds = new Set<string>();
  for (const entry of index.issues) {
    if (issueIds.has(entry.id)) errors.push(`duplicate issue id in index: ${entry.id}`);
    issueIds.add(entry.id);
  }

  const coveredByFile = new Map<string, Set<number>>();
  for (const entry of index.issues) {
    const label = `issue ${entry.id} (${entry.issue_path})`;
    if (!issuePathPattern.test(entry.issue_path)) {
      errors.push(`${label}: issue_path does not match ${issuePathPattern}`);
      continue;
    }
    let markdown;
    try {
      markdown = readFileSync(resolveRepoPath(repoRoot, entry.issue_path), "utf8");
    } catch {
      errors.push(`${label}: issue file is missing`);
      continue;
    }
    const block = parseTraceabilityBlock(markdown, label, errors);
    if (!block) continue;
    crossCheckTraceability(entry, block, label, errors);
    for (const ref of block.source_line_refs ?? []) {
      const match = ref.match(requirementRefPattern);
      if (!match) {
        errors.push(`${label}: source line ref "${ref}" does not match the source ref grammar ${requirementRefPattern}`);
        continue;
      }
      const [, file, startText, endText] = match;
      const start = Number(startText);
      const end = endText === undefined ? start : Number(endText);
      if (!corpusPaths.has(file)) {
        errors.push(`${label}: requirement ref "${ref}" points to a file outside the pinned manifest corpus`);
        continue;
      }
      if (start < 1 || start > end) {
        errors.push(`${label}: requirement ref "${ref}" has an empty or inverted range`);
        continue;
      }
      const lineCount = loadDocLines(file).length;
      if (end > lineCount) {
        errors.push(`${label}: requirement ref "${ref}" is out of range (${file} has ${lineCount} line(s))`);
        continue;
      }
      const lines = coveredByFile.get(file) ?? new Set<number>();
      for (let line = start; line <= end; line += 1) lines.add(line);
      coveredByFile.set(file, lines);
    }
    for (const dependency of entry.depends_on) {
      if (!issueIds.has(dependency)) {
        errors.push(`${label}: depends_on references unknown issue id "${dependency}"`);
      }
    }
  }

  const cycle = findDependencyCycle(index.issues);
  if (cycle) errors.push(`depends_on cycle detected: ${cycle.join(" -> ")}`);
  if (errors.length > 0) return fail();

  const totals = { auto_lines: 0, covered_lines: 0, doc_files: corpusFiles.length, excluded_lines: 0, total_lines: 0, uncovered_lines: 0 };
  const summaryTotals = { classified: 0, covered: 0, total: 0 };
  const fileReports: FileReport[] = [];
  const sourceMapFiles: { path: string; ranges: ClassifiedRange[]; total_lines: number }[] = [];
  for (const file of corpusFiles) {
    const docLines = loadDocLines(file.path);
    const covered = coveredByFile.get(file.path) ?? new Set<number>();
    const excluded = excludedByFile.get(file.path) ?? new Map<number, string>();
    const auto = computeAutoExclusions(docLines);
    const classes: LineClass[] = new Array(docLines.length + 1);
    const overlapLines: number[] = [];
    const counts = { auto: 0, covered: 0, excluded: 0, uncovered: 0 };
    for (let line = 1; line <= docLines.length; line += 1) {
      if (covered.has(line)) {
        if (excluded.has(line)) overlapLines.push(line);
        classes[line] = { classification: "covered" };
      } else if (excluded.has(line)) {
        classes[line] = { classification: "excluded", reason_class: excluded.get(line) };
      } else if (auto.has(line)) {
        classes[line] = { classification: "auto" };
      } else {
        classes[line] = { classification: "uncovered" };
      }
      counts[classes[line].classification] += 1;
      if (docLines[line - 1].trim().length > 0) {
        summaryTotals.total += 1;
        const cls = classes[line].classification;
        if (cls !== "uncovered") summaryTotals.classified += 1;
        if (cls === "covered") summaryTotals.covered += 1;
      }
    }
    for (const range of compactLineRanges(overlapLines)) {
      warnings.push(`${file.path}:${range} is both issue-covered and excluded; covered wins`);
    }
    const ranges = compactClassifiedRanges(classes);
    const uncoveredRanges = ranges.filter((range) => range.classification === "uncovered").map(formatRange);
    fileReports.push({
      auto_lines: counts.auto,
      covered_lines: counts.covered,
      excluded_lines: counts.excluded,
      path: file.path,
      total_lines: docLines.length,
      uncovered_lines: counts.uncovered,
      uncovered_ranges: uncoveredRanges,
    });
    sourceMapFiles.push({ path: file.path, ranges, total_lines: docLines.length });
    totals.auto_lines += counts.auto;
    totals.covered_lines += counts.covered;
    totals.excluded_lines += counts.excluded;
    totals.total_lines += docLines.length;
    totals.uncovered_lines += counts.uncovered;
  }

  // Reports are written before the verdict is returned, deliberately: a failing run still leaves evidence of what's uncovered.
  const toleratedUncovered = index.status === inProgressStatus && !strict && totals.uncovered_lines > 0;
  if (toleratedUncovered) {
    warnings.push(
      `coverage incomplete (tolerated: status "${inProgressStatus}"): ` +
        `${totals.uncovered_lines} canonical doc line(s) still UNCOVERED (see ${paths.coverageReportJsonPath})`,
    );
  }
  const sourceMap = {
    baseline_id: index.baseline_id,
    baseline_version: index.baseline_version,
    files: sourceMapFiles,
    requirement_excerpts: computeRequirementExcerpts(repoRoot, corpusPaths, loadDocLines),
    schema_version: 1,
  };
  const coverageReport = {
    baseline_id: index.baseline_id,
    baseline_version: index.baseline_version,
    files: fileReports,
    schema_version: 1,
    strict,
    totals,
    warnings,
  };
  try {
    writeReport(resolveRepoPath(repoRoot, paths.sourceMapPath), sourceMap);
    writeReport(resolveRepoPath(repoRoot, paths.coverageReportJsonPath), coverageReport);
    const summary = {
      total_doc_lines: summaryTotals.total,
      classified_doc_lines: summaryTotals.classified,
      requirement_linked_doc_lines: summaryTotals.covered,
      issue_linked_doc_lines: summaryTotals.covered,
    };
    const current = (indexRaw as { coverage_summary?: Record<string, number> }).coverage_summary ?? {};
    if (Object.keys(summary).some((key) => current[key] !== (summary as Record<string, number>)[key])) {
      const updated = { ...(indexRaw as Record<string, unknown>), coverage_summary: { ...current, ...summary } };
      writeReport(resolveRepoPath(repoRoot, paths.issueIndexPath), updated);
    }
  } catch (error) {
    errors.push(`unable to write reports: ${error instanceof Error ? error.message : String(error)}`);
    return fail();
  }

  if (totals.uncovered_lines > 0 && !toleratedUncovered) {
    errors.push(`coverage gate failed: ${totals.uncovered_lines} canonical doc line(s) UNCOVERED (see ${paths.coverageReportJsonPath})`);
  }
  if (strict && warnings.length > 0) {
    errors.push(`--strict: ${warnings.length} warning(s) escalated to failure`);
  }
  return {
    coverage: { files: fileReports, totals },
    errors,
    exitCode: errors.length > 0 ? 1 : 0,
    placeholder: false,
    reportsWritten: true,
    summary:
      `semantic-extraction-check: ${totals.doc_files} doc(s), ${totals.total_lines} line(s): ` +
      `${totals.covered_lines} covered, ${totals.excluded_lines} excluded, ${totals.auto_lines} auto, ${totals.uncovered_lines} UNCOVERED` +
      (toleratedUncovered ? " (tolerated: extraction in progress)" : ""),
    warnings,
  };
}

function computeRequirementExcerpts(
  repoRoot: string,
  corpusPaths: Set<string>,
  loadDocLines: (path: string) => string[],
): { id: string; source_excerpt_sha256: string }[] {
  const catalogPath = ".vivicy/requirements/catalog.json";
  if (!existsSync(resolveRepoPath(repoRoot, catalogPath))) return [];
  let catalog: { requirements?: unknown };
  try {
    catalog = JSON.parse(readFileSync(resolveRepoPath(repoRoot, catalogPath), "utf8"));
  } catch {
    return [];
  }
  const requirements = (Array.isArray(catalog.requirements) ? catalog.requirements : []) as {
    id?: string;
    sourceRefs?: string[];
  }[];
  const excerpts: { id: string; source_excerpt_sha256: string }[] = [];
  for (const req of requirements) {
    const refs = Array.isArray(req.sourceRefs) ? req.sourceRefs : [];
    if (refs.length === 0 || !req.id) continue;
    const parts: string[] = [];
    let resolvable = true;
    for (const ref of refs) {
      const match = requirementRefPattern.exec(ref);
      if (!match || !corpusPaths.has(match[1])) {
        resolvable = false;
        break;
      }
      const start = Number(match[2]);
      const end = match[3] ? Number(match[3]) : start;
      const lines = loadDocLines(match[1]);
      if (start < 1 || start > end || end > lines.length) {
        resolvable = false;
        break;
      }
      parts.push(lines.slice(start - 1, end).join("\n"));
    }
    if (resolvable) {
      excerpts.push({ id: req.id, source_excerpt_sha256: createHash("sha256").update(parts.join("\n")).digest("hex") });
    }
  }
  return excerpts;
}

const traceabilityScalarKeys = ["issue_id"];
const traceabilityListKeys = ["depends_on", "graph_refs", "requirement_ids", "source_line_refs", "spike_gates", "verification_gate_ids"];

function parseTraceabilityBlock(markdown: string, label: string, errors: string[]): TraceabilityBlock | null {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Traceability\s*$/.test(line));
  if (headingIndex === -1) {
    errors.push(`${label}: missing "## Traceability" section`);
    return null;
  }
  const data: TraceabilityBlock = {};
  let currentList: string[] | null = null;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^#{1,2}\s/.test(raw)) break;
    if (!raw.trim()) continue;
    if (/^\s*(`{3,}|~{3,})/.test(raw)) continue;
    const keyMatch = raw.match(/^([a-z_]+):\s*(.*)$/);
    if (keyMatch) {
      const [, key, value] = keyMatch;
      currentList = null;
      if (data[key] !== undefined) {
        errors.push(`${label}: duplicate traceability key "${key}"`);
        continue;
      }
      if (traceabilityScalarKeys.includes(key)) {
        if (!value.trim()) errors.push(`${label}: traceability key "${key}" must have a value`);
        data[key] = value.trim();
        continue;
      }
      if (traceabilityListKeys.includes(key)) {
        if (value.trim()) {
          errors.push(`${label}: traceability key "${key}" must be a list of "- " items, found inline value "${value.trim()}"`);
        }
        data[key] = [];
        currentList = data[key] as string[];
        continue;
      }
      errors.push(`${label}: unknown traceability key "${key}"`);
      continue;
    }
    const itemMatch = raw.match(/^\s*-\s+(.+)$/);
    if (itemMatch && currentList) {
      currentList.push(itemMatch[1].trim());
      continue;
    }
    errors.push(`${label}: unparseable traceability line "${raw.trim()}"`);
  }
  for (const key of [...traceabilityScalarKeys, ...traceabilityListKeys]) {
    if (data[key] === undefined) errors.push(`${label}: traceability block is missing "${key}"`);
  }
  if (Array.isArray(data.source_line_refs) && data.source_line_refs.length === 0) {
    errors.push(`${label}: traceability source_line_refs must list at least one ref`);
  }
  if (Array.isArray(data.requirement_ids) && data.requirement_ids.length === 0) {
    errors.push(`${label}: traceability requirement_ids must list at least one id`);
  }
  return data;
}

function crossCheckTraceability(entry: IssueEntry, block: TraceabilityBlock, label: string, errors: string[]): void {
  if (block.issue_id !== undefined && block.issue_id !== entry.id) {
    errors.push(`${label}: traceability issue_id "${block.issue_id}" does not match index id "${entry.id}"`);
  }
  for (const [blockKey, indexKey] of [
    ["depends_on", "depends_on"],
    ["graph_refs", "graph_refs"],
    ["requirement_ids", "requirement_ids"],
    ["source_line_refs", "source_line_refs"],
    ["spike_gates", "spike_gates"],
    ["verification_gate_ids", "verification_gate_ids"],
  ] as [string, keyof IssueEntry][]) {
    if (block[blockKey] !== undefined && !sameStringSet(block[blockKey], entry[indexKey])) {
      errors.push(`${label}: traceability ${blockKey} does not match index ${indexKey}`);
    }
  }
}

function sameStringSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

function findDependencyCycle(issues: IssueEntry[]): string[] | null {
  const dependencies = new Map(issues.map((issue) => [issue.id, issue.depends_on]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!dependencies.has(dependency)) continue;
      const dependencyState = state.get(dependency);
      if (dependencyState === "visiting") return [...stack.slice(stack.indexOf(dependency)), dependency];
      if (dependencyState === undefined) {
        const found = visit(dependency);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, "done");
    return null;
  };
  for (const id of dependencies.keys()) {
    if (state.get(id) === undefined) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

function computeAutoExclusions(docLines: string[]): Set<number> {
  const auto = new Set<number>();
  let h1Seen = false;
  docLines.forEach((text, idx) => {
    const line = idx + 1;
    if (!text.trim()) {
      auto.add(line);
      return;
    }
    if (/^\s*(`{3,}|~{3,})[\w+.#-]*\s*$/.test(text)) {
      auto.add(line);
      return;
    }
    if (/^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(text)) {
      auto.add(line);
      return;
    }
    if (!h1Seen && /^#\s/.test(text)) {
      h1Seen = true;
      auto.add(line);
    }
  });
  return auto;
}

function compactClassifiedRanges(classes: LineClass[]): ClassifiedRange[] {
  const ranges: ClassifiedRange[] = [];
  for (let line = 1; line < classes.length; line += 1) {
    const current = classes[line];
    const previous = ranges[ranges.length - 1];
    if (
      previous &&
      previous.end === line - 1 &&
      previous.classification === current.classification &&
      previous.reason_class === current.reason_class
    ) {
      previous.end = line;
      continue;
    }
    ranges.push({
      classification: current.classification,
      end: line,
      start: line,
      ...(current.reason_class ? { reason_class: current.reason_class } : {}),
    });
  }
  return ranges;
}

function compactLineRanges(sortedLines: number[]): string[] {
  const ranges: LineRange[] = [];
  for (const line of sortedLines) {
    const previous = ranges[ranges.length - 1];
    if (previous && previous.end === line - 1) {
      previous.end = line;
      continue;
    }
    ranges.push({ end: line, start: line });
  }
  return ranges.map(formatRange);
}

function formatRange(range: LineRange): string {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          pattern += "(?:[^/]+/)*";
          i += 2;
        } else {
          pattern += ".*";
          i += 1;
        }
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    pattern += /[\\^$.|?+()[\]{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${pattern}$`);
}

function zodIssueMessages(label: string, error: z.ZodError): string[] {
  return error.issues.map((issue) => `${label}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

// atomicWriteJson never creates parent directories, so mkdir here first (report dirs may not exist yet in a fresh target).
function writeReport(absolutePath: string, value: unknown): void {
  mkdirSync(dirname(absolutePath), { recursive: true });
  atomicWriteJson(absolutePath, value);
}

function readJson(repoRoot: string, path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(resolveRepoPath(repoRoot, path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveRepoPath(repoRoot: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`Path must be repository-relative: ${path}`);
  const absolute = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path must stay inside repository: ${path}`);
  return absolute;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== "--strict");
  if (unknown.length > 0) {
    console.error(`Unknown argument(s): ${unknown.join(" ")}`);
    console.error("Usage: node vivicy/factory/semantic-extraction-check.ts [--strict]");
    process.exit(2);
  }
  const targetRoot = resolveTargetRoot();
  if (!targetRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check.",
    );
    process.exit(2);
  }
  const result = runSemanticExtractionCheck({
    strict: args.includes("--strict"),
    repoRoot: targetRoot,
  });
  for (const warning of result.warnings) console.warn(`warning: ${warning}`);
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(result.summary);
  process.exit(result.exitCode);
}
