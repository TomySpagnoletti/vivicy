import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  applySkillsBlock,
  auditVerdict,
  buildSkillsBlock,
  installSkills,
  removeSkills,
  MAX_PROJECT_SKILLS,
  normalizeSkillId,
  OFFICIAL_VENDOR_OWNERS,
  SkillsConfigError,
  SKILLS_REPORT_REL,
} from "./install-skills.ts";
import type { SkillAuditFetch, SkillsReport } from "./install-skills.ts";
import { skillsStageNeeded } from "./dev-loop-supervised.ts";
import { readDeclaredSkills } from "./dev-preflight.ts";

const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json";
const BASELINE_ID = "baseline-v1.0.0";

let repo: string;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vivicy-skills-test-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

function writeJson(rel: string, value: unknown): void {
  const abs = resolve(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(repo, rel), "utf8"));
}

function seedBaseline(baselineId = BASELINE_ID): void {
  writeJson(`.vivicy/baselines/${baselineId}.json`, { baseline_id: baselineId, status: "frozen", version: "1.0.0" });
}

interface FakeInstallCall {
  source: string;
  skill: string;
}

function fakeScout(resultsByAttempt: Array<unknown | string>, calls: Array<{ attempt: number; feedback: string | null }> = []) {
  return async ({ repoRoot, attempt, feedback }: { repoRoot: string; attempt: number; feedback: string | null }) => {
    calls.push({ attempt, feedback });
    const result = resultsByAttempt[attempt - 1];
    if (result === undefined) return;
    const abs = resolve(repoRoot, SCOUT_RESULT_REL);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, typeof result === "string" ? result : JSON.stringify(result));
  };
}

function passAudit(): SkillAuditFetch {
  return { found: true, audits: [{ provider: "gateseal", status: "pass" }] };
}

function fakeAudits(bySkill: Record<string, SkillAuditFetch> = {}) {
  return async ({ source, skill }: { source: string; skill: string }) => bySkill[`${source}@${skill}`] ?? passAudit();
}

function fakeInstaller(calls: FakeInstallCall[], failFor: Set<string> = new Set()) {
  return ({ source, skill }: { repoRoot: string; source: string; skill: string }) => {
    calls.push({ source, skill });
    return failFor.has(`${source}@${skill}`) ? { code: 1, output: "npx skills add exploded" } : { code: 0, output: "installed" };
  };
}

describe("normalizeSkillId", () => {
  it("accepts owner/repo@skill and full skills.sh URLs, rejects everything else", () => {
    assert.deepEqual(normalizeSkillId("supabase/agent-skills@postgres"), {
      id: "supabase/agent-skills@postgres",
      owner: "supabase",
      source: "supabase/agent-skills",
      skill: "postgres",
    });
    assert.equal(normalizeSkillId("https://skills.sh/vercel-labs/agent-skills/nextjs")?.id, "vercel-labs/agent-skills@nextjs");
    assert.equal(normalizeSkillId("http://skills.sh/vercel-labs/agent-skills/nextjs/")?.id, "vercel-labs/agent-skills@nextjs");
    assert.equal(normalizeSkillId("not a skill"), null);
    assert.equal(normalizeSkillId("owner/repo"), null);
    assert.equal(normalizeSkillId("owner@skill"), null);
    assert.equal(normalizeSkillId("https://skills.sh/owner/repo"), null);
  });
});

describe("auditVerdict", () => {
  it("is safe iff zero fails and at most one warn; unaudited when not found", () => {
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "pass" }] }), "safe");
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "warn" }] }), "safe");
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "warn" }, { provider: "b", status: "warn" }] }), "too_many_warnings");
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "pass" }, { provider: "b", status: "fail" }] }), "red_audit");
    assert.equal(auditVerdict({ found: false, audits: [] }), "unaudited");
  });
});

describe("auto mode", () => {
  it("green path: scout selection -> audits -> install -> report + vivicy.json merge + AGENTS.md block", async () => {
    seedBaseline();
    writeJson("vivicy.json", { gateCommand: "go test ./...", custom: { keep: true } });
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          skills: [
            { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "spec uses Supabase" },
            { id: "somebody/community@helper", name: "Helper", reason: "no official option" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
    });

    assert.equal(report.phase, "green");
    assert.equal(report.mode, "auto");
    assert.equal(report.baseline_id, BASELINE_ID);
    assert.equal(report.installed.length, 2);
    assert.deepEqual(installs, [
      { source: "supabase/agent-skills", skill: "postgres" },
      { source: "somebody/community", skill: "helper" },
    ]);
    const supabase = report.installed[0];
    assert.equal(supabase.official, true);
    assert.equal(supabase.security_waived, false);
    assert.deepEqual(supabase.audits, [{ provider: "gateseal", status: "pass" }]);
    assert.equal(supabase.reason, "spec uses Supabase");
    assert.equal(report.installed[1].official, false);

    const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport;
    assert.equal(onDisk.phase, "green");
    assert.ok(onDisk.updated_at);

    const config = readJson("vivicy.json") as Record<string, unknown>;
    assert.equal(config.gateCommand, "go test ./...");
    assert.deepEqual(config.custom, { keep: true });
    assert.deepEqual(config.requiredSkills, ["supabase/agent-skills@postgres", "somebody/community@helper"]);
    assert.ok(readFileSync(resolve(repo, "vivicy.json"), "utf8").endsWith("}\n"));

    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
    assert.match(agents, /<!-- vivicy:skills:begin -->/);
    assert.match(agents, /## Project skills/);
    assert.match(agents, /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — spec uses Supabase/);
    assert.match(agents, /\*\*Helper\*\* \(`somebody\/community@helper`, community\)/);
    assert.match(agents, /MUST consult and apply/);
    assert.ok(!existsSync(resolve(repo, SCOUT_RESULT_REL)), "the transient scout result is cleared after the read");
  });

  it("selecting zero skills is a legitimate green and writes no vivicy.json/AGENTS.md", async () => {
    seedBaseline();
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
    });
    assert.equal(report.phase, "green");
    assert.deepEqual(report.installed, []);
    assert.deepEqual(installs, []);
    assert.ok(!existsSync(resolve(repo, "vivicy.json")));
    assert.ok(!existsSync(resolve(repo, "AGENTS.md")));
  });

  it("refuses loudly without an active frozen baseline", async () => {
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError);
  });

  it("a superseded frozen manifest is not an active baseline", async () => {
    writeJson(`.vivicy/baselines/${BASELINE_ID}.json`, { baseline_id: BASELINE_ID, status: "frozen", superseded: true });
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError);
  });

  it("skips idempotently when the report is already green for the SAME baseline, re-runs for a new one", async () => {
    seedBaseline();
    const prior = { phase: "green", baseline_id: BASELINE_ID, mode: "auto", installed: [], rejected: [], summary: "", updated_at: "" };
    writeJson(SKILLS_REPORT_REL, prior);
    const scoutCalls: Array<{ attempt: number; feedback: string | null }> = [];
    const skipped = await installSkills({ repoRoot: repo, spawnScout: fakeScout([], scoutCalls), fetchAudit: fakeAudits(), runInstall: fakeInstaller([]) });
    assert.equal(skipped.phase, "skipped");
    assert.equal(scoutCalls.length, 0, "no leg is spawned on a skip");

    seedBaseline("baseline-v1.1.0");
    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`));
    const rerun = await installSkills({ repoRoot: repo, spawnScout: fakeScout([{ skills: [] }], scoutCalls), fetchAudit: fakeAudits(), runInstall: fakeInstaller([]) });
    assert.equal(rerun.phase, "green");
    assert.equal(rerun.baseline_id, "baseline-v1.1.0");
    assert.equal(scoutCalls.length, 1, "a changed baseline re-runs the scout");
  });

  it("invalid scout output triggers ONE re-prompt with feedback, then failed", async () => {
    seedBaseline();
    const scoutCalls: Array<{ attempt: number; feedback: string | null }> = [];
    const phases: string[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout(["not json at all", { skills: [{ id: "invented-without-find" }] }], scoutCalls),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => phases.push(r.phase),
    });
    assert.equal(report.phase, "failed");
    assert.equal(scoutCalls.length, 2);
    assert.equal(scoutCalls[0].feedback, null);
    assert.match(scoutCalls[1].feedback ?? "", /no valid JSON result file/);
    assert.match(report.summary, /invalid skill id/);
    assert.deepEqual(phases, ["selecting", "failed"]);
  });

  it("more than 6 proposed skills is invalid scout output (re-prompted, then failed)", async () => {
    seedBaseline();
    const seven = { skills: Array.from({ length: 7 }, (_, i) => ({ id: `owner/repo@skill-${i}` })) };
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([seven, seven]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    });
    assert.equal(report.phase, "failed");
    assert.match(report.summary, /maximum is 6/);
  });

  it("enforces the 6-total cap official-first over already-installed skills", async () => {
    seedBaseline();
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@one", "a/b@two", "a/b@three", "a/b@four"] });
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          skills: [
            { id: "somebody/community@first" },
            { id: "stripe/agent-skills@payments" },
            { id: "supabase/agent-skills@auth" },
            { id: "a/b@one" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      emitReport: () => {},
    });
    assert.deepEqual(report.installed.map((e) => e.id), ["stripe/agent-skills@payments", "supabase/agent-skills@auth"]);
    assert.deepEqual(report.rejected, [
      { id: "somebody/community@first", reason: "cap_exceeded", detail: `project already has 4 skill(s); the installed set may never exceed ${MAX_PROJECT_SKILLS} total` },
    ]);
    const config = readJson("vivicy.json") as { requiredSkills: string[] };
    assert.equal(config.requiredSkills.length, 6);
  });
});

describe("security audits", () => {
  const scoutOne = () => fakeScout([{ skills: [{ id: "somebody/repo@risky", name: "Risky", reason: "why not" }] }]);

  it("rejects a red audit without the env flag, never installing", async () => {
    seedBaseline();
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { found: true, audits: [{ provider: "gateseal", status: "fail" }] } }),
      runInstall: fakeInstaller(installs),
      env: {},
    });
    assert.equal(report.phase, "green");
    assert.deepEqual(installs, []);
    assert.equal(report.rejected[0].reason, "red_audit");
    assert.match(report.rejected[0].detail ?? "", /gateseal:fail/);
  });

  it("installs a red-audited skill WITH the flag, flagged security_waived", async () => {
    seedBaseline();
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { found: true, audits: [{ provider: "gateseal", status: "fail" }] } }),
      runInstall: fakeInstaller(installs),
      env: { VIVICY_ALLOW_UNSAFE_SKILLS: "1" },
    });
    assert.equal(report.installed.length, 1);
    assert.equal(report.installed[0].security_waived, true);
    assert.equal(report.installed[0].reason, "red_audit");
    assert.deepEqual(installs, [{ source: "somebody/repo", skill: "risky" }]);
  });

  it("rejects on more than one warn; exactly one warn is safe", async () => {
    seedBaseline();
    const twoWarns: SkillAuditFetch = { found: true, audits: [{ provider: "a", status: "warn" }, { provider: "b", status: "warn" }] };
    const rejectedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": twoWarns }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    });
    assert.equal(rejectedRun.rejected[0].reason, "too_many_warnings");

    rmSync(resolve(repo, SKILLS_REPORT_REL), { force: true });
    const oneWarn: SkillAuditFetch = { found: true, audits: [{ provider: "a", status: "warn" }] };
    const safeRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": oneWarn }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    });
    assert.equal(safeRun.installed.length, 1);
    assert.equal(safeRun.installed[0].security_waived, false);
  });

  it("treats an unreachable/absent audit as unverified: rejected without the flag, waived with it", async () => {
    seedBaseline();
    const unaudited: SkillAuditFetch = { found: false, audits: [] };
    const rejectedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": unaudited }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    });
    assert.deepEqual(rejectedRun.rejected.map((r) => r.reason), ["unaudited"]);

    const waivedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": unaudited }),
      runInstall: fakeInstaller([]),
      env: { VIVICY_ALLOW_UNSAFE_SKILLS: "1" },
      emitReport: () => {},
    });
    assert.equal(waivedRun.installed[0].security_waived, true);
    assert.equal(waivedRun.installed[0].reason, "unaudited");
  });
});

describe("explicit mode (--ids)", () => {
  it("normalizes both id and URL forms, rejects invalid ids, never spawns the scout", async () => {
    seedBaseline();
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      ids: ["https://skills.sh/supabase/agent-skills/postgres", "vercel-labs/agent-skills@nextjs", "garbage id"],
      spawnScout: async () => {
        throw new Error("explicit mode must not spawn the scout");
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
    });
    assert.equal(report.mode, "explicit");
    assert.equal(report.phase, "green");
    assert.deepEqual(report.installed.map((e) => e.id), ["supabase/agent-skills@postgres", "vercel-labs/agent-skills@nextjs"]);
    assert.deepEqual(report.rejected, [
      { id: "garbage id", reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" },
    ]);
    assert.equal(report.installed[0].reason, "explicitly requested");
  });

  it("works without any frozen baseline (baseline_id null) and rejects ids beyond the cap", async () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@s1", "a/b@s2", "a/b@s3", "a/b@s4", "a/b@s5"] });
    const report = await installSkills({
      repoRoot: repo,
      ids: ["x/y@first", "x/y@second"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    });
    assert.equal(report.baseline_id, null);
    assert.deepEqual(report.installed.map((e) => e.id), ["x/y@first"]);
    assert.deepEqual(report.rejected.map((r) => ({ id: r.id, reason: r.reason })), [{ id: "x/y@second", reason: "cap_exceeded" }]);
  });
});

describe("install failures", () => {
  it("a non-zero skills-CLI exit lands in rejected as install_failed and never reaches vivicy.json", async () => {
    seedBaseline();
    writeJson("vivicy.json", { gateCommand: "npm test" });
    const installs: FakeInstallCall[] = [];
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "good/repo@fine" }, { id: "bad/repo@broken" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs, new Set(["bad/repo@broken"])),
    });
    assert.equal(report.phase, "green");
    assert.deepEqual(report.installed.map((e) => e.id), ["good/repo@fine"]);
    assert.deepEqual(report.rejected, [{ id: "bad/repo@broken", reason: "install_failed", detail: "npx skills add exploded" }]);
    assert.deepEqual((readJson("vivicy.json") as { requiredSkills: string[] }).requiredSkills, ["good/repo@fine"]);
  });
});

describe("AGENTS.md managed block", () => {
  const entries = [
    { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", official: true, reason: "database" },
    { id: "somebody/community@helper", name: "Helper", official: false, reason: "" },
  ];

  it("applySkillsBlock is idempotent and replaces an existing block in place", () => {
    const created = applySkillsBlock(null, entries);
    assert.equal(applySkillsBlock(created, entries), created, "same inputs -> byte-identical file");

    const surrounded = `# My project\n\nIntro prose.\n\n${buildSkillsBlock([entries[0]])}\n\n## Later section\n`;
    const replaced = applySkillsBlock(surrounded, entries);
    assert.match(replaced, /^# My project\n\nIntro prose\./);
    assert.match(replaced, /## Later section\n$/);
    assert.match(replaced, /Helper/);
    assert.equal(replaced.match(/vivicy:skills:begin/g)?.length, 1, "exactly one managed block");
    assert.equal(applySkillsBlock(replaced, entries), replaced);
  });

  it("appends the block to an existing AGENTS.md without one", () => {
    const appended = applySkillsBlock("# Existing agent doc\n\nRules.\n", entries);
    assert.match(appended, /^# Existing agent doc\n\nRules\.\n\n<!-- vivicy:skills:begin -->/);
    assert.ok(appended.endsWith("<!-- vivicy:skills:end -->\n"));
  });

  it("an incremental explicit install extends the block with prior-report metadata intact", async () => {
    seedBaseline();
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    });
    await installSkills({
      repoRoot: repo,
      ids: ["stripe/agent-skills@payments"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    });
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
    assert.match(agents, /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — database/, "the first run's metadata survives the second run");
    assert.match(agents, /`stripe\/agent-skills@payments`, official/);
    assert.equal(agents.match(/vivicy:skills:begin/g)?.length, 1);
  });
});

describe("supervisor hook decision (skillsStageNeeded)", () => {
  it("runs only with a baseline, when the report is missing, unsettled, or for another baseline", () => {
    const baseline = { baselineId: BASELINE_ID };
    assert.equal(skillsStageNeeded(null, null), false, "no baseline -> nothing to select from");
    assert.equal(skillsStageNeeded(baseline, null), true);
    assert.equal(skillsStageNeeded(baseline, { phase: "failed", baseline_id: BASELINE_ID }), true, "a red stage stays retryable");
    assert.equal(skillsStageNeeded(baseline, { phase: "green", baseline_id: "baseline-v0.9.0" }), true);
    assert.equal(skillsStageNeeded(baseline, { phase: "green", baseline_id: BASELINE_ID }), false);
    assert.equal(skillsStageNeeded(baseline, { phase: "skipped", baseline_id: BASELINE_ID }), false);
  });
});

describe("dev-preflight declared skills (vivicy.json first)", () => {
  it("reads vivicy.json requiredSkills as skill-name parts, falling back to package.json", () => {
    writeJson("vivicy.json", { gateCommand: "cargo test", requiredSkills: ["supabase/agent-skills@postgres", "plain-name"] });
    writeJson("package.json", { vivicy: { requiredSkills: ["ignored"], recommendedSkills: ["nice-to-have"] } });
    const declared = readDeclaredSkills(repo);
    assert.deepEqual(declared.required, ["postgres", "plain-name"], "ids match `skills list` output by their skill-name part");
    assert.deepEqual(declared.recommended, ["nice-to-have"], "fallback is per field");
  });

  it("keeps the package.json fallback for targets without a vivicy.json", () => {
    writeJson("package.json", { vivicy: { requiredSkills: ["from-pkg"] } });
    assert.deepEqual(readDeclaredSkills(repo).required, ["from-pkg"]);
  });

  it("an explicit empty requiredSkills in vivicy.json is authoritative (no fallback resurrection)", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: [] });
    writeJson("package.json", { vivicy: { requiredSkills: ["stale-skill"] } });
    assert.deepEqual(readDeclaredSkills(repo).required, []);
  });
});

describe("official vendor owners", () => {
  it("covers the first-party vendors the selection prioritizes", () => {
    for (const owner of ["vercel-labs", "supabase", "anthropics", "shadcn", "stripe", "expo", "prisma", "microsoft", "aws"]) {
      assert.ok(OFFICIAL_VENDOR_OWNERS.has(owner), `${owner} must be an official vendor owner`);
    }
    assert.ok(!OFFICIAL_VENDOR_OWNERS.has("somebody"));
  });
});

describe("removeSkills (deterministic uninstall)", () => {
  const PRIOR: SkillsReport = {
    phase: "green",
    baseline_id: BASELINE_ID,
    mode: "explicit",
    installed: [
      { id: "anthropics/skills@pdf", source: "anthropics/skills", skill: "pdf", name: "pdf", official: true, security_waived: false, audits: [], reason: "" },
      { id: "acme/repo@scraper", source: "acme/repo", skill: "scraper", name: "scraper", official: false, security_waived: false, audits: [], reason: "" },
    ],
    rejected: [],
    summary: "",
    updated_at: "t",
  };

  function seedInstalledState(): void {
    writeJson(SKILLS_REPORT_REL, PRIOR);
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf", "acme/repo@scraper"] });
    writeFileSync(resolve(repo, "AGENTS.md"), applySkillsBlock(null, [
      { id: "anthropics/skills@pdf", name: "pdf", official: true, reason: "" },
      { id: "acme/repo@scraper", name: "scraper", official: false, reason: "" },
    ]));
  }

  function fakeRemover(calls: FakeInstallCall[], failFor: Set<string> = new Set()) {
    return ({ source, skill }: { repoRoot: string; source: string; skill: string }) => {
      calls.push({ source, skill });
      return failFor.has(`${source}@${skill}`) ? { code: 1, output: "remove exploded" } : { code: 0, output: "removed" };
    };
  }

  it("removes an installed skill: report, vivicy.json, and AGENTS.md all shrink together", async () => {
    seedInstalledState();
    const calls: FakeInstallCall[] = [];
    const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover(calls) });

    assert.equal(report.phase, "green");
    assert.equal(report.mode, "remove");
    assert.deepEqual(report.removed, [{ id: "anthropics/skills@pdf" }]);
    assert.deepEqual(calls, [{ source: "anthropics/skills", skill: "pdf" }]);
    const config = readJson("vivicy.json") as { gateCommand: string; requiredSkills: string[] };
    assert.equal(config.gateCommand, "npm test");
    assert.deepEqual(config.requiredSkills, ["acme/repo@scraper"]);
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
    assert.ok(agents.includes("acme/repo@scraper"));
    assert.ok(!agents.includes("anthropics/skills@pdf"));
    const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport;
    assert.equal(onDisk.installed?.length, 1);
    assert.equal(onDisk.installed?.[0]?.id, "acme/repo@scraper");
  });

  it("accepts a skills.sh URL and frees a cap slot", async () => {
    seedInstalledState();
    const report = await removeSkills({ repoRoot: repo, ids: ["https://skills.sh/acme/repo/scraper"], runRemove: fakeRemover([]) });
    assert.deepEqual(report.removed, [{ id: "acme/repo@scraper" }]);
    const config = readJson("vivicy.json") as { requiredSkills: string[] };
    assert.deepEqual(config.requiredSkills, ["anthropics/skills@pdf"]);
  });

  it("refuses a not-installed id and an invalid id with machine reasons (never silent)", async () => {
    seedInstalledState();
    const calls: FakeInstallCall[] = [];
    const report = await removeSkills({ repoRoot: repo, ids: ["ghost/repo@nope", "not-an-id"], runRemove: fakeRemover(calls) });

    assert.equal(report.phase, "green");
    assert.deepEqual(report.removed, []);
    assert.equal(calls.length, 0, "nothing not-installed is ever passed to the remover");
    const reasons = report.rejected.map((r) => r.reason).sort();
    assert.deepEqual(reasons, ["invalid_id", "not_installed"]);
    const config = readJson("vivicy.json") as { requiredSkills: string[] };
    assert.equal(config.requiredSkills.length, 2);
  });

  it("records a remove_failed rejection and leaves the state intact for that skill", async () => {
    seedInstalledState();
    const report = await removeSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf", "acme/repo@scraper"],
      runRemove: fakeRemover([], new Set(["anthropics/skills@pdf"])),
    });

    assert.deepEqual(report.removed, [{ id: "acme/repo@scraper" }]);
    assert.deepEqual(report.rejected.map((r) => ({ id: r.id, reason: r.reason })), [
      { id: "anthropics/skills@pdf", reason: "remove_failed" },
    ]);
    const config = readJson("vivicy.json") as { requiredSkills: string[] };
    assert.deepEqual(config.requiredSkills, ["anthropics/skills@pdf"], "the failed removal keeps its slot");
  });

  it("renders the empty-set AGENTS.md block when the last skill is removed", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] });
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf"] });
    writeFileSync(resolve(repo, "AGENTS.md"), applySkillsBlock(null, [{ id: "anthropics/skills@pdf", name: "pdf", official: true, reason: "" }]));

    await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover([]) });
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8");
    assert.ok(agents.includes("No project skills are currently installed"));
  });

  it("throws SkillsConfigError without a target or without ids", async () => {
    await assert.rejects(() => removeSkills({ ids: ["a/b@c"] }), SkillsConfigError);
    await assert.rejects(() => removeSkills({ repoRoot: repo, ids: [] }), SkillsConfigError);
  });
});
