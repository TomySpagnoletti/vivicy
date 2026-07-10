// MUST be the first import: binds VIVICY_TARGET_ROOT before dev-loop.ts binds its target root at module load (see test-target-root.ts for why order matters).
import { testTargetRoot as repoRoot } from "./test-target-root.ts";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  agentCliArgs,
  buildArchitectureIndex,
  buildDepsClosure,
  clampConcurrency,
  composePrompt,
  computeDoneIds,
  computeReadySet,
  computeWaitMs,
  CONFLICT_DISTANCE_FAR,
  DEFAULT_CONFIG,
  DEFAULT_QUOTA_PATTERNS,
  defaultCreateWorktree,
  defaultRemoveWorktree,
  defaultResetWorktreeFrozenArtifacts,
  defaultRunImplementer,
  defaultRunReviewer,
  dependenciesSatisfied,
  extractTraceabilityBlock,
  frozenIntegrationPaths,
  detectRateLimit,
  footprintDistance,
  issueClaim,
  issueFootprint,
  issuesIndependent,
  issueUpdatePreservesTraceability,
  MAX_CONCURRENCY,
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
  spikeGatesSatisfied,
} from "./dev-loop.ts";
import type { Config, Issue, LoopSteps, ProcessedIssue } from "./dev-loop.ts";
import { checkSkills, missingSkills, readDeclaredSkills } from "./dev-preflight.ts";
import { nextSupervisorAction } from "./dev-loop-supervised.ts";

after(() => {
  rmSync(repoRoot, { recursive: true, force: true });
});

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
  assert.equal(pickNextIssue(issues, new Set())!.id, "A");
  assert.equal(pickNextIssue(issues, new Set(["A"]))!.id, "B");
  assert.equal(pickNextIssue(issues, new Set(["A", "B"])), null);
});

test("spikeGatesSatisfied gates an issue on its verified spikes", () => {
  assert.equal(spikeGatesSatisfied({ spike_gates: [] }, new Set()), true);
  assert.equal(spikeGatesSatisfied({}, new Set()), true);
  assert.equal(spikeGatesSatisfied({ spike_gates: ["gate:phase0:s01-x"] }, new Set()), false);
  assert.equal(spikeGatesSatisfied({ spike_gates: ["gate:phase0:s01-x"] }, new Set(["gate:phase0:s01-x"])), true);
  assert.equal(
    spikeGatesSatisfied({ spike_gates: ["gate:phase0:s01-x", "gate:phase0:s02-y"] }, new Set(["gate:phase0:s01-x"])),
    false,
  );
});

test("readiness holds back issues whose spikes are not verified", () => {
  const issues = [
    { id: "A", depends_on: [], spike_gates: ["gate:phase0:s01-x"] },
    { id: "B", depends_on: [], spike_gates: [] },
  ];
  assert.equal(pickNextIssue(issues, new Set(), new Set())!.id, "B");
  assert.deepEqual(computeReadySet(issues, new Set(), new Set(), new Set()).map((i) => i.id), ["B"]);
  const verified = new Set(["gate:phase0:s01-x"]);
  assert.equal(pickNextIssue(issues, new Set(), verified)!.id, "A");
  assert.deepEqual(computeReadySet(issues, new Set(), new Set(), verified).map((i) => i.id), ["A", "B"]);
});

test("computeDoneIds counts moved files and per-issue verified graph refs", () => {
  const issues = [
    { id: "A", graph_refs: ["node:x"] },
    { id: "B", graph_refs: ["node:y"] },
    { id: "C", graph_refs: ["node:y"] },
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

test("agentCliArgs builds claude --model/--effort and codex -m/-c flags", () => {
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8", effort: "xhigh" }), [
    "--model",
    "claude-opus-4-8",
    "--effort",
    "xhigh",
  ]);
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5", effort: "high" }), [
    "-m",
    "gpt-5.5",
    "-c",
    'model_reasoning_effort="high"',
  ]);
});

test("agentCliArgs omits only the missing flag pair, never a bare flag", () => {
  assert.deepEqual(agentCliArgs("claude", { effort: "max" }), ["--effort", "max"]);
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8" }), ["--model", "claude-opus-4-8"]);
  assert.deepEqual(agentCliArgs("codex", { effort: "minimal" }), ["-c", 'model_reasoning_effort="minimal"']);
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5" }), ["-m", "gpt-5.5"]);
  assert.deepEqual(agentCliArgs("claude", {}), []);
  assert.deepEqual(agentCliArgs("codex", {}), []);
  assert.deepEqual(agentCliArgs("other", { model: "x", effort: "high" }), []);
});

test("agentCliArgs appends fast flags ONLY for a fast-capable model", () => {
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8", effort: "xhigh", fast: true }), [
    "--model",
    "claude-opus-4-8",
    "--effort",
    "xhigh",
    "--settings",
    JSON.stringify({ fastMode: true }),
  ]);
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
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-5", effort: "high", fast: true }), [
    "--model",
    "claude-opus-4-5",
    "--effort",
    "high",
  ]);
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.3-codex-spark", fast: true }), [
    "-m",
    "gpt-5.3-codex-spark",
  ]);
  assert.ok(!agentCliArgs("codex", { model: "gpt-5.4-mini", effort: "high", fast: true }).includes("fast_mode=true"));
});

test("DEFAULT_CONFIG pins the latest models with the documented default thinking levels", () => {
  assert.equal(DEFAULT_CONFIG.implementer.provider, "claude");
  assert.equal(DEFAULT_CONFIG.implementer.model, "claude-opus-4-8");
  assert.equal(DEFAULT_CONFIG.implementer.effort, "xhigh");
  assert.equal(DEFAULT_CONFIG.reviewer.provider, "codex");
  assert.equal(DEFAULT_CONFIG.reviewer.model, "gpt-5.5");
  assert.equal(DEFAULT_CONFIG.reviewer.effort, "high");
});

test("defaultRunImplementer / defaultRunReviewer spawn with the model + effort flags", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-agent-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  const shim = (name: string) =>
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
    const cfg = {
      ...DEFAULT_CONFIG,
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

    const cm = claude.argv.indexOf("--model");
    assert.ok(cm !== -1 && claude.argv[cm + 1] === "claude-opus-4-8");
    const ce = claude.argv.indexOf("--effort");
    assert.ok(ce !== -1 && claude.argv[ce + 1] === "max");

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

test("resolveAgentLegs reads the role -> CLI assignment from the env", () => {
  const def = resolveAgentLegs({});
  assert.equal(def.implementer.provider, "claude");
  assert.equal(def.implementer.actor, "claude");
  assert.equal(def.implementer.role, "implementer");
  assert.equal(def.reviewer.provider, "codex");
  assert.equal(def.reviewer.actor, "codex");
  assert.equal(def.reviewer.role, "reviewer");

  const swap = resolveAgentLegs({
    VIVICY_IMPLEMENTER_CLI: "codex",
    VIVICY_REVIEWER_CLI: "claude",
    VIVICY_CLAUDE_EFFORT: "max",
    VIVICY_CODEX_EFFORT: "minimal",
  });
  assert.equal(swap.implementer.provider, "codex");
  assert.equal(swap.implementer.effort, "minimal");
  assert.equal(swap.reviewer.provider, "claude");
  assert.equal(swap.reviewer.effort, "max");
});

test("resolveAgentLegs honors fast ONLY for a fast-capable model (authoritative gate)", () => {
  const on = resolveAgentLegs({
    VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
    VIVICY_CLAUDE_FAST: "1",
    VIVICY_CODEX_MODEL: "gpt-5.5",
    VIVICY_CODEX_FAST: "1",
  });
  assert.equal(on.implementer.fast, true);
  assert.equal(on.reviewer.fast, true);

  const gated = resolveAgentLegs({
    VIVICY_CLAUDE_MODEL: "claude-opus-4-5",
    VIVICY_CLAUDE_FAST: "1",
    VIVICY_CODEX_MODEL: "gpt-5.3-codex-spark",
    VIVICY_CODEX_FAST: "1",
  });
  assert.equal(gated.implementer.fast, false);
  assert.equal(gated.reviewer.fast, false);

  const def = resolveAgentLegs({});
  assert.equal(def.implementer.fast, false);
  assert.equal(def.reviewer.fast, false);
});

test("resolveAgentLegs repairs an out-of-band INVALID effort to the CLI default", () => {
  const legs = resolveAgentLegs({
    VIVICY_CLAUDE_EFFORT: "extreme",
    VIVICY_CODEX_EFFORT: "max",
  });
  assert.equal(legs.implementer.effort, "xhigh");
  assert.equal(legs.reviewer.effort, "high");
  const ok = resolveAgentLegs({ VIVICY_CLAUDE_EFFORT: "low", VIVICY_CODEX_EFFORT: "minimal" });
  assert.equal(ok.implementer.effort, "low");
  assert.equal(ok.reviewer.effort, "minimal");
});

test("a fast-enabled leg spawns the real fast flags in its argv", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-agent-fast-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  const shim = (name: string) =>
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

    const cs = claude.argv.indexOf("--settings");
    assert.ok(cs !== -1, "claude --settings present for fast");
    assert.deepEqual(JSON.parse(claude.argv[cs + 1]), { fastMode: true });

    assert.ok(codex.argv.includes("fast_mode=true"), "codex fast_mode=true present");
  } finally {
    process.env.PATH = prevPath;
    if (prevOut === undefined) delete process.env.AGENT_SHIM_OUT;
    else process.env.AGENT_SHIM_OUT = prevOut;
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("resolveAgentLegs enforces distinct CLIs (rejects same CLI for both roles)", () => {
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

  const bogus = resolveAgentLegs({ VIVICY_IMPLEMENTER_CLI: "gemini" });
  assert.equal(bogus.implementer.provider, "claude");
  assert.equal(bogus.reviewer.provider, "codex");
});

test("defaultRunImplementer / defaultRunReviewer dispatch to the assigned CLI (roles swapped)", () => {
  const shimDir = mkdtempSync(resolve(repoRoot, "_tmp-swap-shim-"));
  const shimRel = relative(repoRoot, shimDir);
  const argvFile = resolve(shimDir, "argv.json");
  const shim = (name: string) =>
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

    const codex = records.find((r) => r.name === "codex");
    assert.ok(codex, "implementer leg spawned codex");
    assert.ok(codex.argv.includes("exec"), "codex invoked in exec mode");
    const xc = codex.argv.indexOf("-c");
    assert.ok(xc !== -1 && codex.argv[xc + 1] === 'model_reasoning_effort="minimal"');

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
  const probe = [
    "import { DEFAULT_CONFIG, agentCliArgs } from " + JSON.stringify(new URL("./dev-loop.ts", import.meta.url).href) + ";",
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
  assert.deepEqual(out.claude, ["--model", "claude-opus-4-8", "--effort", "max"]);
  assert.deepEqual(out.codex, ["-m", "gpt-5.5", "-c", 'model_reasoning_effort="minimal"']);
});

function buildScratch(gateCommand: string | undefined, { perIssueGate = true }: { perIssueGate?: boolean } = {}) {
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
  const gateField = perIssueGate ? { gate_command: gateCommand } : {};
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
        ...gateField,
        path: `${issuesDir}/ISS-A.md`,
      },
      {
        id: "ISS-B",
        title: "B",
        graph_refs: ["node:y"],
        depends_on: ["ISS-A"],
        verification_gate_ids: ["gate:test:b"],
        ...gateField,
        path: `${issuesDir}/ISS-B.md`,
      },
    ],
  };
  writeFileSync(resolve(repoRoot, indexRel), `${JSON.stringify(index, null, 2)}\n`);
  const quotaStatePath = `${reportsDir}/quota-state.json`;
  return { dir, cfg: { issueIndexPath: indexRel, progressLedgerPath: ledgerRel, issuesDir, doneDir, gatesDir, reportsDir, quotaStatePath, baselineId: "baseline-test", readiness: false } };
}

const stubLifecycle = {
  verifyBaseline: () => "baseline-test",
  verifyTraceability: () => true,
};
const stubSteps = { runImplementer: () => {}, runReviewer: () => {}, commit: () => {}, ...stubLifecycle };

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
    const indexAfter = JSON.parse(readFileSync(resolve(repoRoot, cfg.issueIndexPath), "utf8"));
    assert.equal(indexAfter.issues[0].path, `${cfg.doneDir}/ISS-A.md`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("POLYGLOT: runLoop resolves a NON-NODE gate from the project's vivicy.json (no npm/node assumption)", () => {
  const configPath = resolve(repoRoot, "vivicy.json");
  writeFileSync(configPath, JSON.stringify({ gateCommand: "echo go-test-ran" }));
  const { dir, cfg } = buildScratch(undefined, { perIssueGate: false });
  try {
    const processed = runLoop(cfg, stubSteps);
    assert.deepEqual(processed, [
      { id: "ISS-A", status: "verified" },
      { id: "ISS-B", status: "verified" },
    ]);
    const evidence = JSON.parse(
      readFileSync(resolve(repoRoot, `${cfg.gatesDir}/ISS-A-gate.json`), "utf8"),
    );
    assert.equal(evidence.command, "echo go-test-ran");
    assert.equal(evidence.status, "pass");
    assert.ok(!/npm|node --test/.test(evidence.command), "gate command must carry no Node assumption");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(configPath, { force: true });
  }
});

test("POLYGLOT: runLoop fails loudly when NO gate is configured (no silent npm fallback)", () => {
  const { dir, cfg } = buildScratch(undefined, { perIssueGate: false });
  try {
    assert.throws(() => runLoop(cfg, stubSteps), /gate command/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoop REFUSES to develop on a tampered frozen baseline (integrity gate blocks)", () => {
  const { dir, cfg } = buildScratch("true");
  try {
    let developed = false;
    assert.throws(
      () =>
        runLoop(cfg, {
          ...stubSteps,
          verifyBaseline: () => {
            throw new Error("dev-loop refuses to develop on a tampered/invalid frozen baseline");
          },
          runImplementer: () => {
            developed = true;
          },
        }),
      /tampered\/invalid frozen baseline/,
    );
    assert.equal(developed, false, "no issue ran after the baseline gate blocked");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoop REFUSES to develop on a failing traceability check (integrity gate blocks)", () => {
  const { dir, cfg } = buildScratch("true");
  try {
    let developed = false;
    assert.throws(
      () =>
        runLoop(cfg, {
          ...stubSteps,
          verifyTraceability: () => {
            throw new Error("dev-loop refuses to develop on a failing traceability check");
          },
          runImplementer: () => {
            developed = true;
          },
        }),
      /failing traceability check/,
    );
    assert.equal(developed, false, "no issue ran after the traceability gate blocked");
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
    const scratchRel = relative(repoRoot, dir);
    const legRel = (name: string) => `${scratchRel}/tx-${name}.jsonl`;
    const writeLeg = (name: string) => {
      writeFileSync(resolve(repoRoot, legRel(name)), "transcript\n");
      return { transcriptRel: legRel(name) };
    };
    const steps = {
      runImplementer: () => writeLeg("claude"),
      runReviewer: () => writeLeg("codex"),
      commit: () => {},
      ...stubLifecycle,
    };
    runLoop(cfg, steps);
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    const stateA = ledger.graph_item_states.find((state: { graph_ref: string }) => state.graph_ref === "node:x");
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

test("missingSkills detects absent skills against a project-defined list (substring-robust)", () => {
  const declared = ["alpha-skill", "beta-skill", "gamma-skill"];
  assert.deepEqual(missingSkills(declared.join(" "), declared), []);
  assert.deepEqual(missingSkills("only alpha-skill installed", declared), ["beta-skill", "gamma-skill"]);
  assert.deepEqual(missingSkills("anything"), []);
});

test("checkSkills is ok with no declared skills and never runs the CLI (generic project)", () => {
  let ran = false;
  const result = checkSkills(
    () => {
      ran = true;
      return { ok: true, output: "" };
    },
    { required: [], recommended: [] },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingRequired, []);
  assert.deepEqual(result.notes, []);
  assert.equal(ran, false, "no declared skills => the skills CLI is never invoked");
});

test("checkSkills only NOTES absent recommended skills, never fails", () => {
  const result = checkSkills(() => ({ ok: true, output: "" }), { required: [], recommended: ["nice-to-have"] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.missingRecommended, ["nice-to-have"]);
  assert.equal(result.notes.length, 1);
  assert.match(result.notes[0], /informational only/);
});

test("checkSkills fails only when a declared REQUIRED skill is missing", () => {
  const present = checkSkills(() => ({ ok: true, output: "must-have other" }), { required: ["must-have"], recommended: [] });
  assert.equal(present.ok, true);
  assert.deepEqual(present.missingRequired, []);

  const absent = checkSkills(() => ({ ok: true, output: "other" }), { required: ["must-have"], recommended: [] });
  assert.equal(absent.ok, false);
  assert.deepEqual(absent.missingRequired, ["must-have"]);
});

test("checkSkills blocks on an unavailable CLI only when required skills are declared", () => {
  const blocked = checkSkills(() => ({ ok: false }), { required: ["must-have"], recommended: [] });
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.missingRequired, ["must-have"]);

  const noted = checkSkills(() => ({ ok: false }), { required: [], recommended: ["nice-to-have"] });
  assert.equal(noted.ok, true);
  assert.equal(noted.notes.length, 1);
});

test("readDeclaredSkills returns no skills when the target declares none", () => {
  assert.deepEqual(readDeclaredSkills(null), { required: [], recommended: [] });
});

test("runLoop blocks an issue whose gate stays red after maxRetries and stops", () => {
  const { dir, cfg } = buildScratch("false");
  try {
    const processed = runLoop({ ...cfg, maxRetries: 2 }, stubSteps);
    assert.deepEqual(processed, [{ id: "ISS-A", status: "blocked" }]);
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-blocked.json`)));
    assert.ok(!existsSync(resolve(repoRoot, cfg.doneDir)) || !readdirSync(resolve(repoRoot, cfg.doneDir)).includes("ISS-A.md"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoop: a leg that keeps TIMING OUT is retried, then issue_blocked with the timeout reason (never hangs)", () => {
  const { dir, cfg } = buildScratch("false");
  const timedOutLeg = () => ({
    result: { status: 124, timedOut: true, timeoutReason: "leg timed out after 45 min (hard cap)" },
    output: "",
  });
  const steps = { runImplementer: timedOutLeg, runReviewer: timedOutLeg, commit: () => {}, ...stubLifecycle };
  try {
    const processed = runLoop(
      { ...cfg, maxRetries: 2, claudeQuotaProbeEnabled: false },
      steps,
    );
    assert.deepEqual(processed, [{ id: "ISS-A", status: "blocked" }], "the timed-out issue blocked, the loop did not hang");
    const blocked = JSON.parse(readFileSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-blocked.json`), "utf8"));
    assert.equal(blocked.kind, "timeout", "the block is attributed to a timeout, not a plain red gate");
    assert.match(blocked.reason, /leg timed out after 45 min/);
    assert.match(blocked.reason, /still red after 2 attempts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("detectRateLimit fires on quota signals and ignores plain test failures", () => {
  assert.equal(detectRateLimit("Error: 429 rate_limit_error", undefined, 1).hit, true);
  assert.equal(detectRateLimit("You have hit your usage limit reached", undefined, 1).hit, true);
  assert.equal(detectRateLimit("Anthropic API overloaded, try again later", undefined, 1).hit, true);
  assert.equal(detectRateLimit("rate limit reached; resets at 15:30", undefined, 1).hit, true);
  assert.equal(detectRateLimit("HTTP 429 Too Many Requests", undefined, 1).hit, true);
  assert.equal(detectRateLimit("FAIL src/foo.test.ts: expected 1 to equal 2", undefined, 1).hit, false);
  assert.equal(detectRateLimit("TypeError: x is not a function", undefined, 1).hit, false);
  assert.equal(detectRateLimit("", undefined, 1).hit, false);
  const det = detectRateLimit("line one\nrate limit reached; resets at 16:00\nline three", undefined, 1);
  assert.match(det.message!, /rate limit reached; resets at 16:00/);
});

test("detectRateLimit never throttles a SUCCESSFUL leg, even one about quotas", () => {
  const greenSummaries = [
    "implemented per-account quota enforcement; all tests pass",
    "added rate-limit middleware and a 429 Too Many Requests handler",
    "usage limit policy wired; resets at midnight covered by a test",
  ];
  for (const out of greenSummaries) {
    assert.equal(detectRateLimit(out, undefined, 0).hit, false, `green leg falsely throttled: ${out}`);
  }
  assert.equal(detectRateLimit("429 Too Many Requests", undefined, 1).hit, true);
});

test("parseResetMs parses retry-after, relative, ISO, and clock-time resets", () => {
  const now = Date.UTC(2026, 5, 24, 12, 0, 0);
  assert.equal(parseResetMs("retry-after: 120", now), now + 120_000);
  assert.equal(parseResetMs("please retry after 30 seconds", now), now + 30_000);
  assert.equal(parseResetMs("resets in 2h 14m", now), now + (2 * 3600 + 14 * 60) * 1000);
  assert.equal(parseResetMs("try again in 90s", now), now + 90_000);
  assert.equal(parseResetMs("limit until 2026-06-24T13:00:00Z", now), Date.UTC(2026, 5, 24, 13, 0, 0));
  assert.equal(parseResetMs("rate limited, sorry", now), null);
  assert.equal(parseResetMs("", now), null);
});

test("parseResetMs rolls an already-past clock time to the next day", () => {
  const base = new Date(2026, 5, 24, 12, 0, 0);
  const now = base.getTime();
  const reset = parseResetMs("available again at 9:00", now);
  const expected = new Date(2026, 5, 25, 9, 0, 0, 0).getTime();
  assert.equal(reset, expected);
});

test("computeWaitMs uses the parsed reset when present, capped at the window", () => {
  const cfg = { quotaBackoffStartMs: 5 * 60_000, quotaBackoffCapMs: 5 * 3600_000 };
  const now = 1_000_000;
  const a = computeWaitMs({ message: "try again in 90s", nowMs: now, attempt: 1, cfg });
  assert.equal(a.waitMs, 90_000 + 5000);
  const b = computeWaitMs({ message: "resets in 10h", nowMs: now, attempt: 1, cfg });
  assert.equal(b.waitMs, cfg.quotaBackoffCapMs);
});

test("computeWaitMs backs off exponentially (capped) when no reset is parseable", () => {
  const cfg = { quotaBackoffStartMs: 5 * 60_000, quotaBackoffCapMs: 5 * 3600_000 };
  const args = (attempt: number) => ({ message: "rate limited", nowMs: 0, attempt, cfg });
  assert.equal(computeWaitMs(args(1)).waitMs, 5 * 60_000);
  assert.equal(computeWaitMs(args(2)).waitMs, 10 * 60_000);
  assert.equal(computeWaitMs(args(3)).waitMs, 20 * 60_000);
  assert.equal(computeWaitMs(args(20)).waitMs, cfg.quotaBackoffCapMs);
});

function fakeClockCfg(overrides: Partial<Config> = {}) {
  const waits: number[] = [];
  let clock = 0;
  const cfg: Config = {
    ...DEFAULT_CONFIG,
    quotaStatePath: null,
    claudeQuotaProbeEnabled: false,
    now: () => clock,
    sleep: (ms: number) => {
      waits.push(ms);
      clock += ms;
    },
    ...overrides,
  };
  return { cfg, waits, advance: (ms: number) => (clock += ms) };
}

test("runLegWithQuota waits the parsed duration, retries the same leg, then proceeds", () => {
  const { cfg, waits } = fakeClockCfg({ quotaStatePath: null, quotaMaxWaitMs: 8 * 3600_000 });
  const noWriteCfg = { ...cfg, quotaStatePath: undefined };
  let call = 0;
  const runLeg = () => {
    call += 1;
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
  const out = computeWaitMs({ message: "retry-after: 0", nowMs: 0, attempt: 1, cfg });
  assert.equal(out.waitMs, 30_000);
  const ok = computeWaitMs({ message: "try again in 90s", nowMs: 0, attempt: 1, cfg });
  assert.equal(ok.waitMs, 90_000 + 5000);
});

test("runLegWithQuota gives up (quotaBlocked) once the hard cap is exceeded, never throws", () => {
  const { cfg, waits } = fakeClockCfg({
    quotaMaxWaitMs: 6 * 60_000,
    quotaBackoffStartMs: 5 * 60_000,
    quotaBackoffCapMs: 5 * 3600_000,
  });
  const runLeg = () => ({ output: "rate limited, please slow down", result: { status: 1 } });
  const leg = { actor: "claude", role: "implementer" };
  const out = runLegWithQuota(runLeg, leg, { id: "X" }, withQuotaStateOff(cfg));
  assert.equal(out.quotaBlocked, true, "blocks for a human past the cap instead of looping forever");
  assert.deepEqual(waits, [5 * 60_000]);
});

function withQuotaStateOff(cfg: Config): Config {
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
    assert.equal(state.agents.claude.status, "available");
    assert.equal(state.agents.claude.model, "claude-opus-4-8");
    assert.equal(state.agents.claude.reset_at, null);
    assert.ok(state.updated_at, "the file carries an updated_at timestamp");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCodexQuotaWindows extracts REAL 5h + weekly percentages from a rollout", () => {
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
  assert.deepEqual(parseClaudeStatusRateLimits(null), {});
  assert.deepEqual(parseClaudeStatusRateLimits({}), {});
  assert.deepEqual(parseClaudeStatusRateLimits({ rate_limits: null }), {});
  const oneWin = parseClaudeStatusRateLimits({ five_hour: { used_percentage: 42, resets_at: 1782395400 } });
  assert.equal(oneWin["5h"].used_pct, 42);
  assert.equal(oneWin.weekly, undefined, "absent seven_day => no weekly window, never zero");
});

test("parseClaudeQuotaWindows PREFERS a captured status-line rate_limits line (real %) over the event", () => {
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
    writeFileSync(
      resolve(repoRoot, transcriptRel),
      `{"type":"rate_limit_event","rate_limit_info":{"resetsAt":1782395400,"rateLimitType":"five_hour"}}\n`,
    );
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
    const { cfg, advance } = fakeClockCfg({
      quotaStatePath: quotaRel,
      quotaMaxWaitMs: 8 * 3600_000,
      claudeQuotaProbeEnabled: true,
      claudeQuotaProbeMinIntervalMs: window,
      claudeQuotaProbe: probe,
    });
    advance(10 * 24 * 3600_000);
    const leg = { actor: "claude", role: "implementer", model: "claude-opus-4-8" };
    const runLeg = () => ({ output: "ok", result: { status: 0 } });
    runLegWithQuota(runLeg, leg, { id: "X" }, cfg);
    runLegWithQuota(runLeg, leg, { id: "Y" }, cfg);
    assert.equal(probeCalls, 1, "second leg within the same window reuses the throttled probe");
    advance(window + 60_000);
    runLegWithQuota(runLeg, leg, { id: "Z" }, cfg);
    assert.equal(probeCalls, 2, "after the window elapses, the probe runs again");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DEFAULT_QUOTA_PATTERNS is configurable and case-insensitive", () => {
  const custom = [/please wait/i];
  assert.equal(detectRateLimit("RATE LIMIT hit", custom).hit, false);
  assert.equal(detectRateLimit("Please Wait and retry", custom).hit, true);
  assert.equal(detectRateLimit("RATE_LIMIT", DEFAULT_QUOTA_PATTERNS).hit, true);
});

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
  assert.deepEqual(computeReadySet(issues, new Set()).map((i) => i.id), ["A", "C"]);
  assert.deepEqual(computeReadySet(issues, new Set(["A"])).map((i) => i.id), ["B", "C"]);
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
  assert.deepEqual([...closure.get("C")!].sort(), ["A", "B"]);
  assert.deepEqual([...closure.get("B")!], ["A"]);
  assert.deepEqual([...closure.get("A")!], []);
});

test("issuesIndependent requires NO dependency path AND disjoint claims", () => {
  const issues = [
    { id: "A", depends_on: [], graph_refs: ["node:x"] },
    { id: "B", depends_on: ["A"], graph_refs: ["node:y"] },
    { id: "C", depends_on: [], graph_refs: ["node:x"] },
    { id: "D", depends_on: [], graph_refs: ["node:z"] },
  ];
  const closure = buildDepsClosure(issues);
  const byId = Object.fromEntries(issues.map((i) => [i.id, i]));
  assert.equal(issuesIndependent(byId.A, byId.B, closure), false);
  assert.equal(issuesIndependent(byId.A, byId.C, closure), false);
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
    { id: "B", depends_on: [], graph_refs: ["node:x"] },
    { id: "C", depends_on: [], graph_refs: ["node:y"] },
    { id: "D", depends_on: [], graph_refs: ["node:z"] },
  ];
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 3, closure);
  assert.deepEqual(batch.map((i) => i.id), ["A", "C", "D"]);
});

test("selectIndependentBatch respects already-running issues (no shared claim with them)", () => {
  const issues = [
    { id: "B", depends_on: [], graph_refs: ["node:x"] },
    { id: "C", depends_on: [], graph_refs: ["node:y"] },
  ];
  const running = [{ id: "A", depends_on: [], graph_refs: ["node:x"] }];
  const closure = buildDepsClosure([...issues, ...running]);
  const batch = selectIndependentBatch(issues, running, 2, closure);
  assert.deepEqual(batch.map((i) => i.id), ["C"]);
});

test("clampConcurrency caps at MAX_CONCURRENCY = 12 (range 1..12)", () => {
  assert.equal(MAX_CONCURRENCY, 12);
  assert.equal(clampConcurrency(0), 1);
  assert.equal(clampConcurrency(-7), 1);
  assert.equal(clampConcurrency("nope"), 1);
  assert.equal(clampConcurrency(1), 1);
  assert.equal(clampConcurrency(8), 8);
  assert.equal(clampConcurrency(12), 12);
  assert.equal(clampConcurrency("12"), 12);
  assert.equal(clampConcurrency(11.9), 11);
  assert.equal(clampConcurrency(13), 12);
  assert.equal(clampConcurrency(100), 12);
  assert.equal(clampConcurrency("999"), 12);
});

function spreadArchitecture() {
  return {
    nodes: [
      { id: "a1", layout_cluster: "alpha" },
      { id: "a2", layout_cluster: "alpha" },
      { id: "b1", layout_cluster: "beta" },
      { id: "b2", layout_cluster: "beta" },
      { id: "g1", layout_cluster: "gamma" },
      { id: "g2", layout_cluster: "gamma" },
    ],
    edges: [{ from: "a1", to: "b1", relation: "calls", protocol: "module" }],
  };
}

function spreadIssues() {
  return [
    { id: "I-a1", depends_on: [], graph_refs: ["node:a1"] },
    { id: "I-a2", depends_on: [], graph_refs: ["node:a2"] },
    { id: "I-b1", depends_on: [], graph_refs: ["node:b1"] },
    { id: "I-b2", depends_on: [], graph_refs: ["node:b2"] },
    { id: "I-g1", depends_on: [], graph_refs: ["node:g1"] },
    { id: "I-g2", depends_on: [], graph_refs: ["node:g2"] },
  ];
}

test("buildArchitectureIndex maps node clusters and symmetric edge adjacency", () => {
  const idx = buildArchitectureIndex(spreadArchitecture());
  assert.equal(idx.clusterByNode.get("a1"), "alpha");
  assert.equal(idx.clusterByNode.get("g2"), "gamma");
  assert.ok(idx.adjacencyByNode.get("a1")!.has("b1"));
  assert.ok(idx.adjacencyByNode.get("b1")!.has("a1"));
  assert.equal(idx.adjacencyByNode.get("g1")!.size, 0);
});

test("buildArchitectureIndex tolerates missing / malformed input (graceful)", () => {
  for (const bad of [null, undefined, {}, { nodes: "x" }, { nodes: [{ noId: 1 }], edges: [{}] }]) {
    const idx = buildArchitectureIndex(bad);
    assert.equal(idx.clusterByNode.size, 0);
  }
});

test("issueFootprint unions claims, source files, clusters, and graph neighborhood", () => {
  const idx = buildArchitectureIndex(spreadArchitecture());
  const fp = issueFootprint(
    { graph_refs: ["node:a1"], source_line_refs: ["docs/x.md:7-13", "docs/x.md:20"] },
    idx,
  );
  assert.ok(fp.files.has("file:node:a1"));
  assert.ok(fp.sources.has("src:docs/x.md"));
  assert.ok(fp.clusters.has("cluster:alpha"));
  assert.ok(fp.nodes.has("node:a1"));
  assert.ok(fp.nodes.has("node:b1"));
});

test("footprintDistance follows the ordered risk ladder (file<source<cluster<adjacent<far)", () => {
  const idx = buildArchitectureIndex(spreadArchitecture());
  const fpA1 = issueFootprint({ graph_refs: ["node:a1"], source_line_refs: ["docs/s.md:1"] }, idx);
  const fpA2 = issueFootprint({ graph_refs: ["node:a2"] }, idx);
  const fpB1 = issueFootprint({ graph_refs: ["node:b1"] }, idx);
  const fpG1 = issueFootprint({ graph_refs: ["node:g1"] }, idx);
  const fpA1bis = issueFootprint({ graph_refs: ["node:a1"] }, idx);
  assert.equal(footprintDistance(fpA1, fpA1bis), 0);
  const fpShareSrc = issueFootprint({ graph_refs: ["node:g2"], source_line_refs: ["docs/s.md:9"] }, idx);
  assert.equal(footprintDistance(fpA1, fpShareSrc), 1);
  assert.equal(footprintDistance(fpA1, fpA2), 2);
  assert.equal(footprintDistance(fpA1, fpB1), 3);
  assert.equal(footprintDistance(fpA1, fpG1), CONFLICT_DISTANCE_FAR);
});

test("max-spread selection spreads across DIFFERENT clusters (vs index-order siblings)", () => {
  const issues = spreadIssues();
  const idx = buildArchitectureIndex(spreadArchitecture());
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 3, closure, idx);
  assert.deepEqual(batch.map((i) => i.id), ["I-a1", "I-b2", "I-g1"]);
  assert.ok(!batch.some((i) => i.id === "I-a2"));
  const clusters = new Set(
    batch.flatMap((i) => i.graph_refs!.map((r) => idx.clusterByNode.get(r.slice("node:".length)))),
  );
  assert.equal(clusters.size, 3);

  const indexOrder = selectIndependentBatch(issues, [], 3, closure);
  assert.deepEqual(indexOrder.map((i) => i.id), ["I-a1", "I-a2", "I-b1"]);
  assert.notDeepEqual(batch.map((i) => i.id), indexOrder.map((i) => i.id));
});

test("max-spread NEVER co-schedules dependent issues (hard gate intact, spread on top)", () => {
  const issues = [
    { id: "I-a1", depends_on: [], graph_refs: ["node:a1"] },
    { id: "I-b1", depends_on: ["I-a1"], graph_refs: ["node:b1"] },
    { id: "I-g1", depends_on: [], graph_refs: ["node:g1"] },
  ];
  const idx = buildArchitectureIndex(spreadArchitecture());
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 3, closure, idx);
  assert.ok(!batch.some((i) => i.id === "I-b1"));
  assert.deepEqual(batch.map((i) => i.id), ["I-a1", "I-g1"]);
});

test("max-spread NEVER co-schedules claim-overlapping issues (disjoint-claim gate intact)", () => {
  const issues = [
    { id: "I-a1", depends_on: [], graph_refs: ["node:a1"] },
    { id: "I-a1dup", depends_on: [], graph_refs: ["node:a1"] },
    { id: "I-g1", depends_on: [], graph_refs: ["node:g1"] },
  ];
  const idx = buildArchitectureIndex(spreadArchitecture());
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 3, closure, idx);
  assert.ok(!batch.some((i) => i.id === "I-a1dup"));
  assert.deepEqual(batch.map((i) => i.id), ["I-a1", "I-g1"]);
});

test("max-spread is deterministic (stable batch across repeated runs)", () => {
  const idx = buildArchitectureIndex(spreadArchitecture());
  const closure = buildDepsClosure(spreadIssues());
  const first = selectIndependentBatch(spreadIssues(), [], 4, closure, idx).map((i) => i.id);
  for (let i = 0; i < 5; i += 1) {
    const again = selectIndependentBatch(spreadIssues(), [], 4, closure, idx).map((j) => j.id);
    assert.deepEqual(again, first);
  }
});

test("max-spread degrades gracefully with NO cluster/edge data (falls back to index order)", () => {
  const issues = spreadIssues();
  const closure = buildDepsClosure(issues);
  const batch = selectIndependentBatch(issues, [], 3, closure);
  assert.deepEqual(batch.map((i) => i.id), ["I-a1", "I-a2", "I-b1"]);
});

test("max-spread with limit 1 returns exactly one issue == old sequential pick", () => {
  const issues = spreadIssues();
  const idx = buildArchitectureIndex(spreadArchitecture());
  const closure = buildDepsClosure(issues);
  const withIdx = selectIndependentBatch(issues, [], 1, closure, idx);
  const withoutIdx = selectIndependentBatch(issues, [], 1, closure);
  assert.deepEqual(withIdx.map((i) => i.id), ["I-a1"]);
  assert.deepEqual(withIdx.map((i) => i.id), withoutIdx.map((i) => i.id));
});

interface TimelineEntry {
  id: string;
  who: string;
  phase: "start" | "end";
  t: number;
}

let parallelGitReady = false;
function ensureRepoRootGit() {
  if (parallelGitReady) return;
  const git = (a: string[]) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });
  if (!existsSync(resolve(repoRoot, ".git"))) {
    git(["init", "-q"]);
    git(["config", "user.email", "t@local"]);
    git(["config", "user.name", "t"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "--allow-empty", "-qm", "root"]);
  }
  parallelGitReady = true;
}

function buildParallelScratch({ issues, gateById = {} }: { issues: Issue[]; gateById?: Record<string, string> }) {
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
  const git = (a: string[]) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });
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
    readiness: false,
  };
  return { dir, scratchRel, cfg };
}

function parallelFakeSteps(timeline: TimelineEntry[], scratchRel: string) {
  const leg = (who: string) => async (issue: Issue, cfg?: Config) => {
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
  return {
    runImplementer: leg("impl"),
    runReviewer: leg("rev"),
    verifyBaseline: () => "baseline-test",
    verifyTraceability: () => true,
  };
}

test("runLoopParallel runs independent issues concurrently in distinct worktrees and integrates them", async () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:ledger"] },
    { id: "ISS-B", depends_on: ["ISS-A"], graph_refs: ["node:ledger"] },
    { id: "ISS-D", depends_on: [], graph_refs: ["node:cat"] },
    { id: "ISS-E", depends_on: ["ISS-D"], graph_refs: ["node:cat"] },
  ];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues });
  const timeline: TimelineEntry[] = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true" },
      { ...parallelFakeSteps(timeline, scratchRel), skipWorktreeIgnore: true },
    );
    const verified = processed.filter((p) => p.status === "verified").map((p) => p.id).sort();
    assert.deepEqual(verified, ["ISS-A", "ISS-B", "ISS-D", "ISS-E"]);
    assert.equal(new Set(processed.map((p) => p.id)).size, 4, "no issue settled twice");
    const win = (id: string) => {
      const s = Math.min(...timeline.filter((e) => e.id === id && e.phase === "start").map((e) => e.t));
      const e = Math.max(...timeline.filter((e) => e.id === id && e.phase === "end").map((e) => e.t));
      return [s, e];
    };
    const [as, ae] = win("ISS-A");
    const [ds, de] = win("ISS-D");
    assert.ok(as < de && ds < ae, "ISS-A and ISS-D execution windows overlapped (ran concurrently)");
    const bStart = Math.min(...timeline.filter((e) => e.id === "ISS-B" && e.phase === "start").map((e) => e.t));
    assert.ok(bStart >= ae, "ISS-B started after ISS-A finished (dependency order)");
    for (const id of ["ISS-A", "ISS-B", "ISS-D", "ISS-E"]) {
      assert.ok(
        existsSync(resolve(repoRoot, scratchRel, "gen", `${id}.txt`)),
        `${id} merged its worktree file onto main`,
      );
    }
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    for (const id of verified) {
      const node = issues.find((i) => i.id === id)!.graph_refs![0];
      const state = ledger.graph_item_states.find((s: { graph_ref: string }) => s.graph_ref === node);
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
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:a"] },
    { id: "ISS-B", depends_on: [], graph_refs: ["node:b"] },
    { id: "ISS-C", depends_on: [], graph_refs: ["node:c"] },
  ];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues, gateById: { "ISS-B": "false" } });
  const timeline: TimelineEntry[] = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 3, maxRetries: 1, defaultGateCommand: "true" },
      { ...parallelFakeSteps(timeline, scratchRel), skipWorktreeIgnore: true },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-B"], "blocked", "forced-red B is blocked");
    assert.equal(byId["ISS-A"], "verified", "independent A still verified");
    assert.equal(byId["ISS-C"], "verified", "independent C still verified");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-B-blocked.json`)), "B has a blocked report");
    const done = readdirSync(resolve(repoRoot, cfg.doneDir));
    assert.ok(done.includes("ISS-A.md") && done.includes("ISS-C.md"), "A and C moved to done/");
    assert.ok(!done.includes("ISS-B.md"), "blocked B NOT moved to done/");
    const wtDir = resolve(repoRoot, cfg.worktreesDir);
    const leftover = existsSync(wtDir) ? readdirSync(wtDir).filter((f) => !f.startsWith(".")) : [];
    assert.deepEqual(leftover, [], "worktrees removed including the blocked issue's");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel: an EARLY block never stops LATER independent issues from being scheduled", async () => {
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
    const done = readdirSync(resolve(repoRoot, cfg.doneDir)).sort();
    assert.deepEqual(done, ["ISS-2.md", "ISS-3.md", "ISS-4.md", "ISS-5.md"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel: a worktree-cleanup failure never masks a verified result", async () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:a"] }]
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues })
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true" },
      {
        ...parallelFakeSteps([], scratchRel),
        skipWorktreeIgnore: true,
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
    for (const issue of issues) {
      const state = ledger.graph_item_states.find((s: { graph_ref: string }) => s.graph_ref === issue.graph_refs![0]);
      assert.equal(state?.issue_states[issue.id], "verified", `${issue.id} verified, no lost event`);
    }
    assert.ok(typeof ledger.revision === "number" && ledger.revision >= 6, "ledger revision advanced per write");
    assert.equal((ledger.active_items ?? []).length, 0, "no dangling active items");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function seedFrozenArtifact(relPath: string, baseline: string) {
  ensureRepoRootGit();
  const git = (a: string[]) => spawnSync("git", a, { cwd: repoRoot, encoding: "utf8" });
  const abs = resolve(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, baseline);
  git(["add", "--", relPath]);
  git(["commit", "-qm", `seed frozen ${relPath}`]);
  return {
    relPath,
    baseline,
    headContent: () => readFileSync(abs, "utf8"),
    cleanup: () => {
      spawnSync("git", ["rm", "-q", "-f", "--", relPath], { cwd: repoRoot, encoding: "utf8" });
      spawnSync("git", ["commit", "-qm", `unseed frozen ${relPath}`], { cwd: repoRoot, encoding: "utf8" });
    },
  };
}

test("frozenIntegrationPaths covers the locked extraction corpus, not loop lifecycle files", () => {
  const paths = frozenIntegrationPaths({ issueIndexPath: ".vivicy/development/issue-index.json" });
  for (const p of [
    ".vivicy/canonical/",
    ".vivicy/baselines/",
    ".vivicy/requirements/",
    ".vivicy/architecture-map/architecture-map.yml",
    ".vivicy/development/issue-index.json",
  ]) {
    assert.ok(paths.includes(p), `frozen set includes ${p}`);
  }
  for (const notFrozen of [
    ".vivicy/development/issues",
    ".vivicy/development/issues/done",
    ".vivicy/development/progress-ledger.json",
    ".vivicy/development/gates",
    "package.json",
  ]) {
    assert.ok(!paths.includes(notFrozen), `${notFrozen} is loop-managed / dependency-bearing, never auto-discarded`);
  }
});

test("defaultResetWorktreeFrozenArtifacts drops a worktree's frozen-artifact edit while keeping legit src changes", () => {
  const frozenRel = ".vivicy/requirements/catalog.json";
  const frozen = seedFrozenArtifact(frozenRel, `${JSON.stringify({ requirements: ["R1"] }, null, 2)}\n`);
  const issues = [{ id: "ISS-FZ", depends_on: [], graph_refs: ["node:fz"] }];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues });
  try {
    const created = defaultCreateWorktree(issues[0], cfg as Config);
    const wtFrozen = resolve(created.worktreeRoot, frozenRel);
    writeFileSync(wtFrozen, `${JSON.stringify({ requirements: ["R1", "INJECTED-DRIFT"] }, null, 2)}\n`);
    const legitRel = `${scratchRel}/gen/impl.txt`;
    mkdirSync(resolve(created.worktreeRoot, scratchRel, "gen"), { recursive: true });
    writeFileSync(resolve(created.worktreeRoot, legitRel), "legit implementation\n");
    spawnSync("git", ["add", "-A"], { cwd: created.worktreeRoot, encoding: "utf8" });
    spawnSync("git", ["commit", "-qm", "ISS-FZ: work + drift"], { cwd: created.worktreeRoot, encoding: "utf8" });

    const didReset = defaultResetWorktreeFrozenArtifacts(issues[0], cfg as Config, created.worktreeRoot);
    assert.equal(didReset, true, "guard reported it neutralized a frozen-artifact edit");
    assert.equal(readFileSync(wtFrozen, "utf8"), frozen.baseline, "frozen file reset to integration head in the worktree");
    assert.equal(
      readFileSync(resolve(created.worktreeRoot, legitRel), "utf8"),
      "legit implementation\n",
      "legitimate src change is preserved (not discarded by the guard)",
    );
    const status = spawnSync("git", ["status", "--porcelain"], { cwd: created.worktreeRoot, encoding: "utf8" });
    assert.equal((status.stdout ?? "").trim(), "", "guard committed the reset; worktree tree is clean");

    const again = defaultResetWorktreeFrozenArtifacts(issues[0], cfg as Config, created.worktreeRoot);
    assert.equal(again, false, "no frozen edit remaining -> guard is a no-op");

    defaultRemoveWorktree(issues[0], cfg as Config, created.worktreeRoot, created.branch);
  } finally {
    frozen.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runLoopParallel: two parallel branches both editing a frozen artifact integrate WITHOUT a conflict (edits dropped, legit work kept)", async () => {
  const frozenRel = ".vivicy/requirements/traceability-matrix.json";
  const frozen = seedFrozenArtifact(frozenRel, `${JSON.stringify({ matrix: "BASELINE" }, null, 2)}\n`);
  const issues = [
    { id: "ISS-P", depends_on: [], graph_refs: ["node:p"] },
    { id: "ISS-Q", depends_on: [], graph_refs: ["node:q"] },
  ];
  const { dir, scratchRel, cfg } = buildParallelScratch({ issues });
  const driftingLegs = () => {
    const leg = (who: string) => async (issue: Issue, c?: Config) => {
      await new Promise((r) => setTimeout(r, 10));
      if (c?.execRoot) {
        writeFileSync(
          resolve(c.execRoot, frozenRel),
          `${JSON.stringify({ matrix: `DRIFT-${issue.id}-${who}` }, null, 2)}\n`,
        );
        const genDir = resolve(c.execRoot, scratchRel, "gen");
        mkdirSync(genDir, { recursive: true });
        writeFileSync(resolve(genDir, `${issue.id}.txt`), `${who} ${issue.id}\n`);
      }
      return { output: `${who} ${issue.id}`, result: { status: 0 } };
    };
    return {
      runImplementer: leg("impl"),
      runReviewer: leg("rev"),
      verifyBaseline: () => "baseline-test",
      verifyTraceability: () => true,
    };
  };
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true" },
      { ...driftingLegs(), skipWorktreeIgnore: true },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-P"], "verified", "ISS-P integrated despite editing the frozen file");
    assert.equal(byId["ISS-Q"], "verified", "ISS-Q integrated despite editing the frozen file");
    assert.ok(
      !existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-P-blocked.json`)) &&
        !existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-Q-blocked.json`)),
      "no integration-conflict block was written for either branch",
    );
    assert.equal(frozen.headContent(), frozen.baseline, "frozen artifact at HEAD is byte-identical to its baseline");
    for (const id of ["ISS-P", "ISS-Q"]) {
      assert.ok(
        existsSync(resolve(repoRoot, scratchRel, "gen", `${id}.txt`)),
        `${id}'s legit file was integrated onto main`,
      );
    }
  } finally {
    frozen.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the implementer and reviewer prompts pin the frozen-corpus read-only scope", () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), "utf8");
  for (const name of ["implementer.md", "reviewer.md"]) {
    const text = read(name);
    assert.match(text, /FROZEN/, `${name} declares the corpus FROZEN`);
    assert.match(text, /READ-ONLY/, `${name} declares the corpus READ-ONLY`);
    assert.match(text, /\.vivicy\/requirements/, `${name} names .vivicy/requirements as frozen`);
    assert.match(text, /\.vivicy\/canonical/, `${name} names .vivicy/canonical as frozen`);
    assert.match(text, /\.vivicy\/baselines/, `${name} names .vivicy/baselines as frozen`);
    assert.match(text, /issue-index\.json/, `${name} names the issue index as frozen`);
    assert.match(text, /architecture-map\.yml/, `${name} names the architecture map as frozen`);
    assert.match(text, /package\.json/, `${name} addresses package.json scope`);
  }
});

test("the implementer and reviewer prompts carry the public-API quality bar (the two audit-defect levers)", () => {
  const read = (name: string) => readFileSync(fileURLToPath(new URL(`./prompts/${name}`, import.meta.url)), "utf8");
  for (const name of ["implementer.md", "reviewer.md"]) {
    const text = read(name);
    assert.match(text, /end-to-end/i, `${name} requires end-to-end public-path testing`);
    assert.match(text, /public entry point/i, `${name} names the public entry point`);
    assert.match(text, /helper/i, `${name} distinguishes the public path from internal helpers`);
    assert.match(text, /(type-fuzz|garbage|wrong-type)/i, `${name} requires type-fuzzing public input`);
    assert.match(text, /null/, `${name} names null as a fuzz case`);
    assert.match(text, /undefined/, `${name} names undefined as a fuzz case`);
    assert.match(text, /typed error/i, `${name} requires the documented typed error / safe degradation`);
    assert.match(text, /(raw|uncaught).{0,40}throw|throw.{0,40}(raw|garbage)/i, `${name} forbids a raw throw on garbage input`);
    assert.match(text, /side-channel/i, `${name} forbids side-channel reconciliation`);
    assert.match(
      text,
      /surface (?:the contradiction|it)[^.]*\bblocker\b|\bblocker\b[^.]*\bspec\b/i,
      `${name} surfaces a contract conflict as a blocker instead of hacking it`,
    );
    assert.match(text, /(dead|unreferenced|orphan)/i, `${name} forbids dead/unreferenced exports`);
    assert.match(text, /production path/i, `${name} requires exports be reachable from the production path`);
  }
});

test("the extraction-fidelity verifier prompt enforces cross-document consistency (defect #1's root cause)", () => {
  const text = readFileSync(fileURLToPath(new URL(`./prompts/extraction-verifier.md`, import.meta.url)), "utf8");
  assert.match(text, /cross-document consistency/i, "verifier prompt has a cross-document consistency check");
  assert.match(text, /contradict/i, "verifier prompt flags self-contradiction across docs");
  assert.match(text, /cross_document_contradiction/, "verifier prompt defines the cross_document_contradiction verdict kind");
  assert.match(text, /across/i, "verifier prompt requires reading across docs");
});

test("runLoop(maxParallel=1) is the sequential path: returns an array, identical behavior", () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:x"] },
    { id: "ISS-B", depends_on: ["ISS-A"], graph_refs: ["node:y"] },
  ];
  const { dir, cfg } = buildParallelScratch({ issues });
  try {
    const processed = runLoop(
      { ...cfg, maxParallel: 1, defaultGateCommand: "true" },
      { runImplementer: () => {}, runReviewer: () => {}, commit: () => {}, ...stubLifecycle },
    );
    assert.ok(Array.isArray(processed), "N=1 returns an array synchronously");
    assert.deepEqual(processed, [
      { id: "ISS-A", status: "verified" },
      { id: "ISS-B", status: "verified" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function issueBody({ id = "ISS-A", exec = "Original scope prose.", refs = ["node:x"] } = {}) {
  return [
    `# ${id} — a slice`,
    "",
    "## Summary",
    "",
    exec,
    "",
    "## Traceability",
    "",
    "```text",
    `issue_id: ${id}`,
    "graph_refs:",
    ...refs.map((r) => `  - ${r}`),
    "requirement_ids:",
    "  - REQ-X-001",
    "source_line_refs:",
    "  - .vivicy/canonical/01.md:7",
    "depends_on:",
    "spike_gates:",
    "verification_gate_ids:",
    `  - gate:test:${id}`,
    "```",
    "",
    "## Scope",
    "",
    exec,
    "",
  ].join("\n");
}

function fakeReadiness(verdictById: Record<string, unknown>, calls: Record<string, number> = {}) {
  return (issue: Issue, cfg: Config) => {
    calls[issue.id] = (calls[issue.id] ?? 0) + 1;
    const verdict = verdictById[issue.id];
    if (verdict !== undefined) {
      mkdirSync(resolve(repoRoot, cfg.reportsDir!), { recursive: true });
      writeFileSync(
        resolve(repoRoot, `${cfg.reportsDir}/${issue.id}-readiness.json`),
        `${JSON.stringify(verdict, null, 2)}\n`,
      );
    }
    return { output: `readiness ${issue.id}`, result: { status: 0 } };
  };
}

function buildReadinessScratch(issues: Issue[]) {
  ensureRepoRootGit();
  const dir = mkdtempSync(resolve(repoRoot, "_tmp-readiness-"));
  const scratchRel = relative(repoRoot, dir);
  const issuesDir = `${scratchRel}/issues`;
  const doneDir = `${scratchRel}/issues/done`;
  const gatesDir = `${scratchRel}/gates`;
  const reportsDir = `${scratchRel}/reports`;
  mkdirSync(resolve(repoRoot, issuesDir), { recursive: true });
  for (const issue of issues) {
    writeFileSync(resolve(repoRoot, `${issuesDir}/${issue.id}.md`), issueBody({ id: issue.id, refs: issue.graph_refs }));
  }
  const indexRel = `${scratchRel}/issue-index.json`;
  const ledgerRel = `${scratchRel}/progress-ledger.json`;
  const index = {
    baseline_id: "baseline-test",
    verification_evidence_ref_grammar: `^${scratchRel}/(gates|reports)/.+`,
    issues: issues.map((issue) => ({
      ...issue,
      title: issue.title ?? issue.id,
      verification_gate_ids: [`gate:test:${issue.id}`],
      gate_command: "true",
      path: `${issuesDir}/${issue.id}.md`,
    })),
  };
  writeFileSync(resolve(repoRoot, indexRel), `${JSON.stringify(index, null, 2)}\n`);
  const cfg = {
    issueIndexPath: indexRel,
    progressLedgerPath: ledgerRel,
    issuesDir,
    doneDir,
    gatesDir,
    reportsDir,
    quotaStatePath: `${reportsDir}/quota-state.json`,
    baselineId: "baseline-test",
    readiness: true,
    claudeQuotaProbeEnabled: false,
  };
  return { dir, scratchRel, cfg };
}

test("extractTraceabilityBlock returns the fenced block under ## Traceability, ignoring stray fences", () => {
  const body = issueBody({ id: "ISS-A" });
  const block = extractTraceabilityBlock(body);
  assert.ok(block && block.includes("issue_id: ISS-A"), "the traceability block is extracted");
  assert.ok(block.includes("verification_gate_ids:"), "the whole block is captured");
  const withStray = "```text\nnot the block\n```\n\n" + body;
  assert.equal(extractTraceabilityBlock(withStray), block, "anchors on ## Traceability, not a stray fence");
  assert.equal(extractTraceabilityBlock("# just a title\n\nno block here"), null);
});

test("issueUpdatePreservesTraceability accepts prose-only edits and rejects block edits", () => {
  const before = issueBody({ id: "ISS-A", exec: "Original prose." });
  const proseOnly = issueBody({ id: "ISS-A", exec: "Revised execution prose, same refs." });
  assert.equal(issueUpdatePreservesTraceability(before, proseOnly), true);
  const blockEdited = issueBody({ id: "ISS-A", exec: "Original prose.", refs: ["node:y"] });
  assert.equal(issueUpdatePreservesTraceability(before, blockEdited), false);
  assert.equal(issueUpdatePreservesTraceability(before, "# ISS-A\n\nno traceability block"), false);
});

test("readiness implementable -> the implementer runs and the issue verifies", () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:x"] }];
  const { dir, cfg } = buildReadinessScratch(issues);
  let implemented = 0;
  try {
    const processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({ "ISS-A": { verdict: "implementable", reason: "clean" } }),
      runImplementer: () => {
        implemented += 1;
      },
      runReviewer: () => {},
      commit: () => {},
    });
    assert.deepEqual(processed, [{ id: "ISS-A", status: "verified" }]);
    assert.equal(implemented, 1, "an implementable verdict runs the implementer");
    const ledger = JSON.parse(readFileSync(resolve(repoRoot, cfg.progressLedgerPath), "utf8"));
    const node = ledger.graph_item_states.find((s: { graph_ref: string }) => s.graph_ref === "node:x");
    assert.equal(node.issue_states["ISS-A"], "verified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness issue_update: a prose-only patch is applied to the issue file, then it implements", () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:x"] }];
  const { dir, cfg } = buildReadinessScratch(issues);
  const patched = issueBody({ id: "ISS-A", exec: "PATCHED execution detail (ordering fixed)." });
  let implemented = 0;
  try {
    const processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({
        "ISS-A": { verdict: "issue_update", reason: "ordering drifted", updates: { body_patch: patched } },
      }),
      runImplementer: () => {
        implemented += 1;
      },
      runReviewer: () => {},
      commit: () => {},
    });
    assert.deepEqual(processed, [{ id: "ISS-A", status: "verified" }]);
    assert.equal(implemented, 1, "after a bounded update the issue implements");
    const activePath = resolve(repoRoot, `${cfg.issuesDir}/ISS-A.md`);
    const body = existsSync(activePath)
      ? readFileSync(activePath, "utf8")
      : readFileSync(resolve(repoRoot, `${cfg.doneDir}/ISS-A.md`), "utf8");
    assert.ok(body.includes("PATCHED execution detail"), "the bounded prose patch was applied");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness issue_update touching the traceability block is REFUSED, routed to parked, patch NOT applied", () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:x"] },
    { id: "ISS-B", depends_on: [], graph_refs: ["node:y"] },
  ];
  const { dir, cfg } = buildReadinessScratch(issues);
  const illegalPatch = issueBody({ id: "ISS-A", exec: "prose", refs: ["node:HIJACKED"] });
  const original = readFileSync(resolve(repoRoot, `${cfg.issuesDir}/ISS-A.md`), "utf8");
  let implementedA = 0;
  try {
    const processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({
        "ISS-A": { verdict: "issue_update", reason: "sneaky", updates: { body_patch: illegalPatch } },
        "ISS-B": { verdict: "implementable", reason: "fine" },
      }),
      runImplementer: (iss: Issue) => {
        if (iss.id === "ISS-A") implementedA += 1;
      },
      runReviewer: () => {},
      commit: () => {},
    });
    const byId = Object.fromEntries((processed as ProcessedIssue[]).map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-A"], "parked", "the traceability-touching update is parked (routed to needs_cr)");
    assert.equal(byId["ISS-B"], "verified", "the loop continued to the next ready issue");
    assert.equal(implementedA, 0, "the refused issue never reached the implementer");
    assert.equal(readFileSync(resolve(repoRoot, `${cfg.issuesDir}/ISS-A.md`), "utf8"), original, "issue file untouched");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-parked.json`)), "parked report written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness needs_cr: the issue is parked, the implementer is NEVER called, the loop continues", () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:x"] },
    { id: "ISS-B", depends_on: [], graph_refs: ["node:y"] },
  ];
  const { dir, cfg } = buildReadinessScratch(issues);
  const implementedIds: string[] = [];
  try {
    const processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({
        "ISS-A": { verdict: "needs_cr", reason: "code made the requirement false" },
        "ISS-B": { verdict: "implementable", reason: "fine" },
      }),
      runImplementer: (iss: Issue) => {
        implementedIds.push(iss.id);
      },
      runReviewer: () => {},
      commit: () => {},
    });
    const byId = Object.fromEntries((processed as ProcessedIssue[]).map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-A"], "parked");
    assert.equal(byId["ISS-B"], "verified");
    assert.deepEqual(implementedIds, ["ISS-B"], "the parked issue never reached the implementer; the loop continued");
    const report = JSON.parse(readFileSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-parked.json`), "utf8"));
    assert.match(report.reason, /requirement false/);
    assert.ok(typeof report.issue_hash === "string" && report.issue_hash.length > 0, "identity hash stamped for unparking");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readiness leg death (no verdict file) -> ONE retry then parked with reason readiness_leg_failed", () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:x"] }];
  const { dir, cfg } = buildReadinessScratch(issues);
  const calls: Record<string, number> = {};
  let implemented = 0;
  try {
    const processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({}, calls),
      runImplementer: () => {
        implemented += 1;
      },
      runReviewer: () => {},
      commit: () => {},
    });
    assert.deepEqual(processed, [{ id: "ISS-A", status: "parked" }]);
    assert.equal(calls["ISS-A"], 2, "the readiness leg was retried exactly once (2 total attempts)");
    assert.equal(implemented, 0, "a leg that never yields a verdict never proceeds to implement");
    const report = JSON.parse(readFileSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-parked.json`), "utf8"));
    assert.equal(report.reason, "readiness_leg_failed", "parked as a transient failure, never silently proceeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a parked report is CLEARED when its issue file changes (CR-driven unpark)", () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:x"] }];
  const { dir, cfg } = buildReadinessScratch(issues);
  try {
    let processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({ "ISS-A": { verdict: "needs_cr", reason: "blocked on CR" } }),
      runImplementer: () => {},
      runReviewer: () => {},
      commit: () => {},
    });
    assert.deepEqual(processed, [{ id: "ISS-A", status: "parked" }]);
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-parked.json`)));

    writeFileSync(
      resolve(repoRoot, `${cfg.issuesDir}/ISS-A.md`),
      issueBody({ id: "ISS-A", exec: "REVISED after CR — now implementable." }),
    );
    let implemented = 0;
    processed = runLoop(cfg, {
      ...stubLifecycle,
      runReadiness: fakeReadiness({ "ISS-A": { verdict: "implementable", reason: "CR resolved" } }),
      runImplementer: () => {
        implemented += 1;
      },
      runReviewer: () => {},
      commit: () => {},
    });
    assert.deepEqual(processed, [{ id: "ISS-A", status: "verified" }], "the changed issue unparked and verified");
    assert.equal(implemented, 1);
    assert.ok(
      !existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-parked.json`)),
      "the stale parked report was cleared when the issue file changed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parallel readiness: a batch member that parks gets NO worktree (excluded pre-worktree)", async () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:a"] },
    { id: "ISS-B", depends_on: [], graph_refs: ["node:b"] },
  ];
  const { dir, cfg } = buildParallelScratch({ issues });
  const hermetic = hermeticWorktreeSteps();
  const worktreesCreated: string[] = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 2, defaultGateCommand: "true", readiness: true, claudeQuotaProbeEnabled: false },
      {
        ...hermetic,
        ...hermeticLegs(),
        skipWorktreeIgnore: true,
        runReadiness: fakeReadiness({
          "ISS-A": { verdict: "implementable", reason: "ok" },
          "ISS-B": { verdict: "needs_cr", reason: "blocked" },
        }),
        createWorktree: (issue: Issue) => {
          worktreesCreated.push(issue.id);
          return hermetic.createWorktree!(issue);
        },
        integrateWorktree: () => ({ ok: true, conflict: false, message: "merged" }),
        runGate: makeFakeGate(() => true),
        captureHead: () => "PRE_SHA",
        resetHard: () => {},
      },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-A"], "verified", "the implementable member ran and verified");
    assert.equal(byId["ISS-B"], "parked", "the needs_cr member is parked");
    assert.ok(worktreesCreated.includes("ISS-A"), "the admitted issue got a worktree");
    assert.ok(!worktreesCreated.includes("ISS-B"), "the parked issue got NO worktree (excluded pre-worktree)");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-B-parked.json`)), "B parked report written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeMergeResolver(resolvedById: Record<string, boolean>) {
  return (issue: Issue, cfg: Config) => {
    mkdirSync(resolve(repoRoot, cfg.reportsDir!), { recursive: true });
    writeFileSync(
      resolve(repoRoot, `${cfg.reportsDir}/${issue.id}-merge-resolution.json`),
      `${JSON.stringify({ resolved: resolvedById[issue.id] ?? false, reason: "fake" }, null, 2)}\n`,
    );
    return { output: `resolve ${issue.id}`, result: { status: 0 } };
  };
}

function makeFakeGate(verdict: (issue: Issue, ctx: { stage: string; worktreeCall: number }) => boolean) {
  const worktreeCallsByIssue: Record<string, number> = {};
  return (issue: Issue, cfg: Config) => {
    const stage = cfg.execRoot ? "worktree" : "post_merge";
    if (stage === "worktree") worktreeCallsByIssue[issue.id] = (worktreeCallsByIssue[issue.id] ?? 0) + 1;
    const pass = verdict(issue, { stage, worktreeCall: worktreeCallsByIssue[issue.id] ?? 0 });
    mkdirSync(resolve(repoRoot, cfg.gatesDir!), { recursive: true });
    const evidenceRel = `${cfg.gatesDir}/${issue.id}-gate.json`;
    writeFileSync(
      resolve(repoRoot, evidenceRel),
      `${JSON.stringify(
        {
          gate_id: `gate:test:${issue.id}`,
          issue_id: issue.id,
          command: "true",
          exit_code: pass ? 0 : 1,
          status: pass ? "pass" : "fail",
          finished_at: new Date().toISOString(),
          baseline_id: "baseline-test",
        },
        null,
        2,
      )}\n`,
    );
    return { pass, evidenceRel, exitCode: pass ? 0 : 1 };
  };
}

function hermeticWorktreeSteps(): LoopSteps {
  return {
    createWorktree: (issue: Issue) => {
      const wt = resolve(repoRoot, `_tmp-wt-${issue.id}-${Math.random().toString(36).slice(2)}`);
      mkdirSync(wt, { recursive: true });
      return { worktreeRoot: wt, branch: `vivicy/${issue.id}` };
    },
    removeWorktree: (issue: Issue, worktreeRoot: string) => {
      if (worktreeRoot) rmSync(worktreeRoot, { recursive: true, force: true });
    },
    resetFrozenArtifacts: () => false,
    rebaseWorktree: () => ({ ok: true, message: "rebased" }),
    commitDoneMove: false,
    commit: () => {},
    verifyBaseline: () => "baseline-test",
    verifyTraceability: () => true,
  };
}

function hermeticLegs() {
  return {
    runImplementer: async () => ({ output: "impl", result: { status: 0 } }),
    runReviewer: async () => ({ output: "rev", result: { status: 0 } }),
  };
}

test("G6 conflict -> resolver resolved + worktree gate green -> merge retried once -> success", async () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:a"] }];
  const { dir, cfg } = buildParallelScratch({ issues });
  let mergeCalls = 0;
  let resolverCalls = 0;
  let rebased = 0;
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 1, defaultGateCommand: "true", claudeQuotaProbeEnabled: false },
      {
        ...hermeticWorktreeSteps(),
        ...hermeticLegs(),
        skipWorktreeIgnore: true,
        integrateWorktree: () => {
          mergeCalls += 1;
          return mergeCalls === 1
            ? { ok: false, conflict: true, message: "CONFLICT in src/x" }
            : { ok: true, conflict: false, message: "merged" };
        },
        rebaseWorktree: () => {
          rebased += 1;
          return { ok: true, message: "rebased" };
        },
        runMergeResolver: (issue, c) => {
          resolverCalls += 1;
          return fakeMergeResolver({ "ISS-A": true })(issue, c);
        },
        runGate: makeFakeGate(() => true),
        captureHead: () => "PRE_SHA",
        resetHard: () => {
          throw new Error("resetHard must NOT be called on a clean post-merge gate");
        },
      },
    );
    assert.deepEqual(processed, [{ id: "ISS-A", status: "verified" }], "resolved conflict + green gates -> verified");
    assert.equal(mergeCalls, 2, "the merge was retried exactly once after resolution");
    assert.equal(resolverCalls, 1, "the merge-resolver leg ran once");
    assert.equal(rebased, 1, "the worktree was rebased onto integration HEAD before resolving");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-merge-resolution.json`)), "resolution verdict written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G6 resolver CLAIMS resolved but the orchestrator's worktree gate re-run is RED -> blocked (trust nothing)", async () => {
  const issues = [{ id: "ISS-A", depends_on: [], graph_refs: ["node:a"] }];
  const { dir, cfg } = buildParallelScratch({ issues });
  let mergeCalls = 0;
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 1, defaultGateCommand: "true", claudeQuotaProbeEnabled: false },
      {
        ...hermeticWorktreeSteps(),
        ...hermeticLegs(),
        skipWorktreeIgnore: true,
        integrateWorktree: () => {
          mergeCalls += 1;
          return { ok: false, conflict: true, message: "CONFLICT" };
        },
        rebaseWorktree: () => ({ ok: true, message: "rebased" }),
        runMergeResolver: fakeMergeResolver({ "ISS-A": true }),
        runGate: makeFakeGate((issue, { stage, worktreeCall }) => stage === "worktree" && worktreeCall <= 1),
        captureHead: () => "PRE_SHA",
        resetHard: () => {},
      },
    );
    assert.deepEqual(processed, [{ id: "ISS-A", status: "blocked" }], "a lying resolver is caught by the orchestrator's own gate");
    assert.equal(mergeCalls, 1, "the merge was NOT retried (the orchestrator's gate re-run was red)");
    assert.ok(existsSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-blocked.json`)), "an integration block was written");
    const block = JSON.parse(readFileSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-blocked.json`), "utf8"));
    assert.match(block.reason, /unresolved/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("G6 post-merge re-gate RED -> integration reset to pre-merge sha + issue blocked + others continue", async () => {
  const issues = [
    { id: "ISS-A", depends_on: [], graph_refs: ["node:a"] },
    { id: "ISS-C", depends_on: [], graph_refs: ["node:c"] },
  ];
  const { dir, cfg } = buildParallelScratch({ issues });
  const resetCalls: string[] = [];
  try {
    const processed = await runLoopParallel(
      { ...cfg, maxParallel: 1, defaultGateCommand: "true", claudeQuotaProbeEnabled: false },
      {
        ...hermeticWorktreeSteps(),
        ...hermeticLegs(),
        skipWorktreeIgnore: true,
        integrateWorktree: () => ({ ok: true, conflict: false, message: "merged" }),
        captureHead: () => "PRE_SHA_A",
        resetHard: (sha) => {
          resetCalls.push(sha);
          return { status: 0 };
        },
        runGate: makeFakeGate((issue, { stage }) => !(issue.id === "ISS-A" && stage === "post_merge")),
      },
    );
    const byId = Object.fromEntries(processed.map((p) => [p.id, p.status]));
    assert.equal(byId["ISS-A"], "blocked", "the damaging issue is blocked");
    assert.equal(byId["ISS-C"], "verified", "the independent issue still verifies");
    assert.deepEqual(resetCalls, ["PRE_SHA_A"], "the merge was reverted to the pre-merge HEAD sha");
    const block = JSON.parse(readFileSync(resolve(repoRoot, `${cfg.reportsDir}/ISS-A-integration-blocked.json`), "utf8"));
    assert.equal(block.kind, "post_merge_gate");
    assert.equal(block.reverted_to_sha, "PRE_SHA_A");
    assert.equal(block.pre_merge_gate_evidence?.record?.status, "pass", "the green pre-merge verdict is preserved");
    assert.equal(block.post_merge_gate_evidence?.record?.status, "fail", "the red post-merge verdict is recorded");
    const done = readdirSync(resolve(repoRoot, cfg.doneDir));
    assert.ok(!done.includes("ISS-A.md"), "damaged issue NOT moved to done/");
    assert.ok(done.includes("ISS-C.md"), "independent issue moved to done/");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
