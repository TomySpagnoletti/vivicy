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
  composePrompt,
  computeDoneIds,
  computeWaitMs,
  DEFAULT_CONFIG,
  DEFAULT_QUOTA_PATTERNS,
  defaultRunImplementer,
  defaultRunReviewer,
  dependenciesSatisfied,
  detectRateLimit,
  parseResetMs,
  pickNextIssue,
  runLegWithQuota,
  runLoop,
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
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5-codex", effort: "high" }), [
    "-m",
    "gpt-5.5-codex",
    "-c",
    'model_reasoning_effort="high"',
  ]);
});

test("agentCliArgs omits only the missing flag pair, never a bare flag", () => {
  // Effort without a model still emits the effort flag (and vice-versa).
  assert.deepEqual(agentCliArgs("claude", { effort: "max" }), ["--effort", "max"]);
  assert.deepEqual(agentCliArgs("claude", { model: "claude-opus-4-8" }), ["--model", "claude-opus-4-8"]);
  assert.deepEqual(agentCliArgs("codex", { effort: "minimal" }), ["-c", 'model_reasoning_effort="minimal"']);
  assert.deepEqual(agentCliArgs("codex", { model: "gpt-5.5-codex" }), ["-m", "gpt-5.5-codex"]);
  // Empty config (or unknown provider) yields no args, never a dangling flag.
  assert.deepEqual(agentCliArgs("claude", {}), []);
  assert.deepEqual(agentCliArgs("codex", {}), []);
  assert.deepEqual(agentCliArgs("other", { model: "x", effort: "high" }), []);
});

test("DEFAULT_CONFIG pins the latest models with the documented default thinking levels", () => {
  // Always-latest model; thinking level is the user-tunable knob (env-overridable).
  assert.equal(DEFAULT_CONFIG.implementer.provider, "claude");
  assert.equal(DEFAULT_CONFIG.implementer.model, "claude-opus-4-8");
  assert.equal(DEFAULT_CONFIG.implementer.effort, "xhigh");
  assert.equal(DEFAULT_CONFIG.reviewer.provider, "codex");
  assert.equal(DEFAULT_CONFIG.reviewer.model, "gpt-5.5-codex");
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
      reviewer: { ...DEFAULT_CONFIG.reviewer, model: "gpt-5.5-codex", effort: "minimal" },
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

    // Codex argv carries `-m gpt-5.5-codex -c model_reasoning_effort="minimal"`.
    const xm = codex.argv.indexOf("-m");
    assert.ok(xm !== -1 && codex.argv[xm + 1] === "gpt-5.5-codex");
    const xc = codex.argv.indexOf("-c");
    assert.ok(xc !== -1 && codex.argv[xc + 1] === 'model_reasoning_effort="minimal"');
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
    VIVICY_CODEX_MODEL: "gpt-5.5-codex",
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
  assert.deepEqual(out.codex, ["-m", "gpt-5.5-codex", "-c", 'model_reasoning_effort="minimal"']);
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
function fakeClockCfg(overrides = {}) {
  const waits = [];
  let clock = 0;
  const cfg = {
    ...DEFAULT_CONFIG,
    quotaStatePath: null, // set per-test; default off
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

test("DEFAULT_QUOTA_PATTERNS is configurable and case-insensitive", () => {
  // Custom pattern set narrows what counts as a quota signal.
  const custom = [/please wait/i];
  assert.equal(detectRateLimit("RATE LIMIT hit", custom).hit, false);
  assert.equal(detectRateLimit("Please Wait and retry", custom).hit, true);
  // Default set is case-insensitive.
  assert.equal(detectRateLimit("RATE_LIMIT", DEFAULT_QUOTA_PATTERNS).hit, true);
});
