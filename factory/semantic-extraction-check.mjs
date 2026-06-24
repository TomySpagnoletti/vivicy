// Deterministic Part-1 gate for the semantic issue extraction pipeline.
//
// Usage: node vivicy/factory/semantic-extraction-check.mjs [--strict]
//
// Issues are LLM-authored from the frozen canonical docs baseline; this checker
// owns only the deterministic contract around them: the issue index pins must
// equal the frozen manifest, every requirement ref must resolve into a pinned
// canonical doc line range, dependencies must be acyclic, and every canonical
// doc line must be accounted for as covered (issue-linked), excluded (with a
// governed reason in spec/requirements/exclusions.json), auto-excluded
// (mechanical: blank lines, code-fence delimiters, horizontal rules, the H1
// title), or UNCOVERED. Any UNCOVERED line fails the gate.
//
// While the issue index is still the committed placeholder (no issues,
// status pending_llm_semantic_issue_generation) the gate exits 0 with
// "nothing to check yet" so verify stays green before extraction starts.
// While the index status is llm_extraction_in_progress the gate runs the
// full accounting and writes the reports, but uncovered lines are tolerated
// as warnings: extraction spans several sessions and the root gate must stay
// green mid-extraction. Pin, schema, reference, and cycle failures stay fatal.
// --strict escalates: placeholder mode, tolerated uncovered lines, and
// warnings become failures.
//
// The checker is read-only over the issue index; its outputs are
// spec/requirements/source-map.json, coverage-report.json, coverage-report.md.

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { resolveTargetRoot } from "./target-root.mjs";

const defaultPaths = {
  coverageReportJsonPath: "spec/requirements/coverage-report.json",
  coverageReportMarkdownPath: "spec/requirements/coverage-report.md",
  exclusionsPath: "spec/requirements/exclusions.json",
  issueIndexPath: "spec/development/issue-index.json",
  sourceMapPath: "spec/requirements/source-map.json",
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

// The deterministic ref grammar: docs/canonical/<file>.md:<start>[-<end>].
export const requirementRefPattern = /^(docs\/canonical\/[a-z0-9-]+\.md):(\d+)(?:-(\d+))?$/;
const requirementFilePattern = /^docs\/canonical\/[a-z0-9-]+\.md$/;
const issuePathPattern = /^spec\/development\/issues\/[A-Za-z0-9._/-]+\.md$/;

// Aligned with the development traceability method and the viewer validator
// (vivicy/factory/generate-viewer-data.ts): issue_path, requirement_ids
// (REQ-* IDs), and source_line_refs (path:line refs). The index stores no live
// status (progress lives only in the ledger), so the viewer validator rejects it.
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

export function runSemanticExtractionCheck(options = {}) {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check, or pass options.repoRoot.",
    );
  }
  const strict = options.strict === true;
  const paths = { ...defaultPaths };
  for (const key of Object.keys(defaultPaths)) {
    if (typeof options[key] === "string") paths[key] = options[key];
  }

  const errors = [];
  const warnings = [];
  const fail = () => ({
    coverage: null,
    errors,
    exitCode: 1,
    placeholder: false,
    reportsWritten: false,
    summary: `semantic-extraction-check: failed with ${errors.length} error(s), no reports written`,
    warnings,
  });

  // 1. Issue index (read-only here; reports are this checker's only outputs).
  let indexRaw;
  try {
    indexRaw = readJson(repoRoot, paths.issueIndexPath, "issue index");
  } catch (error) {
    errors.push(error.message);
    return fail();
  }
  const indexParsed = issueIndexSchema.safeParse(indexRaw);
  if (!indexParsed.success) {
    errors.push(...zodIssueMessages(`issue index ${paths.issueIndexPath}`, indexParsed.error));
    return fail();
  }
  const index = indexParsed.data;

  // 2. Pinned manifest: the index pin fields must equal the frozen manifest.
  let manifestRaw;
  try {
    manifestRaw = readJson(repoRoot, index.manifest_path, "baseline manifest");
  } catch (error) {
    errors.push(error.message);
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
  ]) {
    if (index[indexField] !== manifest[manifestField]) {
      errors.push(
        `pin mismatch: issue index ${indexField} "${index[indexField]}" != manifest ${manifestField} "${manifest[manifestField]}"`,
      );
    }
  }
  if (errors.length > 0) return fail();

  // 3. Accounting domain: manifest files that belong to the declared corpus.
  const corpusMatchers = index.source_corpus.map(globToRegExp);
  const corpusFiles = manifest.files.filter((file) => corpusMatchers.some((matcher) => matcher.test(file.path)));
  if (corpusFiles.length === 0) {
    errors.push(`no manifest files[] match source_corpus ${JSON.stringify(index.source_corpus)}`);
    return fail();
  }
  const corpusPaths = new Set(corpusFiles.map((file) => file.path));

  // Line counts come from the working tree: the baseline gate elsewhere
  // guarantees the content matches the manifest hashes.
  const docLinesCache = new Map();
  const loadDocLines = (path) => {
    if (docLinesCache.has(path)) return docLinesCache.get(path);
    const lines = readFileSync(resolveRepoPath(repoRoot, path), "utf8").split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    docLinesCache.set(path, lines);
    return lines;
  };

  // 4. Governed exclusions: refs must resolve exactly like issue refs.
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
    errors.push(error.message);
    return fail();
  }
  const exclusionsParsed = exclusionsFileSchema.safeParse(exclusionsRaw);
  if (!exclusionsParsed.success) {
    errors.push(...zodIssueMessages(`exclusions ${paths.exclusionsPath}`, exclusionsParsed.error));
    return fail();
  }
  // path -> Map(line -> reason_class); first exclusion wins on overlap.
  const excludedByFile = new Map();
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

  // 5. Placeholder mode: the gate must not block before extraction starts.
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

  // 6. Issues: index entries, issue files, traceability blocks, refs.
  const issueIds = new Set();
  for (const entry of index.issues) {
    if (issueIds.has(entry.id)) errors.push(`duplicate issue id in index: ${entry.id}`);
    issueIds.add(entry.id);
  }

  // path -> Set(line) covered by at least one issue requirement ref.
  const coveredByFile = new Map();
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
      const lines = coveredByFile.get(file) ?? new Set();
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

  // 7. Accounting: every corpus line is covered / excluded / auto / UNCOVERED.
  const totals = { auto_lines: 0, covered_lines: 0, doc_files: corpusFiles.length, excluded_lines: 0, total_lines: 0, uncovered_lines: 0 };
  // Governance coverage_summary metrics count NON-BLANK lines only (the method's
  // "real documentation lines"); blank lines inside covered ranges do not count.
  const summaryTotals = { classified: 0, covered: 0, total: 0 };
  const fileReports = [];
  const sourceMapFiles = [];
  for (const file of corpusFiles) {
    const docLines = loadDocLines(file.path);
    const covered = coveredByFile.get(file.path) ?? new Set();
    const excluded = excludedByFile.get(file.path) ?? new Map();
    const auto = computeAutoExclusions(docLines);
    const classes = new Array(docLines.length + 1);
    const overlapLines = [];
    const counts = { auto: 0, covered: 0, excluded: 0, uncovered: 0 };
    for (let line = 1; line <= docLines.length; line += 1) {
      if (covered.has(line)) {
        // Overlap conflict: covered wins, excluded becomes a warning.
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

  // 8. Reports (atomic writes); the gate verdict follows after they exist so a
  // red run still leaves the evidence of what is uncovered. While extraction is
  // in progress (multi-session), uncovered lines are tolerated as warnings;
  // --strict keeps them fatal.
  const toleratedUncovered = index.status === inProgressStatus && !strict && totals.uncovered_lines > 0;
  if (toleratedUncovered) {
    warnings.push(
      `coverage incomplete (tolerated: status "${inProgressStatus}"): ` +
        `${totals.uncovered_lines} canonical doc line(s) still UNCOVERED (see ${paths.coverageReportMarkdownPath})`,
    );
  }
  const sourceMap = {
    baseline_id: index.baseline_id,
    baseline_version: index.baseline_version,
    files: sourceMapFiles,
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
    writeFileAtomically(resolveRepoPath(repoRoot, paths.sourceMapPath), `${JSON.stringify(sourceMap, null, 2)}\n`);
    writeFileAtomically(resolveRepoPath(repoRoot, paths.coverageReportJsonPath), `${JSON.stringify(coverageReport, null, 2)}\n`);
    writeFileAtomically(
      resolveRepoPath(repoRoot, paths.coverageReportMarkdownPath),
      renderCoverageMarkdown(index, totals, fileReports, warnings),
    );
    // coverage_summary is owned by this check (governance 05): same computation
    // as the report, written back only when the numbers changed. issues[] stays
    // read-only here.
    const summary = {
      total_doc_lines: summaryTotals.total,
      classified_doc_lines: summaryTotals.classified,
      requirement_linked_doc_lines: summaryTotals.covered,
      issue_linked_doc_lines: summaryTotals.covered,
    };
    const current = indexRaw.coverage_summary ?? {};
    if (Object.keys(summary).some((key) => current[key] !== summary[key])) {
      const updated = { ...indexRaw, coverage_summary: { ...current, ...summary } };
      writeFileAtomically(resolveRepoPath(repoRoot, paths.issueIndexPath), `${JSON.stringify(updated, null, 2)}\n`);
    }
  } catch (error) {
    errors.push(`unable to write reports: ${error instanceof Error ? error.message : String(error)}`);
    return fail();
  }

  if (totals.uncovered_lines > 0 && !toleratedUncovered) {
    errors.push(`coverage gate failed: ${totals.uncovered_lines} canonical doc line(s) UNCOVERED (see ${paths.coverageReportMarkdownPath})`);
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

// The Traceability block is YAML-shaped but parsed with fixed line rules so the
// checker stays dependency-free and the accepted grammar stays deterministic.
const traceabilityScalarKeys = ["issue_id"];
const traceabilityListKeys = ["depends_on", "graph_refs", "requirement_ids", "source_line_refs", "spike_gates", "verification_gate_ids"];

function parseTraceabilityBlock(markdown, label, errors) {
  const lines = markdown.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Traceability\s*$/.test(line));
  if (headingIndex === -1) {
    errors.push(`${label}: missing "## Traceability" section`);
    return null;
  }
  const data = {};
  let currentList = null;
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
        currentList = data[key];
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

// The index entry and the issue file's traceability block must agree exactly:
// the index is what tooling reads, the file is what humans review.
function crossCheckTraceability(entry, block, label, errors) {
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
  ]) {
    if (block[blockKey] !== undefined && !sameStringSet(block[blockKey], entry[indexKey])) {
      errors.push(`${label}: traceability ${blockKey} does not match index ${indexKey}`);
    }
  }
}

function sameStringSet(a, b) {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((value, i) => value === right[i]);
}

// Returns the first dependency cycle as [start, ..., start] or null.
function findDependencyCycle(issues) {
  const dependencies = new Map(issues.map((issue) => [issue.id, issue.depends_on]));
  const state = new Map();
  const stack = [];
  const visit = (id) => {
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

// Mechanical lines no issue can meaningfully cover: blank/whitespace-only
// lines, pure code-fence delimiter lines, horizontal rules, and the H1 title.
function computeAutoExclusions(docLines) {
  const auto = new Set();
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

// classes is 1-indexed; merges contiguous lines with equal classification
// (and equal reason_class for excluded lines) into compact ranges.
function compactClassifiedRanges(classes) {
  const ranges = [];
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

function compactLineRanges(sortedLines) {
  const ranges = [];
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

function formatRange(range) {
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

function renderCoverageMarkdown(index, totals, fileReports, warnings) {
  const lines = [
    "# Semantic Extraction Coverage Report",
    "",
    `Generated by \`vivicy/factory/semantic-extraction-check.mjs\` from frozen baseline \`${index.baseline_id}\` (version ${index.baseline_version}). Do not edit by hand.`,
    "",
    "| Document | Total | Auto | Covered | Excluded | Uncovered |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const report of fileReports) {
    lines.push(
      `| ${report.path} | ${report.total_lines} | ${report.auto_lines} | ${report.covered_lines} | ${report.excluded_lines} | ${report.uncovered_lines} |`,
    );
  }
  lines.push(
    `| **All documents** | ${totals.total_lines} | ${totals.auto_lines} | ${totals.covered_lines} | ${totals.excluded_lines} | ${totals.uncovered_lines} |`,
    "",
    "## Uncovered Ranges",
    "",
  );
  const uncovered = fileReports.filter((report) => report.uncovered_ranges.length > 0);
  if (uncovered.length === 0) {
    lines.push("None.");
  } else {
    for (const report of uncovered) {
      for (const range of report.uncovered_ranges) {
        lines.push(`- \`${report.path}:${range}\``);
      }
    }
  }
  lines.push("", "## Warnings", "");
  if (warnings.length === 0) {
    lines.push("None.");
  } else {
    for (const warning of warnings) lines.push(`- ${warning}`);
  }
  lines.push("");
  return lines.join("\n");
}

// Minimal glob support for the source_corpus entries (`**/` segments and `*`).
function globToRegExp(glob) {
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

function zodIssueMessages(label, error) {
  return error.issues.map((issue) => `${label}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
}

// rename(2) is atomic only within a filesystem — hence the sibling temp file; a
// reader never sees a half-written report.
function writeFileAtomically(absolutePath, content) {
  mkdirSync(dirname(absolutePath), { recursive: true });
  const tmpPath = `${absolutePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  const fd = openSync(tmpPath, "w");
  try {
    writeSync(fd, content);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmpPath, absolutePath);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // best-effort cleanup of the temp file
    }
    throw error;
  }
}

function readJson(repoRoot, path, label) {
  try {
    return JSON.parse(readFileSync(resolveRepoPath(repoRoot, path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveRepoPath(repoRoot, path) {
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
    console.error("Usage: node vivicy/factory/semantic-extraction-check.mjs [--strict]");
    process.exit(2);
  }
  // VIVICY_TARGET_ROOT (NAIGHT_DEV_ROOT alias) selects the project to check.
  // Vivicy is standalone: with no target there is nothing to check, so exit
  // clearly instead of guessing a directory.
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
