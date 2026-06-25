// MUST be the first import: it binds VIVICY_TARGET_ROOT to a dedicated temp root
// as a side effect, before dev-loop.mjs (imported below) binds its target root at
// module load. See test-target-root.mjs for why import order matters here.
import { testTargetRoot as repoRoot } from "./test-target-root.mjs";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  agentCliArgs,
  buildDepsClosure,
  clampConcurrency,
  composePrompt,
  computeDoneIds,
  computeReadySet,
  computeWaitMs,
  DEFAULT_CONFIG,
  DEFAULT_QUOTA_PATTERNS,
  defaultRunImplementer,
  defaultRunReviewer,
  dependenciesSatisfied,
  detectRateLimit,
  issueClaim,
  issuesIndependent,
  parseClaudeQuotaWindows,
  parseClaudeStatusRateLimits,
  parseCodexQuotaWindows,
  parseQuotaWindows,
  parseResetMs,
  pickNextIssue,
  resolveAgentLegs,
  runLegWithQuota,
  runLoop,
  runLoopParallel,
  selectIndependentBatch,
} from "./dev-loop.mjs";
import { REQUIRED_SKILLS, checkSkills, missingSkills } from "./dev-preflight.mjs";
import { nextSupervisorAction } from "./dev-loop-supervised.mjs";

// Vivicy is a STANDALONE factory: dev-loop.mjs binds its target root from
// VIVICY_TARGET_ROOT at module load (set above to a dedicated temp dir). Every
// scratch fixture this test writes via resolve(repoRoot, ...) now lands under that
// temp root — self-contained, never a host project.

// Remove the temp target root once the file's tests finish (per-test scratch dirs
// clean up themselves; this sweeps the root itself).
after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

// --- pure core ---

test("dependenciesSatisfied", () => {
  assert.equal(dependenciesSatisfied({ depends_on: ["A"] }, new Set(["A"])), true);
  assert.equal(dependenciesSatisfied({ depends_on: ["A", "B"] }, new Set(["A"])), false);
  assert.equal(dependenciesSatisfied({}, new Set()), true);
});

test("pickNextIssue respects done, dependencies, and order", () => {
  const issues = [
    { id: "A", depends_on: [] },
    { id: "B", depends_on: ["A"] },
  ];
  assert.equal(pickNextIssue(issues, new Set()).id, "A");
  assert.equal(pickNextIssue(issues, new Set(["A"])).id, "B");
  assert.equal(pickNextIssue(issues, new Set(["A", "B"])), null);
});

test("computeDoneIds counts moved files and per-issue verified graph refs", () => {
  const issues = [
    { id: "A", graph_refs: ["node:x"] },
    { id: "B", graph_refs: ["node:y"] },
    { id: "C", graph_refs: ["node:y"] }, // shares node:y with B
  ];
  const ledger = {
    graph_item_states: [{ graph_ref: "node:y", status: "verified", issue_states: { B: "verified" } }],
  };
  const done = computeDoneIds(issues, ledger, new Set(["A.md"]));
  assert.ok(done.has("A"), "A is done via its moved file");
  assert.ok(done.has("B"), "B is done via its own verified per-issue state");
  assert.ok(!done.has("C"), "C is NOT done: node:y was verified by B, not C (no shared-node over-count)");
});

test("composePrompt fills placeholders", () => {
  const out = composePrompt("Issue {{issue_id}} at {{issue_path}} refs {{graph_refs}}", {
    id: "ISS-1",
    path: "p.md",
    graph_refs: ["a", "b"],
  });
  assert.equal(out, "Issue ISS-1 at p.md refs a, b");
});

// --- per-agent model + thinking-level CLI flags ---

test("agentCliArgs builds claude --model/--effort and codex -m/-c flags", () => {
  // Claude (implementer): `--model <id> --effort <level>`.
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8", effort: "xhigh" }), [
    "--model",
    "claude-opus-4-8",
    "--effort",
    "xhigh",
  ]);
  // Codex (reviewer): `-m <id> -c model_reasoning_effort="<level>"`.
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5", effort: "high" }), [
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
  ]);
});

test("agentCliArgs omits only the missing flag pair, never a bare flag", () => {
  // Effort without a model still emits the effort flag (and vice-versa).
  assert.deepEqual(agentCliArgs("claude", { effort: "max" }), ["--effort", "max"]);
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8" }), ["--model", "claude-opus-4-8"]);
  assert.deepEqual(agentCliArgs("codex", { effort: "minimal" }), ["-c", 'model_reasoning_effort="minimal"']);
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5" }), ["-m", "gpt-5.5"]);
  // Empty config (or unknown provider) yields no args, never a dangling flag.
  assert.deepEqual(agentCliArgs("claude", {}), []);
  assert.deepEqual(agentCliArgs("codex", {}), []);
  assert.deepEqual(agentCliArgs("other", { model: "x", effort: "high" }), []);
});

test("agentCliArgs appends fast flags ONLY for a fast-capable model", () => {
  // Claude fast: `--settings {"fastMode":true}` after the model/effort flags, for a
  // fast-capable Opus.
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8", effort: "xhigh", fast: true }), [
    "--model",
    "claude-opus-4-8",
    "--effort",
    "xhigh",
    "--settings",
    JSON.stringify({ fastMode: true }),
  ]);
  // Codex fast: `-c fast_mode=true` after the model/effort flags, on gpt-5.5.
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5", effort: "high", fast: true }), [
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "fast_mode=true",
  ]);
});

test("agentCliArgs OMITS fast for a model that cannot do fast (honest, even if asked)", () => {
  // Older Opus has no fast: no --settings emitted even with fast: true.
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-5", effort: "high", fast: true }), [
    "--model",
    "claude-opus-4-5",
    "--effort",
    "high",
  ]);
  // Spark is a low-latency model, not a fast target: no -c fast_mode=true.
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.3-codex-spark", fast: true }), [
    "-m",
    "gpt-5.3-codex-spark",
  ]);
  // gpt-5.4-mini has no documented fast support either.
  assert.ok(!agentCliArgs("codex", { model: "gpt-5.4-mini", effort: "high", fast: true }).includes("fast_mode=true"));
});

test("DEFAULT_CONFIG pins the latest models with the documented default thinking levels", () => {
  // Always-latest model; thinking level is the user-tunable knob (env-overridable).
  assert.equal(DEFAULT_CONFIG.implementer.provider, "claude");
  assert.equal(DEFAULT_CONFIG.implementer.model, "claude-opus-4-8");
  assert.equal(DEFAULT_CONFIG.implementer.effort, "xhigh");
  assert.equal(DEFAULT_CONFIG.reviewer.provider, "codex");
  assert.equal(DEFAULT_CONFIG.reviewer.model, "gpt-5.5");
  assert.equal(DEFAULT_CONFIG.reviewer.effort, "high");
});

// The leg builders must actually append the provider flags to the spawned argv.
// A tiny PATH shim impersonates `claude`/`codex`, recording its argv to a file
// so we assert the real argv the loop spawned — no real agent CLI involved.
test("defaultRunImplementer / defaultRunReviewer spawn with the model + effort flags", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-agent-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  // POSIX shim: dump "$@" as JSON lines into $AGENT_SHIM_OUT, then exit 0.
  const shim = (name) =>
    `#!/usr/bin/env node\n` +
    `import { appendFileSync } from "node:fs";\n` +
    `appendFileSync(process.env.AGENT_SHIM_OUT, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n`;
  writeFileSync(resolve(shimDir, "claude"), shim("claude"), { mode: 0o755 });
  writeFileSync(resolve(shimDir, "codex"), shim("codex"), { mode: 0o755 });

  const prevPath = process.env.PATH;
  const prevOut = process.env.AGENT_SHIM_OUT;
  process.env.PATH = `${shimDir}:${prevPath}`;
  process.env.AGENT_SHIM_OUT = argvFile;
  try {
    const issue = { id: "ISS-FLAGS", graph_refs: ["node:x"] };
    // Use the real DEFAULT_CONFIG agent legs; override effort to a non-default to
    // prove the configured value (not a hardcoded one) is what gets spawned.
    const cfg = {
      ...DEFAULT_CONFIG,
      // Keep transcript writes inside the scratch dir, never the real repo store.
      transcriptsDir: `${shimRel}/transcripts`,
      implementer: { ...DEFAULT_CONFIG.implementer, model: "claude-opus-4-8", effort: "max" },
      reviewer: { ...DEFAULT_CONFIG.reviewer, model: "gpt-5.5", effort: "minimal" },
    };
    defaultRunImplementer(issue, cfg);
    defaultRunReviewer(issue, cfg);

    const records = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const claude = records.find((r) => r.name === "claude");
    const codex = records.find((r) => r.name === "codex");
    assert.ok(claude, "claude leg spawned");
    assert.ok(codex, "codex leg spawned");

    // Claude argv carries `--model claude-opus-4-8 --effort max` in order.
    const cm = claude.argv.indexOf("--model");
    assert.ok(cm !== -1 && claude.argv[cm + 1] === "claude-opus-4-8");
    const ce = claude.argv.indexOf("--effort");
    assert.ok(ce !== -1 && claude.argv[ce + 1] === "max");

    // Codex argv carries `-m gpt-5.5 -c model_reasoning_effort="minimal"`.
    const xm = codex.argv.indexOf("-m");
    assert.ok(xm !== -1 && codex.argv[xm + 1] === "gpt-5.5");
    const xc = codex.argv.indexOf("-c");
    assert.ok(xc !== -1 && codex.argv[xc + 1] === 'model_reasoning_effort="minimal"');
  } finally {
    process.env.PATH = prevPath;
    if (prevOut === undefined) delete process.env.AGENT_SHIM_OUT;
    else process.env.AGENT_SHIM_OUT = prevOut;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

// R12: the role -> CLI assignment is configurable from settings (env), and the
// loop must read it instead of hardcoding implementer=claude / reviewer=codex.
test("resolveAgentLegs reads the role -> CLI assignment from the env", () => {
  // Default (no env): implementer=claude, reviewer=codex.
  const def = resolveAgentLegs({});
  assert.equal(def.implementer.provider, "claude");
  assert.equal(def.implementer.actor, "claude");
  assert.equal(def.implementer.role, "implementer");
  assert.equal(def.reviewer.provider, "codex");
  assert.equal(def.reviewer.actor, "codex");
  assert.equal(def.reviewer.role, "reviewer");

  // Swapped: implementer=codex, reviewer=claude, with each CLI's model/level
  // following the CLI it is assigned to.
  const swap = resolveAgentLegs({
    VIVICY_IMPLEMENTER_CLI: "codex",
    VIVICY_REVIEWER_CLI: "claude",
    VIVICY_CLAUDE_EFFORT: "max",
    VIVICY_CODEX_EFFORT: "minimal",
  });
  assert.equal(swap.implementer.provider, "codex");
  assert.equal(swap.implementer.effort, "minimal"); // codex's level follows codex
  assert.equal(swap.reviewer.provider, "claude");
  assert.equal(swap.reviewer.effort, "max"); // claude's level follows claude
});

test("resolveAgentLegs honors fast ONLY for a fast-capable model (authoritative gate)", () => {
  // Fast requested on fast-capable defaults => fast true on both legs.
  const on = resolveAgentLegs({
    VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
    VIVICY_CLAUDE_FAST: "1",
    VIVICY_CODEX_MODEL: "gpt-5.5",
    VIVICY_CODEX_FAST: "1",
  });
  assert.equal(on.implementer.fast, true);
  assert.equal(on.reviewer.fast, true);

  // Fast requested on incapable models => dropped to false here, before any spawn.
  const gated = resolveAgentLegs({
    VIVICY_CLAUDE_MODEL: "claude-opus-4-5",
    VIVICY_CLAUDE_FAST: "1",
    VIVICY_CODEX_MODEL: "gpt-5.3-codex-spark",
    VIVICY_CODEX_FAST: "1",
  });
  assert.equal(gated.implementer.fast, false);
  assert.equal(gated.reviewer.fast, false);

  // Fast off by default (no env).
  const def = resolveAgentLegs({});
  assert.equal(def.implementer.fast, false);
  assert.equal(def.reviewer.fast, false);
});

test("resolveAgentLegs repairs an out-of-band INVALID effort to the CLI default", () => {
  // A hand-edited/out-of-band env carrying a level the CLI would reject must never
  // reach agentCliArgs; the leg falls back to the CLI's documented default.
  const legs = resolveAgentLegs({
    VIVICY_CLAUDE_EFFORT: "extreme", // not a claude level
    VIVICY_CODEX_EFFORT: "max", // claude-only level, invalid for codex
  });
  assert.equal(legs.implementer.effort, "xhigh"); // claude default
  assert.equal(legs.reviewer.effort, "high"); // codex default
  // A valid env effort is still honored.
  const ok = resolveAgentLegs({ VIVICY_CLAUDE_EFFORT: "low", VIVICY_CODEX_EFFORT: "minimal" });
  assert.equal(ok.implementer.effort, "low");
  assert.equal(ok.reviewer.effort, "minimal");
});

test("a fast-enabled leg spawns the real fast flags in its argv", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-agent-fast-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  const shim = (name) =>
    `#!/usr/bin/env node\n` +
    `import { appendFileSync } from "node:fs";\n` +
    `appendFileSync(process.env.AGENT_SHIM_OUT, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n`;
  writeFileSync(resolve(shimDir, "claude"), shim("claude"), { mode: 0o755 });
  writeFileSync(resolve(shimDir, "codex"), shim("codex"), { mode: 0o755 });

  const prevPath = process.env.PATH;
  const prevOut = process.env.AGENT_SHIM_OUT;
  process.env.PATH = `${shimDir}:${prevPath}`;
  process.env.AGENT_SHIM_OUT = argvFile;
  try {
    const issue = { id: "ISS-FAST", graph_refs: ["node:x"] };
    const cfg = {
      ...DEFAULT_CONFIG,
      transcriptsDir: `${shimRel}/transcripts`,
      implementer: { ...DEFAULT_CONFIG.implementer, model: "claude-opus-4-8", effort: "xhigh", fast: true },
      reviewer: { ...DEFAULT_CONFIG.reviewer, model: "gpt-5.5", effort: "high", fast: true },
    };
    defaultRunImplementer(issue, cfg);
    defaultRunReviewer(issue, cfg);

    const records = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const claude = records.find((r) => r.name === "claude");
    const codex = records.find((r) => r.name === "codex");

    // Claude fast: a --settings arg whose JSON enables fastMode.
    const cs = claude.argv.indexOf("--settings");
    assert.ok(cs !== -1, "claude --settings present for fast");
    assert.deepEqual(JSON.parse(claude.argv[cs + 1]), { fastMode: true });

    // Codex fast: a `-c fast_mode=true` pair.
    assert.ok(codex.argv.includes("fast_mode=true"), "codex fast_mode=true present");
  } finally {
    process.env.PATH = prevPath;
    if (prevOut === undefined) delete process.env.AGENT_SHIM_OUT;
    else process.env.AGENT_SHIM_OUT = prevOut;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("resolveAgentLegs enforces distinct CLIs (rejects same CLI for both roles)", () => {
  // Same CLI assigned to both roles: the reviewer is repaired to the other CLI so
  // a CLI never reviews its own implementation.
  const dupClaude = resolveAgentLegs({
    VIVICY_IMPLEMENTER_CLI: "claude",
    VIVICY_REVIEWER_CLI: "claude",
  });
  assert.equal(dupClaude.implementer.provider, "claude");
  assert.equal(dupClaude.reviewer.provider, "codex");
  assert.notEqual(dupClaude.implementer.provider, dupClaude.reviewer.provider);

  const dupCodex = resolveAgentLegs({
    VIVICY_IMPLEMENTER_CLI: "codex",
    VIVICY_REVIEWER_CLI: "codex",
  });
  assert.equal(dupCodex.implementer.provider, "codex");
  assert.equal(dupCodex.reviewer.provider, "claude");
  assert.notEqual(dupCodex.implementer.provider, dupCodex.reviewer.provider);

  // An unknown CLI falls back to the role default (never strands the loop).
  const bogus = resolveAgentLegs({ VIVICY_IMPLEMENTER_CLI: "gemini" });
  assert.equal(bogus.implementer.provider, "claude");
  assert.equal(bogus.reviewer.provider, "codex");
});

// The loop must spawn the CLI ASSIGNED to a role — not a role-fixed CLI. With the
// roles swapped (implementer=codex, reviewer=claude), the implementer leg must
// spawn `codex` with the implementer prompt's effort and the reviewer leg must
// spawn `claude`.
test("defaultRunImplementer / defaultRunReviewer dispatch to the assigned CLI (roles swapped)", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-swap-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  const shim = (name) =>
    `#!/usr/bin/env node\n` +
    `import { appendFileSync } from "node:fs";\n` +
    `appendFileSync(process.env.AGENT_SHIM_OUT, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n`;
  writeFileSync(resolve(shimDir, "claude"), shim("claude"), { mode: 0o755 });
  writeFileSync(resolve(shimDir, "codex"), shim("codex"), { mode: 0o755 });

  const prevPath = process.env.PATH;
  const prevOut = process.env.AGENT_SHIM_OUT;
  process.env.PATH = `${shimDir}:${prevPath}`;
  process.env.AGENT_SHIM_OUT = argvFile;
  try {
    const issue = { id: "ISS-SWAP", graph_refs: ["node:x"] };
    // Build legs as the loop would from a swapped assignment.
    const legs = resolveAgentLegs({
      VIVICY_IMPLEMENTER_CLI: "codex",
      VIVICY_REVIEWER_CLI: "claude",
      VIVICY_CODEX_EFFORT: "minimal",
      VIVICY_CLAUDE_EFFORT: "max",
    });
    const cfg = {
      ...DEFAULT_CONFIG,
      transcriptsDir: `${shimRel}/transcripts`,
      implementer: legs.implementer,
      reviewer: legs.reviewer,
    };
    defaultRunImplementer(issue, cfg);
    defaultRunReviewer(issue, cfg);

    const records = readFileSync(argvFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // The implementer leg spawned CODEX (the assigned CLI) with codex flags.
    const codex = records.find((r) => r.name === "codex");
    assert.ok(codex, "implementer leg spawned codex");
    assert.ok(codex.argv.includes("exec"), "codex invoked in exec mode");
    const xc = codex.argv.indexOf("-c");
    assert.ok(xc !== -1 && codex.argv[xc + 1] === 'model_reasoning_effort="minimal"');

    // The reviewer leg spawned CLAUDE (the assigned CLI) with claude flags.
    const claude = records.find((r) => r.name === "claude");
    assert.ok(claude, "reviewer leg spawned claude");
    const ce = claude.argv.indexOf("--effort");
    assert.ok(ce !== -1 && claude.argv[ce + 1] === "max");
  } finally {
    process.env.PATH = prevPath;
    if (prevOut === undefined) delete process.env.AGENT_SHIM_OUT;
    else process.env.AGENT_SHIM_OUT = prevOut;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("env vars flow into DEFAULT_CONFIG -> argv when the module loads in a fresh process", () => {
  // Production flow: Vivicy spawns the supervisor as a FRESH `node` child with
  // VIVICY_CLAUDE_*/VIVICY_CODEX_* in its env; DEFAULT_CONFIG reads those at
  // module-load time, and agentCliArgs turns them into the leg argv. Prove that
  // end-to-end by importing the module in a child with a custom env and printing
  // the resolved argv it would spawn — closing the env->argv path with evidence.
  const probe = [
    "import { DEFAULT_CONFIG, agentCliArgs } from " + JSON.stringify(new URL("./dev-loop.mjs", import.meta.url).href) + ";",
    "process.stdout.write(JSON.stringify({",
    "  claude: agentCliArgs('claude', DEFAULT_CONFIG.implementer),",
    "  codex: agentCliArgs('codex', DEFAULT_CONFIG.reviewer),",
    "}));",
  ].join("\n");
  const env = {
    ...process.env,
    VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
    VIVICY_CLAUDE_EFFORT: "max",
    VIVICY_CODEX_MODEL: "gpt-5.5",
    VIVICY_CODEX_EFFORT: "minimal",
  };
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `child failed: ${result.stderr}`);
  const out = JSON.parse(result.stdout);
  // The custom-effort env vars made it all the way to the spawned argv.
  assert.deepEqual(out.claude, ["--model", "claude-opus-4-8", "--effort", "max"]);
  assert.deepEqual(out.codex, ["-m", "gpt-5.5", "-c", 'model_reasoning_effort="minimal"']);
});

// --- stub end-to-end: real gate runner + ledger, stubbed agent legs ---

function buildScratch(gateCommand) {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-dev-loop-"));
  const scratchRel = relative(repoRoot, dir);
  const issuesDir = `${scratchRel}/issues`;
  const doneDir = `${scratchRel}/issues/done`;
  const gatesDir = `${scratchRel}/gates`;
  const reportsDir = `${scratchRel}/reports`;
  mkdirSync(resolve(repoRoot, issuesDir), { recursive: true });
  writeFileSync(resolve(repoRoot, `${issuesDir}/ISS-A.md`), "# A\n");
  writeFileSync(resolve(repoRoot, `${issuesDir}/ISS-B.md`), "# B\n");
  const indexRel = `${scratchRel}/issue-index.json`;
  const ledgerRel = `${scratchRel}/progress-ledger.json`;
  const index = {
    baseline_id: "baseline-test",
    verification_evidence_ref_grammar: `^${scratchRel}/(gates|reports)/.+`,
    issues: [
      {
        id: "ISS-A",
        title: "A",
        graph_refs: ["node:x"],
        depends_on: [],
        verification_gate_ids: ["gate:test:a"],
        gate_command: gateCommand,
        path: `${issuesDir}/ISS-A.md`,
      },
      {
        id: "ISS-B",
        title: "B",
        graph_refs: ["node:y"],
        depends_on: ["ISS-A"],
        verification_gate_ids: ["gate:test:b"],
        gate_command: gateCommand,
        path: `${issuesDir}/ISS-B.md`,
      },
    ],
  };
  writeFileSync(resolve(repoRoot, indexRel), `${JSON.stringify(index, null, 2)}\n`);
  // Keep quota-state writes inside the scratch dir, never the real reports path.
  const quotaStatePath = `${reportsDir}/quota-state.json`;
  return { dir, cfg: { issueIndexPath: indexRel, progressLedgerPath: ledgerRel, issuesDir, doneDir, gatesDir, reportsDir, quotaStatePath, baselineId: "baseline-test" } };
}

const stubSteps = { runImplementer: () => {}, runReviewer: () => {}, commit: () => {} };

test("runLoop drives two issues to verified, moved to done, in dependency order", () => {
  const { dir, cfg } = buildScratch("true");
  try {
    const processed = runLoop(cfg, stubSteps);
    assert.deepEqual(processed, [
      { id: "ISS-A", status: "verified" },
      { id: "ISS-B", status: "verified" },
    ]);
    const doneFiles = new Set(readdirSync(resolve(repoRoot, cfg.doneDir)));
    assert.ok(doneFiles.has("ISS-A.md"));
    assert.ok(doneFiles.has("ISS-B.md"));
    assert.ok(!existsSync(resolve(repoRoot, `${cfg.issuesDir}/ISS-A.md`)));
    // moveIssueToDone keeps the index path truthful for external readers.
    const indexAfter = JSON.parse(readFileSync(resolve(repoRoot, cfg.issueIndexPath), "utf8"));
    assert.equal(indexAfter.issues[0].path, `${cfg.doneDir}/ISS-A.md`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoop rejects absolute config paths", () => {
  assert.throws(
    () => runLoop({ issueIndexPath: "/abs/issue-index.json" }, stubSteps),
    /must be repository-relative/,
  );
});

test("runLoop records transcript_refs from agent legs onto graph item states", () => {
  const { dir, cfg } = buildScratch("true");
  try {
    // Real (non-empty) transcript files under the scratch dir: the loop now only
    // records transcript_refs for transcripts that actually landed on disk.
    const scratchRel = relative(repoRoot, dir);
    const legRel = (name) => `${scratchRel}/tx-${name}.jsonl`;
    const writeLeg = (name) => {
      writeFileSync(resolve(repoRoot, legRel(name)), "transcript\n");
      return { transcriptRel: legRel(name) };
    };
    const steps = {
      runImplementer: () => writeLeg("claude"),
      runReviewer: () => writeLeg("codex"),
      commit: () => {},
    };
    runLoop(cfg, steps);
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    const stateA = ledger.graph_item_states.find((state) => state.graph_ref === "node:x");
    assert.ok(stateA.transcript_refs.includes(legRel("claude")));
    assert.ok(stateA.transcript_refs.includes(legRel("codex")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("supervisor relaunches while progressing and stops on done/block/stall/cap", () => {
  const limits = { stallLimit: 3, maxRelaunches: 5 };
  assert.equal(nextSupervisorAction({ done: 8, total: 8, blocked: 0, attempt: 2, stall: 0 }, limits).action, "done");
  assert.equal(nextSupervisorAction({ done: 3, total: 8, blocked: 1, attempt: 2, stall: 0 }, limits).action, "blocked");
  assert.equal(nextSupervisorAction({ done: 3, total: 8, blocked: 0, attempt: 5, stall: 0 }, limits).action, "max_relaunches");
  assert.equal(nextSupervisorAction({ done: 3, total: 8, blocked: 0, attempt: 2, stall: 3 }, limits).action, "stalled");
  assert.equal(nextSupervisorAction({ done: 3, total: 8, blocked: 0, attempt: 2, stall: 1 }, limits).action, "relaunch");
});

test("missingSkills detects absent required skills (substring-robust)", () => {
  assert.deepEqual(missingSkills(REQUIRED_SKILLS.join(" ")), []);
  assert.deepEqual(missingSkills("only react-best-practices installed"), [
    "taste-skill",
    "nestjs-best-practices",
    "supabase",
    "supabase-postgres-best-practices",
  ]);
});

test("checkSkills reports not-ok when the skills CLI is unavailable", () => {
  const result = checkSkills(() => ({ ok: false }));
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, REQUIRED_SKILLS);
});

test("checkSkills is ok when all required skills are present", () => {
  const result = checkSkills(() => ({ ok: true, output: REQUIRED_SKILLS.join("\n") }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.missing, []);
});

test("runLoop blocks an issue whose gate stays red after maxRetries and stops", () => {
  const { dir, cfg } = buildScratch("false");
  try {
    const processed = runLoop({ ...cfg, maxRetries: 2 }, stubSteps);
    assert.deepEqual(processed, [{ id: "ISS-A", status: "blocked" }]);
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-blocked.json`)));
    // Blocked issue is not moved to done and the loop did not advance to ISS-B.
    assert.ok(!existsSync(resolve(repoRoot, cfg.doneDir)) || !readdirSync(resolve(repoRoot, cfg.doneDir)).includes("ISS-A.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- quota / rate-limit handling ---

test("detectRateLimit fires on quota signals and ignores plain test failures", () => {
  // Real-world signals (a FAILED leg => exit code passed as a non-zero or null).
  assert.equal(detectRateLimit("Error: 429 rate_limit_error", undefined, 1).hit, true);
  assert.equal(detectRateLimit("You have hit your usage limit reached", undefined, 1).hit, true);
  assert.equal(detectRateLimit("Anthropic API overloaded, try again later", undefined, 1).hit, true);
  assert.equal(detectRateLimit("rate limit reached; resets at 15:30", undefined, 1).hit, true);
  assert.equal(detectRateLimit("HTTP 429 Too Many Requests", undefined, 1).hit, true);
  // A non-zero exit with a NORMAL test failure must NOT be treated as a quota hit
  // (otherwise a real red gate would be retried forever).
  assert.equal(detectRateLimit("FAIL src/foo.test.ts: expected 1 to equal 2", undefined, 1).hit, false);
  assert.equal(detectRateLimit("TypeError: x is not a function", undefined, 1).hit, false);
  assert.equal(detectRateLimit("", undefined, 1).hit, false);
  // The matching line is captured for the state record.
  const det = detectRateLimit("line one\nrate limit reached; resets at 16:00\nline three", undefined, 1);
  assert.match(det.message, /rate limit reached; resets at 16:00/);
});

test("detectRateLimit never throttles a SUCCESSFUL leg, even one about quotas", () => {
  // Naight OS is a product *about* quotas / rate limits / 429s: a green leg that
  // summarizes its work routinely prints that vocabulary. Exit 0 => never a hit,
  // so a verified slice is never falsely blocked.
  const greenSummaries = [
    "implemented per-tenant quota enforcement; all tests pass",
    "added rate-limit middleware and a 429 Too Many Requests handler",
    "usage limit policy wired; resets at midnight covered by a test",
  ];
  for (const out of greenSummaries) {
    assert.equal(detectRateLimit(out, undefined, 0).hit, false, `green leg falsely throttled: ${out}`);
  }
  // The very same text on a FAILED leg IS a quota hit.
  assert.equal(detectRateLimit("429 Too Many Requests", undefined, 1).hit, true);
});

test("parseResetMs parses retry-after, relative, ISO, and clock-time resets", () => {
  const now = Date.UTC(2026, 5, 24, 12, 0, 0); // 2026-06-24 12:00:00 UTC
  // retry-after seconds.
  assert.equal(parseResetMs("retry-after: 120", now), now + 120_000);
  assert.equal(parseResetMs("please retry after 30 seconds", now), now + 30_000);
  // relative duration.
  assert.equal(parseResetMs("resets in 2h 14m", now), now + (2 * 3600 + 14 * 60) * 1000);
  assert.equal(parseResetMs("try again in 90s", now), now + 90_000);
  // ISO timestamp.
  assert.equal(parseResetMs("limit until 2026-06-24T13:00:00Z", now), Date.UTC(2026, 5, 24, 13, 0, 0));
  // No parseable reset -> null (caller backs off).
  assert.equal(parseResetMs("rate limited, sorry", now), null);
  assert.equal(parseResetMs("", now), null);
});

test("parseResetMs rolls an already-past clock time to the next day", () => {
  const base = new Date(2026, 5, 24, 12, 0, 0); // local noon
  const now = base.getTime();
  // "at 9:00" is earlier today -> tomorrow 09:00 local.
  const reset = parseResetMs("available again at 9:00", now);
  const expected = new Date(2026, 5, 25, 9, 0, 0, 0).getTime();
  assert.equal(reset, expected);
});

test("computeWaitMs uses the parsed reset when present, capped at the window", () => {
  const cfg = { quotaBackoffStartMs: 5 * 60_000, quotaBackoffCapMs: 5 * 3600_000 };
  const now = 1_000_000;
  // Parseable reset -> wait until reset (+ small pad), clamped to the cap.
  const a = computeWaitMs({ message: "try again in 90s", nowMs: now, attempt: 1, cfg });
  assert.equal(a.waitMs, 90_000 + 5000);
  // A reset beyond the cap is clamped to the cap.
  const b = computeWaitMs({ message: "resets in 10h", nowMs: now, attempt: 1, cfg });
  assert.equal(b.waitMs, cfg.quotaBackoffCapMs);
});

test("computeWaitMs backs off exponentially (capped) when no reset is parseable", () => {
  const cfg = { quotaBackoffStartMs: 5 * 60_000, quotaBackoffCapMs: 5 * 3600_000 };
  const args = (attempt) => ({ message: "rate limited", nowMs: 0, attempt, cfg });
  assert.equal(computeWaitMs(args(1)).waitMs, 5 * 60_000); // start
  assert.equal(computeWaitMs(args(2)).waitMs, 10 * 60_000); // 2x
  assert.equal(computeWaitMs(args(3)).waitMs, 20 * 60_000); // 4x
  // Eventually clamps at the cap, never grows unbounded.
  assert.equal(computeWaitMs(args(20)).waitMs, cfg.quotaBackoffCapMs);
});

// Build a config with a FAKE clock + sleep so quota waits resolve instantly.
// The real Claude status-line probe is DISABLED by default here so a unit test
// never spawns a real `claude` CLI; probe-specific tests opt in by setting
// claudeQuotaProbeEnabled:true and injecting a stub claudeQuotaProbe.
function fakeClockCfg(overrides = {}) {
  const waits = [];
  let clock = 0;
  const cfg = {
    ...DEFAULT_CONFIG,
    quotaStatePath: null, // set per-test; default off
    claudeQuotaProbeEnabled: false, // never spawn the real probe in unit tests
    now: () => clock,
    sleep: (ms) => {
      waits.push(ms);
      clock += ms; // advancing the fake clock simulates time passing while we wait
    },
    ...overrides,
  };
  return { cfg, waits, advance: (ms) => (clock += ms) };
}

test("runLegWithQuota waits the parsed duration, retries the same leg, then proceeds", () => {
  const { cfg, waits } = fakeClockCfg({ quotaStatePath: null, quotaMaxWaitMs: 8 * 3600_000 });
  // Skip quota-state writes for this clock-substance test by stubbing the path off.
  const noWriteCfg = { ...cfg, quotaStatePath: undefined };
  let call = 0;
  const runLeg = () => {
    call += 1;
    // First call is rate-limited with a parseable reset; second call succeeds.
    return call === 1
      ? { output: "Error: 429 rate_limit_error, try again in 120s", result: { status: 1 } }
      : { output: "all good", result: { status: 0 }, transcriptRel: "tx.jsonl" };
  };
  const leg = { actor: "claude", role: "implementer", model: "opus" };
  const out = runLegWithQuota(runLeg, leg, { id: "X" }, withQuotaStateOff(noWriteCfg));
  assert.equal(call, 2, "the SAME leg was re-run exactly once after the wait");
  assert.equal(out.quotaBlocked, false);
  assert.equal(out.transcriptRel, "tx.jsonl");
  assert.deepEqual(waits, [120_000 + 5000], "waited the parsed reset (+pad), nothing more");
});

test("runLegWithQuota never waits or throws on a clean (non-rate-limited) leg", () => {
  const { cfg, waits } = fakeClockCfg();
  let call = 0;
  const runLeg = () => {
    call += 1;
    return { output: "build complete\nFAIL one test", result: { status: 1 } };
  };
  const leg = { actor: "codex", role: "reviewer" };
  const out = runLegWithQuota(runLeg, leg, { id: "X" }, withQuotaStateOff(cfg));
  assert.equal(call, 1, "a normal failing leg runs exactly once (gate decides, not quota)");
  assert.equal(out.quotaBlocked, false);
  assert.deepEqual(waits, [], "no quota wait on a non-rate-limited leg");
});

test("runLegWithQuota leaves a SUCCESSFUL quota-mentioning leg alone (no false block)", () => {
  const { cfg, waits } = fakeClockCfg();
  let call = 0;
  const runLeg = () => {
    call += 1;
    // Exit 0 + quota vocabulary: this is a GREEN slice, not a rate limit.
    return { output: "implemented rate-limit middleware; 429 handler added", result: { status: 0 } };
  };
  const leg = { actor: "claude", role: "implementer" };
  const out = runLegWithQuota(runLeg, leg, { id: "X" }, withQuotaStateOff(cfg));
  assert.equal(call, 1, "a successful leg runs exactly once even if it talks about quotas");
  assert.equal(out.quotaBlocked, false);
  assert.deepEqual(waits, [], "no quota wait on a successful leg");
});

test("computeWaitMs floors a near-zero parsed reset to avoid a busy-spin", () => {
  const cfg = { quotaBackoffStartMs: 5 * 60_000, quotaBackoffCapMs: 5 * 3600_000 };
  // "retry-after: 0" would otherwise wait only the 5s pad; the 30s floor prevents
  // a tight respawn loop against a misbehaving provider.
  const out = computeWaitMs({ message: "retry-after: 0", nowMs: 0, attempt: 1, cfg });
  assert.equal(out.waitMs, 30_000);
  // A genuine short reset (90s) is still honored closely (above the floor).
  const ok = computeWaitMs({ message: "try again in 90s", nowMs: 0, attempt: 1, cfg });
  assert.equal(ok.waitMs, 90_000 + 5000);
});

test("runLegWithQuota gives up (quotaBlocked) once the hard cap is exceeded, never throws", () => {
  // Tiny cap so a couple of backoffs blow past it; sleep is faked so this is instant.
  const { cfg, waits } = fakeClockCfg({
    quotaMaxWaitMs: 6 * 60_000,
    quotaBackoffStartMs: 5 * 60_000,
    quotaBackoffCapMs: 5 * 3600_000,
  });
  const runLeg = () => ({ output: "rate limited, please slow down", result: { status: 1 } });
  const leg = { actor: "claude", role: "implementer" };
  const out = runLegWithQuota(runLeg, leg, { id: "X" }, withQuotaStateOff(cfg));
  assert.equal(out.quotaBlocked, true, "blocks for a human past the cap instead of looping forever");
  // First backoff (5m) fits under the 6m cap and is waited; the next (10m) would
  // exceed it, so we stop without waiting it.
  assert.deepEqual(waits, [5 * 60_000]);
});

// Helper: a cfg whose quota-state writes are no-ops (we test the control flow,
// not the file IO, in these unit tests). A falsy quotaStatePath disables the
// write — quota state is advisory, never load-bearing.
function withQuotaStateOff(cfg) {
  return { ...cfg, quotaStatePath: null };
}

test("runLegWithQuota writes throttled then available quota state to disk", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-quota-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  try {
    const { cfg } = fakeClockCfg({ quotaStatePath: quotaRel, quotaMaxWaitMs: 8 * 3600_000 });
    let call = 0;
    const runLeg = () => {
      call += 1;
      return call === 1
        ? { output: "usage limit reached; resets in 1h", result: { status: 1 } }
        : { output: "done", result: { status: 0 } };
    };
    const leg = { actor: "claude", role: "implementer", model: "claude-opus-4-8" };
    const out = runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    assert.equal(out.quotaBlocked, false);
    const state = JSON.parse(readFileSync(resolve(repoRoot, quotaRel), "utf8"));
    // After a successful retry the agent is recorded available again (honest:
    // no fabricated percentage, just the real status + model).
    assert.equal(state.agents.claude.status, "available");
    assert.equal(state.agents.claude.model, "claude-opus-4-8");
    assert.equal(state.agents.claude.reset_at, null);
    assert.ok(state.updated_at, "the file carries an updated_at timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- real quota-window extraction (R8: prove the data, never fabricate) ---

test("parseCodexQuotaWindows extracts REAL 5h + weekly percentages from a rollout", () => {
  // The exact shape Codex writes to its session rollout JSONL (proven by probe):
  // a token_count event whose payload.rate_limits carries real used_percent.
  const rollout = [
    `{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":100}}}}`,
    `{"timestamp":"2026-06-24T16:50:57Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":38,"window_minutes":300,"resets_at":1782337221},"secondary":{"used_percent":12,"window_minutes":10080,"resets_at":1782373367},"plan_type":"pro"}}}`,
  ].join("\n");
  const w = parseCodexQuotaWindows(rollout);
  assert.equal(w["5h"].used_pct, 38, "real 5h percentage (primary)");
  assert.equal(w["5h"].remaining, 62);
  assert.equal(w["5h"].reset_at, new Date(1782337221 * 1000).toISOString());
  assert.equal(w.weekly.used_pct, 12, "real weekly percentage (secondary)");
  assert.equal(w.weekly.reset_at, new Date(1782373367 * 1000).toISOString());
});

test("parseCodexQuotaWindows uses the LAST rate_limits and tolerates junk lines", () => {
  const rollout = [
    `not json at all`,
    `{"payload":{"rate_limits":{"primary":{"used_percent":5,"resets_at":1782300000}}}}`,
    `{"payload":{"rate_limits":{"primary":{"used_percent":41,"resets_at":1782337221},"secondary":{"used_percent":12,"resets_at":1782373367}}}}`,
  ].join("\n");
  const w = parseCodexQuotaWindows(rollout);
  assert.equal(w["5h"].used_pct, 41, "the newest token_count state wins");
  assert.equal(w.weekly.used_pct, 12);
});

test("parseCodexQuotaWindows clamps out-of-range and returns {} for no data", () => {
  assert.deepEqual(parseCodexQuotaWindows(""), {});
  assert.deepEqual(parseCodexQuotaWindows("plain log\nno rate limits here"), {});
  const clamped = parseCodexQuotaWindows(
    `{"payload":{"rate_limits":{"primary":{"used_percent":150,"resets_at":1782337221}}}}`,
  );
  assert.equal(clamped["5h"].used_pct, 100, "percentages clamp to [0,100]");
});

test("parseClaudeQuotaWindows falls back to a REAL 5h reset + null percentage from rate_limit_event", () => {
  // With NO status-line capture, the stream-json rate_limit_event is the only
  // surface: status + resetsAt + window type, NO % and no weekly window.
  const transcript = [
    `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
    `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1782328800,"rateLimitType":"five_hour"}}`,
  ].join("\n");
  const w = parseClaudeQuotaWindows(transcript);
  assert.equal(w["5h"].used_pct, null, "no status-line capture => honest null, never fabricated");
  assert.equal(w["5h"].remaining, null);
  assert.equal(w["5h"].reset_at, new Date(1782328800 * 1000).toISOString(), "but the 5h reset IS real");
  assert.equal(w.weekly, undefined, "no weekly window from the rate_limit_event fallback");
});

// A REAL captured status-line payload (see https://code.claude.com/docs/en/statusline),
// taken verbatim from a live `claude` interactive probe (v2.1.183, Max plan).
const REAL_CLAUDE_STATUSLINE = {
  session_id: "a5fba7fe-105c-4cc4-b345-b88adece075c",
  model: { id: "claude-opus-4-8[1m]", display_name: "Opus 4.8 (1M context)" },
  version: "2.1.183",
  context_window: { used_percentage: 3, remaining_percentage: 97 },
  rate_limits: {
    five_hour: { used_percentage: 1, resets_at: 1782395400 },
    seven_day: { used_percentage: 10, resets_at: 1782792000 },
  },
};

test("parseClaudeStatusRateLimits extracts REAL 5h + weekly % from a captured status-line payload", () => {
  // Accepts the full status-line object (with a top-level rate_limits).
  const w = parseClaudeStatusRateLimits(REAL_CLAUDE_STATUSLINE);
  assert.equal(w["5h"].used_pct, 1, "real 5h percentage (five_hour)");
  assert.equal(w["5h"].remaining, 99);
  assert.equal(w["5h"].reset_at, new Date(1782395400 * 1000).toISOString());
  assert.equal(w.weekly.used_pct, 10, "real weekly percentage (seven_day)");
  assert.equal(w.weekly.remaining, 90);
  assert.equal(w.weekly.reset_at, new Date(1782792000 * 1000).toISOString());
});

test("parseClaudeStatusRateLimits also accepts a bare rate_limits object and tolerates absence", () => {
  const w = parseClaudeStatusRateLimits(REAL_CLAUDE_STATUSLINE.rate_limits);
  assert.equal(w["5h"].used_pct, 1);
  assert.equal(w.weekly.used_pct, 10);
  // A null/absent rate_limits (non-subscriber, or before first API response) => {}.
  assert.deepEqual(parseClaudeStatusRateLimits(null), {});
  assert.deepEqual(parseClaudeStatusRateLimits({}), {});
  assert.deepEqual(parseClaudeStatusRateLimits({ rate_limits: null }), {});
  // One window present, the other absent: surface only the real one.
  const oneWin = parseClaudeStatusRateLimits({ five_hour: { used_percentage: 42, resets_at: 1782395400 } });
  assert.equal(oneWin["5h"].used_pct, 42);
  assert.equal(oneWin.weekly, undefined, "absent seven_day => no weekly window, never zero");
});

test("parseClaudeQuotaWindows PREFERS a captured status-line rate_limits line (real %) over the event", () => {
  // A transcript that carries BOTH a status-line capture line AND a reset-only
  // rate_limit_event must surface the REAL percentages, not the null fallback.
  const transcript = [
    `{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1782328800,"rateLimitType":"five_hour"}}`,
    JSON.stringify(REAL_CLAUDE_STATUSLINE),
  ].join("\n");
  const w = parseClaudeQuotaWindows(transcript);
  assert.equal(w["5h"].used_pct, 1, "real 5h percentage from the status-line capture wins");
  assert.equal(w["5h"].reset_at, new Date(1782395400 * 1000).toISOString());
  assert.equal(w.weekly.used_pct, 10, "real weekly percentage surfaced");
});

test("parseClaudeQuotaWindows uses the LAST status-line capture when several are present", () => {
  const transcript = [
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1782395400 } } }),
    JSON.stringify({ rate_limits: { five_hour: { used_percentage: 7, resets_at: 1782399000 }, seven_day: { used_percentage: 11, resets_at: 1782792000 } } }),
  ].join("\n");
  const w = parseClaudeQuotaWindows(transcript);
  assert.equal(w["5h"].used_pct, 7, "newest status-line state wins");
  assert.equal(w.weekly.used_pct, 11);
});

test("parseClaudeQuotaWindows returns {} when no rate_limit_event is present", () => {
  assert.deepEqual(parseClaudeQuotaWindows(""), {});
  assert.deepEqual(
    parseClaudeQuotaWindows(`{"type":"assistant","message":{"content":[]}}`),
    {},
    "a transcript with no rate_limit_event yields no windows (unknown)",
  );
});

test("parseQuotaWindows dispatches by actor and is unknown for others", () => {
  const codex = `{"payload":{"rate_limits":{"primary":{"used_percent":7,"resets_at":1782337221}}}}`;
  assert.equal(parseQuotaWindows("codex", codex)["5h"].used_pct, 7);
  const claude = `{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1782328800,"rateLimitType":"five_hour"}}`;
  assert.equal(parseQuotaWindows("claude", claude)["5h"].used_pct, null);
  assert.deepEqual(parseQuotaWindows("someone-else", codex), {}, "unknown actor => no windows");
});

test("runLegWithQuota records REAL windows from a Codex rollout on an available leg", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-quota-win-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  const rolloutRel = `${scratchRel}/codex-rollout.jsonl`;
  try {
    // The leg's captured transcript carries Codex's real rate_limits payload.
    writeFileSync(
      resolve(repoRoot, rolloutRel),
      `{"payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":38,"resets_at":1782337221},"secondary":{"used_percent":12,"resets_at":1782373367}}}}\n`,
    );
    const { cfg } = fakeClockCfg({ quotaStatePath: quotaRel, quotaMaxWaitMs: 8 * 3600_000 });
    const runLeg = () => ({ output: "review done", result: { status: 0 }, transcriptRel: rolloutRel });
    const leg = { actor: "codex", role: "reviewer", model: "gpt-5.5" };
    const out = runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    assert.equal(out.quotaBlocked, false);
    const state = JSON.parse(readFileSync(resolve(repoRoot, quotaRel), "utf8"));
    assert.equal(state.agents.codex.status, "available");
    // The REAL percentages are persisted for the footer to render live.
    assert.equal(state.agents.codex.windows["5h"].used_pct, 38);
    assert.equal(state.agents.codex.windows.weekly.used_pct, 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLegWithQuota records REAL Claude 5h + weekly % from the status-line probe on an available leg", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-claude-quota-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  const transcriptRel = `${scratchRel}/claude-transcript.jsonl`;
  try {
    // The leg's own -p transcript carries ONLY a reset-only rate_limit_event.
    writeFileSync(
      resolve(repoRoot, transcriptRel),
      `{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1782395400,"rateLimitType":"five_hour"}}\n`,
    );
    // Inject a status-line probe returning the REAL captured rate_limits payload
    // (no real CLI spawn). claudeQuotaProbeMinIntervalMs:0 lets it run immediately.
    let probeCalls = 0;
    const claudeQuotaProbe = () => {
      probeCalls += 1;
      return REAL_CLAUDE_STATUSLINE.rate_limits;
    };
    const { cfg } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeEnabled: true,
      claudeQuotaProbeMinIntervalMs: 0,
      claudeQuotaProbe,
    });
    const runLeg = () => ({ output: "impl done", result: { status: 0 }, transcriptRel });
    const leg = { actor: "claude", role: "implementer", model: "claude-opus-4-8" };
    const out = runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    assert.equal(out.quotaBlocked, false);
    assert.equal(probeCalls, 1, "the status-line probe ran once for the available Claude leg");
    const state = JSON.parse(readFileSync(resolve(repoRoot, quotaRel), "utf8"));
    assert.equal(state.agents.claude.status, "available");
    // The REAL percentages from the documented status-line surface are persisted.
    assert.equal(state.agents.claude.windows["5h"].used_pct, 1, "real 5h % from the status-line capture");
    assert.equal(state.agents.claude.windows.weekly.used_pct, 10, "real weekly % from the status-line capture");
    assert.equal(state.agents.claude.windows["5h"].reset_at, new Date(1782395400 * 1000).toISOString());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLegWithQuota keeps the honest reset-only 5h window when the Claude probe yields nothing", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-claude-quota-none-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  const transcriptRel = `${scratchRel}/claude-transcript.jsonl`;
  try {
    writeFileSync(
      resolve(repoRoot, transcriptRel),
      `{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1782395400,"rateLimitType":"five_hour"}}\n`,
    );
    // A non-subscriber / failed probe returns null => no fabricated numbers.
    const { cfg } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeEnabled: true,
      claudeQuotaProbeMinIntervalMs: 0,
      claudeQuotaProbe: () => null,
    });
    const runLeg = () => ({ output: "impl done", result: { status: 0 }, transcriptRel });
    const leg = { actor: "claude", role: "implementer", model: "claude-opus-4-8" };
    runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    const state = JSON.parse(readFileSync(resolve(repoRoot, quotaRel), "utf8"));
    assert.equal(state.agents.claude.windows["5h"].used_pct, null, "honest null %, never fabricated");
    assert.equal(state.agents.claude.windows["5h"].reset_at, new Date(1782395400 * 1000).toISOString(), "but the real 5h reset is kept");
    assert.equal(state.agents.claude.windows.weekly, undefined, "no weekly window invented");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLegWithQuota does NOT run the status-line probe for a Codex leg or when disabled", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-claude-quota-skip-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  try {
    let probeCalls = 0;
    const probe = () => {
      probeCalls += 1;
      return REAL_CLAUDE_STATUSLINE.rate_limits;
    };
    // A Codex leg never triggers the Claude probe.
    const { cfg: codexCfg } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeMinIntervalMs: 0,
      claudeQuotaProbe: probe,
    });
    runLegWithQuota(
      () => ({ output: "ok", result: { status: 0 } }),
      { actor: "codex", role: "reviewer", model: "gpt-5.5" },
      { id: "X" },
      codexCfg,
    );
    assert.equal(probeCalls, 0, "Codex legs never invoke the Claude status-line probe");
    // A Claude leg with the probe disabled also never calls it.
    const { cfg: offCfg } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeEnabled: false,
      claudeQuotaProbe: probe,
    });
    runLegWithQuota(
      () => ({ output: "ok", result: { status: 0 } }),
      { actor: "claude", role: "implementer", model: "claude-opus-4-8" },
      { id: "X" },
      offCfg,
    );
    assert.equal(probeCalls, 0, "a disabled probe is never invoked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLegWithQuota throttles the Claude status-line probe to once per window", () => {
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-claude-quota-throttle-"));
  const scratchRel = relative(repoRoot, dir);
  const quotaRel = `${scratchRel}/quota-state.json`;
  try {
    let probeCalls = 0;
    const probe = () => {
      probeCalls += 1;
      return REAL_CLAUDE_STATUSLINE.rate_limits;
    };
    const window = 30 * 60 * 1000;
    // The throttle marker is the durable last_probe_at in this test's own scratch
    // quota-state file, so there is no cross-test contamination.
    const { cfg, advance } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeEnabled: true,
      claudeQuotaProbeMinIntervalMs: window,
      claudeQuotaProbe: probe,
    });
    advance(10 * 24 * 3600_000); // a non-zero clock so last_probe_at is well-formed
    const leg = { actor: "claude", role: "implementer", model: "claude-opus-4-8" };
    const runLeg = () => ({ output: "ok", result: { status: 0 } });
    runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    runLegWithQuota(runLeg, leg, { id: "Y" }, cfg);
    assert.equal(probeCalls, 1, "second leg within the same window reuses the throttled probe");
    // Advance past the window: the next leg probes again.
    advance(window + 60_000);
    runLegWithQuota(runLeg, leg, { id: "Z" }, cfg);
    assert.equal(probeCalls, 2, "after the window elapses, the probe runs again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_QUOTA_PATTERNS is configurable and case-insensitive", () => {
  // Custom pattern set narrows what counts as a quota signal.
  const custom = [/please wait/i];
  assert.equal(detectRateLimit("RATE LIMIT hit", custom).hit, false);
  assert.equal(detectRateLimit("Please Wait and retry", custom).hit, true);
  // Default set is case-insensitive.
  assert.equal(detectRateLimit("RATE_LIMIT", DEFAULT_QUOTA_PATTERNS).hit, true);
});

// --------------------------------------------------------------------------
// Parallel scheduler (pure: ready set + independence rule)
// --------------------------------------------------------------------------

test("clampConcurrency floors bad values to 1 (sequential default)", () => {
  assert.equal(clampConcurrency(undefined), 1);
  assert.equal(clampConcurrency("0"), 1);
  assert.equal(clampConcurrency(-3), 1);
  assert.equal(clampConcurrency("abc"), 1);
  assert.equal(clampConcurrency("3"), 3);
  assert.equal(clampConcurrency(2.9), 2);
});

test("computeReadySet returns deps-satisfied, not-done, not-running issues in index order", () => {
  const issues = [
    { id: "A", depends_on: [] },
    { id: "B", depends_on: ["A"] },
    { id: "C", depends_on: [] },
  ];
  // Nothing done: only the dependency-free roots are ready, in order.
  assert.deepEqual(computeReadySet(issues, new Set()).map((i) => i.id), ["A", "C"]);
  // A done: B becomes ready; A excluded as done.
  assert.deepEqual(computeReadySet(issues, new Set(["A"])).map((i) => i.id), ["B", "C"]);
  // C already running: excluded from the ready set so it is never double-claimed.
  assert.deepEqual(computeReadySet(issues, new Set(), new Set(["C"])).map((i) => i.id), ["A"]);
});

test("issueClaim prefers explicit claims, falls back to graph_refs", () => {
  assert.deepEqual([...issueClaim({ graph_refs: ["node:x"] })], ["node:x"]);
  assert.deepEqual([...issueClaim({ claims: ["file:a"], graph_refs: ["node:x"] })], ["file:a"]);
  assert.deepEqual([...issueClaim({ claimed_files: ["file:b"] })], ["file:b"]);
});

test("buildDepsClosure resolves transitive dependencies", () => {
  const issues = [
    { id: "A", depends_on: [] },
    { id: "B", depends_on: ["A"] },
    { id: "C", depends_on: ["B"] },
  ];
  const closure = buildDepsClosure(issues);
  assert.deepEqual([...closure.get("C")].sort(), ["A", "B"]);
  assert.deepEqual([...closure.get("B")], ["A"]);
  assert.deepEqual([...closure.get("A")], []);
});

test("issuesIndependent requires NO dependency path AND disjoint claims", () => {
  const issues = [
    { id: "A", depends_on: [], graph_refs: ["node:x"] },
    { id: "B", depends_on: ["A"], graph_refs: ["node:y"] }, // depends on A
    { id: "C", depends_on: [], graph_refs: ["node:x"] }, // shares node:x with A
    { id: "D", depends_on: [], graph_refs: ["node:z"] }, // truly independent of A
  ];
  const closure = buildDepsClosure(issues);
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
  // A <-> B: dependency path => NOT independent.
  assert.equal(issuesIndependent(byId.A, byId.B, closure), false);
  // A <-> C: disjoint? no — both claim node:x => NOT independent.
  assert.equal(issuesIndependent(byId.A, byId.C, closure), false);
  // A <-> D: no dep path, disjoint claims => independent.
  assert.equal(issuesIndependent(byId.A, byId.D, closure), true);
});

test("selectIndependentBatch with limit 1 returns exactly one ready issue (sequential)", () => {
  const issues = [
    { id: "A", depends_on: [], graph_refs: ["node:x"] },
    { id: "B", depends_on: [], graph_refs: ["node:y"] },
  ];
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 1, closure);
  assert.deepEqual(batch.map((i) => i.id), ["A"]);
});

test("selectIndependentBatch picks only mutually-independent issues up to the limit", () => {
  const issues = [
    { id: "A", depends_on: [], graph_refs: ["node:x"] },
    { id: "B", depends_on: [], graph_refs: ["node:x"] }, // collides with A on node:x
    { id: "C", depends_on: [], graph_refs: ["node:y"] }, // independent of A
    { id: "D", depends_on: [], graph_refs: ["node:z"] }, // independent of A and C
  ];
  const closure = buildDepsClosure(issues);
  // limit 3: A selected; B skipped (claims node:x like A); C and D selected.
  const batch = selectIndependentBatch(issues, [], 3, closure);
  assert.deepEqual(batch.map((i) => i.id), ["A", "C", "D"]);
});

test("selectIndependentBatch respects already-running issues (no shared claim with them)", () => {
  const issues = [
    { id: "B", depends_on: [], graph_refs: ["node:x"] }, // shares node:x with running A
    { id: "C", depends_on: [], graph_refs: ["node:y"] },
  ];
  const running = [{ id: "A", depends_on: [], graph_refs: ["node:x"] }];
  const closure = buildDepsClosure([...issues, ...running]);
  // One slot free (limit 2, one running). B collides with A; C is compatible.
  const batch = selectIndependentBatch(issues, running, 2, closure);
  assert.deepEqual(batch.map((i) => i.id), ["C"]);
});

// --------------------------------------------------------------------------
// Parallel loop: real git worktrees, real gate + ledger, fake legs
// --------------------------------------------------------------------------

// Build a parallel-loop fixture. The git ops (worktree add / merge / commit) run
// against the MAIN root = requireRepoRoot() = the test target root, exactly as in
// production where the main root IS the git repo and the ledger root. So we init
// ONE git repo AT repoRoot (idempotent across tests) and give each test a fresh
// subdir scratch; all cfg paths stay relative to repoRoot for the ledger writer,
// and worktrees live under the scratch's .wt. The fixture COMMITS the scratch so
// each parallel issue's worktree branches from a tree that already contains its
// issue files (the merge then only carries the agent's new disjoint code).
let parallelGitReady = false;
function ensureRepoRootGit() {
  if (parallelGitReady) return;
  const git = (a) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });
  if (!existsSync(resolve(repoRoot, ".git"))) {
    git(["init", "-q"]);
    git(["config", "user.email", "t@local"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-qm", "root"]);
  }
  parallelGitReady = true;
}

function buildParallelScratch({ issues, gateById = {} }) {
  ensureRepoRootGit();
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-parallel-"));
  const scratchRel = relative(repoRoot, dir);
  const issuesDir = `${scratchRel}/issues`;
  const doneDir = `${scratchRel}/issues/done`;
  const gatesDir = `${scratchRel}/gates`;
  const reportsDir = `${scratchRel}/reports`;
  const transcriptsDir = `${scratchRel}/transcripts`;
  mkdirSync(resolve(repoRoot, issuesDir), { recursive: true });
  for (const issue of issues) writeFileSync(resolve(repoRoot, `${issuesDir}/${issue.id}.md`), `# ${issue.id}\n`);
  const indexRel = `${scratchRel}/issue-index.json`;
  const ledgerRel = `${scratchRel}/progress-ledger.json`;
  const index = {
    baseline_id: "baseline-test",
    verification_evidence_ref_grammar: `^${scratchRel}/(gates|reports)/.+`,
    issues: issues.map((issue) => ({
      ...issue,
      title: issue.title ?? issue.id,
      verification_gate_ids: [`gate:test:${issue.id}`],
      gate_command: gateById[issue.id] ?? "true",
      path: `${issuesDir}/${issue.id}.md`,
    })),
  };
  writeFileSync(resolve(repoRoot, indexRel), `${JSON.stringify(index, null, 2)}\n`);
  // Commit the scratch into the root repo so worktrees branch from a tree that
  // already has these issue files (.gitignore keeps prior scratches out of the way).
  const git = (a) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });
  git(["add", "--", scratchRel]);
  git(["commit", "-qm", `scratch ${scratchRel}`]);
  const cfg = {
    issueIndexPath: indexRel,
    progressLedgerPath: ledgerRel,
    issuesDir,
    doneDir,
    gatesDir,
    reportsDir,
    transcriptsDir,
    quotaStatePath: `${reportsDir}/quota-state.json`,
    baselineId: "baseline-test",
    worktreesDir: `${scratchRel}/.wt`,
  };
  return { dir, scratchRel, cfg };
}

// Fake async legs that write a DISJOINT per-issue file into the worktree (execRoot)
// so each worktree branch has real, non-overlapping content to merge. The file is
// written under the test's scratch path (relative to the worktree root) so after
// the merge it lands at repoRoot/<scratchRel>/gen/<id>.txt — test-scoped, never
// colliding across tests. Records the concurrency window (start/end ms) per issue
// so a test can assert real overlap.
function parallelFakeSteps(timeline, scratchRel) {
  const leg = (who) => async (issue, cfg) => {
    timeline.push({ id: issue.id, who, phase: "start", t: Date.now() });
    await new Promise((r) => setTimeout(r, 20));
    if (cfg?.execRoot) {
      const genDir = resolve(cfg.execRoot, scratchRel, "gen");
      mkdirSync(genDir, { recursive: true });
      writeFileSync(resolve(genDir, `${issue.id}.txt`), `${who} ${issue.id}\n`);
    }
    timeline.push({ id: issue.id, who, phase: "end", t: Date.now() });
    return { output: `${who} ${issue.id}`, result: { status: 0 } };
  };
  return { runImplementer: leg("impl"), runReviewer: leg("rev") };
}

test("runLoopParallel runs independent issues concurrently in distinct worktrees and integrates them", async () => {
  // Two independent roots (A, D) + a chain (A->B, A->C share node:ledger; D->E).
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:ledger"] },
    { id: "ISS-B", depends_on: ["ISS-A"], graph_refs: ["node:ledger"] },
    { id: "ISS-D", depends_on: [], graph_refs: ["node:cat"] },
    { id: "ISS-E", depends_on: ["ISS-D"], graph_refs: ["node:cat"] },
  ];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues });
  const timeline = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true" },
      { ...parallelFakeSteps(timeline, scratchRel), skipWorktreeIgnore: true },
    );
    // (a) Every issue verified exactly once.
    const verified = processed.filter((p) => p.status === "verified").map((p) => p.id).sort();
    assert.deepEqual(verified, ["ISS-A", "ISS-B", "ISS-D", "ISS-E"]);
    assert.equal(new Set(processed.map((p) => p.id)).size, 4, "no issue settled twice");
    // (a) Concurrency was REAL: the two independent roots A and D overlapped in time.
    const win = (id) => {
      const s = Math.min(...timeline.filter((e) => e.id === id && e.phase === "start").map((e) => e.t));
      const e = Math.max(...timeline.filter((e) => e.id === id && e.phase === "end").map((e) => e.t));
      return [s, e];
    };
    const [as, ae] = win("ISS-A");
    const [ds, de] = win("ISS-D");
    assert.ok(as < de && ds < ae, "ISS-A and ISS-D execution windows overlapped (ran concurrently)");
    // (b) Dependent issues respected order: B started only after A's worktree integrated.
    const bStart = Math.min(...timeline.filter((e) => e.id === "ISS-B" && e.phase === "start").map((e) => e.t));
    assert.ok(bStart >= ae, "ISS-B started after ISS-A finished (dependency order)");
    // Distinct worktrees existed: every issue's disjoint file landed on MAIN after merge.
    for (const id of ["ISS-A", "ISS-B", "ISS-D", "ISS-E"]) {
      assert.ok(
        existsSync(resolve(repoRoot, scratchRel, "gen", `${id}.txt`)),
        `${id} merged its worktree file onto main`,
      );
    }
    // (c) Ledger ends consistent: every issue verified on its node, no leftover worktrees.
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    for (const id of verified) {
      const node = issues.find((i) => i.id === id).graph_refs[0];
      const state = ledger.graph_item_states.find((s) => s.graph_ref === node);
      assert.equal(state.issue_states[id], "verified", `${id} verified in ledger`);
    }
    assert.equal((ledger.active_items ?? []).length, 0, "no dangling active items after completion");
    const wtDir = resolve(repoRoot, cfg.worktreesDir);
    const leftover = existsSync(wtDir) ? readdirSync(wtDir).filter((f) => !f.startsWith(".")) : [];
    assert.deepEqual(leftover, [], "all worktrees removed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel blocks a forced-red issue WITHOUT blocking the independent others", async () => {
  // A always-green; B (independent) gate forced red; C independent green.
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:a"] },
    { id: "ISS-B", depends_on: [], graph_refs: ["node:b"] },
    { id: "ISS-C", depends_on: [], graph_refs: ["node:c"] },
  ];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues, gateById: { "ISS-B": "false" } });
  const timeline = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 3, maxRetries: 1, defaultGateCommand: "true" },
      { ...parallelFakeSteps(timeline, scratchRel), skipWorktreeIgnore: true },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    // B is blocked (gate red), A and C still verified — the block did NOT cascade.
    assert.equal(byId["ISS-B"], "blocked", "forced-red B is blocked");
    assert.equal(byId["ISS-A"], "verified", "independent A still verified");
    assert.equal(byId["ISS-C"], "verified", "independent C still verified");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-B-blocked.json`)), "B has a blocked report");
    // A and C merged their code; B did not move to done/.
    const done = readdirSync(resolve(repoRoot, cfg.doneDir));
    assert.ok(done.includes("ISS-A.md") && done.includes("ISS-C.md"), "A and C moved to done/");
    assert.ok(!done.includes("ISS-B.md"), "blocked B NOT moved to done/");
    // No leftover worktrees even for the blocked issue.
    const wtDir = resolve(repoRoot, cfg.worktreesDir);
    const leftover = existsSync(wtDir) ? readdirSync(wtDir).filter((f) => !f.startsWith(".")) : [];
    assert.deepEqual(leftover, [], "worktrees removed including the blocked issue's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel: an EARLY block never stops LATER independent issues from being scheduled", async () => {
  // 5 fully-independent issues at maxParallel=1 so they are scheduled ONE AT A
  // TIME, in order. The FIRST (ISS-1) gate is forced red. A naive `stop`-on-block
  // scheduler would never start ISS-2..5 (they are scheduled in LATER batches,
  // after the block). The correct scheduler blocks only ISS-1 and runs the rest.
  const issues = Array.from({ length: 5 }, (_, i) => ({
    id: `ISS-${i + 1}`,
    depends_on: [],
    graph_refs: [`node:m${i + 1}`],
  }));
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues, gateById: { "ISS-1": "false" } });
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 1, maxRetries: 1, defaultGateCommand: "true" },
      { ...parallelFakeSteps([], scratchRel), skipWorktreeIgnore: true },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-1"], "blocked", "the early-blocked issue is blocked");
    for (const id of ["ISS-2", "ISS-3", "ISS-4", "ISS-5"]) {
      assert.equal(byId[id], "verified", `${id} (scheduled AFTER the block) still ran and verified`);
    }
    // Exactly the four independent issues moved to done/; the blocked one did not.
    const done = readdirSync(resolve(repoRoot, cfg.doneDir)).sort();
    assert.deepEqual(done, ["ISS-2.md", "ISS-3.md", "ISS-4.md", "ISS-5.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel: a worktree-cleanup failure never masks a verified result", async () => {
  // A green issue whose worktree removal THROWS. The result must stay verified and
  // the loop must not crash — cleanup is best-effort and must never override the
  // settled outcome (a thrown cleanup must not mislabel a verified issue as blocked).
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:a"] }]
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues })
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true" },
      {
        ...parallelFakeSteps([], scratchRel),
        skipWorktreeIgnore: true,
        // Let the real worktree be created/integrated, but make removal throw.
        removeWorktree: () => {
          throw new Error("simulated EBUSY on worktree removal")
        },
      },
    );
    assert.deepEqual(processed, [{ id: "ISS-A", status: "verified" }], "verified despite cleanup throwing");
    assert.ok(readdirSync(resolve(repoRoot, cfg.doneDir)).includes("ISS-A.md"), "still moved to done/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel keeps the ledger consistent under many concurrent completions (no lost events)", async () => {
  // 6 fully-independent issues at N=6: maximal concurrent completion pressure on
  // the shared ledger + integration lock. Every issue must verify exactly once.
  const issues = Array.from({ length: 6 }, (_, i) => ({
    id: `ISS-${i + 1}`,
    depends_on: [],
    graph_refs: [`node:n${i + 1}`],
  }));
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues });
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 6, defaultGateCommand: "true" },
      { ...parallelFakeSteps([], scratchRel), skipWorktreeIgnore: true },
    );
    const verified = processed.filter((p) => p.status === "verified").map((p) => p.id);
    assert.equal(verified.length, 6, "all six verified");
    assert.equal(new Set(verified).size, 6, "each verified exactly once (no duplicate completion)");
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    // Every node verified for its own issue; the revision advanced monotonically.
    for (const issue of issues) {
      const state = ledger.graph_item_states.find((s) => s.graph_ref === issue.graph_refs[0]);
      assert.equal(state?.issue_states[issue.id], "verified", `${issue.id} verified, no lost event`);
    }
    assert.ok(typeof ledger.revision === "number" && ledger.revision >= 6, "ledger revision advanced per write");
    assert.equal((ledger.active_items ?? []).length, 0, "no dangling active items");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoop(maxParallel=1) is the sequential path: returns an array, identical behavior", () => {
  // The dispatch boundary: at N=1, runLoop stays synchronous and sequential.
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:x"] },
    { id: "ISS-B", depends_on: ["ISS-A"], graph_refs: ["node:y"] },
  ];
  const { dir, cfg } = buildParallelScratch({ issues });
  try {
    const processed = runLoop(
      { ...cfg, maxParallel: 1, defaultGateCommand: "true" },
      { runImplementer: () => {}, runReviewer: () => {}, commit: () => {} },
    );
    // Synchronous array return (NOT a promise) — the sequential contract is intact.
    assert.ok(Array.isArray(processed), "N=1 returns an array synchronously");
    assert.deepEqual(processed, [
      { id: "ISS-A", status: "verified" },
      { id: "ISS-B", status: "verified" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
