import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";

import { getProjectRuntimeDir } from "../lib/project-runtime.ts";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "cli.ts");

// runCli injects an isolated VIVICY_RUNTIME_DIR by default — without it, locking verbs (start, skills install, cr approve) would write into the repo's real .vivicy-runtime; --runtime-dir flag still wins over it.
const isolatedRuntimeRoot = mkdtempSync(join(tmpdir(), "vivicy-cli-rt-"));
after(() => rmSync(isolatedRuntimeRoot, { recursive: true, force: true }));

function runCli(
  args: string[],
  { env = {} }: { env?: NodeJS.ProcessEnv } = {}
): { code: number | null; out: string; err: string; json: any } {
  const res = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, VIVICY_RUNTIME_DIR: isolatedRuntimeRoot, ...env },
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

let target: string;
let runtimeDir: string;

function seedTarget(): string {
  const dir = mkdtempSync(join(tmpdir(), "vivicy-cli-target-"));
  mkdirSync(join(dir, ".vivicy/development/reports"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/development/issues/done"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/change-requests"), { recursive: true });
  mkdirSync(join(dir, ".vivicy/canonical"), { recursive: true });
  return dir;
}

function writeIssueIndex(dir: string, ids: string[]): void {
  writeFileSync(
    join(dir, ".vivicy/development/issue-index.json"),
    JSON.stringify({ issues: ids.map((id) => ({ id, graph_refs: [] })) })
  );
}
function writeDone(dir: string, id: string): void {
  writeFileSync(join(dir, `.vivicy/development/issues/done/${id}.md`), "# done\n");
}
function writeExtractionStatus(dir: string, status: Record<string, unknown>): void {
  writeFileSync(
    join(dir, ".vivicy/development/reports/extraction-status.json"),
    JSON.stringify({ updated_at: "2026-07-02T10:00:00Z", ...status })
  );
}
function writeCr(dir: string, name: string, fm: Record<string, string>): void {
  const body = ["---", ...Object.entries(fm).map(([k, v]) => `${k}: ${v}`), "---", "", `# ${fm.id}`, ""];
  writeFileSync(join(dir, ".vivicy/change-requests", name), body.join("\n"));
}
function writeCanonical(dir: string, name = "01-product.md"): void {
  writeFileSync(join(dir, ".vivicy/canonical", name), "# Product\n\nThe product exists.\n");
}

beforeEach(() => {
  target = seedTarget();
  runtimeDir = mkdtempSync(join(tmpdir(), "vivicy-cli-rt-"));
});
afterEach(() => {
  for (const d of [target, runtimeDir]) rmSync(d, { recursive: true, force: true });
});

describe("help + unknown verb", () => {
  test("--help exits 0 and lists verbs", () => {
    const r = runCli(["--help"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /vivicy status/);
    assert.match(r.out, /vivicy retry-stage/);
    assert.match(r.out, /vivicy skills/);
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
    assert.equal(r.json.run, null);
    assert.equal(r.json.run_active, false);
    assert.equal(r.json.dev.issues_total, 2);
    assert.equal(r.json.dev.issues_done, 1);
    assert.equal(r.json.extraction.phase, "green");
    assert.equal(r.json.extraction.spike_mode, "integrate");
    assert.equal(r.json.extraction.map_mode, "reused");
    assert.deepEqual(r.json.extraction.spike_proving, { proved: 2, failed: 0, skipped: 1 });
    assert.equal(r.json.pending_crs, 1);
    assert.equal(r.out.trim().startsWith("{"), true);
  });

  test("blocked extraction fixture surfaces the phase; status read still exits 0", () => {
    writeIssueIndex(target, ["ISS-1"]);
    writeExtractionStatus(target, {
      phase: "extraction_blocked",
      summary: "extraction_blocked: checks still red after 4 attempt(s)",
    });

    const r = runCli(["status", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);

    assert.equal(r.code, 0);
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
    const stub = mkdtempSync(join(tmpdir(), "vivicy-nostatus-"));
    writeExtractionStatus(target, { phase: "green", summary: "green" });
    try {
      const r = runCli(["status", "--dir", target, "--runtime-dir", runtimeDir, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stub },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.dev, null);
      assert.equal(r.json.extraction.phase, "green");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});

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
    assert.deepEqual(r.json.crs.map((c: { id: string }) => c.id), ["CR-0001", "CR-0002"]);
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

describe("cr approve", () => {
  test("unknown id is an actionable refusal (exit 1, unknown_cr)", () => {
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

describe("retry-stage", () => {
  test("an unsupported stage exits 2 and lists supported stages", () => {
    const r = runCli(["retry-stage", "S6", "--json"]);
    assert.equal(r.code, 2);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.code, "unsupported_stage");
    assert.deepEqual(r.json.supported, ["prepare", "extract", "skills", "dev"]);
  });

  test("no stage given exits 2 with the supported list", () => {
    const r = runCli(["retry-stage", "--json"]);
    assert.equal(r.code, 2);
    assert.deepEqual(r.json.supported, ["prepare", "extract", "skills", "dev"]);
  });
});

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

describe("prepare verbs", () => {
  function writePrepReport(dir: string, report: Record<string, unknown>): void {
    writeFileSync(
      join(dir, ".vivicy/development/reports/doc-prep-report.json"),
      JSON.stringify({ updated_at: "2026-07-05T09:00:00Z", ...report })
    );
  }

  test("prepare --json prints the report verbatim, exit 0 on green", () => {
    writePrepReport(target, {
      phase: "green",
      batch_id: "2026-07-05T08-00-00-000Z",
      language: "eng",
      placed: [{ target: "canonical/spec.md", route: "canonical", translated: false }],
      rejected: [{ source: "junk.bin", reason: "extract_failed" }],
      summary: "doc-prep green: 1 placed, 1 rejected",
    });
    const r = runCli(["prepare", "--dir", target, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.report.phase, "green");
    assert.equal(r.json.report.batch_id, "2026-07-05T08-00-00-000Z");
    assert.equal(r.json.report.placed[0].target, "canonical/spec.md");
  });

  test("prepare --json exits 1 (refusal) when the last run failed", () => {
    writePrepReport(target, { phase: "failed", batch_id: "b1", language: "eng", placed: [], rejected: [], summary: "leg produced nothing" });
    const r = runCli(["prepare", "--dir", target, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.report.phase, "failed");
  });

  test("prepare --json with no report is an honest null, exit 0", () => {
    const r = runCli(["prepare", "--dir", target, "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { ok: true, report: null });
  });

  test("prepare with no target is a usage error (exit 2)", () => {
    const r = runCli(["prepare", "--json"], { env: { VIVICY_TARGET_ROOT: "" } });
    assert.equal(r.code, 2);
    assert.equal(r.json.code, "missing_target");
  });

  describe("prepare run against a stub factory", () => {
    let stubFactory: string;
    before(() => {
      stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-prep-"));
      writeFileSync(
        join(stubFactory, "prepare-docs.ts"),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const root = process.env.VIVICY_TARGET_ROOT;",
          "const phase = process.env.STUB_PREP_PHASE || 'green';",
          "const dir = join(root, '.vivicy/development/reports');",
          "mkdirSync(dir, { recursive: true });",
          "writeFileSync(join(dir, 'doc-prep-report.json'), JSON.stringify({ phase, batch_id: 'b1', language: 'eng', placed: [{ target: 'canonical/spec.md', route: 'explode', translated: true }], rejected: [], summary: `${phase}: 1 placed`, updated_at: new Date().toISOString() }));",
          "console.log(`doc-prep ${phase}`);",
          "process.exit(phase === 'failed' ? 1 : 0);",
        ].join("\n")
      );
    });
    after(() => rmSync(stubFactory, { recursive: true, force: true }));

    test("prepare run green: exit 0, phase green, placements surfaced", () => {
      const r = runCli(["prepare", "run", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_PREP_PHASE: "green" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.phase, "green");
      assert.equal(r.json.placed[0].target, "canonical/spec.md");
    });

    test("prepare run failed: exit 1 (refusal)", () => {
      const r = runCli(["prepare", "run", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_PREP_PHASE: "failed" },
      });
      assert.equal(r.code, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.phase, "failed");
    });

    test("retry-stage prepare dispatches to a prepare run", () => {
      const r = runCli(["retry-stage", "prepare", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_PREP_PHASE: "green" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.phase, "green");
    });

    test("a live doc-prep lock refuses a second prepare run (already_running)", () => {
      const projectRuntime = getProjectRuntimeDir(isolatedRuntimeRoot, target);
      mkdirSync(projectRuntime, { recursive: true });
      writeFileSync(join(projectRuntime, "doc-prep.lock"), JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }));
      const r = runCli(["prepare", "run", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_PREP_PHASE: "green" },
      });
      assert.equal(r.code, 1);
      assert.equal(r.json.code, "already_running");
    });
  });
});

describe("skills verbs", () => {
  function writeSkillsReport(dir: string, report: Record<string, unknown>): void {
    writeFileSync(
      join(dir, ".vivicy/development/reports/skills-report.json"),
      JSON.stringify({ updated_at: "2026-07-04T09:00:00Z", ...report })
    );
  }

  test("skills --json prints the report verbatim, exit 0 on green", () => {
    writeSkillsReport(target, {
      phase: "green",
      baseline_id: "baseline-v1.0.0",
      mode: "auto",
      installed: [{ id: "acme/tools@lint", source: "skills.sh", skill: "lint", name: "Lint", official: true, security_waived: false, audits: [{ provider: "socket", status: "pass" }], reason: "spec requires linting" }],
      rejected: [{ id: "acme/tools@risky", reason: "audit failed" }],
      summary: "1 skill installed, 1 rejected",
    });
    const r = runCli(["skills", "--dir", target, "--json"]);
    assert.equal(r.code, 0);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.report.phase, "green");
    assert.equal(r.json.report.mode, "auto");
    assert.equal(r.json.report.installed[0].id, "acme/tools@lint");
    assert.equal(r.json.report.rejected[0].reason, "audit failed");
  });

  test("skills --json exits 1 (refusal) when the last install failed", () => {
    writeSkillsReport(target, { phase: "failed", mode: "auto", installed: [], rejected: [], summary: "installer died" });
    const r = runCli(["skills", "--dir", target, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.report.phase, "failed");
  });

  test("skills --json with no report is an honest null, exit 0", () => {
    const r = runCli(["skills", "--dir", target, "--json"]);
    assert.equal(r.code, 0);
    assert.deepEqual(r.json, { ok: true, report: null });
  });

  test("skills with no target is a usage error (exit 2)", () => {
    const r = runCli(["skills", "--json"], { env: { VIVICY_TARGET_ROOT: "" } });
    assert.equal(r.code, 2);
    assert.equal(r.json.code, "missing_target");
  });

  describe("skills install against a stub factory", () => {
    let stubFactory: string;
    before(() => {
      stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-skills-"));
      writeFileSync(
        join(stubFactory, "install-skills.ts"),
        [
          "import { mkdirSync, writeFileSync } from 'node:fs';",
          "import { join } from 'node:path';",
          "const root = process.env.VIVICY_TARGET_ROOT;",
          "const phase = process.env.STUB_SKILLS_PHASE || 'green';",
          "const idsFlag = process.argv.indexOf('--ids');",
          "const ids = idsFlag >= 0 ? process.argv[idsFlag + 1].split(',') : [];",
          "const mode = ids.length > 0 ? 'explicit' : 'auto';",
          "const dir = join(root, '.vivicy/development/reports');",
          "mkdirSync(dir, { recursive: true });",
          "const installed = ids.map((id) => ({ id, source: 'skills.sh', skill: id, name: id, official: false, security_waived: false, audits: [{ provider: 'stub', status: 'pass' }], reason: 'requested' }));",
          "writeFileSync(join(dir, 'skills-report.json'), JSON.stringify({ phase, baseline_id: 'baseline-v1.0.0', mode, installed, rejected: [], summary: `${phase}: ${installed.length} skill(s)`, updated_at: new Date().toISOString() }));",
          "console.log(`skills ${phase}`);",
          "process.exit(phase === 'green' || phase === 'skipped' ? 0 : 1);",
        ].join("\n")
      );
    });
    after(() => rmSync(stubFactory, { recursive: true, force: true }));

    test("auto mode green: exit 0, mode auto", () => {
      const r = runCli(["skills", "install", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_SKILLS_PHASE: "green" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.phase, "green");
      assert.equal(r.json.mode, "auto");
    });

    test("explicit ids ride --ids and surface mode explicit", () => {
      const r = runCli(["skills", "install", "acme/a@x", "acme/b@y", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_SKILLS_PHASE: "green" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.mode, "explicit");
      assert.deepEqual(r.json.installed.map((s: { id: string }) => s.id), ["acme/a@x", "acme/b@y"]);
    });

    test("skipped is a clean success (exit 0)", () => {
      const r = runCli(["skills", "install", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_SKILLS_PHASE: "skipped" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.phase, "skipped");
    });

    test("failed install is a refusal (exit 1)", () => {
      const r = runCli(["skills", "install", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_SKILLS_PHASE: "failed" },
      });
      assert.equal(r.code, 1);
      assert.equal(r.json.ok, false);
      assert.equal(r.json.phase, "failed");
    });

    test("retry-stage skills dispatches to the installer (parity with the API)", () => {
      const r = runCli(["retry-stage", "skills", "--dir", target, "--json"], {
        env: { VIVICY_FACTORY_ROOT: stubFactory, STUB_SKILLS_PHASE: "green" },
      });
      assert.equal(r.code, 0);
      assert.equal(r.json.phase, "green");
      assert.equal(r.json.mode, "auto");
    });
  });
});

describe("spawning verbs against a stub factory", () => {
  let stubFactory: string;

  before(() => {
    stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-factory-"));

    writeFileSync(
      join(stubFactory, "extract-issues.ts"),
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
    writeFileSync(join(stubFactory, "dev-status.ts"), "console.log(JSON.stringify({ verdict: 'NOT STARTED', issues_total: 0, issues_done: 0, active: [], gates: { pass: 0, fail: 0 } }));\nprocess.exit(0);\n");
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

describe("start/stop lock lifecycle (byte-compatible run-state)", () => {
  let stubFactory: string;
  before(() => {
    stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-sup-"));
    writeFileSync(
      join(stubFactory, "dev-loop-supervised.ts"),
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
    const lockFile = join(getProjectRuntimeDir(runtimeDir, target), "run-state.json");
    const lockRaw = JSON.parse(readFileSync(lockFile, "utf8"));
    assert.equal(lockRaw.pid, start.json.run.pid);
    assert.equal(lockRaw.target_root, target);
    assert.equal(lockRaw.mode, "start");

    const again = runCli(["start", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(again.code, 1);
    assert.equal(again.json.code, "already_running");

    const stop = runCli(["stop", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(stop.code, 0);
    assert.equal(stop.json.stopped.pid, start.json.run.pid);
    assert.equal(existsSync(lockFile), false);
  });

  test("stop with no recorded run is an actionable refusal (exit 1, not_running)", () => {
    const r = runCli(["stop", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.code, "not_running");
  });

  test("stop without a target is a usage error (the lock is per project)", () => {
    const r = runCli(["stop", "--runtime-dir", runtimeDir, "--json"], { env: { VIVICY_TARGET_ROOT: "" } });
    assert.equal(r.code, 2);
    assert.equal(r.json.code, "missing_target");
  });
});

describe("cycle verbs (open/cancel/status, guards mirrored from the app)", () => {
  let stubFactory: string;
  before(() => {
    stubFactory = mkdtempSync(join(tmpdir(), "vivicy-stub-cycle-"));
    writeFileSync(join(stubFactory, "doc-baseline.ts"), "process.exit(0);\n");
    writeFileSync(join(stubFactory, "dev-loop-supervised.ts"), "setTimeout(() => {}, 60000);\n");
  });
  after(() => rmSync(stubFactory, { recursive: true, force: true }));

  function seedFrozenBaseline(): void {
    mkdirSync(join(target, ".vivicy/baselines"), { recursive: true });
    writeFileSync(
      join(target, ".vivicy/baselines/baseline-v1.0.0.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen" })
    );
  }

  test("open refuses without a frozen baseline (pre-freeze IS drafting)", () => {
    const r = runCli(["cycle", "open", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(r.code, 1);
    assert.equal(r.json.code, "cycle_state");
  });

  test("open → status → start refused → cancel round-trip", () => {
    seedFrozenBaseline();
    const env = { VIVICY_FACTORY_ROOT: stubFactory };

    const open = runCli(["cycle", "open", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(open.code, 0, open.err);
    assert.equal(open.json.cycle.status, "drafting");
    assert.equal(open.json.cycle.opened_by, "owner:cli");
    assert.ok(existsSync(join(target, ".vivicy/development/reports/spec-cycle.json")));

    const again = runCli(["cycle", "open", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(again.code, 1);
    assert.equal(again.json.code, "cycle_state");

    const status = runCli(["cycle", "status", "--dir", target, "--runtime-dir", runtimeDir, "--json"]);
    assert.equal(status.code, 0);
    assert.equal(status.json.cycle.id, open.json.cycle.id);

    writeCanonical(target);
    const start = runCli(["start", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(start.code, 1);
    assert.equal(start.json.code, "cycle_state");

    const cancel = runCli(["cycle", "cancel", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
    assert.equal(cancel.code, 0, cancel.err);
    assert.equal(cancel.json.cancelled, open.json.cycle.id);
    assert.equal(existsSync(join(target, ".vivicy/development/reports/spec-cycle.json")), false);
  });

  test("cancel refuses when the canonical has drifted (verifier red)", () => {
    seedFrozenBaseline();
    const driftedStub = mkdtempSync(join(tmpdir(), "vivicy-stub-drift-"));
    try {
      writeFileSync(join(driftedStub, "doc-baseline.ts"), "console.error('changed: 01-a.md'); process.exit(1);\n");
      const env = { VIVICY_FACTORY_ROOT: driftedStub };
      const open = runCli(["cycle", "open", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
      assert.equal(open.code, 0, open.err);
      const cancel = runCli(["cycle", "cancel", "--dir", target, "--runtime-dir", runtimeDir, "--json"], { env });
      assert.equal(cancel.code, 1);
      assert.equal(cancel.json.code, "cycle_state");
      assert.ok(existsSync(join(target, ".vivicy/development/reports/spec-cycle.json")), "the cycle stays open");
    } finally {
      rmSync(driftedStub, { recursive: true, force: true });
    }
  });
});
