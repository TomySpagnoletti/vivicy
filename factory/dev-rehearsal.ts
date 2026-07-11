#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { SpawnSyncReturns } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FACTORY_REHEARSAL_DIR } from "./target-root.ts";
import { hasActiveFrozenBaseline, isSpecCycleOpen, SPEC_CYCLE_REL, writeSpecCycle } from "../lib/spec-cycle.ts";

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

// The pocket-ledger fixture ships gateCommand as the `null` sentinel; the dry implementer establishes it on the stack-setup issue exactly as a real one would, exercising the machine-fill path.
const FIXTURE_GATE_COMMAND = "npm test";

function readGateCommand(root: string): string | null {
  try {
    return (JSON.parse(readFileSync(join(root, "vivicy.json"), "utf8")) as { gateCommand?: string | null }).gateCommand ?? null;
  } catch {
    return null;
  }
}

function fillGateCommandIfSentinel(root: string): void {
  const abs = join(root, "vivicy.json");
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return;
  }
  if (typeof config.gateCommand === "string" && config.gateCommand.length > 0) return;
  config.gateCommand = FIXTURE_GATE_COMMAND;
  writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`);
}

// runIssueCycle (sequential) calls legs synchronously; runIssueCycleAsync (parallel) awaits them — dry legs must match or the sequential path breaks.
function dryImplementer(temp: string) {
  return (issue: LegIssue) => {
    fillGateCommandIfSentinel(temp);
    return writeFakeTranscript(temp, issue, "claude-implementer");
  };
}
function dryReviewer(temp: string) {
  return (issue: LegIssue) => writeFakeTranscript(temp, issue, "codex-reviewer");
}
function dryImplementerParallel(temp: string) {
  return async (issue: LegIssue, cfg?: LegCfg) => {
    await delay(15);
    if (cfg?.execRoot) writeWorktreeMarker(cfg.execRoot, issue, "implementer");
    fillGateCommandIfSentinel(cfg?.execRoot ?? temp);
    return writeFakeTranscript(temp, issue, "claude-implementer");
  };
}
function dryReviewerParallel(temp: string) {
  return async (issue: LegIssue, cfg?: LegCfg) => {
    await delay(15);
    if (cfg?.execRoot) writeWorktreeMarker(cfg.execRoot, issue, "reviewer");
    return writeFakeTranscript(temp, issue, "codex-reviewer");
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
function writeFakeTranscript(temp: string, issue: LegIssue, who: string): { transcriptRel: string } {
  const rel = `.vivicy/development/transcripts/${issue.id}/${who}-dry.jsonl`;
  const abs = join(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ type: "assistant", message: { content: `dry ${who} for ${issue.id}` } })}\n`);
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

  const git = (a: string[], cwd: string) => spawnSync("git", a, { cwd, encoding: "utf8" });
  let temp: string;
  if (fixedDir && existsSync(join(fixedDir, ".git"))) {
    temp = fixedDir;
    const done = existsSync(join(temp, ".vivicy/development/issues/done"))
      ? readdirSync(join(temp, ".vivicy/development/issues/done")).filter((f) => f.endsWith(".md")).length
      : 0;
    record("resume isolated temp repo", true, `${temp} (${done} issue(s) already done)`);
  } else {
    temp = fixedDir ?? mkdtempSync(join(tmpdir(), "vivicy-rehearsal-"));
    if (fixedDir) mkdirSync(fixedDir, { recursive: true });
    cpSync(fixtureDir, temp, { recursive: true });
    git(["init", "-q"], temp);
    git(["add", "-A"], temp);
    git(["-c", "user.email=rehearsal@local", "-c", "user.name=rehearsal", "commit", "-qm", "rehearsal fixture"], temp);
    record("materialize isolated temp repo", existsSync(join(temp, ".git")), temp);
  }

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
  const preLoopGateCommand = readGateCommand(temp);
  let processed: ProcessedIssue[] = [];
  try {
    // No defaultGateCommand: exercises the real polyglot-gate resolution from the fixture's own vivicy.json.
    // readiness: false — dry legs don't implement a readiness leg; keeps the rehearsal deterministic.
    processed = await devloop.runLoop({ maxParallel: concurrency, readiness: false }, steps);
  } catch (error) {
    record("dev-loop two-agent run", false, String((error as Error)?.message ?? error));
  }
  const postLoopGateCommand = readGateCommand(temp);
  record(
    "machine-fill: gateCommand starts as the null sentinel, established by the stack-setup issue (never a human)",
    preLoopGateCommand === null && postLoopGateCommand === FIXTURE_GATE_COMMAND,
    `sentinel(${preLoopGateCommand === null ? "null" : String(preLoopGateCommand)}) -> ${String(postLoopGateCommand)}`,
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
  const transcriptsCommitted = [...tracked].filter((p) => p.startsWith(".vivicy/development/transcripts/"));
  const transcriptsOnDisk = existsSync(join(temp, ".vivicy/development/transcripts"));
  record(
    "closure: transcripts produced but NEVER committed (gitignored)",
    transcriptsOnDisk && transcriptsCommitted.length === 0,
    `${transcriptsCommitted.length} transcript(s) committed (must be 0); on disk: ${transcriptsOnDisk}`,
  );
  const porcelain = (git(["status", "--porcelain"], temp).stdout || "").trim();
  record("closure: clean tree (only gitignored untracked)", porcelain === "", porcelain ? `dirty:\n${porcelain}` : "clean");

  await runFeatureCycleStages(temp);

  writeReport({ dry, temp, processed, verified, blocked, totalIssues, doneCount, verifiedStates: verifiedStates.length, passingGates });
  record("write method-rehearsal-report.md", existsSync(reportPath), reportPath);

  const allPass = stages.every((s) => s.ok);
  process.stdout.write(`\n${allPass ? "REHEARSAL PASSED" : "REHEARSAL FAILED"} (${stages.filter((s) => s.ok).length}/${stages.length} stages)\n`);
  if (keep || !allPass || fixedDir) {
    process.stdout.write(`temp repo kept${fixedDir ? " (pinned)" : ""}: ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
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
  for (const edge of map.edges ?? []) graphRefs.add(edge.graph_ref || edgeGraphRef(edge));
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
  const issueLines = subjects.filter((s) => /ISS-\d+/.test(s)).slice(0, 6);
  return issueLines.join(" | ") || "(no issue commits)";
}
// git log is newest-first: a dependency must appear at a LARGER index (older) than the issue depending on it.
function dependencyOrderRespected(temp: string): boolean {
  const index = readJson<RehearsalIssueIndex>(join(temp, ".vivicy/development/issue-index.json"));
  const issues = Array.isArray(index.issues) ? index.issues : [];
  const subjects = integrationCommitOrder(temp);
  const posById = new Map<string, number>();
  subjects.forEach((subject, i) => {
    const m = subject.match(/ISS-\d+/);
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

async function runFeatureCycleStages(temp: string): Promise<void> {
  const git = (a: string[]) => spawnSync("git", a, { cwd: temp, encoding: "utf8" });
  const readJsonIn = <T,>(rel: string): T => readJson<T>(join(temp, rel));
  const clean = () => (git(["status", "--porcelain"]).stdout || "").trim() === "";

  const guardOk = hasActiveFrozenBaseline(temp) && !isSpecCycleOpen(temp);
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
        return writeFakeTranscript(temp, { id: "EXTRACTION" }, "claude-extractor");
      },
      spawnVerifier: async () => {
        const verdictAbs = join(temp, ".vivicy/development/reports/extraction-fidelity-verdict.json");
        mkdirSync(dirname(verdictAbs), { recursive: true });
        writeFileSync(verdictAbs, `${JSON.stringify({ faithful: true, problems: [] }, null, 2)}\n`);
        return writeFakeTranscript(temp, { id: "EXTRACTION" }, "codex-verifier");
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
  const nextIssueNumber = index.issues.reduce((max, i) => Math.max(max, Number(/^ISS-(\d+)$/.exec(i.id)?.[1] ?? 0)), 0) + 1;
  const issueId = index.issues.find((i) => i.requirement_ids.includes(reqId))?.id ?? `ISS-${String(nextIssueNumber).padStart(4, "0")}`;
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

main();
