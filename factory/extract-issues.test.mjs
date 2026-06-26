// Unit tests for the semantic issue EXTRACTION orchestrator.
//
// The agent leg is ALWAYS faked here (inject options.spawnAgent) — no real CLI is
// launched in this run. The deterministic checks are REAL: the happy path proves
// a valid authored corpus actually passes semantic-extraction-check +
// traceability-check, and the fix/blocked paths prove the orchestrator re-prompts
// on real red checks. The golden corpus is the bundled Pocket Ledger rehearsal
// fixture (which is known to pass both gates).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractIssues, findFrozenManifest, formatCheckOutput } from "./extract-issues.mjs";

const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(FACTORY_DIR, "rehearsal/pocket-ledger");

// The corpus files the extractor authors (everything UNDER spec/ + the arch map),
// as opposed to the inputs it reads (docs/canonical/**, the frozen baseline).
const CORPUS_FILES = [
  "spec/requirements/catalog.json",
  "spec/requirements/catalog.md",
  "spec/requirements/traceability-matrix.json",
  "spec/requirements/traceability-matrix.md",
  "spec/requirements/exclusions.json",
  "spec/development/issue-index.json",
];
const CORPUS_DIRS = ["spec/development/issues"];
const INPUT_PATHS = ["docs/canonical", "docs/baselines", "README.md", "package.json"];

let temp;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vivicy-extract-test-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

/** Seed only the INPUTS (canonical docs + frozen baseline) into the temp repo. */
function seedInputs(root) {
  for (const rel of INPUT_PATHS) {
    const src = resolve(FIXTURE, rel);
    if (existsSync(src)) cpSync(src, resolve(root, rel), { recursive: true });
  }
}

/** Copy ONE corpus path (file or dir) from the fixture into the target repo. */
function copyCorpusPath(root, rel) {
  const src = resolve(FIXTURE, rel);
  const dest = resolve(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/** Write the full, VALID golden corpus (the fixture's authored output). */
function writeValidCorpus(root) {
  for (const rel of [...CORPUS_FILES, ...CORPUS_DIRS]) copyCorpusPath(root, rel);
}

/** Write an INVALID corpus: a non-placeholder index with a broken pin so the
 *  semantic check fails fatally (proves the fix loop re-prompts). */
function writeInvalidCorpus(root) {
  writeValidCorpus(root);
  const indexPath = resolve(root, "spec/development/issue-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.manifest_hash = "deadbeef".repeat(8); // pin mismatch vs the frozen manifest
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

/** A fake agent that runs a per-attempt scripted action and records the calls. */
function fakeAgent(perAttempt) {
  const calls = [];
  const spawnAgent = async (ctx) => {
    calls.push(ctx);
    const action = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    action(ctx);
    return { transcriptRel: `spec/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl` };
  };
  return { spawnAgent, calls };
}

/** Stub seams so no real freeze/map subprocess runs; the CHECKS stay real. */
function stubSeams(extra = {}) {
  const mapCalls = [];
  const freezeCalls = [];
  const statusEvents = [];
  return {
    runFreeze: async ({ repoRoot, version }) => {
      freezeCalls.push({ repoRoot, version });
      // A test "freeze": copy the fixture's frozen manifest in.
      copyCorpusPath(repoRoot, "docs/baselines");
      return { manifestPath: "docs/baselines/baseline-v1.0.0.json", baselineId: "baseline-v1.0.0" };
    },
    runGenerateMap: ({ repoRoot }) => {
      mapCalls.push(repoRoot);
      // Simulate the generator writing architecture-data.json.
      const out = resolve(repoRoot, "docs/architecture-map/viewer/src/architecture-data.json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ development: { issues: [] } }, null, 2));
      return { code: 0, output: "generated" };
    },
    emitStatus: (status) => statusEvents.push(status),
    _calls: { mapCalls, freezeCalls, statusEvents },
    ...extra,
  };
}

describe("extractIssues — happy path", () => {
  it("authors a valid corpus, passes BOTH real checks, regenerates the map, returns green", async () => {
    seedInputs(temp);
    const { spawnAgent, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 1);
    assert.equal(calls.length, 1, "exactly one (initial author) agent leg");
    assert.equal(calls[0].isFix, false);
    assert.equal(calls[0].checkOutput, null);
    // The REAL checks actually passed.
    assert.equal(result.checks.semantic.exitCode, 0);
    assert.equal(result.checks.traceability.exitCode, 0);
    assert.equal(result.checks.semantic.placeholder, false);
    // The map was regenerated and the transcript captured.
    assert.equal(seams._calls.mapCalls.length, 1);
    assert.deepEqual(result.transcripts, ["spec/development/transcripts/EXTRACTION/extract-1.jsonl"]);
    assert.match(result.summary, /8 issue\(s\)/);
  });

  it("does NOT freeze when a frozen baseline already exists (reuses it)", async () => {
    seedInputs(temp); // includes docs/baselines/baseline-v1.0.0.json (frozen)
    const { spawnAgent } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.froze, false);
    assert.equal(seams._calls.freezeCalls.length, 0, "freeze seam never invoked");
    assert.equal(result.baselineId, "baseline-v1.0.0");
  });
});

describe("extractIssues — freeze-if-needed branch", () => {
  it("freezes via the injected freeze seam when no frozen baseline exists", async () => {
    // Seed canonical docs ONLY — no docs/baselines yet.
    cpSync(resolve(FIXTURE, "docs/canonical"), resolve(temp, "docs/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));

    assert.equal(findFrozenManifest(temp), null, "precondition: no frozen baseline");

    const { spawnAgent } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, ...seams });

    assert.equal(seams._calls.freezeCalls.length, 1, "freeze seam invoked exactly once");
    assert.equal(seams._calls.freezeCalls[0].version, "1.0.0");
    assert.equal(result.froze, true);
    assert.equal(result.status, "green");
  });
});

describe("extractIssues — fix loop", () => {
  it("re-prompts with the exact check output when attempt 1 fails, then goes green on attempt 2", async () => {
    seedInputs(temp);
    const { spawnAgent, calls } = fakeAgent([
      (ctx) => writeInvalidCorpus(ctx.repoRoot), // attempt 1: pin mismatch -> red
      (ctx) => writeValidCorpus(ctx.repoRoot), //   attempt 2: valid -> green
    ]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2);
    assert.equal(calls.length, 2);
    // Attempt 2 is a FIX pass and received the attempt-1 check output verbatim.
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got the failing-check text");
    assert.match(calls[1].checkOutput, /pin mismatch/i);
    assert.equal(seams._calls.mapCalls.length, 1, "map runs once, only on green");
    assert.deepEqual(result.transcripts.length, 2);
  });
});

describe("extractIssues — bounded retries / blocked", () => {
  it("returns extraction_blocked after maxRetries+1 red attempts and never maps", async () => {
    seedInputs(temp);
    const { spawnAgent, calls } = fakeAgent([(ctx) => writeInvalidCorpus(ctx.repoRoot)]); // always red
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries");
    assert.equal(calls.length, 3);
    assert.equal(seams._calls.mapCalls.length, 0, "map never runs when blocked");
    assert.match(result.summary, /extraction_blocked/);
    assert.match(result.summary, /pin mismatch/i);
    // A status event for the blocked terminal phase was emitted.
    assert.ok(seams._calls.statusEvents.some((e) => e.phase === "extraction_blocked"));
  });

  it("treats an UNCHANGED placeholder index (agent authored nothing) as a failed attempt, not green", async () => {
    seedInputs(temp);
    // Seed the placeholder index but the agent never writes a real corpus.
    const placeholder = {
      schema_version: 1,
      status: "pending_llm_semantic_issue_generation",
      baseline_id: "baseline-v1.0.0",
      baseline_version: "1.0.0",
      manifest_path: "docs/baselines/baseline-v1.0.0.json",
      manifest_hash: "x",
      document_set_hash: "y",
      source_corpus: ["docs/canonical/**/*.md"],
      verification_evidence_ref_grammar: "path",
      issues: [],
    };
    const writePlaceholder = (root) => {
      const p = resolve(root, "spec/development/issue-index.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify(placeholder, null, 2)}\n`);
      const ex = resolve(root, "spec/requirements/exclusions.json");
      mkdirSync(dirname(ex), { recursive: true });
      writeFileSync(ex, `${JSON.stringify({ schema_version: 1, exclusions: [] }, null, 2)}\n`);
    };
    const { spawnAgent } = fakeAgent([(ctx) => writePlaceholder(ctx.repoRoot)]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, maxRetries: 1, ...seams });

    assert.equal(result.status, "extraction_blocked", "a placeholder is not a successful extraction");
    assert.equal(seams._calls.mapCalls.length, 0);
  });
});

describe("findFrozenManifest", () => {
  it("returns the active frozen manifest and ignores a superseded one", () => {
    mkdirSync(resolve(temp, "docs/baselines"), { recursive: true });
    writeFileSync(
      resolve(temp, "docs/baselines/baseline-v0.9.0.json"),
      JSON.stringify({ baseline_id: "baseline-v0.9.0", status: "frozen", superseded: { by_baseline_id: "baseline-v1.0.0" } }),
    );
    writeFileSync(
      resolve(temp, "docs/baselines/baseline-v1.0.0.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0", status: "frozen" }),
    );
    const found = findFrozenManifest(temp);
    assert.equal(found.baselineId, "baseline-v1.0.0");
  });

  it("returns null when only a draft baseline exists", () => {
    mkdirSync(resolve(temp, "docs/baselines"), { recursive: true });
    writeFileSync(
      resolve(temp, "docs/baselines/baseline-v1.0.0-draft.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0-draft", status: "draft" }),
    );
    assert.equal(findFrozenManifest(temp), null);
  });
});

describe("formatCheckOutput", () => {
  it("flattens semantic + traceability errors into one readable block", () => {
    const text = formatCheckOutput({
      semantic: { exitCode: 1, errors: ["pin mismatch: foo"], warnings: ["w1"], summary: "FAILED" },
      traceability: { exitCode: 1, errors: ["Rule: x"], summary: "FAILED" },
    });
    assert.match(text, /semantic-extraction-check: FAILED/);
    assert.match(text, /pin mismatch: foo/);
    assert.match(text, /traceability-check: FAILED/);
  });

  it("is honest about a missing check object", () => {
    assert.equal(formatCheckOutput(null), "(no check output)");
  });
});
