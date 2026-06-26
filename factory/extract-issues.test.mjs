// Unit tests for the semantic issue EXTRACTION orchestrator (TWO-AGENT loop).
//
// BOTH agent legs are ALWAYS faked here — no real CLI is launched in this run:
//   - the EXTRACTOR leg (options.spawnExtractor) authors/fixes the corpus, and
//   - the independent FIDELITY VERIFIER leg (options.spawnVerifier) writes the
//     structured verdict file.
// The deterministic checks are REAL: the happy path proves a valid authored
// corpus actually passes semantic-extraction-check + traceability-check, and the
// fix/blocked paths prove the orchestrator re-prompts the EXTRACTOR on a real red
// check OR an unfaithful verdict. The golden corpus is the bundled Pocket Ledger
// rehearsal fixture (which is known to pass both deterministic gates).
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractIssues, findFrozenManifest, formatCheckOutput, formatFixContext } from "./extract-issues.mjs";

const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(FACTORY_DIR, "rehearsal/pocket-ledger");
const VERDICT_REL = "spec/development/reports/extraction-fidelity-verdict.json";

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

/** A fake EXTRACTOR that runs a per-attempt scripted action and records the calls. */
function fakeAgent(perAttempt) {
  const calls = [];
  const spawnExtractor = async (ctx) => {
    calls.push(ctx);
    const action = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    action(ctx);
    return { transcriptRel: `spec/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl` };
  };
  return { spawnExtractor, calls };
}

/** Write the verifier's structured verdict into the target repo. */
function writeVerdict(root, verdict) {
  const p = resolve(root, VERDICT_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(verdict, null, 2)}\n`);
}

/**
 * A fake independent FIDELITY VERIFIER that writes a per-attempt scripted verdict
 * and records the calls. `perAttempt[i]` is the verdict object written on attempt
 * i+1 (the last entry repeats). The verifier is only ever invoked AFTER the
 * deterministic checks pass for that attempt, so its call list reflects exactly
 * the attempts that reached the fidelity gate.
 */
function fakeVerifier(perAttempt) {
  const calls = [];
  const spawnVerifier = async (ctx) => {
    calls.push(ctx);
    const verdict = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    writeVerdict(ctx.repoRoot, verdict);
    return { transcriptRel: `spec/development/transcripts/EXTRACTION/verify-${ctx.attempt}.jsonl` };
  };
  return { spawnVerifier, calls };
}

/** A verifier that always returns faithful:true (the default for happy paths). */
function alwaysFaithfulVerifier() {
  return fakeVerifier([{ faithful: true, problems: [] }]);
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

describe("extractIssues — two-agent happy path", () => {
  it("extractor authors a valid corpus -> deterministic green -> verifier faithful:true -> map -> green", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 1);
    assert.equal(calls.length, 1, "exactly one (initial author) extractor leg");
    assert.equal(calls[0].isFix, false);
    assert.equal(calls[0].checkOutput, null);
    // The verifier ran exactly once, AFTER the deterministic checks passed.
    assert.equal(verifyCalls.length, 1, "verifier ran once on the deterministic-green corpus");
    assert.equal(verifyCalls[0].attempt, 1);
    // The REAL deterministic checks actually passed AND the verdict is faithful.
    assert.equal(result.checks.semantic.exitCode, 0);
    assert.equal(result.checks.traceability.exitCode, 0);
    assert.equal(result.checks.semantic.placeholder, false);
    assert.equal(result.verdict.faithful, true);
    // The map was regenerated and BOTH legs' transcripts captured (extract + verify).
    assert.equal(seams._calls.mapCalls.length, 1);
    assert.deepEqual(result.transcripts, [
      "spec/development/transcripts/EXTRACTION/extract-1.jsonl",
      "spec/development/transcripts/EXTRACTION/verify-1.jsonl",
    ]);
    assert.match(result.summary, /8 issue\(s\)/);
    assert.match(result.summary, /faithful:true/);
  });

  it("does NOT freeze when a frozen baseline already exists (reuses it)", async () => {
    seedInputs(temp); // includes docs/baselines/baseline-v1.0.0.json (frozen)
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.froze, false);
    assert.equal(seams._calls.freezeCalls.length, 0, "freeze seam never invoked");
    assert.equal(result.baselineId, "baseline-v1.0.0");
  });

  it("accepts the legacy spawnAgent alias for the extractor leg (back-compat)", async () => {
    seedInputs(temp);
    const { spawnExtractor: spawnAgent, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnAgent, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(calls.length, 1, "the spawnAgent alias drove the extractor leg");
  });
});

describe("extractIssues — freeze-if-needed branch", () => {
  it("freezes via the injected freeze seam when no frozen baseline exists", async () => {
    // Seed canonical docs ONLY — no docs/baselines yet.
    cpSync(resolve(FIXTURE, "docs/canonical"), resolve(temp, "docs/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));

    assert.equal(findFrozenManifest(temp), null, "precondition: no frozen baseline");

    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(seams._calls.freezeCalls.length, 1, "freeze seam invoked exactly once");
    assert.equal(seams._calls.freezeCalls[0].version, "1.0.0");
    assert.equal(result.froze, true);
    assert.equal(result.status, "green");
  });
});

describe("extractIssues — freeze runs before ANY status emission (live-proof regression)", () => {
  it("emits NO status before the freeze seam runs, so the freeze never sees a tree we dirtied", async () => {
    // No frozen baseline yet -> the freeze seam MUST run. We record the exact
    // interleaving of status emissions and the freeze call; the regression is that
    // record({ phase: "freezing" }) used to fire BEFORE the freeze, writing
    // extraction-status.json into a tracked path and tripping doc-baseline's
    // working-tree-clean guard. Assert the freeze is the FIRST observable side
    // effect — nothing tracked is written before it.
    cpSync(resolve(FIXTURE, "docs/canonical"), resolve(temp, "docs/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));

    const order = [];
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const base = stubSeams();

    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      // Order-recording wrappers around the two seams whose ordering matters.
      runFreeze: async (args) => {
        order.push("freeze");
        return base.runFreeze(args);
      },
      emitStatus: (status) => {
        order.push(`status:${status.phase}`);
      },
    });

    assert.equal(result.status, "green");
    assert.ok(order.length > 0, "the orchestrator emitted at least one status");
    assert.equal(order[0], "freeze", "the FREEZE is the first side effect — no status before it");
    // Belt-and-braces: no status event of ANY phase precedes the freeze.
    const firstStatusIdx = order.findIndex((e) => e.startsWith("status:"));
    const freezeIdx = order.indexOf("freeze");
    assert.ok(freezeIdx < firstStatusIdx, "every status emission happens strictly after the freeze");
    // And the old offending "freezing" phase status is gone entirely.
    assert.ok(!order.includes("status:freezing"), "no pre-freeze 'freezing' status is emitted");
  });
});

describe("extractIssues — deterministic fix loop", () => {
  it("re-prompts with the exact check output when attempt 1 fails, then goes green on attempt 2", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([
      (ctx) => writeInvalidCorpus(ctx.repoRoot), // attempt 1: pin mismatch -> red
      (ctx) => writeValidCorpus(ctx.repoRoot), //   attempt 2: valid -> green
    ]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2);
    assert.equal(calls.length, 2);
    // The verifier is short-circuited on attempt 1 (deterministic checks red) and
    // only runs on attempt 2 (deterministic green).
    assert.equal(verifyCalls.length, 1, "verifier only runs after deterministic checks pass");
    assert.equal(verifyCalls[0].attempt, 2);
    // Attempt 2 is a FIX pass and received the attempt-1 check output verbatim.
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got the failing-check text");
    assert.match(calls[1].checkOutput, /pin mismatch/i);
    assert.equal(seams._calls.mapCalls.length, 1, "map runs once, only on green");
    assert.equal(result.transcripts.length, 3, "extract-1 + extract-2 + verify-2");
  });
});

describe("extractIssues — fidelity fix loop (the independent verifier)", () => {
  it("verifier returns problems on attempt 1, extractor fixes, attempt 2 faithful -> green", async () => {
    seedInputs(temp);
    // Both attempts author a deterministically-VALID corpus (so the only thing that
    // gates attempt 1 is the FIDELITY verdict, not a deterministic check).
    const { spawnExtractor, calls } = fakeAgent([
      (ctx) => writeValidCorpus(ctx.repoRoot),
      (ctx) => writeValidCorpus(ctx.repoRoot),
    ]);
    const { spawnVerifier, calls: verifyCalls } = fakeVerifier([
      // attempt 1: deterministic-green but the independent verifier rejects fidelity.
      {
        faithful: false,
        problems: [
          { issue: "ISS-0003", kind: "invented_requirement", detail: "ISS-0003 invents a rate-limit obligation the cited lines do not state." },
        ],
      },
      // attempt 2: faithful.
      { faithful: true, problems: [] },
    ]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2);
    assert.equal(calls.length, 2, "the EXTRACTOR (not the verifier) was re-prompted to fix");
    assert.equal(verifyCalls.length, 2, "the verifier judged both deterministic-green attempts");
    // The fix pass received the verifier's structured problems, fed back verbatim.
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got the fidelity verdict");
    assert.match(calls[1].checkOutput, /faithful:false/);
    assert.match(calls[1].checkOutput, /invented_requirement/);
    assert.match(calls[1].checkOutput, /ISS-0003/);
    assert.equal(result.verdict.faithful, true);
    assert.equal(seams._calls.mapCalls.length, 1, "map runs once, only on the faithful-green attempt");
  });

  it("blocks when fidelity STAYS false through the bounded retries, and never maps", async () => {
    seedInputs(temp);
    // Deterministically valid every time, but the verifier never accepts fidelity.
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier, calls: verifyCalls } = fakeVerifier([
      { faithful: false, problems: [{ issue: "ISS-0001", kind: "scope_drift", detail: "ISS-0001 broadens the cited scope." }] },
    ]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries");
    assert.equal(calls.length, 3, "the extractor was re-prompted up to the bound");
    assert.equal(verifyCalls.length, 3, "the verifier judged every deterministic-green attempt");
    assert.equal(seams._calls.mapCalls.length, 0, "map never runs when fidelity stays false");
    // The blocked report carries the verifier's verdict so a human sees WHY.
    assert.match(result.summary, /extraction_blocked/);
    assert.match(result.summary, /faithful:false/);
    assert.match(result.summary, /scope_drift/);
    assert.equal(result.verdict.faithful, false);
  });

  it("treats a MISSING verdict (verifier wrote nothing) as not faithful, not green", async () => {
    seedInputs(temp);
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    // A verifier that runs but writes NO verdict file.
    const spawnVerifier = async () => ({ transcriptRel: "spec/development/transcripts/EXTRACTION/verify.jsonl" });
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 1, ...seams });

    assert.equal(result.status, "extraction_blocked", "no structured verdict is never a green");
    assert.equal(seams._calls.mapCalls.length, 0);
    assert.equal(result.verdict.faithful, false);
    assert.match(result.summary, /no_verdict|faithful:false/);
  });
});

describe("extractIssues — bounded retries / blocked (deterministic)", () => {
  it("returns extraction_blocked after maxRetries+1 red attempts and never maps or verifies", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeInvalidCorpus(ctx.repoRoot)]); // always red
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries");
    assert.equal(calls.length, 3);
    assert.equal(verifyCalls.length, 0, "the verifier never runs while deterministic checks are red");
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
    const { spawnExtractor } = fakeAgent([(ctx) => writePlaceholder(ctx.repoRoot)]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 1, ...seams });

    assert.equal(result.status, "extraction_blocked", "a placeholder is not a successful extraction");
    assert.equal(verifyCalls.length, 0, "a placeholder never reaches the fidelity verifier");
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

describe("formatFixContext (combined deterministic + fidelity feedback)", () => {
  it("includes the deterministic check block when a deterministic check failed", () => {
    const text = formatFixContext(
      { semantic: { exitCode: 1, errors: ["pin mismatch: foo"], summary: "FAILED" }, traceability: { exitCode: 0, summary: "ok" } },
      null,
    );
    assert.match(text, /pin mismatch: foo/);
  });

  it("includes the fidelity verdict block (and not a passing deterministic block) on a fidelity-only failure", () => {
    const text = formatFixContext(
      // deterministic GREEN
      { semantic: { exitCode: 0, placeholder: false, summary: "ok" }, traceability: { exitCode: 0, summary: "ok" } },
      { faithful: false, problems: [{ issue: "ISS-0003", kind: "invented_requirement", detail: "no canonical basis" }] },
    );
    assert.match(text, /faithful:false/);
    assert.match(text, /invented_requirement/);
    assert.match(text, /ISS-0003/);
    // The passing deterministic checks are NOT re-fed as if they were the problem.
    assert.doesNotMatch(text, /semantic-extraction-check: ok/);
  });

  it("is honest when there is neither check nor verdict output", () => {
    assert.equal(formatFixContext(null, null), "(no check or verdict output)");
    // A faithful:true verdict is not a problem to feed back.
    assert.equal(formatFixContext(null, { faithful: true, problems: [] }), "(no check or verdict output)");
  });
});

describe("scaffold + fixture gitignore the transient extraction-status file", () => {
  const STATUS_LINE = "spec/development/reports/extraction-status.json";

  it("the fixture .gitignore ignores ONLY the transient status file (not all of reports/)", () => {
    const gi = readFileSync(resolve(FIXTURE, ".gitignore"), "utf8");
    assert.ok(gi.split("\n").includes(STATUS_LINE), "fixture .gitignore lists the transient status file");
    // Gate evidence lives under reports/ too — never ignore the whole directory.
    assert.doesNotMatch(gi, /^spec\/development\/reports\/?\s*$/m, "must not ignore the whole reports/ dir");
  });

  it("the scaffold gitignore() template emits the transient status line", () => {
    // Read the template source directly (no TS runtime needed): the gitignore()
    // string literal must carry the exact ignore line so freshly-scaffolded
    // projects never commit (or dirty the freeze with) the status file.
    const scaffoldSrc = readFileSync(resolve(FACTORY_DIR, "../lib/scaffold.ts"), "utf8");
    assert.ok(scaffoldSrc.includes(STATUS_LINE), "scaffold gitignore() template includes the status line");
    assert.doesNotMatch(scaffoldSrc, /\n\s*spec\/development\/reports\/\s*\n/, "scaffold must not ignore the whole reports/ dir");
  });
});
