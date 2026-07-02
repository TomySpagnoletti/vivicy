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
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractIssues, findFrozenManifest, formatCheckOutput, formatFixContext, formatMapError } from "./extract-issues.mjs";
import { readSpikes } from "./spike-check.mjs";

const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(FACTORY_DIR, "rehearsal/pocket-ledger");
const VERDICT_REL = ".vivicy/development/reports/extraction-fidelity-verdict.json";

// The corpus files the extractor authors (under .vivicy/requirements + .vivicy/development),
// as opposed to the inputs it reads (.vivicy/canonical/**, the frozen baseline). Only
// load-bearing .json — the human-readable catalog.md / traceability-matrix.md
// mirrors are decoration nothing reads and are no longer authored.
const CORPUS_FILES = [
  ".vivicy/requirements/catalog.json",
  ".vivicy/requirements/traceability-matrix.json",
  ".vivicy/requirements/exclusions.json",
  ".vivicy/development/issue-index.json",
];
const CORPUS_DIRS = [".vivicy/development/issues"];
const INPUT_PATHS = [".vivicy/canonical", ".vivicy/baselines", "README.md", "package.json"];

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
  const indexPath = resolve(root, ".vivicy/development/issue-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.manifest_hash = "deadbeef".repeat(8); // pin mismatch vs the frozen manifest
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

/**
 * Write a well-formed spike whose gate-id slug equals its filename stem (so
 * spike-check passes) and whose requirement_ids resolve to a real fixture catalog
 * requirement (so traceability-check's back-fill rule passes). It is written `verified`
 * with the six completion fields by default — the state a spike is in by S6 after the
 * S3 proofing stage (G3) has run — so the G13 spike-verification gate lets extraction
 * proceed. Pass `status: "pending"` to model a not-yet-proofed spike. This is exactly the
 * byte-compatible shape an owner-provided (or Vivi-written) spike carries once proofed.
 */
function writeSpike(root, filename, reqId = "REQ-ARCH-001", status = "verified") {
  const slug = filename.replace(/\.md$/, "");
  const content = [
    `# S - ${slug}`,
    "",
    "Document status: Phase 0 spike.",
    "",
    "## Traceability",
    "",
    "```text",
    `requirement_ids: ${reqId}`,
    `gate_id: gate:phase0:s${slug}`,
    `status: ${status}`,
    "```",
    "",
    "## Question",
    "",
    "Does the provider behave as assumed?",
    "",
    "## Must Verify",
    "",
    "- [Live test required: ...] the assumption",
    "",
    "## Evidence Required",
    "",
    "```text",
    "environment: date, runtime, versions",
    "commands or API calls: the exact calls",
    "observed output: the observed result",
    "decision: the locked decision",
    "documentation updates: none",
    "unresolved risks: none",
    "```",
    "",
  ].join("\n");
  const p = resolve(root, ".vivicy/development/spikes", filename);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return { path: p, content, file: `.vivicy/development/spikes/${filename}`, gate_id: `gate:phase0:s${slug}` };
}

/**
 * An inert spike-proofing seam for the extraction tests that do not exercise S3: it runs
 * no legs and mutates nothing, reporting the already-verified seeded spikes as proofed.
 * Extraction tests inject this so the DEFAULT (real-leg) proofing never spawns a CLI, and
 * so the seeded `verified` spikes pass the G13 gate unchanged. G3 itself is proven in
 * spike-proofier.test.mjs; the proof that S3 runs BEFORE the freeze lives below.
 */
function noopSpikeProofing(root) {
  const proofed = readSpikes(root)
    .filter((s) => s.status === "verified")
    .map((s) => ({ file: s.file, gate_id: s.gate_id, verdict: "verified" }));
  return async () => ({ proofed, failed: [], skipped: [], changeRequests: [] });
}

/** Seed a minimal architecture-map.yml so the map pre-exists pre-run (map_mode reused). */
function seedArchitectureMap(root) {
  const p = resolve(root, ".vivicy/architecture-map/architecture-map.yml");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'version: 1\nname: "Owner Map"\n');
}

/** A fake EXTRACTOR that runs a per-attempt scripted action and records the calls. */
function fakeAgent(perAttempt) {
  const calls = [];
  const spawnExtractor = async (ctx) => {
    calls.push(ctx);
    const action = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    action(ctx);
    return { transcriptRel: `.vivicy/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl` };
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
    return { transcriptRel: `.vivicy/development/transcripts/EXTRACTION/verify-${ctx.attempt}.jsonl` };
  };
  return { spawnVerifier, calls };
}

/** A verifier that always returns faithful:true (the default for happy paths). */
function alwaysFaithfulVerifier() {
  return fakeVerifier([{ faithful: true, problems: [] }]);
}

/** Stub seams so no real freeze/map/commit subprocess runs; the CHECKS stay real. */
function stubSeams(extra = {}) {
  const mapCalls = [];
  const freezeCalls = [];
  const statusEvents = [];
  const commitCalls = [];
  return {
    runFreeze: async ({ repoRoot, version }) => {
      freezeCalls.push({ repoRoot, version });
      // A test "freeze": copy the fixture's frozen manifest in.
      copyCorpusPath(repoRoot, ".vivicy/baselines");
      return { manifestPath: ".vivicy/baselines/baseline-v1.0.0.json", baselineId: "baseline-v1.0.0" };
    },
    runGenerateMap: ({ repoRoot }) => {
      mapCalls.push(repoRoot);
      // Simulate the generator writing architecture-data.json.
      const out = resolve(repoRoot, ".vivicy/architecture-map/architecture-data.json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ development: { issues: [] } }, null, 2));
      return { code: 0, output: "generated" };
    },
    emitStatus: (status) => statusEvents.push(status),
    // Stub the mechanical corpus commit: the temp dirs are not git repos, and the
    // real git-backed commit is proven by a dedicated test below.
    commitCorpus: (ctx) => {
      commitCalls.push(ctx);
      return { committed: true };
    },
    // The per-lens map review defaults to CLEAN (no findings) so happy paths green; a
    // test overrides it via `extra` to exercise the find -> fix-pass feedback.
    mapReview: async () => ({ findings: [], actionable: [], legs: [] }),
    // The S3 spike-proofing stage (G3) defaults to INERT here: it runs no real legs and
    // mutates nothing, reporting the already-`verified` seeded spikes as proofed. This
    // keeps the DEFAULT proofier/verifier CLIs from ever spawning in an extraction test,
    // and lets the seeded verified spikes pass the G13 gate. G3 is proven on its own in
    // spike-proofier.test.mjs. A test overrides it via `extra` to exercise the ordering.
    runSpikeProofing: async ({ repoRoot }) => ({
      proofed: readSpikes(repoRoot).filter((s) => s.status === "verified").map((s) => ({ file: s.file, gate_id: s.gate_id, verdict: "verified" })),
      failed: [],
      skipped: [],
      changeRequests: [],
    }),
    _calls: { mapCalls, freezeCalls, statusEvents, commitCalls },
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
      ".vivicy/development/transcripts/EXTRACTION/extract-1.jsonl",
      ".vivicy/development/transcripts/EXTRACTION/verify-1.jsonl",
    ]);
    assert.match(result.summary, /8 issue\(s\)/);
    assert.match(result.summary, /faithful:true/);
    // The corpus was committed MECHANICALLY on green (Item 2) — the orchestrator,
    // not a human, ends the run with a committed corpus.
    assert.equal(seams._calls.commitCalls.length, 1, "corpus committed exactly once on green");
    assert.equal(result.committed, true);
    assert.match(result.summary, /corpus committed/);
  });

  it("does NOT freeze when a frozen baseline already exists (reuses it)", async () => {
    seedInputs(temp); // includes .vivicy/baselines/baseline-v1.0.0.json (frozen)
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.froze, false);
    assert.equal(seams._calls.freezeCalls.length, 0, "freeze seam never invoked");
    assert.equal(result.baselineId, "baseline-v1.0.0");
  });

  it("re-freezes a STALE frozen baseline that no longer matches the spec", async () => {
    seedInputs(temp); // a frozen manifest exists, but the spec has since changed
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    // verifyFrozenManifest:false on the FIRST (pre-loop) check models the owner editing
    // .vivicy/canonical/** after the freeze (document_set_hash no longer verifies) — the
    // stale baseline is discarded and re-frozen. After the re-freeze the new baseline
    // matches, so the per-attempt re-check passes (true).
    let vfmCalls = 0;
    const seams = stubSeams({ verifyFrozenManifest: () => vfmCalls++ > 0 });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.froze, true, "a stale baseline is re-frozen, not reused");
    assert.equal(seams._calls.freezeCalls.length, 1, "freeze seam invoked once to re-establish the baseline");
  });

  it("re-freezes when the EXTRACTOR edits canonical mid-loop (Pass 1 contradiction fix)", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    // Pre-loop the baseline matches (reuse, no freeze). On attempt 1 the extractor edits
    // canonical to resolve a contradiction, so the post-extractor re-check fails ONCE — the
    // orchestrator re-freezes + re-pins and re-authors; the re-frozen baseline then matches.
    let vfmCalls = 0;
    const seams = stubSeams({ verifyFrozenManifest: () => vfmCalls++ !== 1 });
    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });
    assert.equal(result.status, "green");
    assert.equal(seams._calls.freezeCalls.length, 1, "the mid-loop canonical edit triggers exactly one re-freeze");
    assert.equal(calls.length, 2, "attempt 1 re-freezes after the canonical edit; attempt 2 re-authors to green");
  });

  it("re-prompts the extractor when the per-lens map review finds an actionable issue, then greens on a clean review", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    // First map review surfaces a real finding (-> extractor fix pass); the second is clean (-> green).
    let reviewCalls = 0;
    const mapReview = async () => {
      reviewCalls += 1;
      const f = { lens: "data-ownership", target: "node:x", detail: "two owners", real: true };
      return reviewCalls === 1 ? { findings: [f], actionable: [f], legs: [] } : { findings: [], actionable: [], legs: [] };
    };
    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...stubSeams({ mapReview }) });
    assert.equal(result.status, "green");
    assert.equal(reviewCalls, 2, "the map review runs on each faithful attempt; the run greens only when it is clean");
    assert.equal(calls.length, 2, "the actionable finding triggers exactly one extractor fix pass");
    assert.match(result.summary, /map review clean/);
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

describe("extractIssues — S2 spike mode (G12) + S5 map mode (G4)", () => {
  it("INTEGRATE mode: pre-existing spikes pass through byte-for-byte, status says spike_mode integrate", async () => {
    seedInputs(temp);
    // Two owner-provided spikes on disk BEFORE the run: S2 must integrate, not extract.
    const s1 = writeSpike(temp, "01-provider-auth.md");
    const s2 = writeSpike(temp, "02-runtime-limits.md", "REQ-ARCH-002");
    const before1 = readFileSync(s1.path, "utf8");
    const before2 = readFileSync(s2.path, "utf8");

    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    // The mode is resolved from the pre-run corpus and handed to the extractor leg.
    assert.equal(result.spike_mode, "integrate");
    assert.equal(calls[0].spikeMode, "integrate", "the extractor leg is told to INTEGRATE");
    // The persisted extraction-status.json (the exact object emitStatus writes) records it.
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus.spike_mode, "integrate", "extraction-status.json says spike_mode integrate");
    // The provided spikes are untouched BYTE-FOR-BYTE — integrate never rewrites them.
    assert.equal(readFileSync(s1.path, "utf8"), before1, "spike 1 is byte-identical");
    assert.equal(readFileSync(s2.path, "utf8"), before2, "spike 2 is byte-identical");
  });

  it("EXTRACT mode: no spikes on disk -> status says spike_mode extract", async () => {
    seedInputs(temp); // fixture has no spikes/ directory
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.spike_mode, "extract");
    assert.equal(calls[0].spikeMode, "extract", "the extractor leg is told to EXTRACT");
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus.spike_mode, "extract", "extraction-status.json says spike_mode extract");
  });

  it("REUSED map mode: a pre-existing architecture-map.yml -> status says map_mode reused", async () => {
    seedInputs(temp);
    seedArchitectureMap(temp); // the owner brought his own map

    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.map_mode, "reused", "a map existing pre-run is reused, not authored");
    assert.equal(calls[0].mapMode, "reused", "the extractor leg is told to REUSE the map");
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus.map_mode, "reused", "extraction-status.json says map_mode reused");
  });

  it("AUTHORED map mode: no map on disk -> status says map_mode authored", async () => {
    seedInputs(temp); // fixture has no architecture-map.yml
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.map_mode, "authored");
    assert.equal(calls[0].mapMode, "authored", "the extractor leg is told to AUTHOR a map");
  });

  it("records both modes on the BLOCKED path too (a red run still reports which path S2/S5 took)", async () => {
    seedInputs(temp);
    writeSpike(temp, "01-provider-auth.md"); // integrate
    const { spawnExtractor } = fakeAgent([(ctx) => writeInvalidCorpus(ctx.repoRoot)]); // pin mismatch -> never green
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 0, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.spike_mode, "integrate");
    assert.equal(result.map_mode, "authored");
    const blockedStatus = seams._calls.statusEvents.find((e) => e.phase === "extraction_blocked");
    assert.equal(blockedStatus.spike_mode, "integrate", "the blocked extraction-status.json carries spike_mode");
    assert.equal(blockedStatus.map_mode, "authored", "the blocked extraction-status.json carries map_mode");
  });
});

describe("extractIssues — S3 proofing before freeze (order) + G13 spike-verification gate", () => {
  it("runs the S3 proofing stage BEFORE the freeze (S3 precedes S4)", async () => {
    // A from-scratch target so the freeze seam MUST run; record the interleaving of the
    // proofing stage and the freeze. Proofing (which may correct the canonical pre-baseline)
    // must be the FIRST observable side effect, strictly before the freeze — proofing after
    // the freeze would force a re-freeze loop on every correction.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
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
      // Order-recording wrappers around the two seams whose ordering is the contract.
      runSpikeProofing: async () => {
        order.push("proof");
        return { proofed: [], failed: [], skipped: [], changeRequests: [] };
      },
      runFreeze: async (args) => {
        order.push("freeze");
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    assert.ok(order.length >= 2, "both the proofing stage and the freeze ran");
    assert.equal(order[0], "proof", "spike proofing is the first side effect");
    assert.ok(order.indexOf("proof") < order.indexOf("freeze"), "S3 proofing runs strictly before the S4 freeze");
  });

  it("BLOCKS extraction when a non-deferred spike is not verified (loud, with the offending gate_ids)", async () => {
    seedInputs(temp);
    // A PENDING spike on disk that proofing did NOT verify (the injected stage leaves it
    // pending). G13 must refuse to author issues while it is unverified.
    const s = writeSpike(temp, "01-provider-auth.md", "REQ-ARCH-001", "pending");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    // Proofing that proves NOTHING (models a spike still pending after S3, e.g. gated_by_external).
    const seams = stubSeams({ runSpikeProofing: async () => ({ proofed: [], failed: [], skipped: [], changeRequests: [] }) });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "blocked_on_unverified_spikes", "extraction refuses on an unverified required spike");
    assert.deepEqual(result.unverified_spike_gate_ids, [s.gate_id], "the offending gate id is named");
    assert.equal(calls.length, 0, "the extractor leg never ran — extraction did not proceed");
    // The block is loud on the status surface with the gate id.
    const blocked = seams._calls.statusEvents.find((e) => e.phase === "blocked_on_unverified_spikes");
    assert.ok(blocked, "a blocked_on_unverified_spikes status was emitted");
    assert.deepEqual(blocked.unverified_spike_gate_ids, [s.gate_id]);
    assert.match(result.summary, /blocked_on_unverified_spikes/);
    assert.match(result.summary, new RegExp(s.gate_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("PROCEEDS to green when every required spike is verified", async () => {
    seedInputs(temp);
    // A verified spike (writeSpike defaults to verified + full evidence) passes G13.
    writeSpike(temp, "01-provider-auth.md");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green", "a fully-verified spike corpus lets extraction proceed");
    assert.equal(calls.length, 1, "the extractor ran once");
    assert.deepEqual(result.spike_proofing, { proofed: 1, failed: 0, skipped: 0 }, "the proofing summary rides on the status");
  });

  it("a DEFERRED spike does NOT block extraction (its dependents are gated in the dev loop)", async () => {
    seedInputs(temp);
    // A deferred spike is an accepted, tracked deferral — not an open question — so it must
    // not block issue extraction even though it is not verified.
    writeSpike(temp, "01-provider-auth.md", "REQ-ARCH-001", "deferred");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams({ runSpikeProofing: async () => ({ proofed: [], failed: [], skipped: [], changeRequests: [] }) });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green", "a deferred spike does not block extraction");
    assert.equal(calls.length, 1);
  });
});

describe("extractIssues — mechanical corpus commit on green (Item 2, real git)", () => {
  it("commits the whole corpus on green and leaves a clean tree (only gitignored untracked)", async () => {
    seedInputs(temp);
    // Make the temp repo a REAL git repo so the default commitCorpus seam runs for
    // real (the freeze/map seams are still stubbed; the checks are real).
    const git = (args) => spawnSync("git", args, { cwd: temp, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@local"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    // Ship the scaffold-policy .gitignore so transcripts/runtime/worktrees are the
    // ONLY never-commit set; everything else the run produces is committed.
    writeFileSync(
      resolve(temp, ".gitignore"),
      "node_modules/\n.DS_Store\n.vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n",
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "inputs"]);

    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    // Use the REAL commitCorpus (omit the stub) but keep freeze/map stubbed.
    const { commitCorpus, ...seams } = stubSeams();
    void commitCorpus;
    // A fake transcript proves transcripts are NOT committed (gitignored).
    const txAbs = resolve(temp, ".vivicy/development/transcripts/EXTRACTION/extract-1.jsonl");
    mkdirSync(dirname(txAbs), { recursive: true });
    writeFileSync(txAbs, "{}\n");

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });
    assert.equal(result.status, "green");
    assert.equal(result.committed, true, "the orchestrator committed the corpus mechanically");

    // The authored corpus + regenerated map are COMMITTED (tracked in HEAD).
    const tracked = new Set(
      git(["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean),
    );
    for (const rel of [
      ".vivicy/requirements/catalog.json",
      ".vivicy/requirements/traceability-matrix.json",
      ".vivicy/development/issue-index.json",
      ".vivicy/architecture-map/architecture-data.json",
    ]) {
      assert.ok(tracked.has(rel), `expected ${rel} to be committed`);
    }
    // The decorative .md mirrors are NOT produced (nothing reads them).
    assert.ok(!tracked.has(".vivicy/requirements/catalog.md"), "catalog.md must not exist");
    assert.ok(!tracked.has(".vivicy/requirements/traceability-matrix.md"), "traceability-matrix.md must not exist");
    // Transcripts are NEVER committed.
    for (const rel of tracked) {
      assert.ok(!rel.startsWith(".vivicy/development/transcripts/"), `transcript must not be committed: ${rel}`);
    }

    // Clean tree: `git status --porcelain` shows nothing tracked-and-dirty; only the
    // gitignored transcript remains untracked-but-ignored (not reported).
    const porcelain = git(["status", "--porcelain"]).stdout.trim();
    assert.equal(porcelain, "", `tree must be clean after the mechanical commit, got:\n${porcelain}`);
  });
});

// Real-git helpers for the spec-snapshot lifecycle tests below. No fakes — the
// point is to prove the mechanical git lifecycle (init, spec snapshot, freeze) needs
// zero human git step.
function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function isClean(root) {
  return git(root, ["status", "--porcelain"]).stdout.trim() === "";
}
/** Make `root` a git repo with a local identity and an initial commit of its contents. */
function initRepoWithCommit(root) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@local"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
}
/** Ship the scaffold-policy .gitignore so `git add -A` is safe in the lifecycle tests. */
function writeScaffoldGitignore(root) {
  writeFileSync(
    resolve(root, ".gitignore"),
    "node_modules/\n.DS_Store\n.vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n",
  );
}

describe("extractIssues — mechanical SPEC-SNAPSHOT commit before the freeze (no human git)", () => {
  it("commits the owner's uncommitted spec so the freeze sees a CLEAN committed tree", async () => {
    // The owner wrote canonical docs into a repo and left them UNCOMMITTED (dirty
    // tree) — exactly the state after scaffolding + writing the spec, before extract.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    git(temp, ["init", "-q"]);
    git(temp, ["config", "user.email", "t@local"]);
    git(temp, ["config", "user.name", "t"]);
    git(temp, ["config", "commit.gpgsign", "false"]);
    assert.equal(isClean(temp), false, "precondition: the spec is uncommitted (dirty tree)");

    // Spy the freeze seam to assert the tree is CLEAN at the moment the freeze runs —
    // i.e. the spec snapshot committed everything first.
    let cleanAtFreeze = null;
    const base = stubSeams();
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      // REAL spec-snapshot (omit the stub) by simply not passing commitSpecSnapshot.
      runFreeze: async (args) => {
        cleanAtFreeze = isClean(temp);
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    assert.equal(cleanAtFreeze, true, "the spec snapshot left a CLEAN committed tree before the freeze");
    // The spec is now committed in HEAD (the owner ran no git).
    const tracked = new Set(git(temp, ["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    assert.ok(tracked.has(".vivicy/canonical/01-architecture.md"), "the owner's spec is committed");
    // A spec-snapshot commit exists with the expected subject.
    const log = git(temp, ["log", "--format=%s"]).stdout;
    assert.match(log, /spec snapshot: commit canonical spec before freeze/);
  });

  it("makes NO redundant empty commit when the repo is already clean", async () => {
    // The spec is already committed (clean tree) — re-running extract must NOT add an
    // empty 'spec snapshot' commit, and must NOT error.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    initRepoWithCommit(temp);
    assert.equal(isClean(temp), true, "precondition: already-clean committed tree");
    const commitsBefore = git(temp, ["rev-list", "--count", "HEAD"]).stdout.trim();

    const base = stubSeams();
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...base });

    assert.equal(result.status, "green");
    // No 'spec snapshot' commit was created (the tree was already clean) — the only
    // new commits would come from later steps, never from an empty snapshot.
    const log = git(temp, ["log", "--format=%s"]).stdout;
    assert.ok(!/spec snapshot/.test(log), "no redundant empty spec-snapshot commit");
    const commitsAfter = git(temp, ["rev-list", "--count", "HEAD"]).stdout.trim();
    assert.equal(commitsAfter, commitsBefore, "commit count unchanged by the (no-op) snapshot");
  });

  it("inits a repo when the target is NOT a git repo, then commits the spec and freezes", async () => {
    // A from-scratch target that somehow is NOT a repo (defensive path). The snapshot
    // must `git init` it, commit the spec, and the freeze must then succeed.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    assert.notEqual(git(temp, ["rev-parse", "--is-inside-work-tree"]).status, 0, "precondition: not a repo");

    let cleanAtFreeze = null;
    const base = stubSeams();
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      runFreeze: async (args) => {
        cleanAtFreeze = isClean(temp);
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    // It became a repo with a committed spec and a CLEAN tree at freeze time.
    assert.equal(git(temp, ["rev-parse", "--is-inside-work-tree"]).status, 0, "target is now a git repo");
    assert.equal(git(temp, ["rev-parse", "HEAD"]).status, 0, "an initial commit exists (HEAD resolves)");
    assert.equal(cleanAtFreeze, true, "clean committed tree before the freeze");
  });

  it("auto-commits even when the fresh repo has NO git identity configured (sets a local one)", async () => {
    // A fresh repo with NO usable global/system identity. The snapshot must set a
    // LOCAL identity so `git commit` does not fail — no human `git config` step.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    git(temp, ["init", "-q"]);
    // Deliberately set NO user.name/user.email locally; isolate global/system config
    // so only a repo-local identity (which the snapshot must add) can satisfy commit.
    // Point global/system at /dev/null (empty, readable) and use GIT_CONFIG_NOSYSTEM
    // so no ambient identity leaks in — a faithful "fresh machine" with no git identity.
    const emptyHome = mkdtempSync(join(tmpdir(), "vivicy-empty-home-"));
    const prevHome = process.env.HOME;
    const prevG = process.env.GIT_CONFIG_GLOBAL;
    const prevS = process.env.GIT_CONFIG_SYSTEM;
    const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    const prevAuthorEmail = process.env.GIT_AUTHOR_EMAIL;
    const prevAuthorName = process.env.GIT_AUTHOR_NAME;
    const prevCommitterEmail = process.env.GIT_COMMITTER_EMAIL;
    const prevCommitterName = process.env.GIT_COMMITTER_NAME;
    process.env.HOME = emptyHome;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    try {
      // Precondition: with global/system isolated and no local identity, git reports
      // NO usable identity — so only the LOCAL one the snapshot sets can satisfy commit.
      assert.equal(git(temp, ["config", "user.email"]).stdout.trim(), "", "precondition: no identity configured");

      const base = stubSeams();
      const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
      const { spawnVerifier } = alwaysFaithfulVerifier();
      const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...base });

      assert.equal(result.status, "green");
      // The snapshot succeeded: HEAD resolves and the local identity is the one we set.
      assert.equal(git(temp, ["rev-parse", "HEAD"]).status, 0, "a commit exists despite no global identity");
      assert.equal(git(temp, ["config", "user.email"]).stdout.trim(), "vivicy@local");
    } finally {
      const restore = (key, prev) => {
        if (prev === undefined) delete process.env[key];
        else process.env[key] = prev;
      };
      restore("HOME", prevHome);
      restore("GIT_CONFIG_GLOBAL", prevG);
      restore("GIT_CONFIG_SYSTEM", prevS);
      restore("GIT_CONFIG_NOSYSTEM", prevNoSystem);
      restore("GIT_AUTHOR_EMAIL", prevAuthorEmail);
      restore("GIT_AUTHOR_NAME", prevAuthorName);
      restore("GIT_COMMITTER_EMAIL", prevCommitterEmail);
      restore("GIT_COMMITTER_NAME", prevCommitterName);
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("end-to-end: real spec snapshot + REAL doc-baseline freeze succeed on a from-scratch repo", async () => {
    // The strongest proof: REAL snapshot AND the REAL doc-baseline freeze (no freeze
    // stub). The owner's uncommitted spec is snapshotted, then doc-baseline cuts a
    // frozen baseline from the clean committed tree — exactly the gap this closes.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    cpSync(resolve(FIXTURE, "package.json"), resolve(temp, "package.json"));
    writeScaffoldGitignore(temp);
    git(temp, ["init", "-q"]);
    git(temp, ["config", "user.email", "t@local"]);
    git(temp, ["config", "user.name", "t"]);
    git(temp, ["config", "commit.gpgsign", "false"]);
    assert.equal(isClean(temp), false, "precondition: spec uncommitted");
    assert.equal(findFrozenManifest(temp), null, "precondition: no frozen baseline yet");

    // Only stub the agent legs + map + corpus commit; the snapshot AND the freeze are
    // REAL (no runFreeze stub). The fake extractor writes the golden corpus but RE-PINS
    // it to the FRESHLY frozen manifest's hashes — because a real re-freeze produces a
    // new manifest_hash (it includes generated_at/approval), so the fixture's golden
    // pin would otherwise mismatch. That repin is exactly what a real extractor does
    // after reading the just-frozen manifest; here it lets us prove the snapshot→freeze
    // lifecycle end-to-end against the REAL doc-baseline tool.
    const spawnExtractor = async (ctx) => {
      writeValidCorpus(ctx.repoRoot);
      const manifest = JSON.parse(readFileSync(resolve(ctx.repoRoot, ctx.manifestPath), "utf8"));
      const idxPath = resolve(ctx.repoRoot, ".vivicy/development/issue-index.json");
      const idx = JSON.parse(readFileSync(idxPath, "utf8"));
      idx.manifest_hash = manifest.manifest_hash;
      idx.document_set_hash = manifest.document_set_hash;
      idx.manifest_path = ctx.manifestPath;
      idx.baseline_id = ctx.baselineId;
      writeFileSync(idxPath, `${JSON.stringify(idx, null, 2)}\n`);
      return { transcriptRel: `.vivicy/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl` };
    };
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const { runFreeze, ...rest } = stubSeams();
    void runFreeze;
    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...rest });

    assert.equal(result.status, "green", `expected green, got: ${result.summary}`);
    assert.equal(result.froze, true, "the REAL freeze ran (no pre-existing baseline)");
    // A real frozen manifest exists and is recognized.
    const frozen = findFrozenManifest(temp);
    assert.ok(frozen, "a frozen baseline manifest exists after the real freeze");
    // The spec is committed in HEAD — the owner ran zero git commands.
    const tracked = new Set(git(temp, ["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    assert.ok(tracked.has(".vivicy/canonical/01-architecture.md"), "the owner's spec is committed");
  });
});

describe("extractIssues — freeze-if-needed branch", () => {
  it("freezes via the injected freeze seam when no frozen baseline exists", async () => {
    // Seed canonical docs ONLY — no .vivicy/baselines yet.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
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
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
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
    // Map generation is now a GATE that runs on every deterministic-green attempt
    // (before fidelity is judged), so it ran on both attempts — once as the gate
    // for attempt 1 (which then failed fidelity) and once for the faithful attempt 2.
    assert.equal(seams._calls.mapCalls.length, 2, "the map gate runs on each deterministic-green attempt, before fidelity");
  });

  it("blocks when fidelity STAYS false through the bounded retries", async () => {
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
    // The map gate (which the stub passes) runs on each deterministic-green attempt
    // before the verifier; fidelity then keeps it from ever reaching green.
    assert.equal(seams._calls.mapCalls.length, 3, "the map gate runs on each deterministic-green attempt");
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
    const spawnVerifier = async () => ({ transcriptRel: ".vivicy/development/transcripts/EXTRACTION/verify.jsonl" });
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 1, ...seams });

    assert.equal(result.status, "extraction_blocked", "no structured verdict is never a green");
    // The map gate passed on each deterministic-green attempt (maxRetries:1 -> 2
    // attempts), but the missing verdict keeps it from ever reaching green.
    assert.equal(seams._calls.mapCalls.length, 2);
    assert.equal(result.verdict.faithful, false);
    assert.match(result.summary, /no_verdict|faithful:false/);
  });
});

describe("extractIssues — map-generation GATE (the live-run fragility this fix closes)", () => {
  // A scripted runGenerateMap seam: perCall[i] is the {code, output} returned on
  // the i-th map-gen call (the last entry repeats). This lets us simulate the
  // EXACT live-run failure: the extractor authors a corpus that passes the
  // deterministic checks AND would pass fidelity, but whose architecture-map.yml
  // the generator REJECTS (exit 1) — so the attempt must NOT be green.
  function scriptedMap(perCall) {
    const calls = [];
    const runGenerateMap = ({ repoRoot }) => {
      const result = perCall[Math.min(calls.length, perCall.length - 1)];
      calls.push({ repoRoot, result });
      return result;
    };
    return { runGenerateMap, calls };
  }

  const MAP_FAIL = {
    code: 1,
    output: "Error: Unsupported architecture-map.yml line:   - id: pipeline",
  };
  const MAP_OK = { code: 0, output: "generated" };

  it("map-gen failure is NOT green: extractor is re-prompted with the map error, next attempt's map parses -> green", async () => {
    seedInputs(temp);
    // BOTH attempts author a deterministically-VALID corpus AND the verifier always
    // says faithful:true — so the ONLY thing gating attempt 1 is the map generation.
    const { spawnExtractor, calls } = fakeAgent([
      (ctx) => writeValidCorpus(ctx.repoRoot),
      (ctx) => writeValidCorpus(ctx.repoRoot),
    ]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const { runGenerateMap, calls: mapCalls } = scriptedMap([MAP_FAIL, MAP_OK]);
    const seams = stubSeams({ runGenerateMap });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2, "attempt 1 (map fail) is not green; attempt 2 (map ok) is");
    assert.equal(calls.length, 2, "the EXTRACTOR (not the verifier) was re-prompted to fix the map");
    // The map gate ran on BOTH attempts (deterministic checks passed each time).
    assert.equal(mapCalls.length, 2, "map generation ran as a gate on each deterministic-green attempt");
    // The fix pass received the EXACT generator error verbatim.
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got feedback");
    assert.match(calls[1].checkOutput, /architecture-map generation/);
    assert.match(calls[1].checkOutput, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
    // The map failure short-circuits the verifier on attempt 1 (no point judging
    // fidelity of a corpus whose map cannot even be generated); it runs only on the
    // attempt whose map parses.
    assert.equal(verifyCalls.length, 1, "verifier runs only on the map-clean attempt");
    assert.equal(verifyCalls[0].attempt, 2);
    // The green result reflects the clean map and the new, non-contradictory summary.
    assert.equal(result.map.code, 0);
    assert.match(result.summary, /map regenerated/);
    assert.match(result.summary, /faithful:true/);
    // The contradictory "green with map FAILED" outcome no longer exists.
    assert.doesNotMatch(result.summary, /map FAILED/i);
  });

  it("GREEN requires deterministic + map + fidelity all clean (proven by withholding each one)", async () => {
    // Single source of the happy corpus; we flip exactly one gate per sub-case.
    async function run({ corpus, verdict, map }) {
      const root = mkdtempSync(join(tmpdir(), "vivicy-extract-gate-"));
      try {
        seedInputs(root);
        const { spawnExtractor } = fakeAgent([(ctx) => corpus(ctx.repoRoot)]);
        const { spawnVerifier } = fakeVerifier([verdict]);
        const { runGenerateMap } = scriptedMap([map]);
        const seams = stubSeams({ runGenerateMap });
        return await extractIssues({ repoRoot: root, spawnExtractor, spawnVerifier, maxRetries: 0, ...seams });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    // All three clean -> green.
    const allGreen = await run({ corpus: writeValidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_OK });
    assert.equal(allGreen.status, "green", "all three gates clean is green");

    // Deterministic red (pin mismatch) -> blocked, even with map ok + faithful.
    const detRed = await run({ corpus: writeInvalidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_OK });
    assert.equal(detRed.status, "extraction_blocked", "a deterministic failure is never green");

    // Map red -> blocked, even with deterministic green + faithful.
    const mapRed = await run({ corpus: writeValidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_FAIL });
    assert.equal(mapRed.status, "extraction_blocked", "a map-gen failure is never green");
    assert.match(mapRed.summary, /Unsupported architecture-map\.yml line/);

    // Fidelity red -> blocked, even with deterministic green + map ok.
    const fidRed = await run({ corpus: writeValidCorpus, verdict: { faithful: false, problems: [{ issue: "ISS-0001", kind: "scope_drift", detail: "broadens scope" }] }, map: MAP_OK });
    assert.equal(fidRed.status, "extraction_blocked", "a fidelity failure is never green");
  });

  it("blocks when the map STAYS unparseable through the bounded retries, and never reaches the verifier", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const { runGenerateMap, calls: mapCalls } = scriptedMap([MAP_FAIL]); // never recovers
    const seams = stubSeams({ runGenerateMap });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries");
    assert.equal(calls.length, 3, "the extractor was re-prompted on every map-fail attempt");
    assert.equal(mapCalls.length, 3, "the map gate ran on every deterministic-green attempt");
    assert.equal(verifyCalls.length, 0, "a failing map short-circuits the fidelity verifier every time");
    // The blocked report carries the EXACT map error so a human sees WHY.
    assert.match(result.summary, /extraction_blocked/);
    assert.match(result.summary, /architecture-map generation/);
    assert.match(result.summary, /Unsupported architecture-map\.yml line/);
    assert.equal(result.map.code, 1);
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
      manifest_path: ".vivicy/baselines/baseline-v1.0.0.json",
      manifest_hash: "x",
      document_set_hash: "y",
      source_corpus: [".vivicy/canonical/**/*.md"],
      verification_evidence_ref_grammar: "path",
      issues: [],
    };
    const writePlaceholder = (root) => {
      const p = resolve(root, ".vivicy/development/issue-index.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify(placeholder, null, 2)}\n`);
      const ex = resolve(root, ".vivicy/requirements/exclusions.json");
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

  it("a TIMED-OUT extractor leg is retried, then extraction_blocked with the timeout reason (never hangs)", async () => {
    seedInputs(temp);
    // The fake extractor mimics a leg that leg-timeout.mjs KILLED: it authors
    // nothing usable and carries a structured timeout result. A timed-out leg
    // therefore fails the (real) deterministic checks every time, so the loop
    // retries and finally blocks — it must NOT hang, and the block must name the
    // timeout. result.timedOut/timeoutReason are exactly what spawnLegSync returns.
    const calls = [];
    const spawnExtractor = async (ctx) => {
      calls.push(ctx);
      return {
        result: { status: 124, timedOut: true, timeoutReason: "leg timed out after 45 min (hard cap)" },
        output: "",
        transcriptRel: `.vivicy/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl`,
      };
    };
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries, then blocked");
    assert.equal(calls.length, 3, "the timed-out leg was retried, not awaited forever");
    assert.equal(verifyCalls.length, 0, "a timed-out extractor never reaches the fidelity verifier");
    assert.equal(result.timeoutReason, "leg timed out after 45 min (hard cap)");
    assert.match(result.summary, /A leg was killed: leg timed out after 45 min/);
  });
});

describe("findFrozenManifest", () => {
  it("returns the active frozen manifest and ignores a superseded one", () => {
    mkdirSync(resolve(temp, ".vivicy/baselines"), { recursive: true });
    writeFileSync(
      resolve(temp, ".vivicy/baselines/baseline-v0.9.0.json"),
      JSON.stringify({ baseline_id: "baseline-v0.9.0", status: "frozen", superseded: { by_baseline_id: "baseline-v1.0.0" } }),
    );
    writeFileSync(
      resolve(temp, ".vivicy/baselines/baseline-v1.0.0.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0", status: "frozen" }),
    );
    const found = findFrozenManifest(temp);
    assert.equal(found.baselineId, "baseline-v1.0.0");
  });

  it("returns null when only a draft baseline exists", () => {
    mkdirSync(resolve(temp, ".vivicy/baselines"), { recursive: true });
    writeFileSync(
      resolve(temp, ".vivicy/baselines/baseline-v1.0.0-draft.json"),
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

  it("is honest when there is neither check, map, nor verdict output", () => {
    assert.equal(formatFixContext(null, null), "(no check, map, or verdict output)");
    // A faithful:true verdict is not a problem to feed back.
    assert.equal(formatFixContext(null, { faithful: true, problems: [] }), "(no check, map, or verdict output)");
    // A code-0 map is not a problem to feed back.
    assert.equal(formatFixContext(null, null, { code: 0, output: "generated" }), "(no check, map, or verdict output)");
  });

  it("includes the map-generation error (and not a passing deterministic block) on a map-only failure", () => {
    const text = formatFixContext(
      // deterministic GREEN
      { semantic: { exitCode: 0, placeholder: false, summary: "ok" }, traceability: { exitCode: 0, summary: "ok" } },
      null,
      { code: 1, output: "Error: Unsupported architecture-map.yml line:   - id: pipeline" },
    );
    assert.match(text, /architecture-map generation/);
    assert.match(text, /FAILED \(exit 1\)/);
    assert.match(text, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
    // The passing deterministic checks are NOT re-fed as if they were the problem.
    assert.doesNotMatch(text, /semantic-extraction-check: ok/);
  });
});

describe("formatMapError", () => {
  it("returns null for a clean (code 0) map generation", () => {
    assert.equal(formatMapError({ code: 0, output: "generated" }), null);
    assert.equal(formatMapError(null), null);
  });

  it("flattens a failed map generation with its exact generator output", () => {
    const text = formatMapError({ code: 1, output: "Error: Unsupported architecture-map.yml line:   - id: pipeline" });
    assert.match(text, /generate-viewer-data\.ts.*FAILED \(exit 1\)/);
    assert.match(text, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
  });
});

describe("scaffold + fixture gitignore the COMPLETE never-commit set, and ONLY that", () => {
  // Everything Vivicy produces is committed (ledger, gates, reports, the
  // regenerated map data, source-map, coverage, catalog/matrix/index) — the ONLY
  // exclusions are transcripts, runtime, worktrees, and machine/OS noise. So
  // `git add -A` after every checkpoint is safe with zero human edits.
  const NEVER_COMMIT = ["node_modules/", ".DS_Store", ".vivicy-runtime/", ".vivicy-worktrees/", ".vivicy/development/transcripts/"];
  // These are Vivicy outputs the owner wants COMMITTED — they must NOT be ignored.
  const NOW_COMMITTED = [
    "architecture-data.json",
    "source-map.json",
    "coverage-report",
    ".vivicy/development/reports/extraction-status.json",
  ];

  it("the fixture .gitignore lists the complete never-commit set and none of the now-committed outputs", () => {
    const gi = readFileSync(resolve(FIXTURE, ".gitignore"), "utf8");
    for (const line of NEVER_COMMIT) assert.ok(gi.includes(line), `fixture .gitignore must ignore ${line}`);
    for (const out of NOW_COMMITTED) assert.ok(!gi.includes(out), `fixture .gitignore must NOT ignore ${out}`);
    // Gate evidence lives under reports/ — never ignore the whole directory.
    assert.doesNotMatch(gi, /^\.vivicy\/development\/reports\/?\s*$/m, "must not ignore the whole reports/ dir");
  });

  it("the scaffold gitignore() template emits the complete never-commit set and none of the now-committed outputs", () => {
    // Read the template source directly (no TS runtime needed): the gitignore()
    // string literal must carry exactly the never-commit set so freshly-scaffolded
    // projects can `git add -A` safely and commit every other Vivicy output.
    const scaffoldSrc = readFileSync(resolve(FACTORY_DIR, "../lib/scaffold.ts"), "utf8");
    for (const line of NEVER_COMMIT) assert.ok(scaffoldSrc.includes(line), `scaffold gitignore() must include ${line}`);
    for (const out of NOW_COMMITTED) {
      assert.ok(!scaffoldSrc.includes(`\n${out}`) && !scaffoldSrc.includes(`${out}\n`), `scaffold gitignore() must NOT ignore ${out}`);
    }
    assert.doesNotMatch(scaffoldSrc, /\n\s*\.vivicy\/development\/reports\/\s*\n/, "scaffold must not ignore the whole reports/ dir");
  });
});
