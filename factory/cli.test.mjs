// Tests for the agent-drivable `vivicy` CLI (factory/cli.mjs) — G14.
//
// Every case spawns cli.mjs as a CHILD (the real bin) and asserts its stdout JSON
// schema + exit code, because that IS the contract non-human callers depend on. No
// real agent ever spawns:
//   • read-only verbs (status / crs / notifications) run against seeded .vivicy
//     state files in a tmp target — no factory scripts run.
//   • spawning verbs (extract / cr) point at a STUB FACTORY via VIVICY_FACTORY_ROOT
//     (the same override lib/control.ts honors): stub scripts write the expected
//     state files and print the expected JSON instead of launching claude/codex.
// The lock/log land in an isolated dir via --runtime-dir so tests never touch the
// real .vivicy-runtime.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.mjs");

/** Run the CLI as a child. Returns { code, out, err, json } where json is the
 *  parsed stdout (the contract: exactly one JSON object on stdout). */
function runCli(args, { env = {} } = {}) {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  let json = null;
  const stdout = res.stdout ?? "";
  if (stdout.trim().length > 0) {
    try {
      json = JSON.parse(stdout);
    } catch {
      json = null;
    }
  }
  return { code: res.status, out: stdout, err: res.stderr ?? "", json };
}

let target;
let runtimeDir;

/** Seed a minimal target project's .vivicy state. */
function seedTarget() {
  const dir = mkdtempSync(join(tmpdir(), "vivicy-cli-target-"));
  mkdirSync(join(dir, ".vivicy/development/reports"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/development/issues/done"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/change-requests"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/canonical"), { recursive: true });
  return dir;
}

function writeIssueIndex(dir, ids) {
  writeFileSync(
    join(dir, ".vivicy/development/issue-index.json"),
    JSON.stringify({ issues: ids.map((id) => ({ id, graph_refs: [] })) })
  );
}
function writeDone(dir, id) {
  writeFileSync(join(dir, `.vivicy/development/issues/done/${id}.md`), "# done\n");
}
function writeExtractionStatus(dir, status) {
  writeFileSync(
    join(dir, ".vivicy/development/reports/extraction-status.json"),
    JSON.stringify({ updated_at: "2026-07-02T10:00:00Z", ...status })
  );
}
function writeCr(dir, name, fm) {
  const body = ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", `# ${fm.id}`, ""];
  writeFileSync(join(dir, ".vivicy/change-requests", name), body.join("\n"));
}
function writeCanonical(dir, name = "01-product.md") {
  writeFileSync(join(dir, ".vivicy/canonical", name), "# Product\n\nThe product exists.\n");
}

beforeEach(() => {
  target = seedTarget();
  runtimeDir = mkdtempSync(join(tmpdir(), "vivicy-cli-rt-"));
});
afterEach(() => {
  for (const d of [target, runtimeDir]) rmSync(d, { recursive: true, force: true });
});

// ── help / unknown verb ──────────────────────────────────────────────────────
describe("help + unknown verb", () => {
  test("--help exits 0 and lists verbs", () => {
    const r = runCli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /vivicy status/);
    assert.match(r.out, /vivicy retry-stage/);
  });

  test("no args exits 2 (usage) and prints help", () => {
    const r = runCli([]);
    assert.equal(r.code, 2);
  });

  test("unknown verb exits 2 (usage)", () => {
    const r = runCli(["frobnicate"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /Unknown command/);
  });
});

// ── status ───────────────────────────────────────────────────────────────────
describe("status --json", () => {
  test("green fixture: merged shape, exit 0", () => {
    writeIssueIndex(target, ["ISS-1", "ISS-2"]);
    writeDone(target, "ISS-1");
    writeExtractionStatus(target, {
      phase: "green",
      spike_mode: "integrate",
      map_mode: "reused",
      spike_proving: { proved: 2, failed: 0, skipped: 1 },
      summary: "extraction green after 1 attempt(s): 2 issue(s)",
    });
    writeCr(target, "CR-0001-a.md", {
      id: "CR-0001",
      title: "A",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    });

    const r = runCli(["status", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);

    assert.equal(r.code, 0);
    assert.ok(r.json, "stdout must be one JSON object");
    assert.equal(r.json.ok, true);
    assert.equal(r.json.target, target);
    // run-state lock: no run recorded => null + inactive.
    assert.equal(r.json.run, null);
    assert.equal(r.json.run_active, false);
    // dev block came from dev-status.mjs (real, read-only).
    assert.equal(r.json.dev.issues_total, 2);
    assert.equal(r.json.dev.issues_done, 1);
    // extraction block: phase + spike/map modes + proving summary.
    assert.equal(r.json.extraction.phase, "green");
    assert.equal(r.json.extraction.spike_mode, "integrate");
    assert.equal(r.json.extraction.map_mode, "reused");
    assert.deepEqual(r.json.extraction.spike_proving, { proved: 2, failed: 0, skipped: 1 });
    // pending CRs: the single idea-status CR.
    assert.equal(r.json.pending_crs, 1);
    // stdout is JSON only; human/log noise stays on stderr.
    assert.equal(r.out.trim().startsWith("{"), true);
  });

  test("blocked extraction fixture surfaces the phase; status read still exits 0", () => {
    writeIssueIndex(target, ["ISS-1"]);
    writeExtractionStatus(target, {
      phase: "extraction_blocked",
      summary: "extraction_blocked: checks still red after 4 attempt(s)",
    });

    const r = runCli(["status", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);

    assert.equal(r.code, 0); // status itself succeeded; it REPORTS the blocked phase
    assert.equal(r.json.extraction.phase, "extraction_blocked");
  });

  test("missing target is a usage error (exit 2)", () => {
    const r = runCli(["status", "--runtime-dir", runtimeDir, "--json"], {
      env: { VIVICY_TARGET_ROOT: "" },
    });
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "missing_target");
  });

  test("degrades to dev:null (not exit 3) when the dev-status sub-probe is unavailable", () => {
    // Point at a stub factory WITHOUT dev-status.mjs: the merged read must still
    // succeed on its other sources rather than aborting because one is missing.
    const stub = mkdtempSync(join(tmpdir(), "vivicy-nostatus-"));
    writeExtractionStatus(target, { phase: "green", summary: "green" });
    try {
      const r = runCli(["status", "--dir", target, "--runtime-dir", runtimeDir, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stub },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.dev, null);
      assert.equal(r.json.extraction.phase, "green"); // other sources still returned
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});

// ── crs list ─────────────────────────────────────────────────────────────────
describe("crs --json", () => {
  test("lists well-formed CRs, skipping template + readme", () => {
    writeCr(target, "CR-0001-a.md", {
      id: "CR-0001",
      title: "First",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    });
    writeCr(target, "CR-0002-b.md", {
      id: "CR-0002",
      title: "Second",
      status: "accepted_current_build",
      classification: "major_product_change",
      created_at: "2026-07-02",
      source: "owner",
    });
    writeCr(target, "cr-template.md", { id: "CR-0000", title: "tpl", status: "idea", classification: "x", created_at: "x", source: "owner" });
    writeFileSync(join(target, ".vivicy/change-requests/README.md"), "# CRs\n");

    const r = runCli(["crs", "--dir", target, "--json"]);

    assert.equal(r.code, 0);
    assert.deepEqual(r.json.crs.map((c) => c.id), ["CR-0001", "CR-0002"]);
    assert.deepEqual(r.json.crs[0], {
      id: "CR-0001",
      title: "First",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    });
  });

  test("empty registry returns an empty list, exit 0", () => {
    const r = runCli(["crs", "--dir", target, "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json.crs, []);
  });
});

// ── cr approve/reject (unknown id refusal) ───────────────────────────────────
describe("cr approve", () => {
  test("unknown id is an actionable refusal (exit 1, unknown_cr)", () => {
    // Uses the REAL change-control.mjs decide (deterministic, no agent): it refuses
    // an id with no CR file. No stub factory needed.
    writeCanonical(target);
    const r = runCli(["cr", "approve", "CR-9999", "--by", "tester", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "unknown_cr");
  });

  test("missing --by is a usage error (exit 2)", () => {
    const r = runCli(["cr", "approve", "CR-0001", "--dir", target, "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.code, "usage");
  });

  test("a malformed id is a usage error (exit 2)", () => {
    const r = runCli(["cr", "approve", "nope", "--by", "tester", "--dir", target, "--json"]);
    assert.equal(r.code, 2);
  });
});

// ── retry-stage dispatcher ───────────────────────────────────────────────────
describe("retry-stage", () => {
  test("an unsupported stage exits 2 and lists supported stages", () => {
    const r = runCli(["retry-stage", "S6", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "unsupported_stage");
    assert.deepEqual(r.json.supported, ["extract", "dev"]);
  });

  test("no stage given exits 2 with the supported list", () => {
    const r = runCli(["retry-stage", "--json"]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.supported, ["extract", "dev"]);
  });
});

// ── notifications read contract ──────────────────────────────────────────────
describe("notifications --json", () => {
  test("missing log => empty list, exit 0", () => {
    const r = runCli(["notifications", "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { ok: true, notifications: [] });
  });

  test("reads well-formed lines and skips malformed ones", () => {
    writeFileSync(
      join(runtimeDir, "notifications.jsonl"),
      [
        JSON.stringify({ ts: "2026-07-02T10:00:00Z", level: "info", stage: "extract", event: "green", message: "done" }),
        "not json — a partial write",
        JSON.stringify({ ts: "2026-07-02T10:05:00Z", level: "warn", stage: "dev", event: "stall", message: "idle", dismissed: false }),
        "",
      ].join("\n")
    );
    const r = runCli(["notifications", "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.notifications.length, 2);
    assert.equal(r.json.notifications[0].event, "green");
    assert.equal(r.json.notifications[1].stage, "dev");
  });
});

// ── extract + start/stop via a STUB FACTORY (no real agents) ─────────────────
describe("spawning verbs against a stub factory", () => {
  let stubFactory;

  // A stub factory dir with just the scripts the spawning verbs resolve. Each stub
  // reproduces the real script's OBSERVABLE contract (writes the same state file /
  // prints the same JSON, sets the same exit code) but spawns nothing.
  before(() => {
    stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-factory-"));

    // extract-issues.mjs: read VIVICY_TARGET_ROOT, write extraction-status.json with
    // the phase named by STUB_EXTRACT_PHASE, exit 0 on green else 1 — exactly the
    // real orchestrator's terminal contract.
    writeFileSync(
      join(stubFactory, "extract-issues.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { join } from 'node:path';",
        "const root = process.env.VIVICY_TARGET_ROOT;",
        "const phase = process.env.STUB_EXTRACT_PHASE || 'green';",
        "const dir = join(root, '.vivicy/development/reports');",
        "mkdirSync(dir, { recursive: true });",
        "const summary = phase === 'green' ? 'extraction green after 1 attempt(s): 2 issue(s)' : `${phase}: still red`;",
        "writeFileSync(join(dir, 'extraction-status.json'), JSON.stringify({ phase, spike_mode: 'author', map_mode: 'generated', spike_proving: { proved: 0, failed: 0, skipped: 0 }, summary, updated_at: new Date().toISOString() }));",
        "console.log(summary);",
        "process.exit(phase === 'green' ? 0 : 1);",
      ].join("\n")
    );
    // dev-status.mjs stub (not exercised by extract, present for completeness).
    writeFileSync(join(stubFactory, "dev-status.mjs"), "console.log(JSON.stringify({ verdict: 'NOT STARTED', issues_total: 0, issues_done: 0, active: [], gates: { pass: 0, fail: 0 } }));\nprocess.exit(0);\n");
  });
  after(() => rmSync(stubFactory, { recursive: true, force: true }));

  test("extract green: exit 0, ok:true, phase green, modes surfaced", () => {
    writeCanonical(target);
    const r = runCli(["extract", "--dir", target, "--json"], {
      env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_EXTRACT_PHASE: "green" },
    });
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.blocked, false);
    assert.equal(r.json.phase, "green");
    assert.equal(r.json.spike_mode, "author");
    assert.equal(r.json.map_mode, "generated");
    assert.match(r.json.summary, /2 issue/);
  });

  test("extract blocked: exit 1 (refusal), ok:false, blocked:true", () => {
    writeCanonical(target);
    const r = runCli(["extract", "--dir", target, "--json"], {
      env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_EXTRACT_PHASE: "extraction_blocked" },
    });
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.blocked, true);
    assert.equal(r.json.phase, "extraction_blocked");
  });

  test("extract blocked_on_unverified_spikes is also a blocked refusal (exit 1)", () => {
    writeCanonical(target);
    const r = runCli(["extract", "--dir", target, "--json"], {
      env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_EXTRACT_PHASE: "blocked_on_unverified_spikes" },
    });
    assert.equal(r.code, 1);
    assert.equal(r.json.blocked, true);
  });
});

// ── start / stop lifecycle + lock compatibility ──────────────────────────────
describe("start/stop lock lifecycle (byte-compatible run-state)", () => {
  let stubFactory;
  before(() => {
    stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-sup-"));
    // A supervisor that just sleeps, so the detached pid stays alive long enough to
    // observe the lock, then a stop kills it. It writes nothing under .vivicy.
    writeFileSync(
      join(stubFactory, "dev-loop-supervised.mjs"),
      "setTimeout(() => {}, 60000);\n"
    );
  });
  after(() => rmSync(stubFactory, { recursive: true, force: true }));

  test("start writes the run-state lock in the runtime dir; a second start refuses; stop clears it", () => {
    writeCanonical(target);
    const env = { VIVICY_FACTORY_ROOT: stubFactory };

    const start = runCli(["start", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(start.code, 0);
    assert.equal(start.json.ok, true);
    assert.ok(start.json.run.pid > 0);
    assert.equal(start.json.run.mode, "start");
    // The lock lives at <runtimeDir>/run-state.json — the SAME schema/path the app reads.
    const lockRaw = JSON.parse(readFileSync(join(runtimeDir, "run-state.json"), "utf8"));
    assert.equal(lockRaw.pid, start.json.run.pid);
    assert.equal(lockRaw.target_root, target);
    assert.equal(lockRaw.mode, "start");

    // A second start while the run is active is refused (single-run lock, exit 1).
    const again = runCli(["start", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(again.code, 1);
    assert.equal(again.json.code, "already_running");

    // Stop kills the pid and clears the lock.
    const stop = runCli(["stop", "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(stop.code, 0);
    assert.equal(stop.json.stopped.pid, start.json.run.pid);
    assert.equal(existsSync(join(runtimeDir, "run-state.json")), false);
  });

  test("stop with no recorded run is an actionable refusal (exit 1, not_running)", () => {
    const r = runCli(["stop", "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.code, "not_running");
  });
});
