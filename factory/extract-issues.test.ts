import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";

import { extractIssues, findFrozenManifest, formatCheckOutput, formatFixContext, formatMapError, recordExtractedGateCommand, resolveFreezeVersion } from "./extract-issues.ts";
import { readSpikes } from "./spike-check.ts";

const FACTORY_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(FACTORY_DIR, "rehearsal/pocket-ledger");
const VERDICT_REL = ".vivicy/development/reports/extraction-fidelity-verdict.json";

const CORPUS_FILES = [
  ".vivicy/requirements/catalog.json",
  ".vivicy/requirements/traceability-matrix.json",
  ".vivicy/requirements/exclusions.json",
  ".vivicy/development/issue-index.json",
];
const CORPUS_DIRS = [".vivicy/development/issues"];
const INPUT_PATHS = [".vivicy/canonical", ".vivicy/baselines", "README.md", "package.json"];

interface ExtractorCtx {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  attempt: number;
  checkOutput: string | null;
  isFix: boolean;
  spikeMode: string;
  mapMode: string;
}
interface VerifierCtx {
  repoRoot: string;
  attempt: number;
}
interface LegStub {
  transcriptRel?: string;
  result?: { status?: number; timedOut?: boolean; timeoutReason?: string };
  output?: string;
}
type Verdict = { faithful: boolean; problems: unknown[] };
type MapGenResult = { code: number; output: string };
interface StatusRecord {
  phase: string;
  attempt?: number;
  spike_mode?: string;
  map_mode?: string;
  spike_proving?: { proved: number; failed: number; skipped: number };
  unverified_spike_gate_ids?: string[];
  summary?: string;
}
type CommitCtx = { repoRoot: string; baselineId: string };
type FreezeCtx = { repoRoot: string; version: string };

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vivicy-extract-test-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

function seedInputs(root: string) {
  for (const rel of INPUT_PATHS) {
    const src = resolve(FIXTURE, rel);
    if (existsSync(src)) cpSync(src, resolve(root, rel), { recursive: true });
  }
}

function copyCorpusPath(root: string, rel: string) {
  const src = resolve(FIXTURE, rel);
  const dest = resolve(root, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

function writeValidCorpus(root: string) {
  for (const rel of [...CORPUS_FILES, ...CORPUS_DIRS]) copyCorpusPath(root, rel);
}

function writeInvalidCorpus(root: string) {
  writeValidCorpus(root);
  const indexPath = resolve(root, ".vivicy/development/issue-index.json");
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  index.manifest_hash = "deadbeef".repeat(8);
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
}

function writeSpike(root: string, filename: string, reqId = "REQ-ARCH-001", status = "verified") {
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

function noopSpikeProving(root: string) {
  const proved = readSpikes(root)
    .filter((s) => s.status === "verified")
    .map((s) => ({ file: s.file, gate_id: s.gate_id, verdict: "verified" }));
  return async () => ({ proved, failed: [], skipped: [], changeRequests: [] });
}

function seedArchitectureMap(root: string) {
  const p = resolve(root, ".vivicy/architecture-map/architecture-map.yml");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, 'version: 1\nname: "Owner Map"\n');
}

function fakeAgent(perAttempt: Array<(ctx: ExtractorCtx) => void>) {
  const calls: ExtractorCtx[] = [];
  const spawnExtractor = async (ctx: ExtractorCtx): Promise<LegStub> => {
    calls.push(ctx);
    const action = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    action(ctx);
    return { transcriptRel: `.vivicy/development/transcripts/EXTRACTION/extract-${ctx.attempt}.jsonl` };
  };
  return { spawnExtractor, calls };
}

function writeVerdict(root: string, verdict: Verdict) {
  const p = resolve(root, VERDICT_REL);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(verdict, null, 2)}\n`);
}

function fakeVerifier(perAttempt: Verdict[]) {
  const calls: VerifierCtx[] = [];
  const spawnVerifier = async (ctx: VerifierCtx): Promise<LegStub> => {
    calls.push(ctx);
    const verdict = perAttempt[Math.min(ctx.attempt - 1, perAttempt.length - 1)];
    writeVerdict(ctx.repoRoot, verdict);
    return { transcriptRel: `.vivicy/development/transcripts/EXTRACTION/verify-${ctx.attempt}.jsonl` };
  };
  return { spawnVerifier, calls };
}

function alwaysFaithfulVerifier() {
  return fakeVerifier([{ faithful: true, problems: [] }]);
}

function stubSeams(extra: Record<string, unknown> = {}) {
  const mapCalls: string[] = [];
  const freezeCalls: FreezeCtx[] = [];
  const statusEvents: StatusRecord[] = [];
  const commitCalls: CommitCtx[] = [];
  return {
    runFreeze: async ({ repoRoot, version }: FreezeCtx) => {
      freezeCalls.push({ repoRoot, version });
      copyCorpusPath(repoRoot, ".vivicy/baselines");
      return { manifestPath: ".vivicy/baselines/baseline-v1.0.0.json", baselineId: "baseline-v1.0.0" };
    },
    runGenerateMap: ({ repoRoot }: { repoRoot: string }) => {
      mapCalls.push(repoRoot);
      const out = resolve(repoRoot, ".vivicy/architecture-map/architecture-data.json");
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, JSON.stringify({ development: { issues: [] } }, null, 2));
      return { code: 0, output: "generated" };
    },
    emitStatus: (status: StatusRecord) => statusEvents.push(status),
    commitCorpus: (ctx: CommitCtx) => {
      commitCalls.push(ctx);
      return { committed: true };
    },
    mapReview: async () => ({ findings: [], actionable: [], legs: [] }),
    runSpikeProving: async ({ repoRoot }: { repoRoot: string }) => ({
      proved: readSpikes(repoRoot).filter((s) => s.status === "verified").map((s) => ({ file: s.file, gate_id: s.gate_id, verdict: "verified" })),
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
    assert.equal(verifyCalls.length, 1, "verifier ran once on the deterministic-green corpus");
    assert.equal(verifyCalls[0].attempt, 1);
    assert.equal(result.checks!.semantic.exitCode, 0);
    assert.equal(result.checks!.traceability.exitCode, 0);
    assert.equal(result.checks!.semantic.placeholder, false);
    assert.equal(result.verdict!.faithful, true);
    assert.equal(seams._calls.mapCalls.length, 1);
    assert.deepEqual(result.transcripts, [
      ".vivicy/development/transcripts/EXTRACTION/extract-1.jsonl",
      ".vivicy/development/transcripts/EXTRACTION/verify-1.jsonl",
    ]);
    assert.match(result.summary, /8 issue\(s\)/);
    assert.match(result.summary, /faithful:true/);
    assert.equal(seams._calls.commitCalls.length, 1, "corpus committed exactly once on green");
    assert.equal(result.committed, true);
    assert.match(result.summary, /corpus committed/);
  });

  it("does NOT freeze when a frozen baseline already exists (reuses it)", async () => {
    seedInputs(temp);
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
    seedInputs(temp);
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
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

describe("extractIssues — S2 spike mode + S5 map mode", () => {
  it("INTEGRATE mode: pre-existing spikes pass through byte-for-byte, status says spike_mode integrate", async () => {
    seedInputs(temp);
    const s1 = writeSpike(temp, "01-provider-auth.md");
    const s2 = writeSpike(temp, "02-runtime-limits.md", "REQ-ARCH-002");
    const before1 = readFileSync(s1.path, "utf8");
    const before2 = readFileSync(s2.path, "utf8");

    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.spike_mode, "integrate");
    assert.equal(calls[0].spikeMode, "integrate", "the extractor leg is told to INTEGRATE");
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus!.spike_mode, "integrate", "extraction-status.json says spike_mode integrate");
    assert.equal(readFileSync(s1.path, "utf8"), before1, "spike 1 is byte-identical");
    assert.equal(readFileSync(s2.path, "utf8"), before2, "spike 2 is byte-identical");
  });

  it("EXTRACT mode: no spikes on disk -> status says spike_mode extract", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.spike_mode, "extract");
    assert.equal(calls[0].spikeMode, "extract", "the extractor leg is told to EXTRACT");
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus!.spike_mode, "extract", "extraction-status.json says spike_mode extract");
  });

  it("REUSED map mode: a pre-existing architecture-map.yml -> status says map_mode reused", async () => {
    seedInputs(temp);
    seedArchitectureMap(temp);

    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.map_mode, "reused", "a map existing pre-run is reused, not authored");
    assert.equal(calls[0].mapMode, "reused", "the extractor leg is told to REUSE the map");
    const greenStatus = seams._calls.statusEvents.find((e) => e.phase === "green");
    assert.equal(greenStatus!.map_mode, "reused", "extraction-status.json says map_mode reused");
  });

  it("AUTHORED map mode: no map on disk -> status says map_mode authored", async () => {
    seedInputs(temp);
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
    writeSpike(temp, "01-provider-auth.md");
    const { spawnExtractor } = fakeAgent([(ctx) => writeInvalidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 0, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.spike_mode, "integrate");
    assert.equal(result.map_mode, "authored");
    const blockedStatus = seams._calls.statusEvents.find((e) => e.phase === "extraction_blocked");
    assert.equal(blockedStatus!.spike_mode, "integrate", "the blocked extraction-status.json carries spike_mode");
    assert.equal(blockedStatus!.map_mode, "authored", "the blocked extraction-status.json carries map_mode");
  });
});

describe("extractIssues — S3 proving before freeze (order) + the spike-verification gate", () => {
  it("runs the S3 proving stage BEFORE the freeze (S3 precedes S4)", async () => {
    // Spike proving must run before the freeze — correcting canonical after freezing would force a re-freeze on every correction.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));

    const order: string[] = [];
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const base = stubSeams();
    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      runSpikeProving: async () => {
        order.push("prove");
        return { proved: [], failed: [], skipped: [], changeRequests: [] };
      },
      runFreeze: async (args: FreezeCtx) => {
        order.push("freeze");
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    assert.ok(order.length >= 2, "both the proving stage and the freeze ran");
    assert.equal(order[0], "prove", "spike proving is the first side effect");
    assert.ok(order.indexOf("prove") < order.indexOf("freeze"), "S3 proving runs strictly before the S4 freeze");
  });

  it("BLOCKS extraction when a non-deferred spike is not verified (loud, with the offending gate_ids)", async () => {
    seedInputs(temp);
    const s = writeSpike(temp, "01-provider-auth.md", "REQ-ARCH-001", "pending");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams({ runSpikeProving: async () => ({ proved: [], failed: [], skipped: [], changeRequests: [] }) });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "blocked_on_unverified_spikes", "extraction refuses on an unverified required spike");
    assert.deepEqual(result.unverified_spike_gate_ids, [s.gate_id], "the offending gate id is named");
    assert.equal(calls.length, 0, "the extractor leg never ran — extraction did not proceed");
    const blocked = seams._calls.statusEvents.find((e) => e.phase === "blocked_on_unverified_spikes");
    assert.ok(blocked, "a blocked_on_unverified_spikes status was emitted");
    assert.deepEqual(blocked!.unverified_spike_gate_ids, [s.gate_id]);
    assert.match(result.summary, /blocked_on_unverified_spikes/);
    assert.match(result.summary, new RegExp(s.gate_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("PROCEEDS to green when every required spike is verified", async () => {
    seedInputs(temp);
    writeSpike(temp, "01-provider-auth.md");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green", "a fully-verified spike corpus lets extraction proceed");
    assert.equal(calls.length, 1, "the extractor ran once");
    assert.deepEqual(result.spike_proving, { proved: 1, failed: 0, skipped: 0 }, "the proving summary rides on the status");
  });

  it("a DEFERRED spike does NOT block extraction (its dependents are gated in the dev loop)", async () => {
    seedInputs(temp);
    writeSpike(temp, "01-provider-auth.md", "REQ-ARCH-001", "deferred");
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const seams = stubSeams({ runSpikeProving: async () => ({ proved: [], failed: [], skipped: [], changeRequests: [] }) });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });

    assert.equal(result.status, "green", "a deferred spike does not block extraction");
    assert.equal(calls.length, 1);
  });
});

describe("extractIssues — mechanical corpus commit on green (Item 2, real git)", () => {
  it("commits the whole corpus on green and leaves a clean tree (only gitignored untracked)", async () => {
    seedInputs(temp);
    const git = (args: string[]) => spawnSync("git", args, { cwd: temp, encoding: "utf8" });
    git(["init", "-q"]);
    git(["config", "user.email", "t@local"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(
      resolve(temp, ".gitignore"),
      "node_modules/\n.DS_Store\n.vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n",
    );
    git(["add", "-A"]);
    git(["commit", "-qm", "inputs"]);

    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const { commitCorpus, ...seams } = stubSeams();
    void commitCorpus;
    const txAbs = resolve(temp, ".vivicy/development/transcripts/EXTRACTION/extract-1.jsonl");
    mkdirSync(dirname(txAbs), { recursive: true });
    writeFileSync(txAbs, "{}\n");

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...seams });
    assert.equal(result.status, "green");
    assert.equal(result.committed, true, "the orchestrator committed the corpus mechanically");

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
    assert.ok(!tracked.has(".vivicy/requirements/catalog.md"), "catalog.md must not exist");
    assert.ok(!tracked.has(".vivicy/requirements/traceability-matrix.md"), "traceability-matrix.md must not exist");
    for (const rel of tracked) {
      assert.ok(!rel.startsWith(".vivicy/development/transcripts/"), `transcript must not be committed: ${rel}`);
    }

    const porcelain = git(["status", "--porcelain"]).stdout.trim();
    assert.equal(porcelain, "", `tree must be clean after the mechanical commit, got:\n${porcelain}`);
  });
});

function git(root: string, args: string[]) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
function isClean(root: string) {
  return git(root, ["status", "--porcelain"]).stdout.trim() === "";
}
function initRepoWithCommit(root: string) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@local"]);
  git(root, ["config", "user.name", "t"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-qm", "initial"]);
}
function writeScaffoldGitignore(root: string) {
  writeFileSync(
    resolve(root, ".gitignore"),
    "node_modules/\n.DS_Store\n.vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n",
  );
}

describe("extractIssues — mechanical SPEC-SNAPSHOT commit before the freeze (no human git)", () => {
  it("commits the owner's uncommitted spec so the freeze sees a CLEAN committed tree", async () => {
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    git(temp, ["init", "-q"]);
    git(temp, ["config", "user.email", "t@local"]);
    git(temp, ["config", "user.name", "t"]);
    git(temp, ["config", "commit.gpgsign", "false"]);
    assert.equal(isClean(temp), false, "precondition: the spec is uncommitted (dirty tree)");

    let cleanAtFreeze = null;
    const base = stubSeams();
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      runFreeze: async (args: FreezeCtx) => {
        cleanAtFreeze = isClean(temp);
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    assert.equal(cleanAtFreeze, true, "the spec snapshot left a CLEAN committed tree before the freeze");
    const tracked = new Set(git(temp, ["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    assert.ok(tracked.has(".vivicy/canonical/01-architecture.md"), "the owner's spec is committed");
    const log = git(temp, ["log", "--format=%s"]).stdout;
    assert.match(log, /spec snapshot: commit canonical spec before freeze/);
  });

  it("makes NO redundant empty commit when the repo is already clean", async () => {
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
    const log = git(temp, ["log", "--format=%s"]).stdout;
    assert.ok(!/spec snapshot/.test(log), "no redundant empty spec-snapshot commit");
    const commitsAfter = git(temp, ["rev-list", "--count", "HEAD"]).stdout.trim();
    assert.equal(commitsAfter, commitsBefore, "commit count unchanged by the (no-op) snapshot");
  });

  it("inits a repo when the target is NOT a git repo, then commits the spec and freezes", async () => {
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
      runFreeze: async (args: FreezeCtx) => {
        cleanAtFreeze = isClean(temp);
        return base.runFreeze(args);
      },
    });

    assert.equal(result.status, "green");
    assert.equal(git(temp, ["rev-parse", "--is-inside-work-tree"]).status, 0, "target is now a git repo");
    assert.equal(git(temp, ["rev-parse", "HEAD"]).status, 0, "an initial commit exists (HEAD resolves)");
    assert.equal(cleanAtFreeze, true, "clean committed tree before the freeze");
  });

  it("auto-commits even when the fresh repo has NO git identity configured (sets a local one)", async () => {
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));
    writeScaffoldGitignore(temp);
    git(temp, ["init", "-q"]);
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
      assert.equal(git(temp, ["config", "user.email"]).stdout.trim(), "", "precondition: no identity configured");

      const base = stubSeams();
      const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
      const { spawnVerifier } = alwaysFaithfulVerifier();
      const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, ...base });

      assert.equal(result.status, "green");
      assert.equal(git(temp, ["rev-parse", "HEAD"]).status, 0, "a commit exists despite no global identity");
      assert.equal(git(temp, ["config", "user.email"]).stdout.trim(), "vivicy@local");
    } finally {
      const restore = (key: string, prev: string | undefined) => {
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

    const spawnExtractor = async (ctx: ExtractorCtx) => {
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
    const frozen = findFrozenManifest(temp);
    assert.ok(frozen, "a frozen baseline manifest exists after the real freeze");
    const tracked = new Set(git(temp, ["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean));
    assert.ok(tracked.has(".vivicy/canonical/01-architecture.md"), "the owner's spec is committed");
  });
});

describe("extractIssues — freeze-if-needed branch", () => {
  it("freezes via the injected freeze seam when no frozen baseline exists", async () => {
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
    // The freeze must be the first observable side effect — any status write before it would dirty the tree doc-baseline requires clean.
    cpSync(resolve(FIXTURE, ".vivicy/canonical"), resolve(temp, ".vivicy/canonical"), { recursive: true });
    cpSync(resolve(FIXTURE, "README.md"), resolve(temp, "README.md"));

    const order: string[] = [];
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier } = alwaysFaithfulVerifier();
    const base = stubSeams();

    const result = await extractIssues({
      repoRoot: temp,
      spawnExtractor,
      spawnVerifier,
      ...base,
      runFreeze: async (args: FreezeCtx) => {
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
    const firstStatusIdx = order.findIndex((e) => e.startsWith("status:"));
    const freezeIdx = order.indexOf("freeze");
    assert.ok(freezeIdx < firstStatusIdx, "every status emission happens strictly after the freeze");
    assert.ok(!order.includes("status:freezing"), "no pre-freeze 'freezing' status is emitted");
  });
});

describe("extractIssues — deterministic fix loop", () => {
  it("re-prompts with the exact check output when attempt 1 fails, then goes green on attempt 2", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([
      (ctx) => writeInvalidCorpus(ctx.repoRoot),
      (ctx) => writeValidCorpus(ctx.repoRoot),
    ]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2);
    assert.equal(calls.length, 2);
    assert.equal(verifyCalls.length, 1, "verifier only runs after deterministic checks pass");
    assert.equal(verifyCalls[0].attempt, 2);
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
    const { spawnExtractor, calls } = fakeAgent([
      (ctx) => writeValidCorpus(ctx.repoRoot),
      (ctx) => writeValidCorpus(ctx.repoRoot),
    ]);
    const { spawnVerifier, calls: verifyCalls } = fakeVerifier([
      {
        faithful: false,
        problems: [
          { issue: "ISS-0003", kind: "invented_requirement", detail: "ISS-0003 invents a rate-limit obligation the cited lines do not state." },
        ],
      },
      { faithful: true, problems: [] },
    ]);
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 3, ...seams });

    assert.equal(result.status, "green");
    assert.equal(result.attempts, 2);
    assert.equal(calls.length, 2, "the EXTRACTOR (not the verifier) was re-prompted to fix");
    assert.equal(verifyCalls.length, 2, "the verifier judged both deterministic-green attempts");
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got the fidelity verdict");
    assert.match(calls[1].checkOutput, /faithful:false/);
    assert.match(calls[1].checkOutput, /invented_requirement/);
    assert.match(calls[1].checkOutput, /ISS-0003/);
    assert.equal(result.verdict!.faithful, true);
    assert.equal(seams._calls.mapCalls.length, 2, "the map gate runs on each deterministic-green attempt, before fidelity");
  });

  it("blocks when fidelity STAYS false through the bounded retries", async () => {
    seedInputs(temp);
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
    assert.equal(seams._calls.mapCalls.length, 3, "the map gate runs on each deterministic-green attempt");
    assert.match(result.summary, /extraction_blocked/);
    assert.match(result.summary, /faithful:false/);
    assert.match(result.summary, /scope_drift/);
    assert.equal(result.verdict!.faithful, false);
  });

  it("treats a MISSING verdict (verifier wrote nothing) as not faithful, not green", async () => {
    seedInputs(temp);
    const { spawnExtractor } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const spawnVerifier = async () => ({ transcriptRel: ".vivicy/development/transcripts/EXTRACTION/verify.jsonl" });
    const seams = stubSeams();

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 1, ...seams });

    assert.equal(result.status, "extraction_blocked", "no structured verdict is never a green");
    assert.equal(seams._calls.mapCalls.length, 2);
    assert.equal(result.verdict!.faithful, false);
    assert.match(result.summary, /no_verdict|faithful:false/);
  });
});

describe("extractIssues — map-generation GATE (the live-run fragility this fix closes)", () => {
  function scriptedMap(perCall: MapGenResult[]) {
    const calls: Array<{ repoRoot: string; result: MapGenResult }> = [];
    const runGenerateMap = ({ repoRoot }: { repoRoot: string }) => {
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
    assert.equal(mapCalls.length, 2, "map generation ran as a gate on each deterministic-green attempt");
    assert.equal(calls[1].isFix, true);
    assert.ok(calls[1].checkOutput, "fix pass got feedback");
    assert.match(calls[1].checkOutput, /architecture-map generation/);
    assert.match(calls[1].checkOutput, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
    assert.equal(verifyCalls.length, 1, "verifier runs only on the map-clean attempt");
    assert.equal(verifyCalls[0].attempt, 2);
    assert.equal(result.map!.code, 0);
    assert.match(result.summary, /map regenerated/);
    assert.match(result.summary, /faithful:true/);
    assert.doesNotMatch(result.summary, /map FAILED/i);
  });

  it("GREEN requires deterministic + map + fidelity all clean (proven by withholding each one)", async () => {
    async function run({ corpus, verdict, map }: { corpus: (root: string) => void; verdict: Verdict; map: MapGenResult }) {
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

    const allGreen = await run({ corpus: writeValidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_OK });
    assert.equal(allGreen.status, "green", "all three gates clean is green");

    const detRed = await run({ corpus: writeInvalidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_OK });
    assert.equal(detRed.status, "extraction_blocked", "a deterministic failure is never green");

    const mapRed = await run({ corpus: writeValidCorpus, verdict: { faithful: true, problems: [] }, map: MAP_FAIL });
    assert.equal(mapRed.status, "extraction_blocked", "a map-gen failure is never green");
    assert.match(mapRed.summary, /Unsupported architecture-map\.yml line/);

    const fidRed = await run({ corpus: writeValidCorpus, verdict: { faithful: false, problems: [{ issue: "ISS-0001", kind: "scope_drift", detail: "broadens scope" }] }, map: MAP_OK });
    assert.equal(fidRed.status, "extraction_blocked", "a fidelity failure is never green");
  });

  it("blocks when the map STAYS unparseable through the bounded retries, and never reaches the verifier", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeValidCorpus(ctx.repoRoot)]);
    const { spawnVerifier, calls: verifyCalls } = alwaysFaithfulVerifier();
    const { runGenerateMap, calls: mapCalls } = scriptedMap([MAP_FAIL]);
    const seams = stubSeams({ runGenerateMap });

    const result = await extractIssues({ repoRoot: temp, spawnExtractor, spawnVerifier, maxRetries: 2, ...seams });

    assert.equal(result.status, "extraction_blocked");
    assert.equal(result.attempts, 3, "initial author + 2 fix retries");
    assert.equal(calls.length, 3, "the extractor was re-prompted on every map-fail attempt");
    assert.equal(mapCalls.length, 3, "the map gate ran on every deterministic-green attempt");
    assert.equal(verifyCalls.length, 0, "a failing map short-circuits the fidelity verifier every time");
    assert.match(result.summary, /extraction_blocked/);
    assert.match(result.summary, /architecture-map generation/);
    assert.match(result.summary, /Unsupported architecture-map\.yml line/);
    assert.equal(result.map!.code, 1);
  });
});

describe("extractIssues — bounded retries / blocked (deterministic)", () => {
  it("returns extraction_blocked after maxRetries+1 red attempts and never maps or verifies", async () => {
    seedInputs(temp);
    const { spawnExtractor, calls } = fakeAgent([(ctx) => writeInvalidCorpus(ctx.repoRoot)]);
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
    assert.ok(seams._calls.statusEvents.some((e) => e.phase === "extraction_blocked"));
  });

  it("treats an UNCHANGED placeholder index (agent authored nothing) as a failed attempt, not green", async () => {
    seedInputs(temp);
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
    const writePlaceholder = (root: string) => {
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
    // Mirrors leg-timeout.ts/spawnLegSync's return shape for a killed leg, so a real timeout is exercised faithfully.
    const calls = [];
    const spawnExtractor = async (ctx: ExtractorCtx) => {
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
    assert.equal(found!.baselineId, "baseline-v1.0.0");
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

describe("resolveFreezeVersion", () => {
  it("returns 1.0.0 on a virgin target (no baselines dir)", () => {
    assert.equal(resolveFreezeVersion(temp), "1.0.0");
  });

  it("minor-bumps the HIGHEST baseline version ever cut, whatever the statuses (superseded/draft included)", () => {
    mkdirSync(resolve(temp, ".vivicy/baselines"), { recursive: true });
    writeFileSync(
      resolve(temp, ".vivicy/baselines/baseline-v1.0.0.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen", superseded: { by_baseline_id: "baseline-v1.2.0" } }),
    );
    writeFileSync(
      resolve(temp, ".vivicy/baselines/baseline-v1.2.0-draft.json"),
      JSON.stringify({ baseline_id: "baseline-v1.2.0-draft", version: "1.2.0", status: "draft" }),
    );
    assert.equal(resolveFreezeVersion(temp), "1.3.0");
  });

  it("skips malformed manifest files (unparseable JSON, non-semver versions)", () => {
    mkdirSync(resolve(temp, ".vivicy/baselines"), { recursive: true });
    writeFileSync(resolve(temp, ".vivicy/baselines/broken.json"), "{ not json");
    writeFileSync(resolve(temp, ".vivicy/baselines/odd.json"), JSON.stringify({ version: "not-semver" }));
    assert.equal(resolveFreezeVersion(temp), "1.0.0", "all-malformed still yields the virgin default");
    writeFileSync(resolve(temp, ".vivicy/baselines/baseline-v1.1.0.json"), JSON.stringify({ version: "1.1.0", status: "frozen" }));
    assert.equal(resolveFreezeVersion(temp), "1.2.0", "the one well-formed version drives the bump");
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
      { semantic: { exitCode: 0, placeholder: false, summary: "ok" }, traceability: { exitCode: 0, summary: "ok" } },
      { faithful: false, problems: [{ issue: "ISS-0003", kind: "invented_requirement", detail: "no canonical basis" }] },
    );
    assert.match(text, /faithful:false/);
    assert.match(text, /invented_requirement/);
    assert.match(text, /ISS-0003/);
    assert.doesNotMatch(text, /semantic-extraction-check: ok/);
  });

  it("is honest when there is neither check, map, nor verdict output", () => {
    assert.equal(formatFixContext(null, null), "(no check, map, or verdict output)");
    assert.equal(formatFixContext(null, { faithful: true, problems: [] }), "(no check, map, or verdict output)");
    assert.equal(formatFixContext(null, null, { code: 0, output: "generated" }), "(no check, map, or verdict output)");
  });

  it("includes the map-generation error (and not a passing deterministic block) on a map-only failure", () => {
    const text = formatFixContext(
      { semantic: { exitCode: 0, placeholder: false, summary: "ok" }, traceability: { exitCode: 0, summary: "ok" } },
      null,
      { code: 1, output: "Error: Unsupported architecture-map.yml line:   - id: pipeline" },
    );
    assert.match(text, /architecture-map generation/);
    assert.match(text, /FAILED \(exit 1\)/);
    assert.match(text, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
    assert.doesNotMatch(text, /semantic-extraction-check: ok/);
  });
});

describe("formatMapError", () => {
  it("returns null for a clean (code 0) map generation", () => {
    assert.equal(formatMapError({ code: 0, output: "generated" }), null);
    assert.equal(formatMapError(null), null);
  });

  it("flattens a failed map generation with its exact generator output", () => {
    const text = formatMapError({ code: 1, output: "Error: Unsupported architecture-map.yml line:   - id: pipeline" })!;
    assert.match(text, /generate-viewer-data\.ts.*FAILED \(exit 1\)/);
    assert.match(text, /Unsupported architecture-map\.yml line:\s+- id: pipeline/);
  });
});

describe("scaffold + fixture gitignore the COMPLETE never-commit set, and ONLY that", () => {
  // NEVER_COMMIT is exhaustive — every other Vivicy output is committed, so `git add -A` after every checkpoint is safe.
  const NEVER_COMMIT = ["node_modules/", ".DS_Store", ".vivicy-runtime/", ".vivicy-worktrees/", ".vivicy/development/transcripts/"];
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
    assert.doesNotMatch(gi, /^\.vivicy\/development\/reports\/?\s*$/m, "must not ignore the whole reports/ dir");
  });

  it("the scaffold gitignore() template emits the complete never-commit set and none of the now-committed outputs", () => {
    const scaffoldSrc = readFileSync(resolve(FACTORY_DIR, "../lib/scaffold.ts"), "utf8");
    for (const line of NEVER_COMMIT) assert.ok(scaffoldSrc.includes(line), `scaffold gitignore() must include ${line}`);
    for (const out of NOW_COMMITTED) {
      assert.ok(!scaffoldSrc.includes(`\n${out}`) && !scaffoldSrc.includes(`${out}\n`), `scaffold gitignore() must NOT ignore ${out}`);
    }
    assert.doesNotMatch(scaffoldSrc, /\n\s*\.vivicy\/development\/reports\/\s*\n/, "scaffold must not ignore the whole reports/ dir");
  });
});

describe("recordExtractedGateCommand — machine-fills gateCommand from the extractor's structured output", () => {
  const GATE_REPORT_REL = ".vivicy/development/reports/extraction-gate-command.json";
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vivicy-extract-gate-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeReport = (payload: unknown) => {
    const abs = join(dir, GATE_REPORT_REL);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
  };
  const readGate = () => JSON.parse(readFileSync(join(dir, "vivicy.json"), "utf8")).gateCommand;

  it("fills the sentinel when the extractor stated a canonical command", () => {
    writeFileSync(join(dir, "vivicy.json"), JSON.stringify({ gateCommand: null, requiredSkills: ["a/b@c"] }));
    writeReport({ gateCommand: "go test ./..." });
    assert.equal(recordExtractedGateCommand(dir), true);
    assert.equal(readGate(), "go test ./...");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, "vivicy.json"), "utf8")).requiredSkills, ["a/b@c"]);
  });

  it("preserves the sentinel when the extractor stated nothing (no report)", () => {
    writeFileSync(join(dir, "vivicy.json"), JSON.stringify({ gateCommand: null }));
    assert.equal(recordExtractedGateCommand(dir), false);
    assert.equal(readGate(), null);
  });

  it("preserves the sentinel when the extractor explicitly stated null", () => {
    writeFileSync(join(dir, "vivicy.json"), JSON.stringify({ gateCommand: null }));
    writeReport({ gateCommand: null });
    assert.equal(recordExtractedGateCommand(dir), false);
    assert.equal(readGate(), null);
  });

  it("never overrides an already-established gate command", () => {
    writeFileSync(join(dir, "vivicy.json"), JSON.stringify({ gateCommand: "pytest -q" }));
    writeReport({ gateCommand: "go test ./..." });
    assert.equal(recordExtractedGateCommand(dir), false);
    assert.equal(readGate(), "pytest -q");
  });
});
