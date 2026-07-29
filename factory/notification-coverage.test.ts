import "./test-target-root.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runAcceptance } from "./acceptance.ts";
import { DEFAULT_CONFIG, runLegWithQuota } from "./dev-loop.ts";
import type { Config } from "./dev-loop.ts";
import { supervisorTerminalNotification } from "./dev-loop-supervised.ts";

const factoryDir = dirname(fileURLToPath(import.meta.url));

function writeCycleFixture(root: string): void {
  const write = (rel: string, content: string): void => {
    const abs = join(root, ...rel.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  write(".vivicy/development/issue-index.json", JSON.stringify({ issues: [{ id: "ISSUE-0001" }, { id: "ISSUE-0002" }] }));
  write(".vivicy/development/issues/done/ISSUE-0001.md", "# ISSUE-0001\n");
  write(".vivicy/development/issues/done/ISSUE-0002.md", "# ISSUE-0002\n");
  write(".vivicy/baselines/baseline-v1.0.0.json", JSON.stringify({ schema_version: 1, baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen", files: [] }));
}

test("supervisorTerminalNotification names the whole-cycle verdict the absent owner returns to", () => {
  const state = { done: 2, total: 2, blocked: 0 };
  const done = supervisorTerminalNotification("done", state);
  assert.equal(done?.level, "success");
  assert.equal(done?.event, "run_finished");
  assert.equal(done?.stage, "S12");
  assert.equal(supervisorTerminalNotification("blocked", { done: 1, total: 2, blocked: 1 })?.event, "run_blocked");
  assert.equal(supervisorTerminalNotification("blocked", { done: 1, total: 2, blocked: 1 })?.level, "error");
  assert.equal(supervisorTerminalNotification("stalled", { done: 1, total: 2, blocked: 0 })?.event, "run_stalled");
  assert.equal(supervisorTerminalNotification("max_relaunches", { done: 1, total: 2, blocked: 0 })?.event, "run_max_relaunches");
  assert.equal(supervisorTerminalNotification("relaunch", state), null);
});

function quotaCfg(quotaStatePath: string): Config {
  let clock = 0;
  return {
    ...DEFAULT_CONFIG,
    quotaStatePath,
    quotaMaxWaitMs: 8 * 3600_000,
    claudeQuotaProbeEnabled: false,
    now: () => clock,
    sleep: (ms: number) => {
      clock += ms;
    },
  };
}

test("a full walk-away cycle emits the expected notification stream, once per moment, no per-tick spam", async () => {
  const runtimeDir = mkdtempSync(join(tmpdir(), "vivicy-cycle-notif-"));
  const repoRoot = mkdtempSync(join(tmpdir(), "vivicy-cycle-repo-"));
  const prev = process.env.VIVICY_RUNTIME_DIR;
  process.env.VIVICY_RUNTIME_DIR = runtimeDir;
  try {
    writeCycleFixture(repoRoot);

    let call = 0;
    const rateLimitedThenClear = () => {
      call += 1;
      return call <= 2
        ? { output: "Error: 429 rate_limit_error, try again in 60s", result: { status: 1 } }
        : { output: "done", result: { status: 0 } };
    };
    const blocked = runLegWithQuota(rateLimitedThenClear, { actor: "claude", role: "implementer", model: "opus" }, { id: "ISSUE-0001" }, quotaCfg(join(runtimeDir, "quota-state.json")));
    assert.equal(blocked.quotaBlocked, false);

    const report = await runAcceptance({
      repoRoot,
      spawnLeg: async ({ repoRoot: r, verdictRel }: { repoRoot: string; verdictRel: string }) => {
        const abs = join(r, verdictRel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, JSON.stringify({ accepted: true, scenarios: [{ id: "end-to-end", verification: "read_only", result: "ok" }], findings: [] }));
      },
    });
    assert.equal(report.phase, "green");

    const sup = spawnSync("node", [join(factoryDir, "dev-loop-supervised.ts"), "--rehearsal"], {
      cwd: repoRoot,
      env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot, REHEARSAL_DIR: repoRoot, VIVICY_RUNTIME_DIR: runtimeDir },
      encoding: "utf8",
    });
    assert.equal(sup.status, 0, `supervisor should close green:\n${sup.stdout}\n${sup.stderr}`);

    const rows = readFileSync(join(runtimeDir, "notifications.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(
      rows.map((r) => r.event),
      ["quota_paused", "quota_resumed", "acceptance_checking", "acceptance_green", "run_finished"],
      "block -> recover -> acceptance green -> served pizza, each moment once",
    );
    assert.equal(new Set(rows.map((r) => r.id)).size, rows.length, "every notification carries a unique id");
    assert.equal(
      new Set(rows.map((r) => `${r.stage}|${r.event}|${r.message}`)).size,
      rows.length,
      "no moment double-fired within the cycle",
    );
    assert.equal(rows[rows.length - 1].level, "success", "the cycle closes on a success notification");
  } finally {
    if (prev === undefined) delete process.env.VIVICY_RUNTIME_DIR;
    else process.env.VIVICY_RUNTIME_DIR = prev;
    rmSync(runtimeDir, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
  }
});
