import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSemanticExtractionCheck } from "./semantic-extraction-check.mjs";

// Vivicy is a STANDALONE factory: it has no implicit target. runSemanticExtractionCheck
// takes an explicit repoRoot, and the CLI binds VIVICY_TARGET_ROOT at load time, so the
// "real artifacts" cases write a self-contained placeholder index into a temp target root
// rather than reading a host project's committed files.
const factoryDir = dirname(fileURLToPath(import.meta.url));
const checkerPath = resolve(factoryDir, "semantic-extraction-check.mjs");

// A self-contained placeholder index: no issues yet, pinned to a frozen manifest,
// with the canonical evidence-ref grammar. This is the standalone equivalent of the
// committed pending-extraction placeholder artifacts.
function makePlaceholderTarget() {
  const root = mkdtempSync(resolve(tmpdir(), "semantic-extraction-placeholder-"));
  const write = (rel, content) => {
    const absolute = resolve(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  // A frozen manifest needs at least one pinned doc; the checker stays in
  // placeholder mode (no issues) so the doc body is never line-classified.
  const doc = "# Placeholder Spec\n";
  const docPath = ".vivicy/canonical/placeholder-spec.md";
  write(docPath, doc);
  const manifest = {
    baseline_id: "placeholder-baseline",
    document_set_hash: "placeholder-document-set-hash",
    files: [{ bytes: doc.length, path: docPath, sha256: "placeholder-sha256" }],
    manifest_hash: "placeholder-manifest-hash",
    schema_version: 1,
    status: "frozen",
    version: "0.0.1",
  };
  write(".vivicy/baselines/placeholder-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const index = {
    baseline_id: manifest.baseline_id,
    baseline_version: manifest.version,
    document_set_hash: manifest.document_set_hash,
    issues: [],
    manifest_hash: manifest.manifest_hash,
    manifest_path: ".vivicy/baselines/placeholder-manifest.json",
    schema_version: 1,
    source_corpus: [".vivicy/canonical/**/*.md"],
    status: "pending_llm_semantic_issue_generation",
    verification_evidence_ref_grammar: "^.vivicy/development/(gates|reports)/.+",
  };
  write(".vivicy/development/issue-index.json", `${JSON.stringify(index, null, 2)}\n`);
  write(".vivicy/requirements/exclusions.json", `${JSON.stringify({ exclusions: [], schema_version: 1 }, null, 2)}\n`);
  return {
    root,
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
  };
}

test("real repo artifacts: placeholder index passes without writing reports", () => {
  const target = makePlaceholderTarget();
  try {
    const result = runSemanticExtractionCheck({ repoRoot: target.root });
    assert.equal(result.placeholder, true, "the placeholder index is still pending extraction");
    assert.equal(result.exitCode, 0, "placeholder mode must not block verify");
    assert.equal(result.reportsWritten, false, "placeholder mode writes nothing");
    assert.match(result.summary, /nothing to check yet/);
    assert.ok(
      !existsSync(resolve(target.root, ".vivicy/requirements/source-map.json")),
      "no source map written in placeholder mode",
    );
  } finally {
    target.cleanup();
  }
});

test("CLI exits 0 against the real placeholder artifacts", () => {
  const target = makePlaceholderTarget();
  try {
    // The CLI binds its target root from VIVICY_TARGET_ROOT at module load.
    const run = spawnSync(process.execPath, [checkerPath], {
      encoding: "utf8",
      env: { ...process.env, VIVICY_TARGET_ROOT: target.root },
    });
    assert.equal(run.status, 0, `stdout: ${run.stdout}\nstderr: ${run.stderr}`);
    assert.match(run.stdout, /nothing to check yet/);
  } finally {
    target.cleanup();
  }
});

test("CLI rejects unknown arguments", () => {
  const run = spawnSync(process.execPath, [checkerPath, "--bogus"], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Unknown argument/);
});

// ---------------------------------------------------------------------------
// Synthetic fixture: a mini frozen manifest + canonical doc + issues, laid out
// like the real repo under a temp root (the checker takes repoRoot in options).
// ---------------------------------------------------------------------------

// 11 lines: 1 H1 (auto), 2/4/7 blank (auto), 3 heading (needs exclusion),
// 5-6 requirements (need coverage), 8 horizontal rule (auto), 9/11 fence
// delimiters (auto), 10 example line (needs coverage or exclusion).
const SAMPLE_DOC = [
  "# Sample Spec",
  "",
  "## Requirements",
  "",
  "The system must do A.",
  "The system must do B.",
  "",
  "---",
  "```",
  "example code",
  "```",
].join("\n").concat("\n");

const SAMPLE_DOC_PATH = ".vivicy/canonical/sample-spec.md";

const HEADING_EXCLUSION = { end: 3, file: SAMPLE_DOC_PATH, note: "section heading", reason_class: "heading", start: 3 };
const EXAMPLE_EXCLUSION = { end: 10, file: SAMPLE_DOC_PATH, note: "fence body is illustrative", reason_class: "example_illustration", start: 10 };

function issueMarkdown(issue) {
  const list = (items) => items.map((item) => `  - ${item}`).join("\n");
  return `# ${issue.id} - ${issue.title}

## Summary

${issue.summary}

## Traceability

\`\`\`text
issue_id: ${issue.traceabilityIssueId ?? issue.id}
graph_refs:
${list(issue.graphRefs)}
requirement_ids:
${list(issue.traceabilityRequirementIds ?? issue.requirementIds)}
source_line_refs:
${list(issue.traceabilityRequirements ?? issue.requirements)}
depends_on:
${list(issue.dependsOn)}
spike_gates:
${list(issue.spikeGates ?? [])}
verification_gate_ids:
${list(issue.gates)}
\`\`\`

## Scope

Build exactly what the referenced lines state.

## Out Of Scope

Everything else.

## Verification

Run the declared gate green.
`;
}

function makeIssue(overrides = {}) {
  return {
    dependsOn: [],
    gates: ["gate:test:sample"],
    graphRefs: ["node:sample"],
    id: "ISS-SAMPLE-0001",
    requirements: [`${SAMPLE_DOC_PATH}:5-6`, `${SAMPLE_DOC_PATH}:10`],
    requirementIds: ["REQ-SAMPLE-001"],
    spikeGates: [],
    summary: "Implements the sample requirements A and B.",
    title: "Sample requirements",
    ...overrides,
  };
}

function toIndexEntry(issue) {
  return {
    depends_on: issue.dependsOn,
    graph_refs: issue.graphRefs,
    id: issue.id,
    issue_path: `.vivicy/development/issues/${issue.id}.md`,
    requirement_ids: issue.requirementIds,
    source_line_refs: issue.requirements,
    spike_gates: issue.spikeGates ?? [],
    summary: issue.summary,
    title: issue.title,
    verification_gate_ids: issue.gates,
    ...(issue.indexEntryOverrides ?? {}),
  };
}

function makeFixture({ doc = SAMPLE_DOC, exclusions = [HEADING_EXCLUSION, EXAMPLE_EXCLUSION], indexOverrides = {}, issues = [] } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "semantic-extraction-check-"));
  const write = (rel, content) => {
    const absolute = resolve(root, rel);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  write(SAMPLE_DOC_PATH, doc);
  const manifest = {
    baseline_id: "mini-baseline",
    document_set_hash: "fixture-document-set-hash",
    files: [{ bytes: doc.length, path: SAMPLE_DOC_PATH, sha256: "fixture-sha256" }],
    manifest_hash: "fixture-manifest-hash",
    schema_version: 1,
    status: "frozen",
    version: "0.0.1",
  };
  write(".vivicy/baselines/mini-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const index = {
    baseline_id: manifest.baseline_id,
    baseline_version: manifest.version,
    document_set_hash: manifest.document_set_hash,
    issues: issues.map(toIndexEntry),
    manifest_hash: manifest.manifest_hash,
    manifest_path: ".vivicy/baselines/mini-manifest.json",
    schema_version: 1,
    source_corpus: [".vivicy/canonical/**/*.md"],
    status: issues.length === 0 ? "pending_llm_semantic_issue_generation" : "issues_generated",
    verification_evidence_ref_grammar: "^.vivicy/development/(gates|reports)/.+",
    ...indexOverrides,
  };
  write(".vivicy/development/issue-index.json", `${JSON.stringify(index, null, 2)}\n`);
  for (const issue of issues) {
    write(`.vivicy/development/issues/${issue.id}.md`, issueMarkdown(issue));
  }
  write(".vivicy/requirements/exclusions.json", `${JSON.stringify({ exclusions, schema_version: 1 }, null, 2)}\n`);
  return {
    cleanup() {
      rmSync(root, { force: true, recursive: true });
    },
    root,
    run(options = {}) {
      return runSemanticExtractionCheck({ repoRoot: root, ...options });
    },
  };
}

test("fixture placeholder mode exits 0 and writes no reports", () => {
  const fixture = makeFixture({ exclusions: [], issues: [] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 0);
    assert.equal(result.placeholder, true);
    assert.equal(result.reportsWritten, false);
    assert.ok(!existsSync(resolve(fixture.root, ".vivicy/requirements/source-map.json")), "no source map written");
  } finally {
    fixture.cleanup();
  }
});

test("--strict turns placeholder mode into a failure", () => {
  const fixture = makeFixture({ exclusions: [], issues: [] });
  try {
    const result = fixture.run({ strict: true });
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /has not produced issues yet/.test(error)));
  } finally {
    fixture.cleanup();
  }
});

test("C1: source-map carries the tool-computed per-requirement excerpt hash", () => {
  const fixture = makeFixture({ issues: [makeIssue()] });
  try {
    writeFileSync(
      resolve(fixture.root, ".vivicy/requirements/catalog.json"),
      JSON.stringify({
        schema_version: 1,
        requirements: [{ id: "REQ-SAMPLE-001", sourceRefs: [`${SAMPLE_DOC_PATH}:5`] }],
      }),
    );
    const result = fixture.run();
    assert.equal(result.exitCode, 0, result.errors.join("\n"));
    const sourceMap = JSON.parse(readFileSync(resolve(fixture.root, ".vivicy/requirements/source-map.json"), "utf8"));
    const excerpt = sourceMap.requirement_excerpts.find((entry) => entry.id === "REQ-SAMPLE-001");
    // Tool-computed over the exact cited line (line 5 of the sample doc), never authored.
    const expected = createHash("sha256").update("The system must do A.").digest("hex");
    assert.equal(excerpt.source_excerpt_sha256, expected);
  } finally {
    fixture.cleanup();
  }
});

test("valid refs with full coverage pass and write the three reports", () => {
  const fixture = makeFixture({ issues: [makeIssue()] });
  try {
    const result = fixture.run();
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
    assert.equal(result.reportsWritten, true);
    assert.deepEqual(result.coverage.totals, {
      auto_lines: 7,
      covered_lines: 3,
      doc_files: 1,
      excluded_lines: 1,
      total_lines: 11,
      uncovered_lines: 0,
    });

    const sourceMap = JSON.parse(readFileSync(resolve(fixture.root, ".vivicy/requirements/source-map.json"), "utf8"));
    assert.equal(sourceMap.baseline_id, "mini-baseline");
    const ranges = sourceMap.files[0].ranges;
    assert.ok(
      ranges.some((range) => range.classification === "covered" && range.start === 5 && range.end === 6),
      `covered range 5-6 present: ${JSON.stringify(ranges)}`,
    );
    assert.ok(
      ranges.some((range) => range.classification === "excluded" && range.reason_class === "heading" && range.start === 3),
      "heading exclusion recorded with its reason",
    );
    assert.ok(!ranges.some((range) => range.classification === "uncovered"), "no uncovered ranges");

    const coverageJson = JSON.parse(readFileSync(resolve(fixture.root, ".vivicy/requirements/coverage-report.json"), "utf8"));
    assert.equal(coverageJson.totals.uncovered_lines, 0);
    const sampleReport = coverageJson.files.find((file) => file.path === ".vivicy/canonical/sample-spec.md");
    assert.deepEqual(
      {
        total: sampleReport.total_lines,
        auto: sampleReport.auto_lines,
        covered: sampleReport.covered_lines,
        excluded: sampleReport.excluded_lines,
        uncovered: sampleReport.uncovered_lines,
      },
      { total: 11, auto: 7, covered: 3, excluded: 1, uncovered: 0 },
    );
  } finally {
    fixture.cleanup();
  }
});

test("requirement ref beyond the file's line count fails", () => {
  const issue = makeIssue({ requirements: [`${SAMPLE_DOC_PATH}:5-99`, `${SAMPLE_DOC_PATH}:10`] });
  const fixture = makeFixture({ issues: [issue] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /out of range/.test(error)), result.errors.join("\n"));
    assert.equal(result.reportsWritten, false, "structural failures write no reports");
  } finally {
    fixture.cleanup();
  }
});

test("requirement ref outside the canonical grammar fails", () => {
  const issue = makeIssue({ requirements: ["docs/governance/sample.md:1", `${SAMPLE_DOC_PATH}:5-6`, `${SAMPLE_DOC_PATH}:10`] });
  const fixture = makeFixture({ issues: [issue] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /source ref grammar/.test(error)), result.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("an uncovered canonical line fails the gate and is listed in the report", () => {
  // Line 10 ("example code") is neither covered nor excluded here.
  const issue = makeIssue({ requirements: [`${SAMPLE_DOC_PATH}:5-6`] });
  const fixture = makeFixture({ exclusions: [HEADING_EXCLUSION], issues: [issue] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /UNCOVERED/.test(error)), result.errors.join("\n"));
    assert.equal(result.reportsWritten, true, "coverage failures still write the evidence reports");
    const coverageJson = JSON.parse(readFileSync(resolve(fixture.root, ".vivicy/requirements/coverage-report.json"), "utf8"));
    assert.deepEqual(coverageJson.files[0].uncovered_ranges, ["10"]);
  } finally {
    fixture.cleanup();
  }
});

test("an exclusion covering the same line turns the gate green", () => {
  const issue = makeIssue({ requirements: [`${SAMPLE_DOC_PATH}:5-6`] });
  const fixture = makeFixture({ exclusions: [HEADING_EXCLUSION, EXAMPLE_EXCLUSION], issues: [issue] });
  try {
    const result = fixture.run();
    assert.deepEqual(result.errors, []);
    assert.equal(result.exitCode, 0);
    assert.equal(result.coverage.totals.uncovered_lines, 0);
  } finally {
    fixture.cleanup();
  }
});

test("llm_extraction_in_progress tolerates uncovered lines; --strict escalates", () => {
  // Line 10 ("example code") is neither covered nor excluded: mid-extraction
  // the gate must stay green, run the full accounting, and write the reports.
  const issue = makeIssue({ requirements: [`${SAMPLE_DOC_PATH}:5-6`] });
  const fixture = makeFixture({
    exclusions: [HEADING_EXCLUSION],
    indexOverrides: { status: "llm_extraction_in_progress" },
    issues: [issue],
  });
  try {
    const lenient = fixture.run();
    assert.deepEqual(lenient.errors, []);
    assert.equal(lenient.exitCode, 0);
    assert.equal(lenient.reportsWritten, true, "in-progress mode still writes the evidence reports");
    assert.equal(lenient.coverage.totals.uncovered_lines, 1);
    assert.ok(
      lenient.warnings.some((warning) => /tolerated/.test(warning) && /UNCOVERED/.test(warning)),
      lenient.warnings.join("\n"),
    );
    assert.match(lenient.summary, /tolerated: extraction in progress/);
    const coverageJson = JSON.parse(readFileSync(resolve(fixture.root, ".vivicy/requirements/coverage-report.json"), "utf8"));
    assert.deepEqual(coverageJson.files[0].uncovered_ranges, ["10"]);

    const strict = fixture.run({ strict: true });
    assert.equal(strict.exitCode, 1, "--strict keeps uncovered lines fatal mid-extraction");
    assert.ok(strict.errors.some((error) => /UNCOVERED/.test(error)), strict.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("a depends_on cycle fails the gate", () => {
  const issueA = makeIssue({ dependsOn: ["ISS-SAMPLE-0002"], id: "ISS-SAMPLE-0001", requirements: [`${SAMPLE_DOC_PATH}:5`] });
  const issueB = makeIssue({ dependsOn: ["ISS-SAMPLE-0001"], id: "ISS-SAMPLE-0002", requirements: [`${SAMPLE_DOC_PATH}:6`, `${SAMPLE_DOC_PATH}:10`] });
  const fixture = makeFixture({ issues: [issueA, issueB] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /cycle detected/.test(error)), result.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("depends_on referencing an unknown issue id fails", () => {
  const issue = makeIssue({ dependsOn: ["ISS-DOES-NOT-EXIST"] });
  const fixture = makeFixture({ issues: [issue] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /unknown issue id/.test(error)), result.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("index pin mismatch against the manifest fails even in placeholder mode", () => {
  const fixture = makeFixture({ exclusions: [], indexOverrides: { manifest_hash: "tampered" }, issues: [] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /pin mismatch.*manifest_hash/.test(error)), result.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});

test("a line both covered and excluded warns, covered wins; --strict escalates", () => {
  // Exclude line 5 although the issue also covers it.
  const overlap = { end: 5, file: SAMPLE_DOC_PATH, note: "overlaps the covered range", reason_class: "narrative_context", start: 5 };
  const fixture = makeFixture({ exclusions: [HEADING_EXCLUSION, EXAMPLE_EXCLUSION, overlap], issues: [makeIssue()] });
  try {
    const lenient = fixture.run();
    assert.equal(lenient.exitCode, 0);
    assert.ok(lenient.warnings.some((warning) => /covered wins/.test(warning)), lenient.warnings.join("\n"));

    const strict = fixture.run({ strict: true });
    assert.equal(strict.exitCode, 1);
    assert.ok(strict.errors.some((error) => /escalated to failure/.test(error)));
  } finally {
    fixture.cleanup();
  }
});

test("traceability block disagreeing with the index entry fails", () => {
  const issue = makeIssue({ traceabilityRequirements: [`${SAMPLE_DOC_PATH}:5`, `${SAMPLE_DOC_PATH}:10`] });
  const fixture = makeFixture({ issues: [issue] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(
      result.errors.some((error) => /traceability source_line_refs does not match index source_line_refs/.test(error)),
      result.errors.join("\n"),
    );
  } finally {
    fixture.cleanup();
  }
});

test("exclusion ref out of the doc's line range fails", () => {
  const badExclusion = { end: 400, file: SAMPLE_DOC_PATH, note: "bad range", reason_class: "heading", start: 399 };
  const fixture = makeFixture({ exclusions: [badExclusion], issues: [makeIssue()] });
  try {
    const result = fixture.run();
    assert.equal(result.exitCode, 1);
    assert.ok(result.errors.some((error) => /exclusions\[0\].*out of range/.test(error)), result.errors.join("\n"));
  } finally {
    fixture.cleanup();
  }
});
