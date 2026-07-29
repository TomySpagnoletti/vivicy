import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, afterEach, beforeEach, describe, it } from "node:test"

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
} from "./install-skills.ts"
import type { SkillAuditFetch, SkillsReport } from "./install-skills.ts"
import { skillsStageNeeded } from "./dev-loop-supervised.ts"
import { missingSkillsRefusal, readDeclaredSkills } from "./dev-preflight.ts"

const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json"
const BASELINE_ID = "baseline-v1.0.0"

let repo: string

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "vivicy-skills-test-"))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

function writeJson(rel: string, value: unknown): void {
  const abs = resolve(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(rel: string): unknown {
  return JSON.parse(readFileSync(resolve(repo, rel), "utf8"))
}

function seedBaseline(baselineId = BASELINE_ID): void {
  writeJson(`.vivicy/baselines/${baselineId}.json`, { baseline_id: baselineId, status: "frozen", version: "1.0.0" })
}

interface FakeInstallCall {
  source: string
  skill: string
}

function fakeScout(resultsByAttempt: Array<unknown | string>, calls: Array<{ attempt: number; feedback: string | null }> = []) {
  return async ({ repoRoot, attempt, feedback }: { repoRoot: string; attempt: number; feedback: string | null }) => {
    calls.push({ attempt, feedback })
    const result = resultsByAttempt[attempt - 1]
    if (result === undefined) return
    const abs = resolve(repoRoot, SCOUT_RESULT_REL)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof result === "string" ? result : JSON.stringify(result))
  }
}

function passAudit(): SkillAuditFetch {
  return { found: true, audits: [{ provider: "gateseal", status: "pass" }] }
}

function fakeAudits(bySkill: Record<string, SkillAuditFetch> = {}) {
  return async ({ source, skill }: { source: string; skill: string }) => bySkill[`${source}@${skill}`] ?? passAudit()
}

function fakeInstaller(calls: FakeInstallCall[], failFor: Set<string> = new Set()) {
  return ({ source, skill }: { repoRoot: string; source: string; skill: string }) => {
    calls.push({ source, skill })
    return failFor.has(`${source}@${skill}`) ? { code: 1, output: "npx skills add exploded" } : { code: 0, output: "installed" }
  }
}

describe("normalizeSkillId", () => {
  it("accepts owner/repo@skill and full skills.sh URLs, rejects everything else", () => {
    assert.deepEqual(normalizeSkillId("supabase/agent-skills@postgres"), {
      id: "supabase/agent-skills@postgres",
      owner: "supabase",
      source: "supabase/agent-skills",
      skill: "postgres",
    })
    assert.equal(normalizeSkillId("https://skills.sh/vercel-labs/agent-skills/nextjs")?.id, "vercel-labs/agent-skills@nextjs")
    assert.equal(normalizeSkillId("http://skills.sh/vercel-labs/agent-skills/nextjs/")?.id, "vercel-labs/agent-skills@nextjs")
    assert.equal(normalizeSkillId("not a skill"), null)
    assert.equal(normalizeSkillId("owner/repo"), null)
    assert.equal(normalizeSkillId("owner@skill"), null)
    assert.equal(normalizeSkillId("https://skills.sh/owner/repo"), null)
  })
})

describe("auditVerdict", () => {
  it("is safe iff zero fails and at most one warn; unaudited when not found", () => {
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "pass" }] }), "safe")
    assert.equal(auditVerdict({ found: true, audits: [{ provider: "a", status: "warn" }] }), "safe")
    assert.equal(
      auditVerdict({
        found: true,
        audits: [
          { provider: "a", status: "warn" },
          { provider: "b", status: "warn" },
        ],
      }),
      "too_many_warnings"
    )
    assert.equal(
      auditVerdict({
        found: true,
        audits: [
          { provider: "a", status: "pass" },
          { provider: "b", status: "fail" },
        ],
      }),
      "red_audit"
    )
    assert.equal(auditVerdict({ found: false, audits: [] }), "unaudited")
  })
})

describe("auto mode", () => {
  it("green path: scout selection -> audits -> install -> report + vivicy.json merge + AGENTS.md block", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "go test ./...", custom: { keep: true } })
    const installs: FakeInstallCall[] = []
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
    })

    assert.equal(report.phase, "green")
    assert.equal(report.mode, "auto")
    assert.equal(report.baseline_id, BASELINE_ID)
    assert.equal(report.installed.length, 2)
    assert.deepEqual(installs, [
      { source: "supabase/agent-skills", skill: "postgres" },
      { source: "somebody/community", skill: "helper" },
    ])
    const supabase = report.installed[0]
    assert.equal(supabase.official, true)
    assert.equal(supabase.security_waived, false)
    assert.deepEqual(supabase.audits, [{ provider: "gateseal", status: "pass" }])
    assert.equal(supabase.reason, "spec uses Supabase")
    assert.equal(report.installed[1].official, false)

    const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
    assert.equal(onDisk.phase, "green")
    assert.ok(onDisk.updated_at)

    const config = readJson("vivicy.json") as Record<string, unknown>
    assert.equal(config.gateCommand, "go test ./...")
    assert.deepEqual(config.custom, { keep: true })
    assert.deepEqual(config.requiredSkills, ["supabase/agent-skills@postgres", "somebody/community@helper"])
    assert.ok(readFileSync(resolve(repo, "vivicy.json"), "utf8").endsWith("}\n"))

    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
    assert.match(agents, /<!-- vivicy:skills:begin -->/)
    assert.match(agents, /## Project skills/)
    assert.match(agents, /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — spec uses Supabase/)
    assert.match(agents, /\*\*Helper\*\* \(`somebody\/community@helper`, community\)/)
    assert.match(agents, /MUST consult and apply/)
    assert.ok(!existsSync(resolve(repo, SCOUT_RESULT_REL)), "the transient scout result is cleared after the read")
  })

  it("selecting zero skills is a legitimate green and writes no vivicy.json/AGENTS.md", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.installed, [])
    assert.deepEqual(installs, [])
    assert.ok(!existsSync(resolve(repo, "vivicy.json")))
    assert.ok(!existsSync(resolve(repo, "AGENTS.md")))
  })

  it("refuses loudly without an active frozen baseline", async () => {
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError)
  })

  it("a superseded frozen manifest is not an active baseline", async () => {
    writeJson(`.vivicy/baselines/${BASELINE_ID}.json`, { baseline_id: BASELINE_ID, status: "frozen", superseded: true })
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError)
  })

  it("skips idempotently when the report is already green for the SAME baseline, re-runs for a new one", async () => {
    seedBaseline()
    const prior = { phase: "green", baseline_id: BASELINE_ID, mode: "auto", installed: [], rejected: [], summary: "", updated_at: "" }
    writeJson(SKILLS_REPORT_REL, prior)
    const scoutCalls: Array<{ attempt: number; feedback: string | null }> = []
    const skipped = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([], scoutCalls),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(skipped.phase, "skipped")
    assert.equal(scoutCalls.length, 0, "no leg is spawned on a skip")

    seedBaseline("baseline-v1.1.0")
    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    const rerun = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [] }], scoutCalls),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(rerun.phase, "green")
    assert.equal(rerun.baseline_id, "baseline-v1.1.0")
    assert.equal(scoutCalls.length, 1, "a changed baseline re-runs the scout")
  })

  it("invalid scout output triggers ONE re-prompt with feedback, then failed", async () => {
    seedBaseline()
    const scoutCalls: Array<{ attempt: number; feedback: string | null }> = []
    const phases: string[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout(["not json at all", { skills: [{ id: "invented-without-find" }] }], scoutCalls),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => phases.push(r.phase),
    })
    assert.equal(report.phase, "failed")
    assert.equal(scoutCalls.length, 2)
    assert.equal(scoutCalls[0].feedback, null)
    assert.match(scoutCalls[1].feedback ?? "", /no valid JSON result file/)
    assert.match(report.summary, /invalid skill id/)
    assert.deepEqual(phases, ["selecting", "failed"])
  })

  it("more than 6 proposed skills is invalid scout output (re-prompted, then failed)", async () => {
    seedBaseline()
    const seven = { skills: Array.from({ length: 7 }, (_, i) => ({ id: `owner/repo@skill-${i}` })) }
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([seven, seven]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.phase, "failed")
    assert.match(report.summary, /maximum is 6/)
  })

  it("enforces the 6-total cap official-first over already-installed skills", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@one", "a/b@two", "a/b@three", "a/b@four"] })
    const installs: FakeInstallCall[] = []
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
    })
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["stripe/agent-skills@payments", "supabase/agent-skills@auth"]
    )
    assert.deepEqual(report.rejected, [
      {
        id: "somebody/community@first",
        reason: "cap_exceeded",
        detail: `project already has 4 skills; the installed set may never exceed ${MAX_PROJECT_SKILLS} total`,
      },
    ])
    const config = readJson("vivicy.json") as { requiredSkills: string[] }
    assert.equal(config.requiredSkills.length, 6)
  })
})

describe("security audits", () => {
  const scoutOne = () => fakeScout([{ skills: [{ id: "somebody/repo@risky", name: "Risky", reason: "why not" }] }])

  it("rejects a red audit without the env flag, never installing", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { found: true, audits: [{ provider: "gateseal", status: "fail" }] } }),
      runInstall: fakeInstaller(installs),
      env: {},
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(installs, [])
    assert.equal(report.rejected[0].reason, "red_audit")
    assert.match(report.rejected[0].detail ?? "", /gateseal:fail/)
  })

  it("installs a red-audited skill WITH the flag, flagged security_waived", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { found: true, audits: [{ provider: "gateseal", status: "fail" }] } }),
      runInstall: fakeInstaller(installs),
      env: { VIVICY_ALLOW_UNSAFE_SKILLS: "1" },
    })
    assert.equal(report.installed.length, 1)
    assert.equal(report.installed[0].security_waived, true)
    assert.equal(report.installed[0].reason, "red_audit")
    assert.deepEqual(installs, [{ source: "somebody/repo", skill: "risky" }])
  })

  it("rejects on more than one warn; exactly one warn is safe", async () => {
    seedBaseline()
    const twoWarns: SkillAuditFetch = {
      found: true,
      audits: [
        { provider: "a", status: "warn" },
        { provider: "b", status: "warn" },
      ],
    }
    const rejectedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": twoWarns }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    })
    assert.equal(rejectedRun.rejected[0].reason, "too_many_warnings")

    rmSync(resolve(repo, SKILLS_REPORT_REL), { force: true })
    const oneWarn: SkillAuditFetch = { found: true, audits: [{ provider: "a", status: "warn" }] }
    const safeRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": oneWarn }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    })
    assert.equal(safeRun.installed.length, 1)
    assert.equal(safeRun.installed[0].security_waived, false)
  })

  it("treats an unreachable/absent audit as unverified: rejected without the flag, waived with it", async () => {
    seedBaseline()
    const unaudited: SkillAuditFetch = { found: false, audits: [] }
    const rejectedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": unaudited }),
      runInstall: fakeInstaller([]),
      env: {},
      emitReport: () => {},
    })
    assert.deepEqual(
      rejectedRun.rejected.map((r) => r.reason),
      ["unaudited"]
    )

    const waivedRun = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": unaudited }),
      runInstall: fakeInstaller([]),
      env: { VIVICY_ALLOW_UNSAFE_SKILLS: "1" },
      emitReport: () => {},
    })
    assert.equal(waivedRun.installed[0].security_waived, true)
    assert.equal(waivedRun.installed[0].reason, "unaudited")
  })
})

describe("explicit mode (--ids)", () => {
  it("normalizes both id and URL forms, rejects invalid ids, never spawns the scout", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      ids: ["https://skills.sh/supabase/agent-skills/postgres", "vercel-labs/agent-skills@nextjs", "garbage id"],
      spawnScout: async () => {
        throw new Error("explicit mode must not spawn the scout")
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
    })
    assert.equal(report.mode, "explicit")
    assert.equal(report.phase, "green")
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["supabase/agent-skills@postgres", "vercel-labs/agent-skills@nextjs"]
    )
    assert.deepEqual(report.rejected, [
      { id: "garbage id", reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" },
    ])
    assert.equal(report.installed[0].reason, "explicitly requested")
  })

  it("works without any frozen baseline (baseline_id null) and rejects ids beyond the cap", async () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@s1", "a/b@s2", "a/b@s3", "a/b@s4", "a/b@s5"] })
    const report = await installSkills({
      repoRoot: repo,
      ids: ["x/y@first", "x/y@second"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.baseline_id, null)
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["x/y@first"]
    )
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "x/y@second", reason: "cap_exceeded" }]
    )
  })
})

describe("install failures", () => {
  it("a non-zero skills-CLI exit lands in rejected as install_failed and never reaches vivicy.json", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test" })
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "good/repo@fine" }, { id: "bad/repo@broken" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs, new Set(["bad/repo@broken"])),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["good/repo@fine"]
    )
    assert.deepEqual(report.rejected, [{ id: "bad/repo@broken", reason: "install_failed", detail: "npx skills add exploded" }])
    assert.deepEqual((readJson("vivicy.json") as { requiredSkills: string[] }).requiredSkills, ["good/repo@fine"])
  })
})

describe("AGENTS.md managed block", () => {
  const entries = [
    { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", official: true, reason: "database" },
    { id: "somebody/community@helper", name: "Helper", official: false, reason: "" },
  ]

  it("applySkillsBlock is idempotent and replaces an existing block in place", () => {
    const created = applySkillsBlock(null, entries)
    assert.equal(applySkillsBlock(created, entries), created, "same inputs -> byte-identical file")

    const surrounded = `# My project\n\nIntro prose.\n\n${buildSkillsBlock([entries[0]])}\n\n## Later section\n`
    const replaced = applySkillsBlock(surrounded, entries)
    assert.match(replaced, /^# My project\n\nIntro prose\./)
    assert.match(replaced, /## Later section\n$/)
    assert.match(replaced, /Helper/)
    assert.equal(replaced.match(/vivicy:skills:begin/g)?.length, 1, "exactly one managed block")
    assert.equal(applySkillsBlock(replaced, entries), replaced)
  })

  it("appends the block to an existing AGENTS.md without one", () => {
    const appended = applySkillsBlock("# Existing agent doc\n\nRules.\n", entries)
    assert.match(appended, /^# Existing agent doc\n\nRules\.\n\n<!-- vivicy:skills:begin -->/)
    assert.ok(appended.endsWith("<!-- vivicy:skills:end -->\n"))
  })

  it("an incremental explicit install extends the block with prior-report metadata intact", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    await installSkills({
      repoRoot: repo,
      ids: ["stripe/agent-skills@payments"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
    assert.match(
      agents,
      /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — database/,
      "the first run's metadata survives the second run"
    )
    assert.match(agents, /`stripe\/agent-skills@payments`, official/)
    assert.equal(agents.match(/vivicy:skills:begin/g)?.length, 1)
  })
})

describe("supervisor hook decision (skillsStageNeeded)", () => {
  it("runs only with a baseline, when the report is missing, unsettled, or for another baseline", () => {
    const baseline = { baselineId: BASELINE_ID }
    assert.equal(skillsStageNeeded(null, null), false, "no baseline -> nothing to select from")
    assert.equal(skillsStageNeeded(baseline, null), true)
    assert.equal(skillsStageNeeded(baseline, { phase: "failed", baseline_id: BASELINE_ID }), true, "a red stage stays retryable")
    assert.equal(skillsStageNeeded(baseline, { phase: "green", baseline_id: "baseline-v0.9.0" }), true)
    assert.equal(skillsStageNeeded(baseline, { phase: "green", baseline_id: BASELINE_ID }), false)
    assert.equal(skillsStageNeeded(baseline, { phase: "skipped", baseline_id: BASELINE_ID }), false)
  })
})

describe("dev-preflight declared skills (vivicy.json, the one location)", () => {
  it("reads vivicy.json requiredSkills as skill-name parts", () => {
    writeJson("vivicy.json", {
      gateCommand: "cargo test",
      requiredSkills: ["supabase/agent-skills@postgres", "plain-name"],
      recommendedSkills: ["nice-to-have"],
    })
    const declared = readDeclaredSkills(repo)
    assert.deepEqual(declared.required, ["postgres", "plain-name"], "ids match `skills list` output by their skill-name part")
    assert.deepEqual(declared.recommended, ["nice-to-have"])
  })

  it("a `vivicy` field in package.json declares nothing — vivicy.json is the only source", () => {
    writeJson("package.json", { vivicy: { requiredSkills: ["from-pkg"], recommendedSkills: ["also-pkg"] } })
    assert.deepEqual(readDeclaredSkills(repo), { required: [], recommended: [] })

    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["from-vivicy"] })
    assert.deepEqual(readDeclaredSkills(repo).required, ["from-vivicy"])
    assert.deepEqual(readDeclaredSkills(repo).recommended, [])
  })

  it("an explicit empty requiredSkills in vivicy.json declares no skills", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: [] })
    assert.deepEqual(readDeclaredSkills(repo).required, [])
  })

  // The refusal is owner-facing CONTRACT: it is the whole instruction for clearing a blocked run, so it may name only the location readDeclaredSkills actually reads.
  it("the missing-skills refusal names vivicy.json and NOTHING else — following it really clears the refusal", () => {
    const refusal = missingSkillsRefusal(["postgres", "stripe"])
    assert.match(refusal, /vivicy\.json "requiredSkills"/)
    assert.doesNotMatch(refusal, /package\.json/, "package.json declares nothing — pointing there cannot clear the refusal")
    assert.doesNotMatch(refusal, /vivicy\.(required|recommended)Skills/, "the pkg-scoped spelling is dead too")
    assert.match(refusal, /npx skills add <skill>/, "the install half stays actionable")
  })

  it("the refusal's count forms agree with the number of missing skills", () => {
    assert.match(missingSkillsRefusal(["postgres"]), /^1 required development skill missing: postgres\n/)
    assert.match(missingSkillsRefusal(["postgres"]), /install it with .* or drop it from/)
    assert.match(missingSkillsRefusal(["postgres", "stripe"]), /^2 required development skills missing: postgres, stripe\n/)
    assert.match(missingSkillsRefusal(["postgres", "stripe"]), /install them with .* or drop them from/)
  })
})

describe("official vendor owners", () => {
  it("covers the first-party vendors the selection prioritizes", () => {
    for (const owner of ["vercel-labs", "supabase", "anthropics", "shadcn", "stripe", "expo", "prisma", "microsoft", "aws"]) {
      assert.ok(OFFICIAL_VENDOR_OWNERS.has(owner), `${owner} must be an official vendor owner`)
    }
    assert.ok(!OFFICIAL_VENDOR_OWNERS.has("somebody"))
  })
})

describe("removeSkills (deterministic uninstall)", () => {
  const PRIOR: SkillsReport = {
    phase: "green",
    baseline_id: BASELINE_ID,
    mode: "explicit",
    installed: [
      {
        id: "anthropics/skills@pdf",
        source: "anthropics/skills",
        skill: "pdf",
        name: "pdf",
        official: true,
        security_waived: false,
        audits: [],
        reason: "",
      },
      {
        id: "acme/repo@scraper",
        source: "acme/repo",
        skill: "scraper",
        name: "scraper",
        official: false,
        security_waived: false,
        audits: [],
        reason: "",
      },
    ],
    rejected: [],
    summary: "",
    updated_at: "t",
  }

  function seedInstalledState(): void {
    writeJson(SKILLS_REPORT_REL, PRIOR)
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf", "acme/repo@scraper"] })
    writeFileSync(
      resolve(repo, "AGENTS.md"),
      applySkillsBlock(null, [
        { id: "anthropics/skills@pdf", name: "pdf", official: true, reason: "" },
        { id: "acme/repo@scraper", name: "scraper", official: false, reason: "" },
      ])
    )
  }

  function fakeRemover(calls: FakeInstallCall[], failFor: Set<string> = new Set()) {
    return ({ source, skill }: { repoRoot: string; source: string; skill: string }) => {
      calls.push({ source, skill })
      return failFor.has(`${source}@${skill}`) ? { code: 1, output: "remove exploded" } : { code: 0, output: "removed" }
    }
  }

  it("removes an installed skill: report, vivicy.json, and AGENTS.md all shrink together", async () => {
    seedInstalledState()
    const calls: FakeInstallCall[] = []
    const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover(calls) })

    assert.equal(report.phase, "green")
    assert.equal(report.mode, "remove")
    assert.deepEqual(report.removed, [{ id: "anthropics/skills@pdf" }])
    assert.deepEqual(calls, [{ source: "anthropics/skills", skill: "pdf" }])
    const config = readJson("vivicy.json") as { gateCommand: string; requiredSkills: string[] }
    assert.equal(config.gateCommand, "npm test")
    assert.deepEqual(config.requiredSkills, ["acme/repo@scraper"])
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
    assert.ok(agents.includes("acme/repo@scraper"))
    assert.ok(!agents.includes("anthropics/skills@pdf"))
    const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
    assert.equal(onDisk.installed?.length, 1)
    assert.equal(onDisk.installed?.[0]?.id, "acme/repo@scraper")
  })

  it("accepts a skills.sh URL and frees a cap slot", async () => {
    seedInstalledState()
    const report = await removeSkills({ repoRoot: repo, ids: ["https://skills.sh/acme/repo/scraper"], runRemove: fakeRemover([]) })
    assert.deepEqual(report.removed, [{ id: "acme/repo@scraper" }])
    const config = readJson("vivicy.json") as { requiredSkills: string[] }
    assert.deepEqual(config.requiredSkills, ["anthropics/skills@pdf"])
  })

  it("refuses a not-installed id and an invalid id with machine reasons (never silent)", async () => {
    seedInstalledState()
    const calls: FakeInstallCall[] = []
    const report = await removeSkills({ repoRoot: repo, ids: ["ghost/repo@nope", "not-an-id"], runRemove: fakeRemover(calls) })

    assert.equal(report.phase, "green")
    assert.deepEqual(report.removed, [])
    assert.equal(calls.length, 0, "nothing not-installed is ever passed to the remover")
    const reasons = report.rejected.map((r) => r.reason).sort()
    assert.deepEqual(reasons, ["invalid_id", "not_installed"])
    const config = readJson("vivicy.json") as { requiredSkills: string[] }
    assert.equal(config.requiredSkills.length, 2)
  })

  it("records a remove_failed rejection and leaves the state intact for that skill", async () => {
    seedInstalledState()
    const report = await removeSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf", "acme/repo@scraper"],
      runRemove: fakeRemover([], new Set(["anthropics/skills@pdf"])),
    })

    assert.deepEqual(report.removed, [{ id: "acme/repo@scraper" }])
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "anthropics/skills@pdf", reason: "remove_failed" }]
    )
    const config = readJson("vivicy.json") as { requiredSkills: string[] }
    assert.deepEqual(config.requiredSkills, ["anthropics/skills@pdf"], "the failed removal keeps its slot")
  })

  it("renders the empty-set AGENTS.md block when the last skill is removed", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] })
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf"] })
    writeFileSync(
      resolve(repo, "AGENTS.md"),
      applySkillsBlock(null, [{ id: "anthropics/skills@pdf", name: "pdf", official: true, reason: "" }])
    )

    await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover([]) })
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
    assert.ok(agents.includes("No project skills are currently installed"))
  })

  it("throws SkillsConfigError without a target or without ids", async () => {
    await assert.rejects(() => removeSkills({ ids: ["a/b@c"] }), SkillsConfigError)
    await assert.rejects(() => removeSkills({ repoRoot: repo, ids: [] }), SkillsConfigError)
  })
})

describe("stage summaries agree in number", () => {
  async function stageSummaries(ids: string[]): Promise<string[]> {
    seedBaseline()
    const summaries: string[] = []
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: ids.map((id) => ({ id })) }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => summaries.push(r.summary),
    })
    return summaries
  }

  it("one candidate reads in the singular through every phase", async () => {
    const summaries = await stageSummaries(["supabase/agent-skills@postgres"])
    assert.ok(summaries.includes("auditing 1 candidate skill against skills.sh security audits"), summaries.join(" | "))
    assert.ok(summaries.includes("installing 1 skill at the repository level via the skills CLI"), summaries.join(" | "))
  })

  it("several candidates read in the plural through every phase", async () => {
    const summaries = await stageSummaries(["supabase/agent-skills@postgres", "stripe/agent-skills@payments"])
    assert.ok(summaries.includes("auditing 2 candidate skills against skills.sh security audits"), summaries.join(" | "))
    assert.ok(summaries.includes("installing 2 skills at the repository level via the skills CLI"), summaries.join(" | "))
  })

  it("explicit validation and removal each count their own ids", async () => {
    seedBaseline()
    const explicit: string[] = []
    await installSkills({
      repoRoot: repo,
      ids: ["supabase/agent-skills@postgres"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => explicit.push(r.summary),
    })
    assert.ok(explicit.includes("validating 1 explicitly requested skill id"), explicit.join(" | "))

    const removals: string[] = []
    await removeSkills({
      repoRoot: repo,
      ids: ["supabase/agent-skills@postgres", "acme/repo@scraper"],
      runRemove: () => ({ code: 0, output: "removed" }),
      emitReport: (r) => removals.push(r.summary),
    })
    assert.ok(removals.includes("removing 2 skills"), removals.join(" | "))
  })
})

const HERMETIC_GIT_HOME = mkdtempSync(join(tmpdir(), "vivicy-skills-git-home-"))

after(() => {
  rmSync(HERMETIC_GIT_HOME, { recursive: true, force: true })
})

// HOME and XDG_CONFIG_HOME are redirected, not just the config files: git reads its DEFAULT per-user excludes ($XDG_CONFIG_HOME/git/ignore, else $HOME/.config/git/ignore) whether or not core.excludesFile is set, and a per-user rule can only ADD ignores — which silently turns the "tree clean" assertion below green. The identity vars go too, so the absorption really has to establish one. process.env itself is mutated because the stage spawns its own git and npx children with the inherited environment.
async function withHermeticGitEnv<T>(fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string | undefined> = {
    HOME: HERMETIC_GIT_HOME,
    XDG_CONFIG_HOME: HERMETIC_GIT_HOME,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_EMAIL: undefined,
    GIT_AUTHOR_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
  }
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  const apply = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) apply(key, value)
  try {
    return await fn()
  } finally {
    for (const [key, value] of previous) apply(key, value)
  }
}

function git(root: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

const OWNER_AGENTS_MD = `# demo Development Operating Guide

<!-- vivicy:method:begin -->
## Working under Vivicy

The product truth is the frozen canonical spec.
<!-- vivicy:method:end -->

## House rules the owner wrote

Run the linter before pushing.
`

// Reproduces the layout MEASURED from `npx skills add` (bundle under .agents/skills, a per-agent link, a root lockfile); the link target is the one variable, since the guard under test reads exactly that.
function writeSkillsCliStub(root: string, linkTarget: "relative" | "absolute"): void {
  const bin = resolve(root, "node_modules/.bin")
  mkdirSync(bin, { recursive: true })
  const script = `#!/usr/bin/env node
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
const argv = process.argv.slice(2)
const source = argv[1]
const skill = argv[argv.indexOf("--skill") + 1]
const root = process.cwd()
const bundle = resolve(root, ".agents/skills", skill)
mkdirSync(resolve(bundle, "scripts"), { recursive: true })
writeFileSync(resolve(bundle, "SKILL.md"), \`---\\nname: \${skill}\\ndescription: bundle from \${source}\\n---\\n\`)
writeFileSync(resolve(bundle, "LICENSE.txt"), "MIT\\n")
writeFileSync(resolve(bundle, "scripts/recalc.py"), "print('recalc')\\n")
for (const agent of [".claude"${linkTarget === "absolute" ? ', ".codex"' : ""}]) {
  mkdirSync(resolve(root, agent, "skills"), { recursive: true })
  symlinkSync(${linkTarget === "absolute" ? "bundle" : "`../../.agents/skills/${skill}`"}, resolve(root, agent, "skills", skill))
}
writeFileSync(resolve(root, "skills-lock.json"), \`\${JSON.stringify({ version: 1, skills: { [skill]: { source, sourceType: "github" } } }, null, 2)}\\n\`)
console.log(\`Added \${source} (\${skill})\`)
`
  const path = resolve(bin, "skills")
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

function runStubSkillsCli({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }): {
  code: number
  output?: string
} {
  const r = spawnSync(resolve(repoRoot, "node_modules/.bin/skills"), ["add", source, "--skill", skill, "-y"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() }
}

function initGovernedGitTarget(): void {
  writeFileSync(resolve(repo, ".gitignore"), "node_modules\n.vivicy-tmp.*\n.vivicy/development/transcripts/\n")
  writeFileSync(resolve(repo, "AGENTS.md"), OWNER_AGENTS_MD)
  writeJson("vivicy.json", { gateCommand: "npm test" })
  mkdirSync(resolve(repo, ".vivicy/development/reports"), { recursive: true })
  writeFileSync(resolve(repo, ".vivicy/development/reports/.gitkeep"), "")
  git(repo, ["init", "-q"])
  git(repo, ["add", "-A"])
  git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: governed target before the skills stage"])
}

describe("absorption + worktree delivery (real git target, real skills-CLI seam)", () => {
  it("the stage ends on a clean tree and a worktree cut from HEAD carries the bundle, the links and both managed blocks", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "precondition: the owner's tree is clean")
      assert.equal(git(repo, ["config", "user.email"]).stdout.trim(), "", "precondition: no git identity is configured")

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(
        report.installed.map((e) => e.id),
        ["acme/pack@spreadsheets"]
      )

      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "the stage absorbed every one of its own writes")
      assert.equal(git(repo, ["config", "user.email"]).stdout.trim(), "vivicy@local", "the absorption established a local identity")
      assert.equal(git(repo, ["log", "-1", "--format=%s"]).stdout.trim(), "skills: absorb the project-skills stage writes")
      assert.equal(git(repo, ["rev-list", "--count", "HEAD"]).stdout.trim(), "2", "exactly ONE absorption commit, never one per write")

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"])
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
      assert.deepEqual(
        committed,
        [
          ".agents/skills/spreadsheets/LICENSE.txt",
          ".agents/skills/spreadsheets/SKILL.md",
          ".agents/skills/spreadsheets/scripts/recalc.py",
          ".claude/skills/spreadsheets",
          ".vivicy/development/reports/.gitkeep",
          ".vivicy/development/reports/skills-report.json",
          "AGENTS.md",
          "skills-lock.json",
          "vivicy.json",
        ],
        "the pathspec is exact: the bundle, its link and lockfile, the report, the pruned .gitkeep, and the two governance files — nothing of the owner's"
      )

      const worktreeParent = mkdtempSync(join(tmpdir(), "vivicy-skills-worktree-"))
      const worktree = join(worktreeParent, "issue")
      try {
        const added = git(repo, ["worktree", "add", "--detach", "-q", worktree, "HEAD"])
        assert.equal(added.status, 0, added.stderr)

        assert.match(readFileSync(join(worktree, ".agents/skills/spreadsheets/SKILL.md"), "utf8"), /name: spreadsheets/)
        assert.ok(existsSync(join(worktree, ".agents/skills/spreadsheets/scripts/recalc.py")), "the whole bundle rides, not just SKILL.md")
        assert.equal(readlinkSync(join(worktree, ".claude/skills/spreadsheets")), "../../.agents/skills/spreadsheets")
        assert.ok(existsSync(join(worktree, ".claude/skills/spreadsheets/SKILL.md")), "the per-agent link resolves inside the worktree")

        const agents = readFileSync(join(worktree, "AGENTS.md"), "utf8")
        assert.match(agents, /<!-- vivicy:method:begin -->/, "the method block survives in the delivered document")
        assert.match(agents, /<!-- vivicy:skills:begin -->/, "and the skills block is delivered beside it")
        assert.match(agents, /## House rules the owner wrote/, "the owner's own prose is untouched between the two blocks")
        assert.match(agents, /\*\*spreadsheets\*\* \(`acme\/pack@spreadsheets`, community\) — explicitly requested/)

        const config = JSON.parse(readFileSync(join(worktree, "vivicy.json"), "utf8")) as Record<string, unknown>
        assert.deepEqual(config.requiredSkills, ["acme/pack@spreadsheets"])
        assert.equal(config.gateCommand, "npm test", "the owner's own vivicy.json fields ride through untouched")
      } finally {
        git(repo, ["worktree", "remove", "--force", worktree])
        rmSync(worktreeParent, { recursive: true, force: true })
      }
    })
  })

  it("an ABSOLUTE per-agent link is relativized before it can reach history", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "absolute")

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "the stage still ends clean")
      for (const rel of [".claude/skills/spreadsheets", ".codex/skills/spreadsheets"]) {
        assert.equal(lstatSync(resolve(repo, rel)).isSymbolicLink(), true, `${rel} is still a symlink`)
        assert.equal(readlinkSync(resolve(repo, rel)), "../../.agents/skills/spreadsheets", `${rel} was relativized on disk`)
        assert.equal(
          git(repo, ["show", `HEAD:${rel}`]).stdout,
          "../../.agents/skills/spreadsheets",
          `${rel} landed in history as a relative link, so a clone on another machine still resolves it`
        )
      }
      assert.deepEqual(
        readdirSync(resolve(repo, ".claude/skills")),
        ["spreadsheets"],
        "the atomic replacement leaves no temp beside the link"
      )
    })
  })

  it("absorbs what THIS RUN wrote — owner work INSIDE the very directories the stage uses is never captured", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      // The owner's own Claude Code project skill, tracked and mid-edit: `.claude/skills` is THEIR directory too, the stage only ever puts links there named after what it installed.
      mkdirSync(resolve(repo, ".claude/skills/owner-writing-style"), { recursive: true })
      writeFileSync(resolve(repo, ".claude/skills/owner-writing-style/SKILL.md"), "committed draft\n")
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: my own project skill"])
      writeSkillsCliStub(repo, "relative")

      writeFileSync(resolve(repo, ".claude/skills/owner-writing-style/SKILL.md"), "half-written revision\n")
      mkdirSync(resolve(repo, ".claude/skills/owner-untracked-skill"), { recursive: true })
      writeFileSync(resolve(repo, ".claude/skills/owner-untracked-skill/SKILL.md"), "brand new, still mine\n")
      mkdirSync(resolve(repo, ".agents/skills/owner-hand-written"), { recursive: true })
      writeFileSync(resolve(repo, ".agents/skills/owner-hand-written/SKILL.md"), "hand-authored, not installed\n")
      writeFileSync(resolve(repo, "AGENTS.md"), `${OWNER_AGENTS_MD}\nA paragraph the owner is still writing.\n`)
      writeJson("vivicy.json", { gateCommand: "npm test", runCommand: "npm start" })

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"])
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
      assert.deepEqual(
        committed,
        [
          ".agents/skills/spreadsheets/LICENSE.txt",
          ".agents/skills/spreadsheets/SKILL.md",
          ".agents/skills/spreadsheets/scripts/recalc.py",
          ".claude/skills/spreadsheets",
          ".vivicy/development/reports/.gitkeep",
          ".vivicy/development/reports/skills-report.json",
          "skills-lock.json",
        ],
        "only this run's own bundle, link, lockfile and report — the two governance files were already the owner's manuscript when the run opened"
      )
      assert.deepEqual(
        git(repo, ["status", "--porcelain"])
          .stdout.split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort(),
        [
          "?? .agents/skills/owner-hand-written/",
          "?? .claude/skills/owner-untracked-skill/",
          "M .claude/skills/owner-writing-style/SKILL.md",
          "M AGENTS.md",
          "M vivicy.json",
        ],
        "every owner path stays uncommitted for them to resolve — the dirty-tree refusal on their own work is correct behavior"
      )
      assert.equal(
        readFileSync(resolve(repo, ".claude/skills/owner-writing-style/SKILL.md"), "utf8"),
        "half-written revision\n",
        "and their bytes are untouched"
      )
    })
  })

  it("owner work that appears DURING the run is not captured either — the pathspec is what the stage wrote, not where it writes", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")

      const report = await installSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        fetchAudit: fakeAudits(),
        // The stage runs detached while the owner keeps working: this fires mid-run, after the pre-stage snapshot was taken, so only the causal pathspec can exclude it.
        runInstall: (args) => {
          mkdirSync(resolve(repo, ".claude/skills/owner-mid-run"), { recursive: true })
          writeFileSync(resolve(repo, ".claude/skills/owner-mid-run/SKILL.md"), "written while the install ran\n")
          return runStubSkillsCli(args)
        },
      })
      assert.equal(report.phase, "green", report.summary)

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout
      assert.ok(!committed.includes("owner-mid-run"), "a skill directory the stage never installed is not the stage's to commit")
      assert.match(committed, /^AGENTS\.md$/m, "while AGENTS.md, which this run really did rewrite, is absorbed")
      assert.deepEqual(
        git(repo, ["status", "--porcelain"])
          .stdout.split("\n")
          .map((line) => line.trim())
          .filter(Boolean),
        ["?? .claude/skills/owner-mid-run/"],
        "only the owner's mid-run file is left for them"
      )
    })
  })

  it("a run that installs NOTHING commits its report and touches neither governance file", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      const agentsBefore = readFileSync(resolve(repo, "AGENTS.md"), "utf8")

      const report = await installSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        fetchAudit: async () => ({ found: true, audits: [{ provider: "gateseal", status: "fail" }] }),
      })
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(report.installed, [], "the red audit refused the only candidate")

      assert.deepEqual(
        git(repo, ["show", "--name-only", "--format=", "HEAD"])
          .stdout.split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort(),
        [".vivicy/development/reports/.gitkeep", ".vivicy/development/reports/skills-report.json"],
        "nothing was installed, so AGENTS.md and vivicy.json were never written and never staged"
      )
      assert.equal(readFileSync(resolve(repo, "AGENTS.md"), "utf8"), agentsBefore)
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
    })
  })

  it("commits its own staged set only — work the owner had already staged stays staged and uncommitted", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      writeFileSync(resolve(repo, "NOTES.md"), "the owner staged this for their own commit\n")
      git(repo, ["add", "--", "NOTES.md"])

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      assert.ok(
        !git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.includes("NOTES.md"),
        "a pathspec-less commit would have swept the whole index into the skills commit"
      )
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "A  NOTES.md", "their staged file is exactly as they left it")
    })
  })

  it("a throw after the first report write still settles the tree — exception is a closed path, not a dirty one", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      const boom = new Error("scout leg has no prompt file")

      await assert.rejects(
        installSkills({
          repoRoot: repo,
          ids: ["acme/pack@spreadsheets"],
          fetchAudit: fakeAudits(),
          runInstall: () => {
            throw boom
          },
        }),
        (error: unknown) => error === boom
      )

      assert.equal(
        git(repo, ["status", "--porcelain"]).stdout.trim(),
        "",
        "the report the failed run wrote was absorbed, not left to refuse the next Run"
      )
      assert.deepEqual(
        git(repo, ["show", "--name-only", "--format=", "HEAD"])
          .stdout.split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .sort(),
        [".vivicy/development/reports/.gitkeep", ".vivicy/development/reports/skills-report.json"]
      )
    })
  })

  it("a removal commit says what a removal did", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })

      const report = await removeSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        runRemove: ({ skill }) => {
          rmSync(resolve(repo, ".agents/skills", skill), { recursive: true, force: true })
          rmSync(resolve(repo, ".claude/skills", skill), { force: true })
          return { code: 0, output: "removed" }
        },
      })
      assert.equal(report.phase, "green", report.summary)

      const body = git(repo, ["log", "-1", "--format=%B"]).stdout
      assert.match(body, /^skills: absorb the project-skills removal\n/)
      assert.match(body, /the deleted bundle and per-agent links, the shrunken vivicy\.json requiredSkills/)
      assert.ok(!body.includes("Installed skill bundles"), "the install wording never rides a removal")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
      const removed = git(repo, ["show", "--name-status", "--format=", "HEAD"]).stdout
      assert.match(removed, /^D\t\.agents\/skills\/spreadsheets\/SKILL\.md$/m)
      assert.match(removed, /^D\t\.claude\/skills\/spreadsheets$/m)
    })
  })
})
