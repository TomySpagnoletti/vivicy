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
  symlinkSync,
  writeFileSync,
  mkdtempSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, afterEach, beforeEach, describe, it } from "node:test"

import {
  auditVerdict,
  buildSkillsBlock,
  installSkills,
  removeSkills,
  MAX_PROJECT_SKILLS,
  OFFICIAL_VENDOR_OWNERS,
  scoutContext,
  SkillsConfigError,
  SkillsLockError,
  skillsNotification,
  skillsStageNeeded,
  SKILLS_REPORT_REL,
} from "./install-skills.ts"
import type { SkillAuditFetch, SkillsReport } from "./install-skills.ts"
import { checkSkills, missingRequiredSkills, missingSkillsRefusal, readRequiredSkills } from "./dev-preflight.ts"
import { normalizeSkillId } from "./skill-id.ts"

const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json"
const BASELINE_ID = "baseline-v1.0.0"
const MANAGED_DOCS = ["AGENTS.md", "CLAUDE.md"] as const

// What the stage writes into a document that does not exist yet: its own head plus the block.
function skillsDoc(entries: Parameters<typeof buildSkillsBlock>[0]): string {
  return `# Agent instructions\n\n${buildSkillsBlock(entries)}\n`
}

// A UTF-16LE document with its BOM: the one encoding the managed-block engine refuses rather than mangle.
function utf16le(text: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
}

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

  // Ids arrive from LLM output and from chat text; every part of one becomes a directory name, a symlink path, a git pathspec or a URL element.
  it("refuses a `.` or `..` segment in EVERY part of an id, and in the URL form", () => {
    for (const id of ["a/b@..", "a/b@.", "../b@skill", "a/..@skill", "./b@skill", "a/.@skill", "../..@..", "a/b@../../etc"]) {
      assert.equal(normalizeSkillId(id), null, `${id} must not parse`)
    }
    assert.equal(normalizeSkillId("https://skills.sh/a/b/.."), null, "the URL form re-parses through the same rule")
    assert.equal(normalizeSkillId("a/b@...")?.skill, "...", "three dots is an ordinary name, not a traversal")
    assert.equal(normalizeSkillId("a/b@.hidden")?.skill, ".hidden")
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
  it("green path: scout selection -> audits -> install -> report + vivicy.json merge + the block in both documents", async () => {
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
    assert.equal(report.selection_baseline_id, BASELINE_ID)
    assert.equal(report.installed.length, 2)
    assert.deepEqual(report.added, ["supabase/agent-skills@postgres", "somebody/community@helper"])
    assert.deepEqual(report.removed, [])
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

    for (const rel of MANAGED_DOCS) {
      const doc = readFileSync(resolve(repo, rel), "utf8")
      assert.match(doc, /<!-- vivicy:skills:begin -->/, `${rel} carries the block — two CLIs read two files`)
      assert.match(doc, /## Project skills/)
      assert.match(
        doc,
        /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — `\.agents\/skills\/postgres\/SKILL\.md` — spec uses Supabase/,
        `${rel} bullet carries the executable SKILL.md path`
      )
      assert.match(
        doc,
        /\*\*Helper\*\* \(`somebody\/community@helper`, community\) — `\.agents\/skills\/helper\/SKILL\.md` — no official option/
      )
      assert.match(doc, /MUST consult and apply/)
    }
    assert.ok(!existsSync(resolve(repo, SCOUT_RESULT_REL)), "the transient scout result is cleared after the read")
  })

  it("selecting zero skills is a legitimate green and writes no vivicy.json and no governance document", async () => {
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
    for (const rel of MANAGED_DOCS) {
      assert.ok(!existsSync(resolve(repo, rel)), `${rel} is never created to say a project has no skills`)
    }
  })

  it("refuses loudly without an active frozen baseline", async () => {
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError)
  })

  it("a superseded frozen manifest is not an active baseline", async () => {
    writeJson(`.vivicy/baselines/${BASELINE_ID}.json`, { baseline_id: BASELINE_ID, status: "frozen", superseded: true })
    await assert.rejects(installSkills({ repoRoot: repo, spawnScout: fakeScout([]) }), SkillsConfigError)
  })

  it("skips idempotently when the auto stage already settled the SAME baseline, re-runs for a new one", async () => {
    seedBaseline()
    const prior = {
      phase: "green",
      selection_baseline_id: BASELINE_ID,
      mode: "auto",
      installed: [],
      added: [],
      removed: [],
      rejected: [],
      summary: "",
      updated_at: "",
    }
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
    assert.equal(rerun.selection_baseline_id, "baseline-v1.1.0")
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
    const seven = { skills: Array.from({ length: 7 }, (_, i) => ({ id: `owner/repo@skill-${i}`, reason: "the spec needs it" })) }
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
            { id: "somebody/community@first", reason: "no official option" },
            { id: "stripe/agent-skills@payments", reason: "the spec takes payments" },
            { id: "supabase/agent-skills@auth", reason: "the spec authenticates users" },
            { id: "a/b@one", reason: "already installed" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      emitReport: () => {},
    })
    assert.deepEqual(report.added, ["stripe/agent-skills@payments", "supabase/agent-skills@auth"])
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "stripe/agent-skills@payments", "supabase/agent-skills@auth"],
      "installed is the project's whole set — the four it already had plus the two this run added"
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

describe("the scout is told the constraints it will be judged by", () => {
  const BASE = {
    manifestPath: "/t/.vivicy/baselines/b.json",
    baselineId: BASELINE_ID,
    resultRel: SCOUT_RESULT_REL,
    attempt: 1,
    feedback: null,
  }

  function entry(id: string, skill: string): Parameters<typeof scoutContext>[0]["installed"][number] {
    return {
      id,
      source: id.slice(0, id.lastIndexOf("@")),
      skill,
      name: skill,
      official: true,
      security_waived: false,
      audits: [],
      reason: "",
    }
  }

  it("names the installed set, the remaining slots, the collision rule, the audit gate and the reason requirement", () => {
    const context = scoutContext({
      ...BASE,
      installed: [entry("supabase/agent-skills@postgres", "postgres"), entry("stripe/agent-skills@payments", "payments")],
    })
    assert.match(context, /Already installed \(2\/6 slots taken\): `supabase\/agent-skills@postgres`, `stripe\/agent-skills@payments`/)
    assert.match(context, /Never propose one of these again/)
    assert.match(context, /name \(the part after `@`\) matches one of theirs/, "the collision refusal is stated, not discovered")
    assert.match(context, /`\.agents\/skills\/<name>` holds ONE skill/)
    assert.match(
      context,
      /Propose AT MOST 4 skills: 6 is the project TOTAL across every run, not a per-run budget, and 2 slots are already taken/
    )
    assert.match(context, /REFUSED — never installed — when any audit fails, more than one warns, or no audit exists at all/)
    assert.match(context, /non-empty one-line `reason`/)
    assert.doesNotMatch(context, /Select AT MOST 6 skills/, "the stale flat cap is gone — the per-run bound is the remaining slots")
  })

  it("tells an empty project all six slots are free, without an empty list", () => {
    const context = scoutContext({ ...BASE, installed: [] })
    assert.match(context, /This project has NO skills installed yet: all 6 slots are free\./)
    assert.match(
      context,
      /Propose AT MOST 6 skills: 6 is the project TOTAL across every run, not a per-run budget, and 0 slots are already taken\./
    )
    assert.doesNotMatch(context, /Already installed/)
  })

  it("one slot left reads in the singular", () => {
    const context = scoutContext({ ...BASE, installed: [entry("a/b@one", "one")] })
    assert.match(context, /Already installed \(1\/6 slots taken\)/)
    assert.match(context, /and 1 slot is already taken/)
    const five = Array.from({ length: 5 }, (_, i) => entry(`a/b@s${i}`, `s${i}`))
    assert.match(scoutContext({ ...BASE, installed: five }), /Propose AT MOST 1 skill:/)
  })

  // The budget is DERIVED from the set the very next line prints, so the two can never state different arithmetic — the shape that let a raw id count and the projected set disagree.
  it("the printed set and the stated budget always add up to the cap", () => {
    for (let taken = 0; taken <= MAX_PROJECT_SKILLS; taken += 1) {
      const context = scoutContext({ ...BASE, installed: Array.from({ length: taken }, (_, i) => entry(`a/b@s${i}`, `s${i}`)) })
      const budget = Number(/Propose AT MOST (\d+) skills?:/.exec(context)?.[1])
      const printed = taken === 0 ? 0 : Number(/Already installed \((\d+)\/6 slots taken\)/.exec(context)?.[1])
      assert.equal(printed, taken, `context at ${taken} installed printed the wrong set size`)
      assert.equal(printed + budget, MAX_PROJECT_SKILLS, `context at ${taken} installed states ${printed} taken and ${budget} free`)
      assert.match(context, new RegExp(`and ${taken} slots? (is|are) already taken`), `the taken tail is stated at ${taken} too`)
    }
  })

  it("hands the leg the project's real installed set", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@one", "a/b@two"] })
    const seen: Array<{ installed: string[]; budget: string | undefined }> = []
    await installSkills({
      repoRoot: repo,
      spawnScout: async (args) => {
        seen.push({
          installed: args.installed.map((e) => e.id),
          budget: /Propose AT MOST (\d+ skills?):/.exec(scoutContext({ ...BASE, ...args }))?.[1],
        })
        mkdirSync(dirname(resolve(repo, SCOUT_RESULT_REL)), { recursive: true })
        writeFileSync(resolve(repo, SCOUT_RESULT_REL), JSON.stringify({ skills: [] }))
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.deepEqual(seen, [{ installed: ["a/b@one", "a/b@two"], budget: "4 skills" }])
  })

  it("re-prompts a candidate with an empty reason, naming it, and fails when it comes back the same", async () => {
    seedBaseline()
    const calls: Array<{ attempt: number; feedback: string | null }> = []
    const proposal = {
      skills: [
        { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "the spec uses Supabase" },
        { id: "somebody/community@helper", name: "Helper" },
      ],
    }
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([proposal, proposal], calls),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(calls.length, 2, "the bounded re-prompt loop enforces it")
    assert.match(calls[1].feedback ?? "", /somebody\/community@helper has an empty "reason"/)
    assert.equal(report.phase, "failed", "an unjustified candidate is never installed with an empty line in the block")
    assert.match(report.summary, /empty "reason"/)
    assert.deepEqual(report.installed, [], "not even the well-justified half of an invalid result lands")
  })

  it("a whitespace-only reason is empty", async () => {
    seedBaseline()
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "a/b@one", reason: "   \n  " }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.phase, "failed")
  })

  // An owner typo in requiredSkills ("anthropics/skills", no @skill) is declared but names no skill: the cap, the scout's budget and the report all read the installed SET, so it cannot invent a phantom slot. The shape this pins: a 5-skill project firing the at-capacity gate, stamping the settle marker and killing its own scouting for that baseline while the summary announced 5/6.
  it("a declared id that names no skill takes no slot — on either surface", async () => {
    seedBaseline()
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      requiredSkills: ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five", "anthropics/skills"],
    })
    const seen: Array<{ installed: string[]; context: string }> = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: async (args) => {
        seen.push({ installed: args.installed.map((e) => e.id), context: scoutContext({ ...BASE, ...args }) })
        mkdirSync(dirname(resolve(repo, SCOUT_RESULT_REL)), { recursive: true })
        writeFileSync(
          resolve(repo, SCOUT_RESULT_REL),
          JSON.stringify({
            skills: [
              { id: "stripe/agent-skills@payments", reason: "the spec takes payments" },
              { id: "anthropics/skills@pdf", reason: "the spec emails PDF invoices" },
            ],
          })
        )
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })

    assert.equal(seen.length, 1, "the leg IS spawned: a project with five real skills is not at capacity")
    assert.deepEqual(
      seen[0].installed,
      ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five"],
      "the id that names no skill is not in the set"
    )
    assert.match(seen[0].context, /Already installed \(5\/6 slots taken\)/)
    assert.match(
      seen[0].context,
      /Propose AT MOST 1 skill: 6 is the project TOTAL across every run, not a per-run budget, and 5 slots are already taken/
    )
    assert.ok(!seen[0].context.includes("anthropics/skills"), "an id no skill answers to is never named to the leg")

    assert.deepEqual(report.added, ["stripe/agent-skills@payments"], "the free slot was really free")
    assert.equal(report.installed.length, 6)
    assert.deepEqual(
      report.rejected,
      [
        {
          id: "anthropics/skills@pdf",
          reason: "cap_exceeded",
          detail: `project already has 5 skills; the installed set may never exceed ${MAX_PROJECT_SKILLS} total`,
        },
      ],
      "the cap detail counts the SET the owner can see, never the raw declared ids"
    )
    assert.doesNotMatch(report.summary, /every slot was already filled/, "the at-capacity sentence may never contradict its own count")
    assert.match(report.summary, /project total 6\/6$/)
  })

  it("a project already at the cap spawns NO leg at all, and settles the baseline anyway", async () => {
    seedBaseline()
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      requiredSkills: ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five", "a/b@six"],
    })
    const summaries: string[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: async () => {
        throw new Error("a project at capacity has nothing to scout")
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => summaries.push(r.summary),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.added, [])
    assert.deepEqual(report.rejected, [], "the owner is told once why nothing ran, never with six cap_exceeded rows")
    assert.equal(report.installed.length, MAX_PROJECT_SKILLS)
    assert.equal(report.selection_baseline_id, BASELINE_ID, "the baseline is settled, so the supervisor stops re-spawning the stage")
    assert.match(report.summary, /every slot was already filled, so no selection ran; remove a skill to free one/)
    assert.ok(
      summaries.includes("project already holds all 6 skill slots; no selection to run"),
      `the in-flight phase says it too: ${summaries.join(" | ")}`
    )
    assert.equal(skillsNotification(report), null, "and it asks the owner for nothing")
  })
})

describe("the skill NAME is the on-disk primary key", () => {
  it("refuses a candidate whose name an installed skill from another source already holds", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["supabase/agent-skills@postgres"] })
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          skills: [
            { id: "other/pack@postgres", name: "Other Postgres", reason: "the spec uses Postgres" },
            { id: "stripe/agent-skills@payments", name: "Payments", reason: "the spec takes card payments" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      emitReport: () => {},
    })

    assert.deepEqual(report.added, ["stripe/agent-skills@payments"], "the colliding candidate never reached the installer")
    assert.deepEqual(installs, [{ source: "stripe/agent-skills", skill: "payments" }])
    assert.deepEqual(report.rejected, [
      {
        id: "other/pack@postgres",
        reason: "name_collision",
        detail:
          'the name "postgres" is already taken by supabase/agent-skills@postgres; .agents/skills/postgres holds one skill, so keep one of the two',
      },
    ])
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["supabase/agent-skills@postgres", "stripe/agent-skills@payments"],
      "and the installed set still describes one skill per on-disk name"
    )
  })

  it("two vendors of the SAME name in one selection: the first keeps the name, the second is refused", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          skills: [
            { id: "somebody/community@postgres", name: "Community Postgres", reason: "no official option found" },
            { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "the spec uses Supabase" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      emitReport: () => {},
    })

    assert.deepEqual(installs, [{ source: "supabase/agent-skills", skill: "postgres" }], "official-first decides who keeps the name")
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "somebody/community@postgres", reason: "name_collision" }]
    )
    assert.deepEqual(report.added, ["supabase/agent-skills@postgres"])
  })

  it("a refused collision costs no cap slot: the next distinct candidate takes it", async () => {
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      requiredSkills: ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five"],
    })
    const report = await installSkills({
      repoRoot: repo,
      ids: ["x/y@one", "x/y@six"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.deepEqual(report.added, ["x/y@six"], "the last free slot went to the candidate that could actually use it")
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "x/y@one", reason: "name_collision" }]
    )
  })

  // The block's bullet, the removal fallback's rmSync target and the absorption pathspec are all this one derivation.
  it("a prior report whose entry contradicts its own id is normalized back onto the id", async () => {
    writeJson(SKILLS_REPORT_REL, {
      phase: "green",
      selection_baseline_id: null,
      mode: "explicit",
      added: [],
      removed: [],
      installed: [
        {
          id: "acme/pack@scraper",
          source: "somebody/else",
          skill: "..",
          name: "Scraper",
          official: true,
          security_waived: false,
          audits: [],
          reason: "hand-edited",
        },
        { id: "not-an-id", source: "x/y", skill: "ghost", name: "Ghost", official: false, security_waived: false, audits: [], reason: "" },
      ],
      rejected: [],
      summary: "",
      updated_at: "t",
    })
    const report = await installSkills({
      repoRoot: repo,
      ids: ["stripe/agent-skills@payments"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.deepEqual(
      report.installed.map((e) => ({ id: e.id, source: e.source, skill: e.skill })),
      [
        { id: "stripe/agent-skills@payments", source: "stripe/agent-skills", skill: "payments" },
        { id: "acme/pack@scraper", source: "acme/pack", skill: "scraper" },
      ],
      "source and skill are projections of the id, and an entry whose id names no skill is dropped"
    )
    assert.equal(report.installed[1].name, "Scraper", "the metadata that is NOT derivable from the id still rides")
    assertReportAgreesWithSkillsBlock(report)
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

    const note = skillsNotification(report)
    assert.equal(note?.event, "skills_findings", "a skill kept out by a red audit is the owner's to look at, never a silent green")
    assert.equal(note?.level, "warning")
    assert.equal(note?.stage, "SK")
    assert.equal(note?.message, report.summary)
  })

  it("a green stage that installed everything it chose says nothing at all", async () => {
    seedBaseline()
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      env: {},
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.rejected, [])
    assert.equal(skillsNotification(report), null)
  })

  it("only a failed stage and a green-with-rejections speak; every in-flight phase is silent", () => {
    const at = (phase: string, rejected: unknown[] = []) => skillsNotification({ phase, rejected, summary: "s" } as unknown as SkillsReport)
    assert.equal(at("failed")?.event, "skills_failed")
    assert.equal(at("failed")?.message, "project skills stage failed")
    assert.equal(at("green")?.event, undefined)
    assert.equal(at("green", [{ id: "x" }])?.event, "skills_findings")
    for (const phase of ["selecting", "validating", "auditing", "installing", "removing"]) {
      assert.equal(at(phase, [{ id: "x" }]), null, `${phase} is in flight and asks the owner for nothing`)
    }
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

  it("works without any frozen baseline and rejects ids beyond the cap", async () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["a/b@s1", "a/b@s2", "a/b@s3", "a/b@s4", "a/b@s5"] })
    const report = await installSkills({
      repoRoot: repo,
      ids: ["x/y@first", "x/y@second"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.selection_baseline_id, null, "an explicit install never claims a baseline the scout never read")
    assert.deepEqual(report.added, ["x/y@first"])
    assert.equal(report.installed.length, 6)
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
      spawnScout: fakeScout([
        {
          skills: [
            { id: "good/repo@fine", reason: "the spec needs it" },
            { id: "bad/repo@broken", reason: "the spec needs it too" },
          ],
        },
      ]),
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

  // vivicy.json is the owner's file: an unparseable one is never clobbered, which is exactly why the reported set cannot be read back from it alone.
  it("an unparseable vivicy.json is left untouched and the report still lists what was installed", async () => {
    seedBaseline()
    writeFileSync(resolve(repo, "vivicy.json"), "{ this is not json\n")
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.added, ["acme/repo@scraper"])
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["acme/repo@scraper"]
    )
    assert.equal(readFileSync(resolve(repo, "vivicy.json"), "utf8"), "{ this is not json\n", "the owner's broken file is theirs to fix")
    assertReportAgreesWithSkillsBlock(report)
  })
})

describe("the skills block rides the managed-block engine, in both governance documents", () => {
  const OWNER_PROSE = "# My project\n\nIntro prose.\n\n<!-- vivicy:method:begin -->\n## Working under Vivicy\n<!-- vivicy:method:end -->\n"

  async function installOne(): Promise<SkillsReport> {
    return installSkills({
      repoRoot: repo,
      ids: ["supabase/agent-skills@postgres"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
  }

  it("appends at EOF beside the method block, byte-preserving everything outside its own span, and re-runs as a zero diff", async () => {
    for (const rel of MANAGED_DOCS) writeFileSync(resolve(repo, rel), `${OWNER_PROSE}## Later section\n`)

    assert.equal((await installOne()).phase, "green")

    for (const rel of MANAGED_DOCS) {
      const doc = readFileSync(resolve(repo, rel), "utf8")
      assert.ok(doc.startsWith(`${OWNER_PROSE}## Later section\n`), `${rel}: the owner's bytes and their method block are untouched`)
      assert.match(doc, /## Later section\n\n<!-- vivicy:skills:begin -->/, "one blank-line separator, block at the tail")
      assert.ok(doc.endsWith("<!-- vivicy:skills:end -->\n"), "and a clean trailing newline")
      assert.equal(doc.match(/vivicy:skills:begin/g)?.length, 1, "exactly one managed block")
    }

    const before = MANAGED_DOCS.map((rel) => readFileSync(resolve(repo, rel), "utf8"))
    await installOne()
    MANAGED_DOCS.forEach((rel, i) => assert.equal(readFileSync(resolve(repo, rel), "utf8"), before[i], `${rel}: byte-identical re-run`))
  })

  // The hand-rolled splice this replaced paired the first begin with the first end by index, so an owner who damaged a marker got a SECOND block; the engine repairs the residue instead.
  it("repairs markers the owner damaged instead of stacking a second block", async () => {
    const damaged = `# Mine\n\n<!-- vivicy:skills:end -->\n<!-- vivicy:skills:begin -->\n## Project skills\n\nhalf a block\n`
    for (const rel of MANAGED_DOCS) writeFileSync(resolve(repo, rel), damaged)

    assert.equal((await installOne()).phase, "green")

    for (const rel of MANAGED_DOCS) {
      const doc = readFileSync(resolve(repo, rel), "utf8")
      assert.equal(doc.match(/vivicy:skills:begin/g)?.length, 1, `${rel}: one begin marker`)
      assert.equal(doc.match(/vivicy:skills:end/g)?.length, 1, `${rel}: one end marker`)
      assert.match(doc, /^# Mine\n/, "the owner's own line survives the repair")
      assert.match(doc, /`supabase\/agent-skills@postgres`/)
    }
  })

  it("a symlinked CLAUDE.md keeps its link, and the block lands once in the file it points at", async () => {
    writeFileSync(resolve(repo, "AGENTS.md"), OWNER_PROSE)
    symlinkSync("AGENTS.md", resolve(repo, "CLAUDE.md"))

    assert.equal((await installOne()).phase, "green")

    assert.equal(lstatSync(resolve(repo, "CLAUDE.md")).isSymbolicLink(), true, "a rename onto the link would detach the owner's convention")
    const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
    assert.equal(agents.match(/vivicy:skills:begin/g)?.length, 1, "the second write found the block already converged")
    assert.equal(readFileSync(resolve(repo, "CLAUDE.md"), "utf8"), agents)
  })

  it("refuses a UTF-16 document untouched and ends the stage red, naming the file and what to do", async () => {
    writeFileSync(resolve(repo, "AGENTS.md"), OWNER_PROSE)
    const utf16 = utf16le("# mine\n")
    writeFileSync(resolve(repo, "CLAUDE.md"), utf16)

    const report = await installOne()

    assert.equal(report.phase, "failed")
    assert.match(report.summary, /^skills stage failed: CLAUDE\.md refused the project skills block \(not UTF-8 — it is saved as UTF-16LE/)
    assert.match(report.summary, /fix that file and re-run the skills stage\.$/)
    assert.equal(
      report.installed.map((e) => e.id).join(),
      "supabase/agent-skills@postgres",
      "the skill is installed and reported — only the document refused"
    )
    assert.deepEqual((readJson("vivicy.json") as { requiredSkills: string[] }).requiredSkills, ["supabase/agent-skills@postgres"])
    assert.deepEqual(readFileSync(resolve(repo, "CLAUDE.md")), utf16, "a file Vivicy cannot splice byte-safely is never written at all")
    assert.match(
      readFileSync(resolve(repo, "AGENTS.md"), "utf8"),
      /vivicy:skills:begin/,
      "and the document it CAN write still gets the block"
    )
    assert.equal(skillsNotification(report)?.event, "skills_failed")
    assert.equal(skillsNotification(report)?.level, "error")
  })

  // The recorded relay: a read-only document used to throw out of the stage mid-phase, leaving a report stuck in flight and requiredSkills naming a skill whose block no retry ever wrote.
  it("a read-only document that still has something to receive fails the stage — and the retry after the owner fixes it converges", async () => {
    for (const rel of MANAGED_DOCS) writeFileSync(resolve(repo, rel), OWNER_PROSE)
    chmodSync(resolve(repo, "CLAUDE.md"), 0o444)

    const refused = await installOne()
    assert.equal(refused.phase, "failed")
    assert.match(refused.summary, /^skills stage failed: CLAUDE\.md refused the project skills block \(EACCES: permission denied\)\./)
    assert.ok(!refused.summary.includes(".vivicy-tmp."), "Vivicy's internal temp name means nothing to the owner")
    assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).phase, "failed", "the report on disk is terminal, never left mid-phase")

    chmodSync(resolve(repo, "CLAUDE.md"), 0o644)
    const retry = await installSkills({
      repoRoot: repo,
      ids: ["supabase/agent-skills@postgres"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(retry.phase, "green")
    assert.deepEqual(retry.rejected, [], "the already-installed id is no rejection: the retry's work is the block")
    for (const rel of MANAGED_DOCS) {
      assert.match(readFileSync(resolve(repo, rel), "utf8"), /`supabase\/agent-skills@postgres`/, `${rel} converged on the retry`)
    }
  })

  // The block is rewritten only where it would CHANGE, which is what lets every settled re-run converge it without turning a read-only AGENTS.md — a document Vivicy has nothing left to say to — into a failed skills stage.
  it("a settled re-run over a converged block writes nothing, even when AGENTS.md is read-only", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const abs = resolve(repo, "AGENTS.md")
    const before = readFileSync(abs, "utf8")
    chmodSync(abs, 0o444)
    try {
      const skipped = await installSkills({
        repoRoot: repo,
        spawnScout: async () => {
          throw new Error("a settled baseline must never spawn the scout")
        },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
      })
      assert.equal(skipped.phase, "skipped")
      assert.equal(readFileSync(abs, "utf8"), before, "the block was already the report's set, so there was nothing to write")
    } finally {
      chmodSync(abs, 0o644)
    }
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
      /\*\*Supabase Postgres\*\* \(`supabase\/agent-skills@postgres`, official\) — `\.agents\/skills\/postgres\/SKILL\.md` — database/,
      "the first run's metadata survives the second run"
    )
    assert.match(agents, /`stripe\/agent-skills@payments`, official/)
    assert.equal(agents.match(/vivicy:skills:begin/g)?.length, 1)
  })
})

describe("supervisor hook decision (skillsStageNeeded)", () => {
  it("keys on the AUTO stage's own settle marker: missing, unstamped, or stamped for another baseline all still owe a selection", () => {
    const baseline = { baselineId: BASELINE_ID }
    assert.equal(skillsStageNeeded(null, null), false, "no baseline -> nothing to select from")
    assert.equal(skillsStageNeeded(baseline, null), true)
    assert.equal(skillsStageNeeded(baseline, { selection_baseline_id: null }), true, "a stage that never settled still owes a selection")
    assert.equal(skillsStageNeeded(baseline, { selection_baseline_id: "baseline-v0.9.0" }), true)
    assert.equal(skillsStageNeeded(baseline, { selection_baseline_id: BASELINE_ID }), false)
    assert.equal(skillsStageNeeded(baseline, { selection_baseline_id: 7 }), true, "a garbage marker on disk is no settlement")
  })

  it("an explicit install and a removal before the first Run both leave the scout still owed, and neither disturbs a settled one", async () => {
    seedBaseline()
    const baseline = { baselineId: BASELINE_ID }
    const owed = (): boolean => skillsStageNeeded(baseline, readJson(SKILLS_REPORT_REL) as SkillsReport)

    const explicit = await installSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf", "acme/repo@scraper"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(explicit.phase, "green")
    assert.equal(explicit.selection_baseline_id, null)
    assert.equal(owed(), true, "one explicit install may never cancel the automatic scouting this baseline has never had")

    const earlyRemoval = await removeSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf"],
      runRemove: () => ({ code: 0, output: "removed" }),
    })
    assert.equal(earlyRemoval.phase, "green")
    assert.equal(earlyRemoval.selection_baseline_id, null, "a removal never stamps a settlement the scout never made")
    assert.equal(owed(), true, "and a removal cannot cancel the scouting either")

    const auto = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(auto.selection_baseline_id, BASELINE_ID, "the auto path is the only writer of the settle marker")
    assert.equal(owed(), false)

    const lateRemoval = await removeSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      runRemove: () => ({ code: 0, output: "removed" }),
    })
    assert.equal(lateRemoval.selection_baseline_id, BASELINE_ID, "a removal carries the marker rather than re-stamping or clearing it")
    assert.equal(owed(), false)
  })

  it("a FAILED auto run leaves the baseline unsettled, so the stage stays retryable", async () => {
    seedBaseline()
    const failed = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout(["not json", "still not json"]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(failed.phase, "failed")
    assert.equal(failed.selection_baseline_id, null)
    assert.equal(skillsStageNeeded({ baselineId: BASELINE_ID }, readJson(SKILLS_REPORT_REL) as SkillsReport), true)
  })
})

describe("the report tells the truth about the project's whole installed set", () => {
  it("a second auto run reports both baselines' skills, with only its own contribution in added", async () => {
    seedBaseline()
    const first = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.deepEqual(first.added, ["supabase/agent-skills@postgres"])

    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    seedBaseline("baseline-v1.1.0")
    const second = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "stripe/agent-skills@payments", name: "Stripe", reason: "payments" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.deepEqual(second.added, ["stripe/agent-skills@payments"], "added is this run's contribution alone")
    assert.deepEqual(
      second.installed.map((e) => e.id),
      ["supabase/agent-skills@postgres", "stripe/agent-skills@payments"],
      "installed is the project's full set — the first run's skill is not dropped by the second"
    )
    assertReportAgreesWithSkillsBlock(second)
  })

  it("an explicit install reports the full set too, and every surface reads the same one", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const explicit = await installSkills({
      repoRoot: repo,
      ids: ["stripe/agent-skills@payments"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.deepEqual(explicit.added, ["stripe/agent-skills@payments"])
    assert.deepEqual(
      explicit.installed.map((e) => e.id),
      ["supabase/agent-skills@postgres", "stripe/agent-skills@payments"]
    )
    assert.equal(explicit.installed[0].reason, "database", "the first run's metadata rides the full set, never re-derived")
    assertReportAgreesWithSkillsBlock(explicit)
    assert.deepEqual(
      (readJson("vivicy.json") as { requiredSkills: string[] }).requiredSkills,
      explicit.installed.map((e) => e.id),
      "and vivicy.json declares exactly the same set"
    )
  })

  it("the in-flight report already carries the project's set, so no surface shows an empty project mid-run", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    seedBaseline("baseline-v1.1.0")
    const seen: string[][] = []
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: (r) => seen.push(r.installed.map((e) => e.id)),
    })
    assert.ok(seen.length >= 3, `expected a report per phase, got ${seen.length}`)
    for (const [index, ids] of seen.entries()) {
      assert.ok(ids.includes("anthropics/skills@pdf"), `phase ${index} lost the already-installed skill: ${ids.join(", ")}`)
    }
    assert.deepEqual(seen.at(-1), ["anthropics/skills@pdf", "stripe/agent-skills@payments"])
  })

  it("a skill an owner declared by hand in vivicy.json joins the set and the block, and a skipped run converges both", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ skills: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const config = readJson("vivicy.json") as Record<string, unknown>
    writeJson("vivicy.json", { ...config, requiredSkills: [...(config.requiredSkills as string[]), "acme/repo@scraper"] })

    const skipped = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(skipped.phase, "skipped")
    assert.deepEqual(
      skipped.installed.map((e) => e.id),
      ["supabase/agent-skills@postgres", "acme/repo@scraper"]
    )
    const derived = skipped.installed[1]
    assert.deepEqual(
      { name: derived.name, official: derived.official, security_waived: derived.security_waived, audits: derived.audits },
      { name: "scraper", official: false, security_waived: false, audits: [] },
      "an id no report ever described claims nothing it cannot derive from the id"
    )
    assertReportAgreesWithSkillsBlock(skipped)
  })

  it("a removal reports the shrunken set and names only what it dropped", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf", "acme/repo@scraper"],
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const report = await removeSkills({
      repoRoot: repo,
      ids: ["anthropics/skills@pdf"],
      runRemove: () => ({ code: 0, output: "removed" }),
    })
    assert.deepEqual(report.removed, ["anthropics/skills@pdf"])
    assert.deepEqual(report.added, [])
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["acme/repo@scraper"]
    )
    assertReportAgreesWithSkillsBlock(report)
  })
})

// The acceptance the whole slice exists for: the report's set and the block a leg reads are one value projected twice, so they cannot state different things — in EITHER document, since the two CLIs read different files.
function assertReportAgreesWithSkillsBlock(report: SkillsReport): void {
  for (const rel of MANAGED_DOCS) {
    const doc = readFileSync(resolve(repo, rel), "utf8")
    const block = doc.slice(doc.indexOf("<!-- vivicy:skills:begin -->"), doc.indexOf("<!-- vivicy:skills:end -->"))
    assert.ok(block.length > 0, `the ${rel} skills block is missing entirely`)
    const pattern = /^- \*\*(?<name>[^*]+)\*\* \(`(?<id>[^`]+)`, (?<origin>official|community)\) — `(?<doc>[^`]+)`/gm
    const listed = [...block.matchAll(pattern)].map((m) => ({
      id: m.groups!.id,
      name: m.groups!.name,
      origin: m.groups!.origin,
      doc: m.groups!.doc,
    }))
    assert.deepEqual(
      listed,
      report.installed.map((e) => ({
        id: e.id,
        name: e.name,
        origin: e.official ? "official" : "community",
        doc: `.agents/skills/${e.skill}/SKILL.md`,
      })),
      `${rel} and report.installed are the same set, in the same order, with the same metadata and the same bundle paths`
    )
  }
}

describe("dev-preflight declared skills (vivicy.json, the one location)", () => {
  function installBundle(name: string): void {
    const abs = resolve(repo, ".agents/skills", name, "SKILL.md")
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, `---\nname: ${name}\n---\n`)
  }

  it("reads vivicy.json requiredSkills verbatim, as the full ids they are", () => {
    writeJson("vivicy.json", { gateCommand: "cargo test", requiredSkills: ["supabase/agent-skills@postgres", "plain-name"] })
    assert.deepEqual(readRequiredSkills(repo), ["supabase/agent-skills@postgres", "plain-name"])
  })

  it("a `vivicy` field in package.json declares nothing — vivicy.json is the only source", () => {
    writeJson("package.json", { vivicy: { requiredSkills: ["from-pkg"] } })
    assert.deepEqual(readRequiredSkills(repo), [])

    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["from-vivicy"] })
    assert.deepEqual(readRequiredSkills(repo), ["from-vivicy"])
  })

  it("an explicit empty requiredSkills in vivicy.json declares no skills", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: [] })
    assert.deepEqual(readRequiredSkills(repo), [])
    assert.deepEqual(checkSkills(repo), { ok: true, missingRequired: [], reason: undefined }, "nothing declared, nothing to look for")
  })

  it("no target at all declares nothing and demands nothing", () => {
    assert.deepEqual(readRequiredSkills(null), [])
    assert.equal(checkSkills(null, []).ok, true)
    assert.deepEqual(missingRequiredSkills(null, ["a/b@c"]), ["a/b@c"], "with no target, a declared skill can only be missing")
  })

  // Exact on the declared id's own name: a bundle whose name merely CONTAINS it is a different skill, and no tool's output text is consulted.
  it("matches the bundle by the declared id's own name — `next-auth` never answers for `auth`", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["vendor/x@auth"] })
    installBundle("next-auth")
    assert.deepEqual(missingRequiredSkills(repo, readRequiredSkills(repo)), ["vendor/x@auth"], "a longer name is a different skill")

    installBundle("auth")
    assert.deepEqual(missingRequiredSkills(repo, readRequiredSkills(repo)), [])
  })

  it("two vendors' ids with the same name resolve to the one bundle that carries it", () => {
    installBundle("postgres")
    assert.deepEqual(missingRequiredSkills(repo, ["supabase/agent-skills@postgres", "other/pack@postgres"]), [])
    assert.deepEqual(missingRequiredSkills(repo, ["supabase/agent-skills@other"]), ["supabase/agent-skills@other"])
  })

  it("a bare name declares its own bundle; a traversal-shaped declaration can only be missing", () => {
    installBundle("plain-name")
    assert.deepEqual(missingRequiredSkills(repo, ["plain-name"]), [])
    assert.deepEqual(missingRequiredSkills(repo, ["a/b@..", "..", "."]), ["a/b@..", "..", "."])
    assert.ok(
      existsSync(resolve(repo, ".agents/skills/..")),
      "the parent directory really is there, so it is the segment rule that refuses `..` — never a path that happens not to exist"
    )
  })

  // A bundle directory with no SKILL.md is not a skill: the block promises every leg a readable SKILL.md at that path.
  it("an empty bundle directory is not an installed skill", () => {
    mkdirSync(resolve(repo, ".agents/skills/postgres"), { recursive: true })
    assert.deepEqual(missingRequiredSkills(repo, ["supabase/agent-skills@postgres"]), ["supabase/agent-skills@postgres"])
  })

  it("checkSkills fails only when a declared skill's bundle is absent, and says so", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["acme/pack@must-have"] })
    const absent = checkSkills(repo)
    assert.equal(absent.ok, false)
    assert.deepEqual(absent.missingRequired, ["acme/pack@must-have"])
    assert.match(absent.reason ?? "", /not installed in the target project/)

    installBundle("must-have")
    assert.deepEqual(checkSkills(repo), { ok: true, missingRequired: [], reason: undefined })
  })

  // The refusal is owner-facing CONTRACT: it is the whole instruction for clearing a blocked run, so it may name only what the check itself reads.
  it("the missing-skills refusal names vivicy.json and the bundle path, and NOTHING else", () => {
    const refusal = missingSkillsRefusal(["supabase/agent-skills@postgres", "acme/pack@stripe"])
    assert.match(refusal, /vivicy\.json "requiredSkills"/)
    assert.match(refusal, /\.agents\/skills\/<name>\/SKILL\.md/, "the location the check looks at is where the owner must land it")
    assert.doesNotMatch(refusal, /package\.json/, "package.json declares nothing — pointing there cannot clear the refusal")
    assert.doesNotMatch(refusal, /skills list/, "the check no longer asks a CLI, so naming its output would misdirect")
    assert.match(refusal, /npx skills add <owner\/repo> --skill <name>/, "the install half is the invocation the installer itself uses")
  })

  it("the refusal's count forms agree with the number of missing skills", () => {
    assert.match(missingSkillsRefusal(["a/b@postgres"]), /^1 required development skill missing: a\/b@postgres\n/)
    assert.match(missingSkillsRefusal(["a/b@postgres"]), /install it into .* or drop it from/)
    assert.match(
      missingSkillsRefusal(["a/b@postgres", "a/b@stripe"]),
      /^2 required development skills missing: a\/b@postgres, a\/b@stripe\n/
    )
    assert.match(missingSkillsRefusal(["a/b@postgres", "a/b@stripe"]), /install them into .* or drop them from/)
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
    selection_baseline_id: BASELINE_ID,
    mode: "explicit",
    added: [],
    removed: [],
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
    const doc = skillsDoc([
      { id: "anthropics/skills@pdf", skill: "pdf", name: "pdf", official: true, reason: "" },
      { id: "acme/repo@scraper", skill: "scraper", name: "scraper", official: false, reason: "" },
    ])
    for (const rel of MANAGED_DOCS) writeFileSync(resolve(repo, rel), doc)
  }

  function fakeRemover(calls: FakeInstallCall[], failFor: Set<string> = new Set()) {
    return ({ source, skill }: { repoRoot: string; source: string; skill: string }) => {
      calls.push({ source, skill })
      return failFor.has(`${source}@${skill}`) ? { code: 1, output: "remove exploded" } : { code: 0, output: "removed" }
    }
  }

  it("removes an installed skill: report, vivicy.json, and both governance documents all shrink together", async () => {
    seedInstalledState()
    const calls: FakeInstallCall[] = []
    const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover(calls) })

    assert.equal(report.phase, "green")
    assert.equal(report.mode, "remove")
    assert.deepEqual(report.removed, ["anthropics/skills@pdf"])
    assert.deepEqual(calls, [{ source: "anthropics/skills", skill: "pdf" }])
    const config = readJson("vivicy.json") as { gateCommand: string; requiredSkills: string[] }
    assert.equal(config.gateCommand, "npm test")
    assert.deepEqual(config.requiredSkills, ["acme/repo@scraper"])
    for (const rel of MANAGED_DOCS) {
      const doc = readFileSync(resolve(repo, rel), "utf8")
      assert.ok(doc.includes("acme/repo@scraper"), `${rel} keeps the surviving skill`)
      assert.ok(!doc.includes("anthropics/skills@pdf"), `${rel} dropped the removed one`)
    }
    const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
    assert.equal(onDisk.installed?.length, 1)
    assert.equal(onDisk.installed?.[0]?.id, "acme/repo@scraper")
  })

  it("accepts a skills.sh URL and frees a cap slot", async () => {
    seedInstalledState()
    const report = await removeSkills({ repoRoot: repo, ids: ["https://skills.sh/acme/repo/scraper"], runRemove: fakeRemover([]) })
    assert.deepEqual(report.removed, ["acme/repo@scraper"])
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

    assert.deepEqual(report.removed, ["acme/repo@scraper"])
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "anthropics/skills@pdf", reason: "remove_failed" }]
    )
    const config = readJson("vivicy.json") as { requiredSkills: string[] }
    assert.deepEqual(config.requiredSkills, ["anthropics/skills@pdf"], "the failed removal keeps its slot")
  })

  // Emptying the block is the one write a zero-skill project gets; a document that never carried one is still never given one.
  it("renders the empty-set block in the documents that carry it, and creates none in the one that does not", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] })
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf"] })
    writeFileSync(
      resolve(repo, "AGENTS.md"),
      skillsDoc([{ id: "anthropics/skills@pdf", skill: "pdf", name: "pdf", official: true, reason: "" }])
    )

    await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover([]) })

    assert.ok(readFileSync(resolve(repo, "AGENTS.md"), "utf8").includes("No project skills are currently installed"))
    assert.ok(!existsSync(resolve(repo, "CLAUDE.md")), "a document with no block is not handed an empty one")
  })

  // Removing the last skill over documents that both refuse the write: the summary names every refused document and says what is now stale in them, never that a skill nobody has is unreadable.
  it("names both refused documents when the empty-set block cannot land", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] })
    writeJson("vivicy.json", { gateCommand: "npm test", requiredSkills: ["anthropics/skills@pdf"] })
    const doc = skillsDoc([{ id: "anthropics/skills@pdf", skill: "pdf", name: "pdf", official: true, reason: "" }])
    for (const rel of MANAGED_DOCS) {
      writeFileSync(resolve(repo, rel), doc)
      chmodSync(resolve(repo, rel), 0o444)
    }
    try {
      const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover([]) })
      assert.equal(report.phase, "failed")
      assert.match(
        report.summary,
        /^skills stage failed: 2 governance files refused the project skills block — AGENTS\.md \(EACCES: permission denied\); CLAUDE\.md \(EACCES: permission denied\)\./
      )
      assert.match(
        report.summary,
        /AGENTS\.md and CLAUDE\.md still list skills this project no longer has — fix those files and re-run the skills stage\.$/
      )
      assert.deepEqual(report.installed, [], "the removal itself happened; only the documents refused")
    } finally {
      for (const rel of MANAGED_DOCS) chmodSync(resolve(repo, rel), 0o644)
    }
  })

  // The removal fallback resolves `.agents/skills/<skill>` and removes it recursively, so a `..` skill part admitted by the id grammar would delete EVERY installed bundle. The refusal is the grammar's, upstream of the remover — which is why no remover is injected here: reaching the default at all is the defect.
  it("a traversal-shaped id is refused before any remover runs, and every bundle survives", async () => {
    seedInstalledState()
    for (const name of ["pdf", "scraper"]) {
      mkdirSync(resolve(repo, ".agents/skills", name), { recursive: true })
      writeFileSync(resolve(repo, ".agents/skills", name, "SKILL.md"), `---\nname: ${name}\n---\n`)
    }

    const report = await removeSkills({ repoRoot: repo, ids: ["a/b@..", "a/b@."] })

    assert.deepEqual(report.removed, [])
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [
        { id: "a/b@..", reason: "invalid_id" },
        { id: "a/b@.", reason: "invalid_id" },
      ]
    )
    assert.deepEqual(readdirSync(resolve(repo, ".agents/skills")).sort(), ["pdf", "scraper"])
    assert.ok(existsSync(resolve(repo, ".agents/skills/pdf/SKILL.md")))
    assert.deepEqual((readJson("vivicy.json") as { requiredSkills: string[] }).requiredSkills.length, 2)
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
      spawnScout: fakeScout([{ skills: ids.map((id) => ({ id, reason: "the canonical needs it" })) }]),
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

describe("the stage lock (one skills stage per project, claimed where the writes are)", () => {
  const SKILLS_LOCK_FILE = "skills-install.lock"

  // spawnSync returns only after the child has been reaped, so signalling this pid is ESRCH — a killed stage's residue, not a holder.
  function reapedPid(): number {
    const r = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" })
    assert.equal(r.status, 0)
    assert.ok(typeof r.pid === "number" && r.pid > 0)
    return r.pid
  }

  function writeLock(runtimeDir: string, pid: number): string {
    mkdirSync(runtimeDir, { recursive: true })
    const abs = join(runtimeDir, SKILLS_LOCK_FILE)
    writeFileSync(abs, `${JSON.stringify({ pid, started_at: new Date().toISOString() }, null, 2)}\n`)
    return abs
  }

  it("refuses a second stage while a live one holds the lock, and writes nothing over the holder's state", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    writeLock(runtimeDir, process.pid)
    writeJson(SKILLS_REPORT_REL, { phase: "installing", mode: "auto", installed: [], added: [], removed: [], rejected: [] })
    const before = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")

    await assert.rejects(
      installSkills({
        repoRoot: repo,
        ids: ["acme/repo@scraper"],
        env: { VIVICY_RUNTIME_DIR: runtimeDir },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
      }),
      (error: unknown) => error instanceof SkillsLockError && /already in flight \(pid \d+\)/.test((error as Error).message)
    )

    assert.equal(
      readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"),
      before,
      "the holder's report is never overwritten by the refused run"
    )
    assert.ok(!existsSync(resolve(repo, "vivicy.json")), "and nothing else was written either")
    assert.ok(
      existsSync(join(runtimeDir, SKILLS_LOCK_FILE)),
      "the holder still owns its lock — a refused run never releases someone else's"
    )
  })

  // pid 1 is alive and owned by root: the probe must read EPERM as a live holder, not as "gone".
  it("a live holder this user does not own is still a holder", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    writeLock(runtimeDir, 1)
    await assert.rejects(
      installSkills({
        repoRoot: repo,
        ids: ["acme/repo@scraper"],
        env: { VIVICY_RUNTIME_DIR: runtimeDir },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
      }),
      SkillsLockError
    )
    assert.ok(existsSync(join(runtimeDir, SKILLS_LOCK_FILE)))
  })

  // A stage whose lock was reclaimed out from under it (its own pid gone from the file) must not delete the successor's claim on its way out.
  it("releases only its OWN claim, never a lock another holder has since taken", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    const abs = join(runtimeDir, SKILLS_LOCK_FILE)
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      env: { VIVICY_RUNTIME_DIR: runtimeDir },
      fetchAudit: fakeAudits(),
      runInstall: () => {
        writeLock(runtimeDir, 1)
        return { code: 0, output: "installed" }
      },
    })
    assert.equal(report.phase, "green")
    assert.equal((JSON.parse(readFileSync(abs, "utf8")) as { pid: number }).pid, 1, "the successor's lock is still there, untouched")
  })

  it("a removal claims the very same file, so an install in flight refuses it too", async () => {
    const runtimeDir = join(repo, "runtime")
    writeLock(runtimeDir, process.pid)
    await assert.rejects(
      removeSkills({
        repoRoot: repo,
        ids: ["acme/repo@scraper"],
        env: { VIVICY_RUNTIME_DIR: runtimeDir },
        runRemove: () => ({ code: 0, output: "removed" }),
      }),
      SkillsLockError
    )
  })

  it("holds the lock at the path both clients probe for the whole run, and releases it after", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    const abs = join(runtimeDir, SKILLS_LOCK_FILE)
    let heldDuringRun: number | null = null
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      env: { VIVICY_RUNTIME_DIR: runtimeDir },
      fetchAudit: fakeAudits(),
      runInstall: () => {
        heldDuringRun = (JSON.parse(readFileSync(abs, "utf8")) as { pid: number }).pid
        return { code: 0, output: "installed" }
      },
    })
    assert.equal(report.phase, "green")
    assert.equal(heldDuringRun, process.pid, "the stage process itself is the recorded holder")
    assert.ok(!existsSync(abs), "and the claim is released on the way out, never left for the next run to reclaim")
  })

  // Breaking a killed run's residue is exclusive per residue (lib/stage-lock.ts owns the protocol and its races); what the STAGE owes is surfacing a break it did not win as its own typed refusal, having written nothing.
  it("refuses when another stage is already breaking the same residue", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    writeLock(runtimeDir, reapedPid())
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(
      join(runtimeDir, `${SKILLS_LOCK_FILE}.break`),
      `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`
    )

    await assert.rejects(
      installSkills({
        repoRoot: repo,
        ids: ["acme/repo@scraper"],
        env: { VIVICY_RUNTIME_DIR: runtimeDir },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
      }),
      SkillsLockError
    )
    assert.ok(!existsSync(resolve(repo, "vivicy.json")), "a stage that lost the break writes nothing")
  })

  it("reclaims a lock whose holder is gone — a killed stage never dead-ends the next one", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    writeLock(runtimeDir, reapedPid())
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      env: { VIVICY_RUNTIME_DIR: runtimeDir },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(report.phase, "green")
    assert.ok(!existsSync(join(runtimeDir, SKILLS_LOCK_FILE)))
  })

  it("releases the lock on a throw too, so one broken run cannot lock the project out", async () => {
    seedBaseline()
    const runtimeDir = join(repo, "runtime")
    const boom = new Error("scout leg has no prompt file")
    await assert.rejects(
      installSkills({
        repoRoot: repo,
        ids: ["acme/repo@scraper"],
        env: { VIVICY_RUNTIME_DIR: runtimeDir },
        fetchAudit: fakeAudits(),
        runInstall: () => {
          throw boom
        },
      }),
      (error: unknown) => error === boom
    )
    assert.ok(!existsSync(join(runtimeDir, SKILLS_LOCK_FILE)))

    const after = await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      env: { VIVICY_RUNTIME_DIR: runtimeDir },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.equal(after.phase, "green")
  })

  // Every client hands the stage a project-scoped VIVICY_RUNTIME_DIR; a caller that hands none still gets a project-scoped lock, never one keyed on the cwd it happened to be spawned in.
  it("falls back to the project's own gitignored runtime dir when no runtime dir is handed in", async () => {
    seedBaseline()
    const abs = resolve(repo, ".vivicy-runtime", SKILLS_LOCK_FILE)
    let heldDuringRun: number | null = null
    await installSkills({
      repoRoot: repo,
      ids: ["acme/repo@scraper"],
      env: {},
      fetchAudit: fakeAudits(),
      runInstall: () => {
        heldDuringRun = (JSON.parse(readFileSync(abs, "utf8")) as { pid: number }).pid
        return { code: 0, output: "installed" }
      },
    })
    assert.equal(heldDuringRun, process.pid)
    assert.ok(!existsSync(abs))
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

// The pointer document a governed repo really carries (factory/templates/CLAUDE.md): its own method block, and an import of AGENTS.md.
const OWNER_CLAUDE_MD = `<!-- vivicy:method:begin -->
This repository is governed by the **Vivicy** development factory;
the operating guide for every agent working here — Claude included — is [AGENTS.md](./AGENTS.md).
Read it first.

@AGENTS.md
<!-- vivicy:method:end -->
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
  writeFileSync(resolve(repo, ".gitignore"), "node_modules\n.vivicy-tmp.*\n.vivicy-runtime/\n.vivicy/development/transcripts/\n")
  writeFileSync(resolve(repo, "AGENTS.md"), OWNER_AGENTS_MD)
  writeFileSync(resolve(repo, "CLAUDE.md"), OWNER_CLAUDE_MD)
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
          "CLAUDE.md",
          "skills-lock.json",
          "vivicy.json",
        ],
        "the pathspec is exact: the bundle, its link and lockfile, the report, the pruned .gitkeep, and the three governance files — nothing of the owner's"
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
        assert.match(
          agents,
          /\*\*spreadsheets\*\* \(`acme\/pack@spreadsheets`, community\) — `\.agents\/skills\/spreadsheets\/SKILL\.md` — explicitly requested/
        )

        // The bullet is an instruction, so its path has to resolve in the tree the leg actually works in.
        const claude = readFileSync(join(worktree, "CLAUDE.md"), "utf8")
        assert.match(claude, /@AGENTS\.md/, "the Claude pointer document keeps its own method block")
        assert.match(
          claude,
          /<!-- vivicy:skills:begin -->/,
          "and carries the skills block too — the Claude CLI reads this file, not AGENTS.md"
        )
        const bulletPath = /— `(\.agents\/skills\/spreadsheets\/SKILL\.md)`/.exec(claude)?.[1]
        assert.ok(bulletPath && existsSync(join(worktree, bulletPath)), `the bullet's path resolves inside the worktree: ${bulletPath}`)

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
          "CLAUDE.md",
          "skills-lock.json",
        ],
        "this run's own bundle, link, lockfile, report and the CLAUDE.md block it wrote — while AGENTS.md and vivicy.json were already the owner's manuscript when the run opened"
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

  // The causal record is the engine's `onWrite`, so a document the run does NOT change never enters the pathspec: recording it up front would hand Vivicy an owner edit that appeared mid-run on a converged document.
  it("a document this run leaves converged is not in the pathspec at all — an owner's mid-run edit to it stays theirs", async () => {
    await withHermeticGitEnv(async () => {
      seedBaseline()
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      const proposal = { skills: [{ id: "acme/pack@spreadsheets", name: "Spreadsheets", reason: "the spec exports CSV" }] }
      await installSkills({ repoRoot: repo, spawnScout: fakeScout([proposal]), fetchAudit: fakeAudits() })
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")

      rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
      seedBaseline("baseline-v1.1.0")
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: the next freeze"])

      // The scout runs after the pre-stage snapshot, and re-proposes what is already installed, so the rendered block is identical and no document is written.
      const report = await installSkills({
        repoRoot: repo,
        fetchAudit: fakeAudits(),
        spawnScout: async (args) => {
          writeFileSync(
            resolve(repo, "AGENTS.md"),
            `${readFileSync(resolve(repo, "AGENTS.md"), "utf8")}\nA paragraph the owner added while the stage ran.\n`
          )
          return fakeScout([proposal])(args)
        },
      })
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(report.added, [], "the re-proposed skill was already installed")

      assert.ok(
        !git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.includes("AGENTS.md"),
        "a document the run never wrote is not the run's to commit, whoever made it dirty"
      )
      assert.deepEqual(git(repo, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean), [" M AGENTS.md"])
      assert.match(
        readFileSync(resolve(repo, "AGENTS.md"), "utf8"),
        /A paragraph the owner added while the stage ran\./,
        "and their bytes are still there"
      )
    })
  })

  // A write that got as far as the causal record and THEN failed to publish must withdraw it: an owner edit landing on that document after the pre-stage snapshot would otherwise ride Vivicy's commit — the very inversion the record exists to prevent. The blocked temp path is the failure mode that reaches the record (an encoding refusal happens before it), and it leaves the document itself perfectly writable by the owner.
  it("a document whose write could not be PUBLISHED leaves the pathspec — the owner's mid-run edit to it stays theirs", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      // The exact temp name the atomic publish builds for CLAUDE.md; a directory sitting there fails the write after the record is taken.
      mkdirSync(resolve(repo, `.vivicy-tmp.${process.pid}.CLAUDE.md`, "not-vivicy's"), { recursive: true })

      const report = await installSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        fetchAudit: fakeAudits(),
        // Fires mid-run, after the pre-stage snapshot: the owner is mid-edit in the document the stage is about to fail on.
        runInstall: (args) => {
          writeFileSync(resolve(repo, "CLAUDE.md"), `${OWNER_CLAUDE_MD}\nA paragraph the owner added while the stage ran.\n`)
          return runStubSkillsCli(args)
        },
      })
      assert.equal(report.phase, "failed", report.summary)
      assert.match(report.summary, /^skills stage failed: CLAUDE\.md refused the project skills block \(/)
      assert.match(
        report.summary,
        /but nothing reading CLAUDE\.md learns about it until the block lands there — fix that file and re-run the skills stage\.$/,
        "the consequence names the refused document and nothing else — AGENTS.md did take the block"
      )

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout
      assert.ok(!committed.includes("CLAUDE.md"), "the write never landed, so the document is not the stage's to commit")
      assert.match(committed, /^AGENTS\.md$/m, "while the document that DID take the block is absorbed")
      assert.deepEqual(git(repo, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean), [" M CLAUDE.md"])
      assert.match(
        readFileSync(resolve(repo, "CLAUDE.md"), "utf8"),
        /A paragraph the owner added while the stage ran\./,
        "their bytes, untouched"
      )
    })
  })

  // The withdrawal has to name the key the record took: through a symlink that key is the RESOLVED target, so withdrawing the link's name would leave the target in the pathspec and commit whatever the owner does to it.
  it("a symlinked document whose write could not be published withdraws the RESOLVED path, not the link's name", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      mkdirSync(resolve(repo, "docs"), { recursive: true })
      writeFileSync(resolve(repo, "docs/agent-notes.md"), "# Agent notes\n\nThe owner keeps their guide here.\n")
      rmSync(resolve(repo, "AGENTS.md"))
      symlinkSync("docs/agent-notes.md", resolve(repo, "AGENTS.md"))
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: my guide, linked as AGENTS.md"])
      // The temp the atomic publish builds BESIDE the resolved file; a directory there fails the write after the causal record is taken.
      mkdirSync(resolve(repo, "docs", `.vivicy-tmp.${process.pid}.agent-notes.md`, "not-vivicy's"), { recursive: true })

      const report = await installSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        fetchAudit: fakeAudits(),
        runInstall: (args) => {
          writeFileSync(resolve(repo, "docs/agent-notes.md"), "# Agent notes\n\nA paragraph the owner added while the stage ran.\n")
          return runStubSkillsCli(args)
        },
      })
      assert.equal(report.phase, "failed", report.summary)

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout
      assert.ok(
        !committed.includes("agent-notes.md"),
        "the write never landed, so the file it would have landed in is not the stage's to commit"
      )
      assert.deepEqual(git(repo, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean), [" M docs/agent-notes.md"])
      assert.match(readFileSync(resolve(repo, "docs/agent-notes.md"), "utf8"), /A paragraph the owner added while the stage ran\./)
    })
  })

  // The pre-stage snapshot and the causal record must read ONE key space: a document symlinked to another in-repo file is dirty under the TARGET's name, and a snapshot that only knows the link's name would let the owner's uncommitted bytes there ride the absorption commit.
  it("owner dirt in a symlinked document's target is seen by the snapshot and left uncommitted", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      mkdirSync(resolve(repo, "docs"), { recursive: true })
      writeFileSync(resolve(repo, "docs/agent-notes.md"), "# Agent notes\n\nThe owner keeps their Claude guide here.\n")
      rmSync(resolve(repo, "CLAUDE.md"))
      symlinkSync("docs/agent-notes.md", resolve(repo, "CLAUDE.md"))
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: my guide, linked as CLAUDE.md"])
      // Already uncommitted when the run opens: their manuscript, whatever Vivicy writes into the same file afterwards.
      writeFileSync(
        resolve(repo, "docs/agent-notes.md"),
        "# Agent notes\n\nThe owner keeps their Claude guide here.\n\nA half-written paragraph.\n"
      )

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      const inHistory = git(repo, ["show", "HEAD:docs/agent-notes.md"]).stdout
      assert.ok(!inHistory.includes("A half-written paragraph."), "the owner's uncommitted bytes never entered history")
      assert.ok(!inHistory.includes("vivicy:skills:begin"), "and neither did the block Vivicy merged into their dirty file")
      const working = readFileSync(resolve(repo, "docs/agent-notes.md"), "utf8")
      assert.match(working, /A half-written paragraph\./, "their paragraph is still there")
      assert.match(working, /`acme\/pack@spreadsheets`/, "with the block beside it, for them to commit")
      assert.deepEqual(git(repo, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean), [" M docs/agent-notes.md"])
    })
  })

  // The record follows the bytes: a managed document that is a symlink publishes into the file it points at, and a pathspec naming the unchanged link would leave the real write dirty.
  it("a symlinked document absorbs the file the bytes landed in, not the link", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      rmSync(resolve(repo, "AGENTS.md"))
      symlinkSync("CLAUDE.md", resolve(repo, "AGENTS.md"))
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: one document, two names"])

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      assert.equal(lstatSync(resolve(repo, "AGENTS.md")).isSymbolicLink(), true, "their convention survives")
      const claude = readFileSync(resolve(repo, "CLAUDE.md"), "utf8")
      assert.equal(claude.match(/vivicy:skills:begin/g)?.length, 1, "the block landed once, in the file the link points at")
      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout
      assert.match(committed, /^CLAUDE\.md$/m, "and THAT file is what the absorption staged")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "so nothing of the stage's is left to refuse the next Run")
    })
  })

  // CLAUDE.md is a document the stage now writes AND a document an owner edits, so it has to be in the pre-stage snapshot's reading: without it, the stage's own write to their half-finished file would carry their bytes into Vivicy's commit.
  it("an owner's uncommitted CLAUDE.md is theirs — the stage's block write to it is left uncommitted with their edit", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      writeFileSync(resolve(repo, "CLAUDE.md"), `${OWNER_CLAUDE_MD}\nA paragraph the owner is still writing.\n`)

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout
      assert.ok(!committed.includes("CLAUDE.md"), "their manuscript is never committed, not even the half of it Vivicy wrote")
      assert.match(committed, /^AGENTS\.md$/m, "while the document they had not touched is absorbed")
      assert.deepEqual(git(repo, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean), [" M CLAUDE.md"])
      const claude = readFileSync(resolve(repo, "CLAUDE.md"), "utf8")
      assert.match(claude, /A paragraph the owner is still writing\./, "their own bytes survive the block write")
      assert.match(claude, /`acme\/pack@spreadsheets`/, "which really did happen — the file is theirs to commit, not to skip")
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

  // The skipped path used to write nothing but its report; it now converges the block in both documents too, and a stage write left uncommitted is exactly the dirty-tree refusal the absorption exists to close.
  it("a settled re-run that converges the block absorbs that write too — the zero-work path still ends clean", async () => {
    await withHermeticGitEnv(async () => {
      seedBaseline()
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      await installSkills({
        repoRoot: repo,
        spawnScout: fakeScout([{ skills: [{ id: "acme/pack@spreadsheets", name: "Spreadsheets", reason: "the spec exports CSV" }] }]),
        fetchAudit: fakeAudits(),
      })
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")

      // The owner declares a skill they installed themselves: the next settled run must converge the block instead of leaving the two surfaces split.
      const config = readJson("vivicy.json") as Record<string, unknown>
      writeJson("vivicy.json", { ...config, requiredSkills: [...(config.requiredSkills as string[]), "owner/own@handmade"] })
      git(repo, ["add", "--", "vivicy.json"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: my own skill"])

      const skipped = await installSkills({
        repoRoot: repo,
        spawnScout: async () => {
          throw new Error("a settled baseline must never spawn the scout")
        },
        fetchAudit: fakeAudits(),
      })
      assert.equal(skipped.phase, "skipped")
      assert.deepEqual(
        skipped.installed.map((e) => e.id),
        ["acme/pack@spreadsheets", "owner/own@handmade"]
      )

      const agents = readFileSync(resolve(repo, "AGENTS.md"), "utf8")
      assert.match(agents, /`owner\/own@handmade`, community/, "the block converged onto the hand-declared skill")
      assert.match(agents, /## House rules the owner wrote/, "and the owner's own prose is still there")
      assert.equal(
        git(repo, ["status", "--porcelain"]).stdout.trim(),
        "",
        "the convergence write was absorbed, not left to refuse the next Run"
      )
      const committed = git(repo, ["show", "--name-only", "--format=", "HEAD"])
        .stdout.split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .sort()
      assert.deepEqual(
        committed,
        ["AGENTS.md", "CLAUDE.md", ".vivicy/development/reports/skills-report.json"].sort(),
        "the skipped run commits exactly the two blocks it converged and its own report — never vivicy.json, which it did not write"
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
