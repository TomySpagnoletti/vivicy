#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { issueTranscriptDir, TRANSCRIPT_DIRS } from "./agent-spawn.ts";
import { cleanupTree } from "./cleanup-tree.ts";
import { FACTORY_REHEARSAL_DIR } from "./target-root.ts";
import { isCanonicalFrozen, isSpecCycleOpen, SPEC_CYCLE_REL, writeSpecCycle } from "../lib/spec-cycle.ts";
import {
  ISSUES_DIR,
  parseDeclaredProofs,
  proofHomeRel,
  PROOFS_DIR,
  PROOF_RECIPE_FILE,
  readIssueBodyFromDisk,
  readProofsByIssue,
  type ProofStatus,
} from "../lib/proofs.ts";

const TRANSCRIPTS_DIR = ".vivicy/development/transcripts";

interface Stage {
  name: string;
  ok: boolean;
  detail: string;
}

interface ProcessedIssue {
  id: string;
  status: string;
}

interface LegIssue {
  id: string;
}

interface LegCfg {
  execRoot?: string;
}

interface RehearsalMap {
  nodes?: { id: string }[];
  edges?: { graph_ref?: string; from: string; to: string; relation?: string; protocol?: string }[];
  development?: {
    issues?: { id: string; graph_refs?: string[] }[];
    graph_item_states?: { status?: string }[];
  };
}

interface RehearsalLedger {
  graph_item_states?: { status?: string; transcript_refs?: unknown }[];
}

interface RehearsalIssueIndex {
  issues?: { id: string; depends_on?: string[] }[];
}

interface ReportContext {
  dry: boolean;
  temp: string;
  processed: ProcessedIssue[];
  verified: string[];
  blocked: string[];
  totalIssues: number;
  doneCount: number;
  verifiedStates: number;
  passingGates: number;
}

const factoryDir = dirname(fileURLToPath(import.meta.url));
const fixtureName = (process.argv.find((a) => a.startsWith("--fixture="))?.split("=")[1] || "pocket-ledger").replace(/[^a-z0-9-]/gi, "");
const fixtureDir = join(FACTORY_REHEARSAL_DIR, fixtureName);
const reportPath = join(FACTORY_REHEARSAL_DIR, "reports/method-rehearsal-report.md");
const BASELINE_ID = "baseline-v1.0.0";
const MANIFEST_REL = `.vivicy/baselines/${BASELINE_ID}.json`;
const factoryScript = (name: string): string => join(factoryDir, name);

const stages: Stage[] = [];
// A run that dies mid-stage keeps its workspace, exactly like a failed one — the crash report is where its path gets named.
let liveTempRepo: string | null = null;
function record(name: string, ok: boolean, detail = ""): void {
  stages.push({ name, ok, detail });
  process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function sh(args: string[], env?: { VIVICY_TARGET_ROOT?: string }): SpawnSyncReturns<string> {
  const cwd = env?.VIVICY_TARGET_ROOT ?? factoryDir;
  return spawnSync("node", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}
function lastLine(result: SpawnSyncReturns<string>): string {
  return (result.stdout || result.stderr || "").trim().split("\n").pop() ?? "";
}
function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}
// One prefix for every tree the rehearsal creates, so a leftover announced by cleanupTree is greppable in the OS temp dir.
function rehearsalTemp(scenario?: string): string {
  return mkdtempSync(join(tmpdir(), `vivicy-rehearsal-${scenario ? `${scenario}-` : ""}`));
}
// A fixture is a bundled target project; the marker file is what makes one, so the list never goes stale.
function availableFixtures(): string[] {
  return readdirSync(FACTORY_REHEARSAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(FACTORY_REHEARSAL_DIR, entry.name, "vivicy.json")))
    .map((entry) => entry.name)
    .sort();
}

// The fixtures ship gateCommand + runCommand as the `null` sentinel; the dry implementer establishes both on the stack-setup issue exactly as a real one would, exercising the machine-fill path.
const FIXTURE_GATE_COMMAND = "npm test";
const FIXTURE_RUN_COMMAND = "npm run dev";

function readCommandField(root: string, field: "gateCommand" | "runCommand"): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, "vivicy.json"), "utf8")) as Record<string, string | null>)[field] ?? null;
  } catch {
    return null;
  }
}

function fillCommandFieldIfSentinel(root: string, field: "gateCommand" | "runCommand", value: string): void {
  const abs = join(root, "vivicy.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return;
  }
  if (typeof config[field] === "string" && (config[field] as string).length > 0) return;
  config[field] = value;
  writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`);
}

function establishSentinelCommands(root: string): void {
  fillCommandFieldIfSentinel(root, "gateCommand", FIXTURE_GATE_COMMAND);
  fillCommandFieldIfSentinel(root, "runCommand", FIXTURE_RUN_COMMAND);
}

// The dry implementer withholds a declared proof on its FIRST attempt, so the rehearsal exercises the orchestrator's refusal AND its bounded remediation on the next one.
const implementerAttempts = new Map<string, number>();

function produceDeclaredProofs(temp: string, issue: LegIssue): void {
  const attempt = (implementerAttempts.get(issue.id) ?? 0) + 1;
  implementerAttempts.set(issue.id, attempt);
  if (attempt < 2) return;
  for (const proof of parseDeclaredProofs(readIssueBodyFromDisk(temp, issue.id)).proofs) {
    if (proof.class === "gate_evidence") continue;
    const home = join(temp, ...proofHomeRel(issue.id, proof.id).split("/"));
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "observed.log"), `dry-run capture for ${issue.id} (${proof.id}): the product ran and printed its result\n`);
    writeFileSync(join(home, PROOF_RECIPE_FILE), `node src/index.js report 2026-01\n`);
  }
}

// runIssueCycle (sequential) calls legs synchronously; runIssueCycleAsync (parallel) awaits them — dry legs must match or the sequential path breaks.
function dryImplementer(temp: string) {
  return (issue: LegIssue) => {
    establishSentinelCommands(temp);
    produceDeclaredProofs(temp, issue);
    return writeFakeTranscript(temp, issueTranscriptDir(issue.id), "claude-implementer");
  };
}
function dryReviewer(temp: string) {
  return (issue: LegIssue) => writeFakeTranscript(temp, issueTranscriptDir(issue.id), "codex-reviewer");
}
function dryImplementerParallel(temp: string) {
  return async (issue: LegIssue, cfg?: LegCfg) => {
    await delay(15);
    if (cfg?.execRoot) writeWorktreeMarker(cfg.execRoot, issue, "implementer");
    establishSentinelCommands(cfg?.execRoot ?? temp);
    // Proofs go to the MAIN root, never the worktree: the evidence home must survive the worktree's removal.
    produceDeclaredProofs(temp, issue);
    return writeFakeTranscript(temp, issueTranscriptDir(issue.id), "claude-implementer");
  };
}
function dryReviewerParallel(temp: string) {
  return async (issue: LegIssue, cfg?: LegCfg) => {
    await delay(15);
    if (cfg?.execRoot) writeWorktreeMarker(cfg.execRoot, issue, "reviewer");
    return writeFakeTranscript(temp, issueTranscriptDir(issue.id), "codex-reviewer");
  };
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
// Filename keyed by issue.id so parallel worktree branches never collide on merge.
function writeWorktreeMarker(execRoot: string, issue: LegIssue, who: string): void {
  const dir = join(execRoot, "src", "generated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${issue.id}.js`), `// ${who} produced ${issue.id}\nexport const ${issue.id.replace(/[^a-zA-Z0-9]/g, "_")} = true;\n`);
}
function writeFakeTranscript(temp: string, dir: string, who: string): { transcriptRel: string } {
  const rel = `${TRANSCRIPTS_DIR}/${dir}/${who}-dry.jsonl`;
  const abs = join(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ type: "assistant", message: { content: `dry ${who} in ${dir}` } })}\n`);
  return { transcriptRel: rel };
}

function parseConcurrency(): number {
  const arg = process.argv.find((a) => a.startsWith("--concurrency="));
  if (!arg) return 1;
  const n = Math.floor(Number(arg.split("=")[1]));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

async function main(): Promise<void> {
  const dry = process.argv.includes("--dry");
  const concurrency = parseConcurrency();
  const keep = process.env.REHEARSAL_KEEP === "1";
  const fixedDir = process.env.REHEARSAL_DIR ? resolve(process.env.REHEARSAL_DIR) : null;

  // Refused before a temp tree exists: a mistyped --fixture= must not leave an abandoned workspace behind.
  if (!existsSync(fixtureDir)) {
    process.stderr.write(`dev-rehearsal: no fixture "${fixtureName}" at ${fixtureDir} — available: ${availableFixtures().join(", ")}\n`);
    process.exit(1);
  }

  const git = (a: string[], cwd: string) => spawnSync("git", a, { cwd, encoding: "utf8" });
  let temp: string;
  if (fixedDir && existsSync(join(fixedDir, ".git"))) {
    temp = fixedDir;
    const done = existsSync(join(temp, ".vivicy/development/issues/done"))
      ? readdirSync(join(temp, ".vivicy/development/issues/done")).filter((f) => f.endsWith(".md")).length
      : 0;
    record("resume isolated temp repo", true, `${temp} (${done} issue(s) already done)`);
  } else {
    temp = fixedDir ?? rehearsalTemp();
    if (fixedDir) mkdirSync(fixedDir, { recursive: true });
    cpSync(fixtureDir, temp, { recursive: true });
    git(["init", "-q"], temp);
    git(["add", "-A"], temp);
    git(["-c", "user.email=rehearsal@local", "-c", "user.name=rehearsal", "commit", "-qm", "rehearsal fixture"], temp);
    record("materialize isolated temp repo", existsSync(join(temp, ".git")), temp);
  }
  liveTempRepo = temp;

  const env = { VIVICY_TARGET_ROOT: temp };

  let r = sh([factoryScript("doc-baseline.ts"), "verify", "--manifest", MANIFEST_REL, "--require-status", "frozen", "--require-baseline-id", BASELINE_ID], env);
  record("doc-baseline verify (frozen)", r.status === 0, lastLine(r));

  r = sh([factoryScript("semantic-extraction-check.ts")], env);
  const uncovered = /(\d+) UNCOVERED/.exec(r.stdout || "")?.[1];
  record("semantic-extraction:check (0 uncovered)", r.status === 0 && uncovered === "0", lastLine(r));

  r = sh([factoryScript("traceability-check.ts")], env);
  record("traceability:check", r.status === 0, lastLine(r));

  r = sh([factoryScript("generate-viewer-data.ts")], env);
  const preData = generatedData(temp);
  record("generate-viewer-data (pre-loop)", r.status === 0 && (preData?.development?.issues?.length ?? 0) > 0, `${preData?.development?.issues?.length ?? 0} issue(s)`);

  // git add -A is safe here only because .gitignore excludes transcripts/runtime/worktrees/node_modules.
  git(["add", "-A"], temp);
  git(["-c", "user.email=rehearsal@local", "-c", "user.name=rehearsal", "commit", "-qm", "extraction: author corpus + map"], temp);
  const corpusClean = (git(["status", "--porcelain"], temp).stdout || "").trim() === "";
  const mapCommittedPreLoop =
    git(["ls-files", ".vivicy/architecture-map/architecture-data.json"], temp).stdout.trim().length > 0;
  record("extraction corpus committed (map tracked, clean tree)", corpusClean && mapCommittedPreLoop, mapCommittedPreLoop ? "map tracked" : "map NOT tracked");

  const mapPathRel = ".vivicy/architecture-map/architecture-data.json";
  const staticMapBytesPreLoop = readFileSync(join(temp, mapPathRel));
  const staticMapPreLoop = JSON.parse(staticMapBytesPreLoop.toString("utf8")) as RehearsalMap;
  const staticBakedVerified = (staticMapPreLoop.development?.graph_item_states ?? []).filter(
    (s) => s.status === "verified",
  ).length;
  record(
    "static map is generated once with NO baked live progress (zero verified pre-loop)",
    staticBakedVerified === 0,
    `${staticBakedVerified} verified graph item(s) baked (must be 0)`,
  );

  process.env.VIVICY_TARGET_ROOT = temp;
  // Import AFTER setting VIVICY_TARGET_ROOT: dev-loop binds repoRoot at import time.
  const devloop = await import(pathToFileURL(factoryScript("dev-loop.ts")).href);
  const steps = dry
    ? concurrency > 1
      ? { runImplementer: dryImplementerParallel(temp), runReviewer: dryReviewerParallel(temp) }
      : { runImplementer: dryImplementer(temp), runReviewer: dryReviewer(temp) }
    : {};
  const preLoopGateCommand = readCommandField(temp, "gateCommand");
  const preLoopRunCommand = readCommandField(temp, "runCommand");
  let processed: ProcessedIssue[] = [];
  try {
    // No defaultGateCommand: exercises the real polyglot-gate resolution from the fixture's own vivicy.json.
    // readiness: false — dry legs don't implement a readiness leg; keeps the rehearsal deterministic.
    processed = await devloop.runLoop({ maxParallel: concurrency, readiness: false }, steps);
  } catch (error) {
    record("dev-loop two-agent run", false, String((error as Error)?.message ?? error));
  }
  const postLoopGateCommand = readCommandField(temp, "gateCommand");
  const postLoopRunCommand = readCommandField(temp, "runCommand");
  record(
    "machine-fill: gateCommand starts as the null sentinel, established by the stack-setup issue (never a human)",
    preLoopGateCommand === null && postLoopGateCommand === FIXTURE_GATE_COMMAND,
    `sentinel(${preLoopGateCommand === null ? "null" : String(preLoopGateCommand)}) -> ${String(postLoopGateCommand)}`,
  );
  record(
    "machine-fill: runCommand starts as the null sentinel, established by the stack-setup issue (canonical states none)",
    preLoopRunCommand === null && postLoopRunCommand === FIXTURE_RUN_COMMAND,
    `sentinel(${preLoopRunCommand === null ? "null" : String(preLoopRunCommand)}) -> ${String(postLoopRunCommand)}`,
  );
  if (concurrency > 1) {
    const order = processed.map((p) => p.id);
    const doneOnce = new Set(order).size === order.length;
    const worktreesLeft = existsSync(join(temp, ".vivicy-worktrees"))
      ? readdirSync(join(temp, ".vivicy-worktrees")).filter((f) => !f.startsWith(".")).length
      : 0;
    record(`parallel (N=${concurrency}): every issue settled exactly once`, doneOnce && order.length > 0, `${order.length} settled: ${order.join(", ")}`);
    record(`parallel (N=${concurrency}): no leftover worktrees`, worktreesLeft === 0, `${worktreesLeft} worktree dir(s) remain`);
    record(
      `parallel (N=${concurrency}): dependency order respected on the integration branch`,
      dependencyOrderRespected(temp),
      gitLogOrderDetail(temp),
    );
  }
  const verified = processed.filter((p) => p.status === "verified").map((p) => p.id);
  const blocked = processed.filter((p) => p.status === "blocked").map((p) => p.id);
  const totalIssues = preData?.development?.issues?.length ?? 0;
  // doneCount counts done/ (not processed.length): a resumed run only processes the unfinished remainder.
  const doneDir = join(temp, ".vivicy/development/issues/done");
  const doneCount = existsSync(doneDir) ? readdirSync(doneDir).filter((f) => f.endsWith(".md")).length : 0;
  record(
    `dev-loop ${dry ? "(dry agents)" : "two-agent"} run`,
    doneCount === totalIssues && blocked.length === 0,
    `${doneCount}/${totalIssues} done (this run +${verified.length}${blocked.length ? `, blocked ${blocked.join(",")}` : ""})`,
  );

  if (!existsSync(join(temp, ".vivicy/development/progress-ledger.json"))) {
    record("temp workspace survived the run", false, "workspace vanished mid-run — re-run with no concurrent process touching the OS temp dir");
    writeReport({ dry, temp, processed, verified, blocked, totalIssues, doneCount: 0, verifiedStates: 0, passingGates: 0 });
    process.stdout.write("\nREHEARSAL FAILED (workspace vanished)\n");
    process.exit(1);
  }

  record("issues moved to done/", doneCount === totalIssues, `${doneCount}/${totalIssues} in done/`);

  const ledger = readJson<RehearsalLedger>(join(temp, ".vivicy/development/progress-ledger.json"));
  const verifiedStates = (ledger.graph_item_states ?? []).filter((s) => s.status === "verified");
  const withTranscripts = verifiedStates.filter((s) => Array.isArray(s.transcript_refs) && s.transcript_refs.length > 0);
  record("ledger: graph items verified with transcript refs", verifiedStates.length > 0 && withTranscripts.length === verifiedStates.length, `${verifiedStates.length} verified, ${withTranscripts.length} with transcripts`);

  const gatesDir = join(temp, ".vivicy/development/gates");
  const gateRecords = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".json")) : [];
  const passingGates = gateRecords.filter((f) => readJson<{ status?: string }>(join(gatesDir, f)).status === "pass").length;
  record("gate-run evidence records (pass)", passingGates === totalIssues, `${passingGates}/${totalIssues} passing`);

  const declaredProofs: Array<{ issue: string; proof: ProofStatus }> = readProofsByIssue(temp).flatMap((entry) =>
    entry.proofs.map((proof) => ({ issue: entry.issue_id, proof })),
  );
  const unproduced = declaredProofs.filter(({ proof }) => !proof.produced);
  record(
    "proofs: every declared proof is an observation on disk with its replayable recipe",
    declaredProofs.length > 0 && unproduced.length === 0,
    `${declaredProofs.length - unproduced.length}/${declaredProofs.length} produced${unproduced.length ? ` (missing: ${unproduced.map((p) => `${p.issue}:${p.proof.id}`).join(", ")})` : ""}`,
  );
  const artifactProofs = declaredProofs.filter(({ proof }) => proof.class !== "gate_evidence");
  const proofsRoot = join(temp, ...PROOFS_DIR.split("/"));
  const proofDirs = existsSync(proofsRoot) ? readdirSync(proofsRoot).filter((f) => !f.startsWith(".")) : [];
  record(
    "proofs: proportional by class — only the artifact-bearing classes get a directory, a pure-logic obligation rides its own green gate record",
    proofDirs.length === new Set(artifactProofs.map((p) => p.issue)).size,
    `${artifactProofs.length} artifact proof(s) in ${proofDirs.length} issue dir(s); ${declaredProofs.length - artifactProofs.length} gate-witnessed, zero ritual artifacts`,
  );
  // No vacuous PASS: a fixture whose every obligation is gate-witnessed cannot exercise the withhold-then-produce path, so the stage is not recorded at all rather than reported green.
  if (artifactProofs.length > 0) {
    const refused = [...implementerAttempts.entries()].filter(([, attempts]) => attempts > 1).map(([id]) => id);
    record(
      "proofs: the close is REFUSED while a declared proof is missing, then granted once the real run produced it (bounded remediation, never a silent pass)",
      refused.length > 0 && artifactProofs.every(({ issue }) => refused.includes(issue)),
      `withheld once then produced: ${refused.join(", ") || "(none — the refusal path never fired)"}`,
    );
  }

  const staticMapBytesPostLoop = readFileSync(join(temp, mapPathRel));
  const mapByteUnchanged = staticMapBytesPreLoop.equals(staticMapBytesPostLoop);
  record(
    "map file is BYTE-UNCHANGED across the dev-loop (no per-issue regeneration)",
    mapByteUnchanged,
    mapByteUnchanged ? "identical bytes pre/post loop" : "map bytes CHANGED during the loop (regen leaked)",
  );
  const projected = await projectLedgerOntoMap(temp);
  const projectedVerified = (projected?.development?.graph_item_states ?? []).filter((s) => s.status === "verified").length;
  record(
    "read-time overlay projects the live ledger -> verified progress (no regen)",
    projectedVerified > 0,
    `${projectedVerified} verified graph item(s) projected from the live ledger`,
  );

  const tracked = new Set(
    (git(["ls-files"], temp).stdout || "").split("\n").map((s) => s.trim()).filter(Boolean),
  );
  const mapTracked = tracked.has(mapPathRel);
  const ledgerFromHead = readJsonFromHead(temp, ".vivicy/development/progress-ledger.json");
  const committedVerified = mapTracked
    ? (await projectLedgerOntoMap(temp, readMapFromHead(temp), ledgerFromHead))?.development?.graph_item_states?.filter(
        (s) => s.status === "verified",
      ).length ?? 0
    : 0;
  record(
    "closure: static map committed AND committed ledger projects to issues done (live overlay)",
    mapTracked && committedVerified > 0,
    `committed ledger projects ${committedVerified} verified graph item(s) onto the static map`,
  );
  const ledgerTracked = tracked.has(".vivicy/development/progress-ledger.json");
  const gatesTracked = [...tracked].some((p) => p.startsWith(".vivicy/development/gates/") && p.endsWith(".json"));
  record("closure: ledger + gate evidence committed", ledgerTracked && gatesTracked, `ledger ${ledgerTracked}, gates ${gatesTracked}`);
  const transcriptsCommitted = [...tracked].filter((p) => p.startsWith(`${TRANSCRIPTS_DIR}/`));
  const transcriptsOnDisk = existsSync(join(temp, TRANSCRIPTS_DIR));
  record(
    "closure: transcripts produced but NEVER committed (gitignored)",
    transcriptsOnDisk && transcriptsCommitted.length === 0,
    `${transcriptsCommitted.length} transcript(s) committed (must be 0); on disk: ${transcriptsOnDisk}`,
  );
  // Read both halves back out of git HEAD, never the working tree: the claim is that what makes a proof replayable survives in history.
  const trackedUnderProofs = [...tracked].filter((p) => p.startsWith(`${PROOFS_DIR}/`));
  const committedArtifacts = trackedUnderProofs.filter((p) => !p.endsWith(`/${PROOF_RECIPE_FILE}`));
  const recipesInHead = artifactProofs.filter(
    ({ issue, proof }) => (gitShow(temp, `${proofHomeRel(issue, proof.id)}/${PROOF_RECIPE_FILE}`) ?? "").trim().length > 0,
  ).length;
  const declaredFromHead = new Map<string, number>();
  for (const { issue } of declaredProofs) {
    if (declaredFromHead.has(issue)) continue;
    declaredFromHead.set(issue, parseDeclaredProofs(gitShow(temp, `${ISSUES_DIR}/done/${issue}.md`)).proofs.length);
  }
  const declaredInHead = [...declaredFromHead.values()].reduce((total, count) => total + count, 0);
  record(
    "closure: every DECLARATION and every proof RECIPE is readable from git HEAD (replayable by anyone) while the artifacts themselves stay out of history",
    committedArtifacts.length === 0 && declaredInHead === declaredProofs.length && recipesInHead === artifactProofs.length,
    `${committedArtifacts.length} artifact(s) committed (must be 0); ${declaredInHead}/${declaredProofs.length} declaration(s) and ${recipesInHead}/${artifactProofs.length} recipe(s) readable from git HEAD`,
  );
  const porcelain = (git(["status", "--porcelain"], temp).stdout || "").trim();
  record("closure: clean tree (only gitignored untracked)", porcelain === "", porcelain ? `dirty:\n${porcelain}` : "clean");

  await runFeatureCycleStages(temp);
  await runDocPrepScenario();
  await runCycleBatchScenarios();
  await runAcceptanceScenarios();
  await runRetroScenarios();
  await runRunCommandExtractorScenario();

  writeReport({ dry, temp, processed, verified, blocked, totalIssues, doneCount, verifiedStates: verifiedStates.length, passingGates });
  record("write method-rehearsal-report.md", existsSync(reportPath), reportPath);

  const allPass = stages.every((s) => s.ok);
  process.stdout.write(`\n${allPass ? "REHEARSAL PASSED" : "REHEARSAL FAILED"} (${stages.filter((s) => s.ok).length}/${stages.length} stages)\n`);
  if (keep || !allPass || fixedDir) {
    process.stdout.write(`temp repo kept${fixedDir ? " (pinned)" : ""}: ${temp}\n`);
  } else {
    cleanupTree(temp);
  }
  process.exit(allPass ? 0 : 1);
}

function generatedData(temp: string): RehearsalMap | null {
  const path = join(temp, ".vivicy/architecture-map/architecture-data.json");
  return existsSync(path) ? readJson<RehearsalMap>(path) : null;
}

function readMapFromHead(temp: string): RehearsalMap | null {
  const r = spawnSync("git", ["show", "HEAD:.vivicy/architecture-map/architecture-data.json"], {
    cwd: temp,
    encoding: "utf8",
  });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout) as RehearsalMap;
  } catch {
    return null;
  }
}

function gitShow(temp: string, relPath: string): string | null {
  const r = spawnSync("git", ["show", `HEAD:${relPath}`], { cwd: temp, encoding: "utf8" });
  return r.status === 0 ? r.stdout : null;
}

function readJsonFromHead(temp: string, relPath: string): unknown {
  const r = spawnSync("git", ["show", `HEAD:${relPath}`], { cwd: temp, encoding: "utf8" });
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

// Mirrors the /api/map route's read-time overlay logic — keep in sync if that route changes.
async function projectLedgerOntoMap(
  temp: string,
  staticMap?: RehearsalMap | null,
  ledger?: unknown,
): Promise<RehearsalMap | null> {
  const map = staticMap ?? (existsSync(join(temp, ".vivicy/architecture-map/architecture-data.json"))
    ? readJson<RehearsalMap>(join(temp, ".vivicy/architecture-map/architecture-data.json"))
    : null);
  if (!map) return null;
  const ledgerData =
    ledger !== undefined
      ? ledger
      : existsSync(join(temp, ".vivicy/development/progress-ledger.json"))
        ? readJson(join(temp, ".vivicy/development/progress-ledger.json"))
        : undefined;
  const { deriveDevelopmentOverlay, nodeGraphRef, edgeGraphRef } = await import(
    pathToFileURL(join(factoryDir, "../lib/development-overlay.ts")).href
  );
  const graphRefs = new Set<string>();
  for (const node of map.nodes ?? []) graphRefs.add(nodeGraphRef(node.id));
  for (const edge of map.edges ?? []) graphRefs.add(edgeGraphRef(edge));
  const issues = (map.development?.issues ?? []).map((issue) => ({
    id: issue.id,
    graph_refs: issue.graph_refs ?? [],
  }));
  const overlay = deriveDevelopmentOverlay({
    graphRefs,
    issues,
    ledger: ledgerData,
    verificationGateMatcher: /.*/,
  });
  return { ...map, development: { ...(map.development ?? {}), ...overlay } };
}

function integrationCommitOrder(temp: string): string[] {
  const r = spawnSync("git", ["log", "--format=%s"], { cwd: temp, encoding: "utf8" });
  return (r.stdout || "").split("\n").map((s) => s.trim()).filter(Boolean);
}
function gitLogOrderDetail(temp: string): string {
  const subjects = integrationCommitOrder(temp);
  const issueLines = subjects.filter((s) => /ISSUE-\d+/.test(s)).slice(0, 6);
  return issueLines.join(" | ") || "(no issue commits)";
}
// git log is newest-first: a dependency must appear at a LARGER index (older) than the issue depending on it.
function dependencyOrderRespected(temp: string): boolean {
  const index = readJson<RehearsalIssueIndex>(join(temp, ".vivicy/development/issue-index.json"));
  const issues = Array.isArray(index.issues) ? index.issues : [];
  const subjects = integrationCommitOrder(temp);
  const posById = new Map<string, number>();
  subjects.forEach((subject, i) => {
    const m = subject.match(/ISSUE-\d+/);
    if (m && !posById.has(m[0])) posById.set(m[0], i);
  });
  for (const issue of issues) {
    const here = posById.get(issue.id);
    if (here === undefined) continue;
    for (const dep of issue.depends_on ?? []) {
      const depPos = posById.get(dep);
      if (depPos === undefined) return false;
      if (depPos <= here) return false;
    }
  }
  return true;
}

interface CycleExtractionResult {
  status: string;
  manifestPath: string;
  baselineId: string;
  committed?: boolean;
  summary: string;
}

interface CycleManifest {
  version?: string;
  approval?: { approval_ref?: string };
  superseded?: { by_baseline_id?: string };
}

interface CycleIssueEntry {
  id: string;
  title: string;
  summary: string;
  issue_path: string;
  requirement_ids: string[];
  source_line_refs: string[];
  depends_on: string[];
  spike_gates: string[];
  graph_refs: string[];
  verification_gate_ids: string[];
}
interface CycleIssueIndex {
  baseline_id: string;
  baseline_version: string;
  manifest_path: string;
  manifest_hash: string;
  document_set_hash: string;
  issues: CycleIssueEntry[];
}

// The FIRST workflow stage on a fresh mixed import batch: a clean canonical doc is placed untouched, a messy non-dominant doc is exploded/translated through the (faked) leg into canonical form, uploads stay immutable.
async function runDocPrepScenario(): Promise<void> {
  const prep = rehearsalTemp("prep");
  try {
    const batchId = "2026-07-05T08-00-00-000Z";
    const batchDir = join(prep, ".vivicy/uploads", batchId);
    mkdirSync(join(batchDir, "canonical"), { recursive: true });
    const cleanDoc = "# Catalog\n\nThe product lets a user manage a catalog of items with search and pagination across the whole dataset.\n";
    const messyDoc = "Le produit permet à un utilisateur de gérer un catalogue d'articles avec recherche et pagination sur tout le jeu de données.";
    writeFileSync(join(batchDir, "canonical", "spec.md"), cleanDoc);
    writeFileSync(join(batchDir, "cahier.txt"), messyDoc);
    writeFileSync(
      join(batchDir, "manifest.json"),
      JSON.stringify(
        {
          batchId,
          createdAt: new Date().toISOString(),
          language: "eng",
          files: [
            { path: "cahier.txt", size: messyDoc.length, sha256: "x" },
            { path: "canonical/spec.md", size: cleanDoc.length, sha256: "y" },
          ],
        },
        null,
        2,
      ),
    );

    const prepMod = await import(pathToFileURL(factoryScript("prepare-docs.ts")).href);
    let legLanguage = "";
    const report = await prepMod.prepareDocs({
      repoRoot: prep,
      spawnLeg: async ({ inputDir, outputDir, language }: { inputDir: string; outputDir: string; language: string }) => {
        legLanguage = language;
        void inputDir;
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "produit.md"), "# Product\n\nExploded and translated canonical document.\n");
      },
    });

    const cleanPlaced = existsSync(join(prep, ".vivicy/canonical/spec.md"));
    const explodedPlaced = existsSync(join(prep, ".vivicy/canonical/produit.md"));
    const uploadsImmutable =
      readFileSync(join(batchDir, "canonical", "spec.md"), "utf8") === cleanDoc &&
      readFileSync(join(batchDir, "cahier.txt"), "utf8") === messyDoc;
    const scratchGone = !existsSync(join(prep, ".vivicy/development/reports/doc-prep-scratch"));
    record(
      "doc-prep (first stage): mixed batch prepared — clean canonical placed, messy doc exploded/translated via the leg, uploads immutable, scratch cleaned",
      report?.phase === "green" && legLanguage === "eng" && cleanPlaced && explodedPlaced && uploadsImmutable && scratchGone,
      `phase ${report?.phase ?? "?"}; leg lang ${legLanguage}; placed clean=${cleanPlaced} exploded=${explodedPlaced}; uploads immutable=${uploadsImmutable}`,
    );
  } finally {
    cleanupTree(prep);
  }
}

type RehearsalCycle = { binding: "active"; id: string } | { binding: "seed" };

function writeUploadBatch(root: string, id: string, files: Record<string, string>, language: string, cycle: RehearsalCycle): void {
  const batchDir = join(root, ".vivicy/uploads", id);
  const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(batchDir, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    manifestFiles.push({ path: rel, size: content.length, sha256: "x" });
  }
  mkdirSync(batchDir, { recursive: true });
  writeFileSync(join(batchDir, "manifest.json"), JSON.stringify({ batchId: id, createdAt: new Date().toISOString(), language, cycle, files: manifestFiles }, null, 2));
}

function writeFrozenBaselineFixture(root: string): void {
  const dir = join(root, ".vivicy/baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "baseline-v1.0.0.json"), JSON.stringify({ status: "frozen", baseline_id: "baseline-v1.0.0" }, null, 2));
}

// Batch↔cycle law: an active-cycle prep consumes ALL its unconsumed batches at once; a post-freeze import seeds the NEXT cycle and is never folded into the frozen corpus.
async function runCycleBatchScenarios(): Promise<void> {
  const prepMod = await import(pathToFileURL(factoryScript("prepare-docs.ts")).href);
  const EN = "The product lets a user manage a catalog of items with search and pagination across the whole dataset.";

  const progressive = rehearsalTemp("progressive");
  try {
    writeUploadBatch(progressive, "2026-07-05T09-00-00-000Z", { "canonical/one.md": `# One\n\n${EN}` }, "eng", { binding: "active", id: "project" });
    writeUploadBatch(progressive, "2026-07-05T09-05-00-000Z", { "canonical/two.md": `# Two\n\n${EN}` }, "eng", { binding: "active", id: "project" });
    const report = await prepMod.prepareDocs({ repoRoot: progressive });
    const bothConsumed = Array.isArray(report?.batches_consumed) && report.batches_consumed.length === 2;
    const bothPlaced = existsSync(join(progressive, ".vivicy/canonical/one.md")) && existsSync(join(progressive, ".vivicy/canonical/two.md"));
    record(
      "batch↔cycle: two progressively-imported batches of the active cycle are consumed together in one prep run",
      report?.phase === "green" && bothConsumed && bothPlaced && (report.batches_pending?.length ?? -1) === 0,
      `phase ${report?.phase ?? "?"}; consumed ${report?.batches_consumed?.join(",") ?? "?"}`,
    );
  } finally {
    cleanupTree(progressive);
  }

  const seed = rehearsalTemp("seed");
  try {
    writeFrozenBaselineFixture(seed);
    writeUploadBatch(seed, "2026-07-05T10-00-00-000Z", { "canonical/next.md": `# Next\n\n${EN}` }, "eng", { binding: "seed" });
    const whileFrozen = await prepMod.prepareDocs({ repoRoot: seed });
    record(
      "batch↔cycle: a post-freeze import seeds the next cycle — deferred, never folded into the frozen corpus",
      whileFrozen?.phase === "skipped" && whileFrozen?.cycle_id === null && !existsSync(join(seed, ".vivicy/canonical/next.md")),
      `phase ${whileFrozen?.phase ?? "?"}; cycle ${String(whileFrozen?.cycle_id)}`,
    );
    writeSpecCycle(seed, { status: "drafting", kind: "feature", id: "cycle-2026-rehearsal-next", opened_at: new Date().toISOString(), opened_by: "owner:dev-rehearsal" });
    const afterOpen = await prepMod.prepareDocs({ repoRoot: seed });
    const claimed =
      afterOpen?.phase === "green" &&
      Array.isArray(afterOpen?.batches_consumed) &&
      afterOpen.batches_consumed.includes("2026-07-05T10-00-00-000Z") &&
      existsSync(join(seed, ".vivicy/canonical/next.md"));
    record(
      "batch↔cycle: the seed batch becomes unconsumed-active and is prepared once its cycle opens",
      claimed,
      `phase ${afterOpen?.phase ?? "?"}; consumed ${afterOpen?.batches_consumed?.join(",") ?? "?"}`,
    );
  } finally {
    cleanupTree(seed);
  }
}

// The final stage before Done: at done==total the whole-product acceptance leg re-checks the assembled product against the frozen spec. A clean verdict flips Done; a planted cross-issue defect is found, routed to a draft CR, and Done is withheld. Both scenarios run in isolated fixtures with a faked leg (the gate/chain/CR machinery is real).
function writeAcceptanceFixture(root: string): void {
  const write = (rel: string, content: string): void => {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write(".vivicy/development/issue-index.json", JSON.stringify({ issues: [{ id: "ISSUE-0001" }, { id: "ISSUE-0002" }] }, null, 2));
  write(".vivicy/development/issues/done/ISSUE-0001.md", "# ISSUE-0001\n");
  write(".vivicy/development/issues/done/ISSUE-0002.md", "# ISSUE-0002\n");
  write(".vivicy/baselines/baseline-v1.0.0.json", JSON.stringify({ schema_version: 1, baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen", files: [] }, null, 2));
}

async function runAcceptanceScenarios(): Promise<void> {
  const acc = await import(pathToFileURL(factoryScript("acceptance.ts")).href);

  const clean = rehearsalTemp("accept-clean");
  try {
    writeAcceptanceFixture(clean);
    const report = await acc.runAcceptance({
      repoRoot: clean,
      spawnLeg: async ({ repoRoot, verdictRel }: { repoRoot: string; verdictRel: string }) => {
        const abs = join(repoRoot, verdictRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ accepted: true, scenarios: [{ id: "end-to-end", verification: "read_only", result: "unverifiable_without_run_story" }], findings: [] }));
      },
    });
    const noCrs = !existsSync(join(clean, ".vivicy/change-requests")) || readdirSync(join(clean, ".vivicy/change-requests")).filter((f) => f.endsWith(".md")).length === 0;
    record(
      "acceptance (clean): whole-product pass green over the assembled build — Done flips, no CR drafted",
      report?.phase === "green" && (report.drafted_crs?.length ?? -1) === 0 && noCrs && report.read_only_scenarios === 1,
      `phase ${report?.phase ?? "?"}; ${report?.read_only_scenarios ?? "?"} read-only-verified scenario(s) (run-story seam)`,
    );
  } finally {
    cleanupTree(clean);
  }

  const defect = rehearsalTemp("accept-defect");
  try {
    writeAcceptanceFixture(defect);
    const report = await acc.runAcceptance({
      repoRoot: defect,
      spawnLeg: async ({ repoRoot, verdictRel }: { repoRoot: string; verdictRel: string }) => {
        const abs = join(repoRoot, verdictRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({
          accepted: false,
          scenarios: [{ id: "checkout-end-to-end", verification: "executed", result: "fail" }],
          findings: [{ obligation: ".vivicy/canonical/04-checkout.md:20 (REQ-0012)", gap: "the ISSUE-0001/ISSUE-0002 seam drops the tax line, so the checkout total is not tax-inclusive end to end", title: "Checkout total must be tax-inclusive end to end", classification: "minor_product_change", verification: "executed" }],
        }));
      },
    });
    const crs = existsSync(join(defect, ".vivicy/change-requests")) ? readdirSync(join(defect, ".vivicy/change-requests")).filter((f) => /^CR-\d{4}-.*\.md$/.test(f)) : [];
    const crId = crs[0]?.match(/^CR-\d{4}/)?.[0];
    record(
      "acceptance (planted cross-issue defect): gap found, routed to a draft CR via change-control, Done WITHHELD",
      report?.phase === "findings" && crs.length === 1 && report.drafted_crs?.[0] === crId && report.phase !== "green",
      `phase ${report?.phase ?? "?"}; drafted ${report?.drafted_crs?.join(",") ?? "none"}`,
    );
  } finally {
    cleanupTree(defect);
  }
}

// Observability-class stage running after acceptance green: isolated fixtures with a faked leg (the ≥2-occurrence floor, landing coercion, report write, and the never-blocks guarantee are the real machinery under test).
function plantRecurringFailures(root: string): void {
  const write = (rel: string, content: string): void => {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const iss of ["ISSUE-0001", "ISSUE-0002"]) {
    write(`.vivicy/development/gates/${iss}-gate.json`, JSON.stringify({ gate_id: `gate:test:${iss}`, issue_id: iss, command: "npm test", exit_code: 1, status: "fail", finished_at: new Date().toISOString(), baseline_id: "baseline-v1.0.0" }, null, 2));
    write(`.vivicy/development/reports/${iss}-blocked.json`, JSON.stringify({ kind: "quota", reason: "provider quota exhausted mid-issue", issue_id: iss }, null, 2));
  }
}

async function runRetroScenarios(): Promise<void> {
  const retro = await import(pathToFileURL(factoryScript("retro.ts")).href);

  const recurring = rehearsalTemp("retro-recurring");
  try {
    writeAcceptanceFixture(recurring);
    plantRecurringFailures(recurring);
    const report = await retro.runRetro({
      repoRoot: recurring,
      spawnLeg: async ({ repoRoot, verdictRel }: { repoRoot: string; verdictRel: string }) => {
        const abs = join(repoRoot, verdictRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({
          recurring_classes: [
            { id: "gate-flake-test", kind: "gate_flake", signature: "the npm test gate failed on two issues", occurrences: 2, evidence: [".vivicy/development/gates/ISSUE-0001-gate.json", ".vivicy/development/gates/ISSUE-0002-gate.json"] },
            { id: "blocked-quota", kind: "blocked_cause", signature: "two issues blocked on provider quota exhaustion", occurrences: 2, evidence: [".vivicy/development/reports/ISSUE-0001-blocked.json", ".vivicy/development/reports/ISSUE-0002-blocked.json"] },
            { id: "one-off", kind: "review_finding", signature: "a single review finding", occurrences: 1 },
            { id: "fake-count", kind: "gate_flake", signature: "claims five recurrences but cites no witnesses", occurrences: 5, evidence: [] },
          ],
          proposals: [
            { landing: "settings", title: "Lower concurrency to smooth quota bursts", rationale: "two issues blocked on quota", detail: "Set maxParallel to 2 so the run does not exhaust the provider quota in bursts.", addresses: ["blocked-quota"] },
            { landing: "method_block", title: "Prime the gate before the first run", rationale: "the test gate flaked on two issues", detail: "Add a method-block bullet: the stack-setup issue warms the toolchain before the first gate so a cold-start flake never blocks an issue.", addresses: ["gate-flake-test"] },
          ],
        }));
      },
    });
    const landings = (report.proposals ?? []).map((p: { landing?: string }) => p.landing).sort();
    const derivedOccurrences = (report.recurring_classes ?? []).every((c: { occurrences?: number; evidence?: string[] }) => c.occurrences === (c.evidence?.length ?? 0));
    const noCrs = !existsSync(join(recurring, ".vivicy/change-requests"));
    record(
      "retro (planted recurring failures): witnessed classes named, proposals mapped to real landing places, one-off + unwitnessed fake-count dropped by the evidence gate, occurrences machine-derived, NO rule self-applied",
      report.phase === "proposals" && report.recurring_classes?.length === 2 && derivedOccurrences && report.proposals?.length === 2 && landings.join(",") === "method_block,settings" && noCrs,
      `phase ${report.phase ?? "?"}; ${report.recurring_classes?.length ?? "?"} witnessed class(es), proposals -> ${landings.join(",") || "none"}`,
    );
  } finally {
    cleanupTree(recurring);
  }

  const clean = rehearsalTemp("retro-clean");
  try {
    writeAcceptanceFixture(clean);
    const report = await retro.runRetro({
      repoRoot: clean,
      spawnLeg: async ({ repoRoot, verdictRel }: { repoRoot: string; verdictRel: string }) => {
        const abs = join(repoRoot, verdictRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ recurring_classes: [], proposals: [] }));
      },
    });
    record(
      "retro (clean cycle): quiet retro, no recurring classes, nothing to decide",
      report.phase === "quiet" && (report.proposals?.length ?? -1) === 0 && (report.recurring_classes?.length ?? -1) === 0,
      `phase ${report.phase ?? "?"}`,
    );
  } finally {
    cleanupTree(clean);
  }

  const failed = rehearsalTemp("retro-failed");
  try {
    writeAcceptanceFixture(failed);
    let threw = false;
    let report: { phase?: string; summary?: string } | null = null;
    try {
      report = await retro.runRetro({
        repoRoot: failed,
        spawnLeg: async () => {
          throw new Error("retro leg wedged");
        },
      });
    } catch {
      threw = true;
    }
    record(
      "retro (leg failure): loud 'failed' note, cycle close NEVER blocked (runRetro returns, never throws)",
      !threw && report?.phase === "failed" && /close is not affected/i.test(report?.summary ?? ""),
      threw ? "runRetro threw (must not — retro is observability, never fatal)" : `phase ${report?.phase ?? "?"}`,
    );
  } finally {
    cleanupTree(failed);
  }
}

// The other run-story path: when the frozen canonical's run-and-ship area STATES the run command, the extractor records it and the orchestrator establishes it from the sentinel — no stack-setup issue needed.
async function runRunCommandExtractorScenario(): Promise<void> {
  const extract = await import(pathToFileURL(factoryScript("extract-issues.ts")).href);
  const root = rehearsalTemp("runcmd");
  try {
    writeFileSync(join(root, "vivicy.json"), `${JSON.stringify({ gateCommand: null, runCommand: null }, null, 2)}\n`);
    const reportAbs = join(root, ".vivicy/development/reports/extraction-run-command.json");
    mkdirSync(dirname(reportAbs), { recursive: true });
    writeFileSync(reportAbs, `${JSON.stringify({ runCommand: "flask run" }, null, 2)}\n`);

    const filled = extract.recordExtractedRunCommand(root) as boolean;
    const after = readCommandField(root, "runCommand");
    record(
      "run-story: the extractor records a canonical-stated run command and the orchestrator establishes it (no stack-setup needed)",
      filled === true && after === "flask run",
      `recorded=${filled}; runCommand -> ${String(after)}`,
    );
  } finally {
    cleanupTree(root);
  }
}

async function runFeatureCycleStages(temp: string): Promise<void> {
  const git = (a: string[]) => spawnSync("git", a, { cwd: temp, encoding: "utf8" });
  const readJsonIn = <T,>(rel: string): T => readJson<T>(join(temp, rel));
  const clean = () => (git(["status", "--porcelain"]).stdout || "").trim() === "";

  const guardOk = isCanonicalFrozen(temp);
  const cycleId = `cycle-${new Date().toISOString().slice(0, 10)}-rehearsal`;
  if (guardOk) {
    writeSpecCycle(temp, { status: "drafting", kind: "feature", id: cycleId, opened_at: new Date().toISOString(), opened_by: "owner:dev-rehearsal" });
  }
  record("feature-cycle: drafting cycle opened on the frozen baseline (guarded)", guardOk && isSpecCycleOpen(temp), cycleId);

  // Import AFTER VIVICY_TARGET_ROOT is set: extract-issues transitively imports dev-loop, which binds repoRoot at import.
  const extract = await import(pathToFileURL(factoryScript("extract-issues.ts")).href);
  const prior = extract.findFrozenManifest(temp) as { manifestPath: string; baselineId: string } | null;
  const priorVersion = prior ? (readJsonIn<CycleManifest>(prior.manifestPath).version ?? null) : null;

  const doc = writeCycleAddendumDoc(temp);
  git(["add", "-A"]);
  git(["-c", "user.email=rehearsal@local", "-c", "user.name=rehearsal", "commit", "-qm", `spec evolution: add ${doc.docRel} (cycle ${cycleId})`]);
  record("feature-cycle: canonical evolved + committed (new doc joins the corpus)", existsSync(join(temp, doc.docRel)) && clean(), doc.docRel);

  let result: CycleExtractionResult | null = null;
  let failure = "";
  try {
    result = (await extract.extractIssues({
      repoRoot: temp,
      spawnExtractor: async (ctx: { manifestPath: string }) => {
        authorEvolvedCorpus(temp, doc, ctx.manifestPath);
        return writeFakeTranscript(temp, TRANSCRIPT_DIRS.extraction, "claude-extractor");
      },
      spawnVerifier: async () => {
        const verdictAbs = join(temp, ".vivicy/development/reports/extraction-fidelity-verdict.json");
        mkdirSync(dirname(verdictAbs), { recursive: true });
        writeFileSync(verdictAbs, `${JSON.stringify({ faithful: true, problems: [] }, null, 2)}\n`);
        return writeFakeTranscript(temp, TRANSCRIPT_DIRS.extraction, "codex-verifier");
      },
      mapReview: async () => ({ findings: [], actionable: [], legs: [] }),
    })) as CycleExtractionResult;
  } catch (error) {
    failure = String((error as Error)?.message ?? error);
  }
  const coverage = existsSync(join(temp, ".vivicy/requirements/coverage-report.json"))
    ? readJsonIn<{ totals?: { uncovered_lines?: number }; files?: { path: string }[] }>(".vivicy/requirements/coverage-report.json")
    : null;
  const uncovered = coverage?.totals?.uncovered_lines;
  const docCovered = (coverage?.files ?? []).some((f) => f.path === doc.docRel);
  record(
    "feature-cycle: re-extraction green over the EVOLVED canonical (fake agents, real gates)",
    result?.status === "green" && uncovered === 0 && docCovered && result?.committed === true && clean(),
    result ? `${result.summary.split(":")[0]}; ${doc.docRel} in corpus, ${uncovered} uncovered; committed, clean tree` : failure || "extraction did not run",
  );

  const bumped = priorVersion ? minorBump(priorVersion) : null;
  const fresh = result ? readJsonIn<CycleManifest>(result.manifestPath) : null;
  const priorAfter = prior ? readJsonIn<CycleManifest>(prior.manifestPath) : null;
  record(
    "feature-cycle: freeze is a MINOR bump, approval_ref = cycle id, prior baseline superseded",
    Boolean(bumped && fresh?.version === bumped && result?.baselineId === `baseline-v${bumped}` && fresh?.approval?.approval_ref === cycleId && priorAfter?.superseded?.by_baseline_id === result?.baselineId),
    `${priorVersion ?? "?"} -> ${fresh?.version ?? "?"}; approval_ref ${fresh?.approval?.approval_ref ?? "(none)"}`,
  );

  record(
    "feature-cycle: freeze CLOSED the cycle mechanically (state file gone)",
    !existsSync(join(temp, ...SPEC_CYCLE_REL.split("/"))) && !isSpecCycleOpen(temp),
    SPEC_CYCLE_REL,
  );
}

function minorBump(version: string): string | null {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : null;
}

// Every body line must be auto-excludable (H1/blank) or cited by the issue — the semantic full-line-coverage gate demands it.
function writeCycleAddendumDoc(temp: string): { docRel: string; refs: string[]; title: string } {
  const canonicalDir = join(temp, ".vivicy/canonical");
  const next =
    readdirSync(canonicalDir)
      .filter((f) => f.endsWith(".md"))
      .reduce((max, f) => Math.max(max, Number(/^(\d+)-/.exec(f)?.[1] ?? 0)), 0) + 1;
  const nn = String(next).padStart(2, "0");
  const docRel = `.vivicy/canonical/${nn}-feature-cycle-addendum.md`;
  const title = "Feature Cycle Addendum";
  const lines = [
    `# ${nn} - ${title}`,
    "",
    "The system exposes a read-only build identifier naming the frozen baseline it was built from, so a caller can confirm which governed spec version is running.",
    "",
    "The build identifier changes only when a new baseline is frozen; two builds from the same frozen baseline report the same identifier.",
  ];
  writeFileSync(join(temp, docRel), `${lines.join("\n")}\n`);
  const refs = lines
    .map((text, i) => ({ text, line: i + 1 }))
    .filter(({ text, line }) => text.trim().length > 0 && line !== 1)
    .map(({ line }) => `${docRel}:${line}`);
  return { docRel, refs, title };
}

function authorEvolvedCorpus(temp: string, doc: { docRel: string; refs: string[]; title: string }, manifestPath: string): void {
  const manifest = readJson<{ baseline_id: string; version: string; manifest_hash: string; document_set_hash: string }>(join(temp, manifestPath));

  const indexAbs = join(temp, ".vivicy/development/issue-index.json");
  const index = readJson<CycleIssueIndex>(indexAbs);
  index.baseline_id = manifest.baseline_id;
  index.baseline_version = manifest.version;
  index.manifest_path = manifestPath;
  index.manifest_hash = manifest.manifest_hash;
  index.document_set_hash = manifest.document_set_hash;

  const reqId = "REQ-CYCLE-001";
  const gateId = "gate:test:feature-cycle-addendum";
  const nextIssueNumber = index.issues.reduce((max, i) => Math.max(max, Number(/^ISSUE-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0) + 1;
  const issueId = index.issues.find((i) => i.requirement_ids.includes(reqId))?.id ?? `ISSUE-${String(nextIssueNumber).padStart(4, "0")}`;
  const graphRef = index.issues.flatMap((i) => i.graph_refs).find((ref) => ref.startsWith("node:"));
  if (!graphRef) throw new Error("dev-rehearsal: no node: graph ref in the issue index to reuse for the cycle issue");
  const entry: CycleIssueEntry = {
    id: issueId,
    title: "Expose the frozen-baseline build identifier",
    summary: "Implement the read-only build identifier that names the frozen baseline the build was produced from, stable within one baseline and changing only on a new freeze.",
    issue_path: `.vivicy/development/issues/${issueId}.md`,
    requirement_ids: [reqId],
    source_line_refs: doc.refs,
    depends_on: [],
    spike_gates: [],
    graph_refs: [graphRef],
    verification_gate_ids: [gateId],
  };
  index.issues = [...index.issues.filter((i) => i.id !== issueId), entry];
  writeFileSync(indexAbs, `${JSON.stringify(index, null, 2)}\n`);

  writeFileSync(
    join(temp, entry.issue_path),
    [
      `# ${issueId} - ${entry.title}`,
      "",
      "## Summary",
      "",
      entry.summary,
      "",
      "## Task Type",
      "",
      "implementation",
      "",
      "## Traceability",
      "",
      "```text",
      `issue_id: ${issueId}`,
      "graph_refs:",
      `  - ${graphRef}`,
      "requirement_ids:",
      `  - ${reqId}`,
      "source_line_refs:",
      ...doc.refs.map((ref) => `  - ${ref}`),
      "depends_on:",
      "spike_gates:",
      "verification_gate_ids:",
      `  - ${gateId}`,
      "```",
      "",
      "## Scope",
      "",
      "Expose a read-only build identifier derived from the frozen baseline identity; no other module changes.",
      "",
      "## Verification",
      "",
      `Unit tests proving the identifier is present and stable within one frozen baseline; the deterministic gate ${gateId} must be green before this issue is reported complete.`,
      "",
    ].join("\n"),
  );

  const catalogAbs = join(temp, ".vivicy/requirements/catalog.json");
  const catalog = readJson<{ requirements: Record<string, unknown>[] }>(catalogAbs);
  catalog.requirements = catalog.requirements.filter((r) => r.id !== reqId);
  catalog.requirements.push({
    id: reqId,
    title: doc.title,
    statement: "The system exposes a read-only build identifier naming the frozen baseline it was built from; it changes only when a new baseline is frozen.",
    area: "feature-cycle",
    type: "functional",
    maturity: "mvp",
    disposition: "must_implement",
    sourceRefs: doc.refs,
    dependsOn: [],
    blocks: [],
    coveredByIssues: [issueId],
    coveredByTests: [],
    coveredByCode: [],
    verificationLevel: "unit",
    notes: [],
    baselineId: manifest.baseline_id,
    baselineVersion: manifest.version,
    baselineManifestPath: manifestPath,
    manifestHash: manifest.manifest_hash,
    documentSetHash: manifest.document_set_hash,
  });
  writeFileSync(catalogAbs, `${JSON.stringify(catalog, null, 2)}\n`);

  // source_baseline fields must pin the active baseline and the doc must be cited on a node, or the canonical-coverage map gate fails.
  const mapAbs = join(temp, ".vivicy/architecture-map/architecture-map.yml");
  let yml = readFileSync(mapAbs, "utf8");
  for (const [key, value] of [
    ["baseline_id", manifest.baseline_id],
    ["baseline_version", manifest.version],
    ["manifest_path", manifestPath],
    ["manifest_hash", manifest.manifest_hash],
    ["document_set_hash", manifest.document_set_hash],
  ] as const) {
    yml = yml.replace(new RegExp(`^(\\s+${key}: ).*$`, "m"), `$1"${value}"`);
  }
  writeFileSync(mapAbs, citeDocOnNode(yml, graphRef.slice("node:".length), doc.docRel));
}

function citeDocOnNode(yml: string, nodeId: string, docRel: string): string {
  if (yml.includes(`"${docRel}"`)) return yml;
  const lines = yml.split("\n");
  let inNode = false;
  let nodeSeen = false;
  for (let i = 0; i < lines.length; i += 1) {
    const idMatch = lines[i].match(/^\s+-\s+id:\s*"?([^"\s]+)"?\s*$/);
    if (idMatch) {
      inNode = idMatch[1] === nodeId;
      nodeSeen ||= inNode;
    }
    if (inNode && /^\s+source_refs:\s*\[.*\]\s*$/.test(lines[i])) {
      lines[i] = lines[i].replace(/\]\s*$/, `, "${docRel}"]`);
      return lines.join("\n");
    }
  }
  throw new Error(
    `dev-rehearsal: cannot cite ${docRel} — ${nodeSeen ? `node ${nodeId} has no inline source_refs line` : `node ${nodeId} not found in architecture-map.yml`}`,
  );
}

function writeReport(ctx: ReportContext): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  const verdict = stages.every((s) => s.ok) ? "passed" : "failed";
  const rows = stages.map((s) => `| ${s.ok ? "✅" : "❌"} | ${s.name} | ${s.detail.replace(/\|/g, "\\|")} |`).join("\n");
  const body = `# Method Rehearsal Report

Verdict: **${verdict}**${ctx.dry ? " (dry agents — harness validation only)" : " (real two-agent loop)"}

This report records an end-to-end rehearsal of the development method against the
factory-bundled \`${fixtureName}\` fixture (\`factory/rehearsal/${fixtureName}/\`). The
fixture was copied into a throwaway git repo and every tool was driven through
\`VIVICY_TARGET_ROOT\`; the rehearsal is fully self-contained (bundled fixture +
bundled role prompts) and no target/host project was committed to by this run.

## Stages

| | Stage | Detail |
| --- | --- | --- |
${rows}

## Issue outcomes

- total issues: ${ctx.totalIssues}
- verified: ${ctx.verified.length} (${ctx.verified.join(", ") || "none"})
- blocked: ${ctx.blocked.length} (${ctx.blocked.join(", ") || "none"})
- moved to done/: ${ctx.doneCount}
- verified graph items in ledger: ${ctx.verifiedStates}
- passing gate-run records: ${ctx.passingGates}

## Notes

- Mode: ${ctx.dry ? "dry (fake agents; the gate, chain, ledger, and viewer are real)" : "real Claude implementer + Codex reviewer"}.
- Isolation: throwaway temp repo at run time; the committed fixture holds only inputs.
- Gates exercised end to end: baseline freeze + verify, semantic-extraction:check,
  traceability:check, viewer-data generation, the two-agent dev loop, gate-run
  evidence, the verified progress overlay, and the feature spec cycle (cycle open ->
  canonical evolution -> minor-bump re-freeze carrying the cycle id as approval_ref
  and closing the cycle).
`;
  writeFileSync(reportPath, body);
}

main().catch((error) => {
  process.stderr.write(`\nREHEARSAL CRASHED: ${(error as Error)?.stack ?? String(error)}\n`);
  if (liveTempRepo) process.stderr.write(`temp repo kept for inspection: ${liveTempRepo}\n`);
  process.exit(1);
});
