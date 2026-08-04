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
import { fileURLToPath } from "node:url"
import { after, afterEach, beforeEach, describe, it } from "node:test"

import {
  auditVerdict,
  buildSkillsBlock,
  installSkills,
  maintainSkills,
  removeSkills,
  MAX_PROJECT_SKILLS,
  MAX_SCOUT_CANDIDATES,
  OFFICIAL_VENDOR_OWNERS,
  scoutContext,
  SkillsConfigError,
  SkillsLockError,
  skillsNotifications,
  skillsStageNeeded,
  SKILLS_REPORT_REL,
} from "./install-skills.ts"
import type { SkillAuditFetch, SkillsReport } from "./install-skills.ts"
import { normalizeSkillId } from "./skill-id.ts"
import { bundleDrift, hashBundle, maintenanceNeeded, manifestHash, readSkillDeclarations } from "./skill-pin.ts"
import { ensureProjectRuntimeDir } from "../lib/project-runtime.ts"
import { isSkillsPhaseInFlight } from "../lib/skills-report.ts"
import { bundleCacheDir, healBundle } from "./skill-heal.ts"

const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json"
const BASELINE_ID = "baseline-v1.0.0"
const MANAGED_DOCS = ["AGENTS.md", "CLAUDE.md"] as const

function skillsDoc(entries: Parameters<typeof buildSkillsBlock>[0]): string {
  return `# Agent instructions\n\n${buildSkillsBlock(entries)}\n`
}

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

function declared(ids: readonly string[]): Array<{ id: string }> {
  return ids.map((id) => ({ id }))
}

function declaredIds(root = repo): string[] {
  return readSkillDeclarations(root).map((declaration) => declaration.id)
}

function pinOf(id: string, root = repo): { bundle_hash: string; files: Record<string, string> } | null {
  return readSkillDeclarations(root).find((declaration) => declaration.id === id)?.pin ?? null
}

function bundleDir(skill: string, root = repo): string {
  return resolve(root, ".agents/skills", skill)
}

function writeBundle(root: string, skill: string, files: Record<string, string> = {}): void {
  const contents = { "SKILL.md": `# ${skill}\n`, ...files }
  for (const [rel, body] of Object.entries(contents)) {
    const abs = resolve(root, ".agents/skills", skill, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
}

function seedBaseline(baselineId = BASELINE_ID): void {
  writeJson(`.vivicy/baselines/${baselineId}.json`, { baseline_id: baselineId, status: "frozen", version: "1.0.0" })
}

interface FakeInstallCall {
  source: string
  skill: string
}

// A fixture that states no verdicts KEEPS the whole installed set: the keep/drop half is the subject of its own cases, never an obligation every other case must restate.
function keepAll(result: unknown, installed: readonly { id: string }[]): unknown {
  if (result === null || typeof result !== "object" || "installed" in result) return result
  return { ...result, installed: installed.map((entry) => ({ id: entry.id, verdict: "keep", reason: "the canonical still needs it" })) }
}

function fakeScout(resultsByAttempt: Array<unknown | string>, calls: Array<{ attempt: number; feedback: string | null }> = []) {
  return async ({
    repoRoot,
    attempt,
    feedback,
    installed,
  }: {
    repoRoot: string
    attempt: number
    feedback: string | null
    installed: readonly { id: string }[]
  }) => {
    calls.push({ attempt, feedback })
    const result = resultsByAttempt[attempt - 1]
    if (result === undefined) return
    const abs = resolve(repoRoot, SCOUT_RESULT_REL)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, typeof result === "string" ? result : JSON.stringify(keepAll(result, installed)))
  }
}

function drops(id: string): { id: string; verdict: string; reason: string } {
  return { id, verdict: "drop", reason: "the project pivoted away from it" }
}

// Read what the stage really WROTE: skillsNotifications called by hand cannot see the prior report the writer threads, so only this proves "told once".
function notifications(runtimeDir: string): Array<{ level: string; event: string; message: string }> {
  const file = join(runtimeDir, "notifications.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

// The stage's notify seam reads process.env, never the injected env, so a case that wants the real rows has to own that variable.
async function withRuntimeNotifications<T>(runtimeDir: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.VIVICY_RUNTIME_DIR
    else process.env.VIVICY_RUNTIME_DIR = previous
  }
}

function passAudit(): SkillAuditFetch {
  return { state: "audited", audits: [{ provider: "gateseal", status: "pass" }] }
}

const UNREACHABLE: SkillAuditFetch = { state: "unreachable", reason: "getaddrinfo ENOTFOUND skills.sh" }

// Never let a case actually wait out the backoff: the schedule is the subject of its own assertion, never every other case's cost.
function instantSleep(waits: number[] = []) {
  return async (ms: number): Promise<void> => {
    waits.push(ms)
  }
}

function fakeAudits(bySkill: Record<string, SkillAuditFetch> = {}) {
  return async ({ source, skill }: { source: string; skill: string }) => bySkill[`${source}@${skill}`] ?? passAudit()
}

// Never `assert.fail` inside an upstream stub: the probe swallows a throw as one more transport failure, so the case would pass vacuously.
function offlineCli(): { code: number; output: string } {
  return { code: 1, output: "npm error code ENOTFOUND\nnpm error network getaddrinfo ENOTFOUND registry.npmjs.org" }
}

function upstreamServing(files: Record<string, string>, calls: FakeInstallCall[] = []) {
  return ({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }) => {
    calls.push({ source, skill })
    writeBundle(repoRoot, skill, files)
    return { code: 0, output: "installed" }
  }
}

function fakeInstaller(calls: FakeInstallCall[], failFor: Set<string> = new Set(), files: Record<string, string> = {}) {
  return ({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }) => {
    calls.push({ source, skill })
    if (failFor.has(`${source}@${skill}`)) return { code: 1, output: "npx skills add exploded" }
    writeBundle(repoRoot, skill, files)
    return { code: 0, output: "installed" }
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
    assert.equal(auditVerdict({ state: "audited", audits: [{ provider: "a", status: "pass" }] }), "safe")
    assert.equal(auditVerdict({ state: "audited", audits: [{ provider: "a", status: "warn" }] }), "safe")
    assert.equal(
      auditVerdict({
        state: "audited",
        audits: [
          { provider: "a", status: "warn" },
          { provider: "b", status: "warn" },
        ],
      }),
      "too_many_warnings"
    )
    assert.equal(
      auditVerdict({
        state: "audited",
        audits: [
          { provider: "a", status: "pass" },
          { provider: "b", status: "fail" },
        ],
      }),
      "red_audit"
    )
    assert.equal(auditVerdict({ state: "unaudited" }), "unaudited")
  })

  it("separates a registry that ANSWERED from one that never did", () => {
    assert.equal(auditVerdict({ state: "unaudited" }), "unaudited", "the registry's own 404 is a decision about the skill")
    assert.equal(
      auditVerdict({ state: "audited", audits: [] }),
      "unaudited",
      "and an answer carrying zero audits states the same fact — never `safe` by absence of a failing one"
    )
    assert.equal(auditVerdict(UNREACHABLE), "unreachable", "no answer at all is transport, and decides nothing")
  })
})

describe("the bundle hasher (what a pin IS)", () => {
  function bundleAt(dir: string, files: Record<string, string>): string {
    for (const [rel, body] of Object.entries(files)) {
      const abs = resolve(repo, dir, rel)
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, body)
    }
    return resolve(repo, dir)
  }

  it("hashes a manifest canonically: sorted paths, NUL-delimited records, each hash bound to its own path", () => {
    const canonical = manifestHash({ "SKILL.md": "sha256:aa", "scripts/a.py": "sha256:bb" })
    assert.match(canonical, /^[0-9a-f]{64}$/)
    assert.equal(canonical, manifestHash({ "scripts/a.py": "sha256:bb", "SKILL.md": "sha256:aa" }), "insertion order cannot change a pin")
    assert.notEqual(canonical, manifestHash({ "SKILL.md": "sha256:bb", "scripts/a.py": "sha256:aa" }), "each hash is bound to its own path")
    assert.notEqual(
      canonical,
      manifestHash({ "SKILL.mdsha256:aascripts/a.py": "sha256:bb" }),
      "the record delimiter is what stops two entries being forged into one"
    )
  })

  it("pins every file under the bundle, independently of the order the filesystem lists them in", () => {
    const first = hashBundle(bundleAt("a", { "SKILL.md": "doc\n", "scripts/z.py": "z\n", "scripts/a.py": "a\n" }))
    const second = hashBundle(bundleAt("b", { "scripts/a.py": "a\n", "scripts/z.py": "z\n", "SKILL.md": "doc\n" }))
    assert.ok(first && second)
    assert.equal(first.bundle_hash, second.bundle_hash, "the same bytes pin identically whatever order they were written in")
    assert.deepEqual(Object.keys(first.files), ["SKILL.md", "scripts/a.py", "scripts/z.py"], "the manifest is sorted, POSIX-relative")
    assert.match(first.files["SKILL.md"], /^sha256:[0-9a-f]{64}$/)
  })

  it("binds each hash to its own path, so swapping two files' contents is drift", () => {
    const straight = hashBundle(bundleAt("straight", { "SKILL.md": "one\n", "other.md": "two\n" }))
    const swapped = hashBundle(bundleAt("swapped", { "SKILL.md": "two\n", "other.md": "one\n" }))
    assert.ok(straight && swapped)
    assert.notEqual(straight.bundle_hash, swapped.bundle_hash)
  })

  it("names exactly which files moved: a changed byte, an added file, a removed one", () => {
    const pin = hashBundle(bundleAt("pinned", { "SKILL.md": "doc\n", "scripts/a.py": "a\n" }))
    assert.ok(pin)
    assert.equal(bundleDrift(pin, hashBundle(resolve(repo, "pinned"))), null, "unchanged bytes are no drift")

    writeFileSync(resolve(repo, "pinned/scripts/a.py"), "tampered\n")
    assert.deepEqual(bundleDrift(pin, hashBundle(resolve(repo, "pinned"))), { missing: false, changed: ["scripts/a.py"] })

    writeFileSync(resolve(repo, "pinned/scripts/a.py"), "a\n")
    writeFileSync(resolve(repo, "pinned/extra.md"), "smuggled\n")
    assert.deepEqual(bundleDrift(pin, hashBundle(resolve(repo, "pinned"))), { missing: false, changed: ["extra.md"] })

    rmSync(resolve(repo, "pinned/extra.md"))
    rmSync(resolve(repo, "pinned/SKILL.md"))
    assert.deepEqual(bundleDrift(pin, hashBundle(resolve(repo, "pinned"))), { missing: false, changed: ["SKILL.md"] })

    const many = bundleAt("many", { "SKILL.md": "doc\n", a: "1", b: "2", c: "3", d: "4", e: "5" })
    const manyPin = hashBundle(many)
    assert.ok(manyPin)
    for (const rel of ["a", "b", "c", "d", "e"]) writeFileSync(resolve(many, rel), "changed\n")
    assert.deepEqual(bundleDrift(manyPin, hashBundle(many))?.changed, ["a", "b", "c", "d"], "five differ, four are named")
  })

  it("pins a symlink by its target, so replacing a file with a link to the same text is drift", () => {
    const dir = bundleAt("linked", { "SKILL.md": "doc\n", "real.md": "payload\n" })
    symlinkSync("real.md", resolve(dir, "alias.md"))
    const pin = hashBundle(dir)
    assert.ok(pin)
    assert.equal(pin.files["alias.md"], "symlink:real.md")

    rmSync(resolve(dir, "alias.md"))
    writeFileSync(resolve(dir, "alias.md"), "real.md")
    const drift = bundleDrift(pin, hashBundle(dir))
    assert.deepEqual(drift, { missing: false, changed: ["alias.md"] }, "a file whose CONTENT is the link's target is not the link")
  })

  it("gives even an unsupported entry kind a value, so its appearance is drift", () => {
    const dir = bundleAt("kinds", { "SKILL.md": "doc\n" })
    const pin = hashBundle(dir)
    assert.ok(pin)
    const fifo = spawnSync("mkfifo", [resolve(dir, "pipe")], { encoding: "utf8" })
    assert.equal(fifo.status, 0, `mkfifo must be available for this case: ${fifo.stderr}`)
    const withFifo = hashBundle(dir)
    assert.equal(withFifo?.files["pipe"], "unsupported:10000", "a fifo is recorded by its kind, never skipped")
    assert.deepEqual(bundleDrift(pin, withFifo), { missing: false, changed: ["pipe"] })
    rmSync(resolve(dir, "pipe"), { force: true })
  })

  it("pins a file named `__proto__` like any other, at the bundle root and below it", () => {
    const dir = bundleAt("hostile", { "SKILL.md": "doc\n" })
    const pin = hashBundle(dir)
    assert.ok(pin)
    writeFileSync(resolve(dir, "__proto__"), "payload\n")
    const withRoot = hashBundle(dir)
    assert.deepEqual(Object.keys(withRoot?.files ?? {}), ["SKILL.md", "__proto__"], "the entry is a real own key of the manifest")
    assert.match(withRoot?.files["__proto__"] ?? "", /^sha256:[0-9a-f]{64}$/)
    assert.deepEqual(bundleDrift(pin, withRoot), { missing: false, changed: ["__proto__"] }, "and its appearance is drift")

    mkdirSync(resolve(dir, "sub"), { recursive: true })
    writeFileSync(resolve(dir, "sub/__proto__"), "payload\n")
    assert.ok(Object.keys(hashBundle(dir)?.files ?? {}).includes("sub/__proto__"))
  })

  it("round-trips a `__proto__` entry through vivicy.json, and names only what really moved", async () => {
    writeBundle(repo, "quirky", { constructor: "harmless\n" })
    writeFileSync(resolve(bundleDir("quirky"), "__proto__"), "payload\n")
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/pack@quirky"],
      fetchAudit: fakeAudits(),
      runInstall: () => ({ code: 0, output: "already on disk" }),
    })
    assert.deepEqual(report.added, ["acme/pack@quirky"], report.summary)
    assert.match(readFileSync(resolve(repo, "vivicy.json"), "utf8"), /"__proto__": "sha256:/, "the pin on disk carries the entry")
    const pin = pinOf("acme/pack@quirky")
    assert.ok(pin)
    assert.deepEqual(Object.keys(pin.files).sort(), ["SKILL.md", "__proto__", "constructor"], "and the reader keeps it as an own key")

    writeFileSync(resolve(bundleDir("quirky"), "SKILL.md"), "# tampered\n")
    assert.deepEqual(
      bundleDrift(pin, hashBundle(bundleDir("quirky"))),
      { missing: false, changed: ["SKILL.md"] },
      "so a file that never moved is never named as drift"
    )
  })

  it("has no pin at all for a bundle that is not there, and reads that as missing", () => {
    assert.equal(hashBundle(resolve(repo, "absent")), null)
    const pin = hashBundle(bundleAt("present", { "SKILL.md": "doc\n" }))
    assert.ok(pin)
    assert.deepEqual(bundleDrift(pin, null), { missing: true, changed: [] })
  })

  it("is blind to empty directories, exactly as git is", () => {
    const dir = bundleAt("empties", { "SKILL.md": "doc\n" })
    const before = hashBundle(dir)
    mkdirSync(resolve(dir, "nothing/here"), { recursive: true })
    assert.equal(hashBundle(dir)?.bundle_hash, before?.bundle_hash)
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
          add: [
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
    assert.deepEqual(declaredIds(), ["supabase/agent-skills@postgres", "somebody/community@helper"])
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
      spawnScout: fakeScout([{ add: [] }]),
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
      spawnScout: fakeScout([{ add: [] }], scoutCalls),
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
      spawnScout: fakeScout(["not json at all", { add: [{ id: "invented-without-find" }] }], scoutCalls),
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

  it("more ranked candidates than the over-selection bound is invalid scout output (re-prompted, then failed)", async () => {
    seedBaseline()
    const eleven = { add: Array.from({ length: 11 }, (_, i) => ({ id: `owner/repo@skill-${i}`, reason: "the spec needs it" })) }
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([eleven, eleven]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.phase, "failed")
    assert.match(report.summary, new RegExp(`11 skills proposed in "add"; the maximum is ${MAX_SCOUT_CANDIDATES}`))

    rmSync(resolve(repo, SKILLS_REPORT_REL), { force: true })
    const ten = { add: Array.from({ length: MAX_SCOUT_CANDIDATES }, (_, i) => ({ id: `owner/repo@ok-${i}`, reason: "the spec needs it" })) }
    const accepted = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([ten]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(accepted.phase, "green", "ten ranked candidates for six slots is exactly what over-selection is for")
    assert.equal(accepted.added.length, MAX_PROJECT_SKILLS)
  })

  it("fills the budget from the top of the ranking, and the tail below it is reserve rather than a refusal", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["a/b@one", "a/b@two", "a/b@three", "a/b@four"]) })
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [
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
    assert.deepEqual(report.added, ["somebody/community@first", "stripe/agent-skills@payments"], "the scout's rank is the priority order")
    assert.deepEqual(
      report.installed.map((e) => e.id),
      ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "somebody/community@first", "stripe/agent-skills@payments"],
      "installed is the project's whole set — the four it already had plus the two this run added"
    )
    assert.deepEqual(report.rejected, [], "a candidate the budget never reached was refused nothing — it is next round's reserve")
    assert.deepEqual(installs.length, 2, "and it never reached the installer either")
    const config = readJson("vivicy.json") as { skills: { id: string }[] }
    assert.equal(config.skills.length, 6)
  })
})

describe("the default scout binder resolves its leg from the caller's env", () => {
  interface ShimCall {
    name: string
    argv: string[]
  }

  async function withShimmedClis(run: (spawned: () => ShimCall[]) => Promise<void>): Promise<void> {
    const shimDir = mkdtempSync(join(tmpdir(), "vivicy-scout-shim-"))
    const out = resolve(shimDir, "spawned.jsonl")
    const shim = (name: string): string =>
      `#!/usr/bin/env node\n` +
      `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";\n` +
      `import { dirname, resolve } from "node:path";\n` +
      `appendFileSync(process.env.SCOUT_SHIM_OUT, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + "\\n");\n` +
      `const result = resolve(process.cwd(), ${JSON.stringify(SCOUT_RESULT_REL)});\n` +
      `mkdirSync(dirname(result), { recursive: true });\n` +
      `writeFileSync(result, JSON.stringify({ add: [], installed: [] }));\n`
    for (const name of ["claude", "codex"]) writeFileSync(resolve(shimDir, name), shim(name), { mode: 0o755 })

    const previous = {
      PATH: process.env.PATH,
      SCOUT_SHIM_OUT: process.env.SCOUT_SHIM_OUT,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
      CODEX_HOME: process.env.CODEX_HOME,
      VIVICY_RUNTIME_DIR: process.env.VIVICY_RUNTIME_DIR,
      VIVICY_IMPLEMENTER_CLI: process.env.VIVICY_IMPLEMENTER_CLI,
    }
    process.env.PATH = `${shimDir}:${previous.PATH ?? ""}`
    process.env.SCOUT_SHIM_OUT = out
    // The transcript capture reads these homes: point them at an absent directory so no leg here can touch the machine's own agent state.
    process.env.CLAUDE_CONFIG_DIR = resolve(shimDir, "absent")
    process.env.CODEX_HOME = resolve(shimDir, "absent")
    process.env.VIVICY_RUNTIME_DIR = resolve(repo, ".vivicy", "runtime")
    try {
      await run(() =>
        existsSync(out)
          ? readFileSync(out, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line) as ShimCall)
          : []
      )
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      rmSync(shimDir, { recursive: true, force: true })
    }
  }

  it("spawns the CLI the INJECTED env names, never the ambient one", async () => {
    seedBaseline()
    await withShimmedClis(async (spawned) => {
      process.env.VIVICY_IMPLEMENTER_CLI = "claude"
      const report = await installSkills({
        repoRoot: repo,
        env: { VIVICY_RUNTIME_DIR: resolve(repo, ".vivicy", "runtime"), VIVICY_IMPLEMENTER_CLI: "codex", VIVICY_CODEX_MODEL: "gpt-shim" },
        emitReport: () => {},
      })
      assert.equal(report.phase, "green", report.summary)
      const calls = spawned()
      assert.deepEqual(
        calls.map((call) => call.name),
        ["codex"],
        "the injected env picked the leg's CLI"
      )
      const model = calls[0].argv.indexOf("-m")
      assert.ok(model !== -1 && calls[0].argv[model + 1] === "gpt-shim", "and its model, so the WHOLE leg comes from that env")
    })
  })

  it("falls back to process.env when the caller injects none", async () => {
    seedBaseline()
    await withShimmedClis(async (spawned) => {
      process.env.VIVICY_IMPLEMENTER_CLI = "codex"
      const report = await installSkills({ repoRoot: repo, emitReport: () => {} })
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(
        spawned().map((call) => call.name),
        ["codex"]
      )
    })
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

  it("names the installed set, the verdict it owes on each, the budget, the collision rule, the audit gate and the reason requirement", () => {
    const context = scoutContext({
      ...BASE,
      installed: [entry("supabase/agent-skills@postgres", "postgres"), entry("stripe/agent-skills@payments", "payments")],
    })
    assert.match(context, /Already installed \(2\/6 slots taken\): `supabase\/agent-skills@postgres`, `stripe\/agent-skills@payments`/)
    assert.match(context, /Give EACH of them its own `keep` or `drop` verdict/, "the lifecycle verdict is asked for, never inferred")
    assert.match(context, /a missing verdict invalidates your whole result/)
    assert.match(context, /Never propose one of these under `add`/)
    assert.match(context, /name \(the part after `@`\) matches one of theirs/, "the collision refusal is stated, not discovered")
    assert.match(context, /`\.agents\/skills\/<name>` holds ONE skill/)
    assert.match(
      context,
      /6 is the project TOTAL across every run, not a per-run budget: 2 slots are already taken, which leaves 4 free slots — and every skill you drop frees one more\./
    )
    assert.match(context, new RegExp(`\`add\` is a RANKED list, best first, of AT MOST ${MAX_SCOUT_CANDIDATES} skills`))
    assert.match(context, /reserve that backfills a candidate the security audit refuses/)
    assert.match(context, /REFUSED — never installed — when any audit fails, more than one warns, or no audit exists at all/)
    assert.match(context, /non-empty one-line `reason`/)
  })

  it("tells an empty project all six slots are free, without an empty list", () => {
    const context = scoutContext({ ...BASE, installed: [] })
    assert.match(context, /This project has NO skills installed yet: all 6 slots are free, and your `installed` verdict array is empty\./)
    assert.match(
      context,
      /6 is the project TOTAL across every run, not a per-run budget: 0 slots are already taken, which leaves 6 free slots/
    )
    assert.doesNotMatch(context, /Already installed/)
  })

  it("one slot left reads in the singular", () => {
    const context = scoutContext({ ...BASE, installed: [entry("a/b@one", "one")] })
    assert.match(context, /Already installed \(1\/6 slots taken\)/)
    assert.match(context, /: 1 slot is already taken, which leaves 5 free slots/)
    const five = Array.from({ length: 5 }, (_, i) => entry(`a/b@s${i}`, `s${i}`))
    assert.match(scoutContext({ ...BASE, installed: five }), /which leaves 1 free slot —/)
  })

  it("the printed set and the stated budget always add up to the cap", () => {
    for (let taken = 0; taken <= MAX_PROJECT_SKILLS; taken += 1) {
      const context = scoutContext({ ...BASE, installed: Array.from({ length: taken }, (_, i) => entry(`a/b@s${i}`, `s${i}`)) })
      const budget = Number(/which leaves (\d+) free slots?/.exec(context)?.[1])
      const printed = taken === 0 ? 0 : Number(/Already installed \((\d+)\/6 slots taken\)/.exec(context)?.[1])
      assert.equal(printed, taken, `context at ${taken} installed printed the wrong set size`)
      assert.equal(printed + budget, MAX_PROJECT_SKILLS, `context at ${taken} installed states ${printed} taken and ${budget} free`)
      assert.match(context, new RegExp(`: ${taken} slots? (is|are) already taken`), `the taken tail is stated at ${taken} too`)
    }
  })

  it("hands the leg the project's real installed set", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["a/b@one", "a/b@two"]) })
    const seen: Array<{ installed: string[]; budget: string | undefined }> = []
    await installSkills({
      repoRoot: repo,
      spawnScout: async (args) => {
        seen.push({
          installed: args.installed.map((e) => e.id),
          budget: /which leaves (\d+ free slots?)/.exec(scoutContext({ ...BASE, ...args }))?.[1],
        })
        mkdirSync(dirname(resolve(repo, SCOUT_RESULT_REL)), { recursive: true })
        writeFileSync(
          resolve(repo, SCOUT_RESULT_REL),
          JSON.stringify({ add: [], installed: args.installed.map((e) => ({ id: e.id, verdict: "keep", reason: "still needed" })) })
        )
      },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.deepEqual(seen, [{ installed: ["a/b@one", "a/b@two"], budget: "4 free slots" }])
  })

  it("re-prompts a candidate with an empty reason, naming it, and fails when it comes back the same", async () => {
    seedBaseline()
    const calls: Array<{ attempt: number; feedback: string | null }> = []
    const proposal = {
      add: [
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
      spawnScout: fakeScout([{ add: [{ id: "a/b@one", reason: "   \n  " }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    assert.equal(report.phase, "failed")
  })

  it("a declared id that names no skill takes no slot — on either surface", async () => {
    seedBaseline()
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      skills: declared(["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five", "anthropics/skills"]),
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
            add: [
              { id: "stripe/agent-skills@payments", reason: "the spec takes payments" },
              { id: "anthropics/skills@pdf", reason: "the spec emails PDF invoices" },
            ],
            installed: args.installed.map((e) => ({ id: e.id, verdict: "keep", reason: "still needed" })),
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
    assert.match(seen[0].context, /: 5 slots are already taken, which leaves 1 free slot/)
    assert.ok(!seen[0].context.includes("anthropics/skills"), "an id no skill answers to is never named to the leg")

    assert.deepEqual(report.added, ["stripe/agent-skills@payments"], "the free slot was really free")
    assert.equal(report.installed.length, 6)
    assert.deepEqual(report.rejected, [], "the second-ranked candidate simply never reached the budget — nothing refused it")
    assert.doesNotMatch(report.summary, /every one of the 6 slots is taken/, "the at-capacity sentence may never contradict its own count")
    assert.match(report.summary, /project total 6\/6$/)
  })

  it("a project already at the cap still scouts — the verdicts are what free a slot — and settles the baseline", async () => {
    seedBaseline()
    const six = ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five", "a/b@six"]
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(six) })
    const summaries: string[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      runRemove: () => ({ code: 0, output: "removed" }),
      emitReport: (r) => summaries.push(r.summary),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.added, [], "the scout kept all six, so its ranked proposal had nowhere to land")
    assert.deepEqual(report.removed, [])
    assert.deepEqual(report.rejected, [], "the owner is told once why nothing landed, never with a cap_exceeded row per candidate")
    assert.equal(report.installed.length, MAX_PROJECT_SKILLS)
    assert.equal(report.selection_baseline_id, BASELINE_ID, "the baseline is settled, so the supervisor stops re-spawning the stage")
    assert.match(report.summary, /every one of the 6 slots is taken and the scout retired none of them, so nothing new could land$/)
    assert.deepEqual(skillsNotifications(report), [], "and it asks the owner for nothing")

    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    seedBaseline("baseline-v1.1.0")
    const pivot = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }],
          installed: [drops("a/b@six"), ...six.slice(0, 5).map((id) => ({ id, verdict: "keep", reason: "still needed" }))],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      runRemove: () => ({ code: 0, output: "removed" }),
      emitReport: () => {},
    })
    assert.deepEqual(pivot.removed, ["a/b@six"], "a fossil no longer saturates the cap")
    assert.deepEqual(pivot.added, ["stripe/agent-skills@payments"], "and the slot it freed is spent in the very same round")
    assert.deepEqual(
      pivot.installed.map((e) => e.id),
      ["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five", "stripe/agent-skills@payments"]
    )
    assert.match(pivot.summary, /^skills stage green: 1 installed, 1 dropped, 0 rejected this run; project total 6\/6$/)
  })
})

describe("the skill NAME is the on-disk primary key", () => {
  it("refuses a candidate whose name an installed skill from another source already holds", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["supabase/agent-skills@postgres"]) })
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [
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
          add: [
            { id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "the spec uses Supabase" },
            { id: "somebody/community@postgres", name: "Community Postgres", reason: "no official option found" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      emitReport: () => {},
    })

    assert.deepEqual(
      installs,
      [{ source: "supabase/agent-skills", skill: "postgres" }],
      "the scout's RANK decides who keeps the name — nothing re-sorts its list behind its back"
    )
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "somebody/community@postgres", reason: "name_collision" }]
    )
    assert.deepEqual(report.added, ["supabase/agent-skills@postgres"])
  })

  it("a refused collision costs no cap slot: the next distinct candidate takes it", async () => {
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      skills: declared(["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five"]),
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
  const scoutOne = () => fakeScout([{ add: [{ id: "somebody/repo@risky", name: "Risky", reason: "why not" }] }])

  it("rejects a red audit without the env flag, never installing", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { state: "audited", audits: [{ provider: "gateseal", status: "fail" }] } }),
      runInstall: fakeInstaller(installs),
      env: {},
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(installs, [])
    assert.equal(report.rejected[0].reason, "red_audit")
    assert.match(report.rejected[0].detail ?? "", /gateseal:fail/)

    const notes = skillsNotifications(report)
    assert.equal(notes.length, 1)
    assert.equal(notes[0].event, "skills_findings", "a skill kept out by a red audit is the owner's to look at, never a silent green")
    assert.equal(notes[0].level, "warning")
    assert.equal(notes[0].stage, "SK")
    assert.equal(notes[0].message, report.summary)
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
    assert.deepEqual(skillsNotifications(report), [])
  })

  it("only a failed stage and a green-with-rejections speak; every in-flight phase is silent", () => {
    const at = (phase: string, rejected: unknown[] = [], summary = "s") =>
      skillsNotifications({ phase, rejected, summary } as unknown as SkillsReport)
    assert.equal(at("failed")[0]?.event, "skills_failed")
    assert.equal(
      at("failed")[0]?.message,
      "s",
      "the report already names what refused the stage — the owner reads that, never a dead-end sentence"
    )
    assert.equal(at("failed", [], "")[0]?.message, "project skills stage failed")
    assert.deepEqual(at("green"), [])
    assert.equal(at("green", [{ id: "x" }])[0]?.event, "skills_findings")
    for (const phase of ["selecting", "validating", "auditing", "installing", "removing"]) {
      assert.deepEqual(at(phase, [{ id: "x" }]), [], `${phase} is in flight and asks the owner for nothing`)
    }
  })

  it("installs a red-audited skill WITH the flag, flagged security_waived", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits({ "somebody/repo@risky": { state: "audited", audits: [{ provider: "gateseal", status: "fail" }] } }),
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
      state: "audited",
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
    const oneWarn: SkillAuditFetch = { state: "audited", audits: [{ provider: "a", status: "warn" }] }
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
    const unaudited: SkillAuditFetch = { state: "unaudited" }
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

describe("a transport failure is not a verdict (the round is retried, never settled over it)", () => {
  const RISKY = "somebody/repo@risky"
  const scoutOne = () => fakeScout([{ add: [{ id: RISKY, name: "Risky", reason: "the canonical needs it" }] }])

  it("retries the audit with a bounded backoff inside the round, and a candidate that answers late still installs", async () => {
    seedBaseline()
    const waits: number[] = []
    const answers: SkillAuditFetch[] = [UNREACHABLE, UNREACHABLE, passAudit()]
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: async () => answers.shift() ?? passAudit(),
      runInstall: fakeInstaller(installs),
      sleep: instantSleep(waits),
      emitReport: () => {},
    })
    assert.deepEqual(waits, [500, 2000], "the backoff grows between attempts and the round holds only for those two waits")
    assert.deepEqual(report.added, [RISKY], "the blip cost the candidate nothing")
    assert.deepEqual(installs, [{ source: "somebody/repo", skill: "risky" }])
    assert.equal(report.selection_baseline_id, BASELINE_ID, "and the round decided everything, so it settles")
  })

  it("a candidate the registry never answers for keeps its slot: unsettled, silent, and converged by the next pass", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const blip = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: async () => UNREACHABLE,
      runInstall: fakeInstaller(installs),
      sleep: instantSleep(),
    })

    assert.equal(blip.phase, "green", "a network blip is not a red stage")
    assert.deepEqual(installs, [], "nothing unaudited is ever installed")
    assert.deepEqual(
      blip.rejected.map((r) => r.reason),
      ["audit_unreachable"],
      "and it is NOT folded into `unaudited`, which would have refused the skill on the registry's behalf"
    )
    assert.match(blip.rejected[0].detail ?? "", /never answered, over 3 attempts \(getaddrinfo ENOTFOUND skills\.sh\)/)
    assert.equal(blip.selection_baseline_id, null, "the round is UNSETTLED — that is the whole retry signal")
    assert.equal(skillsStageNeeded({ baselineId: BASELINE_ID }, readJson(SKILLS_REPORT_REL) as SkillsReport), true)
    assert.match(blip.summary, /the security registry never answered for 1 candidate \(somebody\/repo@risky\)/)
    assert.match(blip.summary, /this selection is NOT settled and the next start retries it$/)
    assert.deepEqual(skillsNotifications(blip), [], "the machine retries it by itself, so there is nothing to ask the owner")

    const healthy = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs),
      sleep: instantSleep(),
    })
    assert.deepEqual(healthy.added, [RISKY], "the next pass converges on the very candidate the blip could not decide")
    assert.equal(healthy.selection_baseline_id, BASELINE_ID)
    assert.deepEqual(healthy.rejected, [], "and the transport row does not survive the round that decided it")
    assert.equal(skillsStageNeeded({ baselineId: BASELINE_ID }, readJson(SKILLS_REPORT_REL) as SkillsReport), false)
  })

  it("an undecided candidate HOLDS its slot — the ranked tail never takes it while it is still owed", async () => {
    seedBaseline()
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["a/b@one", "a/b@two", "a/b@three", "a/b@four", "a/b@five"]) })
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [
            { id: "x/y@first", reason: "the canonical needs it most" },
            { id: "x/y@second", reason: "the canonical needs it too" },
          ],
        },
      ]),
      fetchAudit: fakeAudits({ "x/y@first": UNREACHABLE }),
      runInstall: fakeInstaller(installs),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.deepEqual(installs, [], "the one free slot belongs to the candidate the registry still owes an answer about")
    assert.deepEqual(
      report.rejected.map((r) => r.id),
      ["x/y@first"]
    )
    assert.equal(report.selection_baseline_id, null)
  })

  // The unsettled/retry semantics are the AUTO path's alone (`selection_baseline_id` + `skillsStageNeeded`); an explicit install is fire-and-forget, so silence there loses the fact for good.
  it("an EXPLICIT install promises no retry it cannot make, and keeps the blip actionable", async () => {
    const runtimeDir = resolve(repo, "runtime")
    const installs: FakeInstallCall[] = []
    const report = await withRuntimeNotifications(runtimeDir, () =>
      installSkills({
        repoRoot: repo,
        ids: [RISKY],
        fetchAudit: async () => UNREACHABLE,
        runInstall: fakeInstaller(installs),
        sleep: instantSleep(),
      })
    )

    assert.equal(report.mode, "explicit")
    assert.deepEqual(installs, [])
    assert.equal(report.rejected[0]?.reason, "audit_unreachable")
    assert.doesNotMatch(
      report.summary,
      /NOT settled|the next start retries it/,
      "nothing re-runs an explicit install, so its summary may never promise one"
    )
    assert.match(
      report.summary,
      /it was not installed, and an explicit install is never retried automatically — ask for it again once the registry answers$/
    )

    const rows = notifications(runtimeDir)
    assert.equal(rows.length, 1, `the owner keeps the actionable warning the blip raised before: ${rows.map((r) => r.event).join(", ")}`)
    assert.equal(rows[0].event, "skills_findings")
    assert.equal(rows[0].level, "warning")
    assert.equal(rows[0].message, report.summary)
  })

  it("a seam that throws is one more transport failure, never a stage that dies mid-phase", async () => {
    seedBaseline()
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: scoutOne(),
      fetchAudit: async () => {
        throw new Error("socket hang up")
      },
      runInstall: fakeInstaller([]),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.equal(report.phase, "green")
    assert.equal(report.rejected[0].reason, "audit_unreachable")
    assert.match(report.rejected[0].detail ?? "", /socket hang up/)
    assert.equal(report.selection_baseline_id, null)
  })
})

describe("an audit rejection backfills from the ranked tail", () => {
  const RANKED = ["x/y@first", "x/y@second", "x/y@third", "x/y@fourth"]

  async function selectInto(free: number, audits: Record<string, SkillAuditFetch>, order = RANKED): Promise<SkillsReport> {
    seedBaseline()
    const taken = Array.from({ length: MAX_PROJECT_SKILLS - free }, (_, i) => `a/b@taken-${i}`)
    if (taken.length > 0) writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(taken) })
    return installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: order.map((id) => ({ id, reason: "the canonical needs it" })) }]),
      fetchAudit: fakeAudits(audits),
      runInstall: fakeInstaller([]),
      sleep: instantSleep(),
      emitReport: () => {},
    })
  }

  it("moves the cap slice down the list, one place per rejection, and never past the cap", async () => {
    const report = await selectInto(2, { "x/y@first": { state: "audited", audits: [{ provider: "gateseal", status: "fail" }] } })
    assert.deepEqual(report.added, ["x/y@second", "x/y@third"], "the refused head is replaced from the tail, in rank order")
    assert.equal(report.installed.length, MAX_PROJECT_SKILLS, "and the budget is filled exactly, never exceeded")
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: "x/y@first", reason: "red_audit" }],
      "only the candidate a verdict really refused is named"
    )
  })

  it("honors the ranking whatever order the scout hands down", async () => {
    for (const order of [RANKED, [...RANKED].reverse(), ["x/y@third", "x/y@first", "x/y@fourth", "x/y@second"]]) {
      rmSync(repo, { recursive: true, force: true })
      mkdirSync(repo, { recursive: true })
      const report = await selectInto(2, { [order[0]]: { state: "unaudited" } }, order)
      assert.deepEqual(
        report.added,
        [order[1], order[2]],
        `with the scout ranking ${order.join(" > ")}, the two survivors are its next two, never a re-sort of its list`
      )
    }
  })

  it("backfills a slot an installer lost too, so one broken bundle never shrinks the set", async () => {
    seedBaseline()
    const installs: FakeInstallCall[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: RANKED.map((id) => ({ id, reason: "the canonical needs it" })) }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller(installs, new Set(["x/y@first", "x/y@second"])),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.deepEqual(report.added, ["x/y@third", "x/y@fourth"], "the round kept walking the list until the reserve ran out")
    assert.deepEqual(
      installs.map((c) => c.skill),
      ["first", "second", "third", "fourth"]
    )
    assert.deepEqual(
      report.rejected.map((r) => r.reason),
      ["install_failed", "install_failed"]
    )
  })

  it("audits nothing past the budget: a healthy head leaves the tail untouched", async () => {
    seedBaseline()
    const asked: string[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        { add: Array.from({ length: MAX_SCOUT_CANDIDATES }, (_, i) => ({ id: `x/y@s${i}`, reason: "the canonical needs it" })) },
      ]),
      fetchAudit: async ({ skill }) => {
        asked.push(skill)
        return passAudit()
      },
      runInstall: fakeInstaller([]),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.equal(asked.length, MAX_PROJECT_SKILLS, "the reserve costs the registry nothing while the budget is met from the top")
    assert.deepEqual(report.rejected, [])
    assert.equal(report.added.length, MAX_PROJECT_SKILLS)
  })
})

describe("the scout's keep/drop verdicts are the project's skill lifecycle", () => {
  const FOSSIL = "old/pack@jquery"
  const KEPT = "supabase/agent-skills@postgres"

  async function projectWithBoth(): Promise<void> {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [
            { id: FOSSIL, name: "jQuery", reason: "the spec used jQuery" },
            { id: KEPT, name: "Supabase Postgres", reason: "the spec uses Supabase" },
          ],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      emitReport: () => {},
    })
    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    seedBaseline("baseline-v1.1.0")
  }

  it("a pivot drops the fossil end to end: report, vivicy.json and both governance blocks shrink together", async () => {
    await projectWithBoth()
    assert.ok(existsSync(bundleDir("jquery")), "the fossil is really on disk before the pivot")
    const removals: FakeInstallCall[] = []
    const phases: string[] = []
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [],
          installed: [drops(FOSSIL), { id: KEPT, verdict: "keep", reason: "the spec still uses Supabase" }],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      runRemove: ({ repoRoot: root, source, skill }) => {
        removals.push({ source, skill })
        rmSync(resolve(root, ".agents/skills", skill), { recursive: true, force: true })
        return { code: 0, output: "removed" }
      },
      sleep: instantSleep(),
      emitReport: (r) => phases.push(r.phase),
    })

    assert.equal(report.phase, "green")
    assert.equal(report.mode, "auto", "a drop rides the auto path — no owner clicked anything")
    assert.deepEqual(report.removed, [FOSSIL])
    assert.deepEqual(removals, [{ source: "old/pack", skill: "jquery" }])
    assert.ok(phases.includes("removing"), `the in-flight phase names the removal: ${phases.join(" | ")}`)
    assert.deepEqual(
      report.installed.map((e) => e.id),
      [KEPT]
    )
    assert.deepEqual(declaredIds(), [KEPT], "the pin left vivicy.json with the declaration")
    assert.ok(!existsSync(bundleDir("jquery")), "and the bundle left the disk")
    assertReportAgreesWithSkillsBlock(report)
    assert.equal(report.selection_baseline_id, "baseline-v1.1.0", "the round carried out every decision it took, so it settles")
    assert.deepEqual(skillsNotifications(report), [], "self-maintenance the scout decided asks the owner for nothing")
  })

  it("every drop frees a slot the same round can spend, so a saturated project still evolves", async () => {
    await projectWithBoth()
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([
        {
          add: [{ id: "stripe/agent-skills@payments", name: "Payments", reason: "the spec takes payments" }],
          installed: [drops(FOSSIL), { id: KEPT, verdict: "keep", reason: "the spec still uses Supabase" }],
        },
      ]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
      runRemove: () => ({ code: 0, output: "removed" }),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.deepEqual(report.removed, [FOSSIL])
    assert.deepEqual(report.added, ["stripe/agent-skills@payments"])
    assert.match(report.summary, /^skills stage green: 1 installed, 1 dropped, 0 rejected this run; project total 2\/6$/)
  })

  // No `emitReport` stub and no hand-called `skillsNotifications`: the told-once wiring lives in the REAL emit (it is the writer that hands the prior over), so a case that fakes either half proves nothing about it.
  it("a bundle that refuses to go leaves the round unsettled and is the one drop the owner hears about — once, not once per start", async () => {
    await projectWithBoth()
    const attempts: FakeInstallCall[] = []
    const waits: number[] = []
    const runtimeDir = resolve(repo, "runtime")
    // The round must keep WORKING after the failed drop — an auditing and an installing emit both carry the rejection, and each one is a chance to announce it a second and a third time.
    const refusingRound = () =>
      installSkills({
        repoRoot: repo,
        spawnScout: async ({ repoRoot: root, installed }) => {
          const abs = resolve(root, SCOUT_RESULT_REL)
          mkdirSync(dirname(abs), { recursive: true })
          writeFileSync(
            abs,
            JSON.stringify({
              add: [{ id: "stripe/agent-skills@payments", name: "Payments", reason: "the spec takes payments" }],
              installed: installed.map((entry) =>
                entry.id === FOSSIL ? drops(FOSSIL) : { id: entry.id, verdict: "keep", reason: "the canonical still needs it" }
              ),
            })
          )
        },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
        runRemove: ({ source, skill }) => {
          attempts.push({ source, skill })
          return { code: 1, output: "EACCES: permission denied" }
        },
        sleep: instantSleep(waits),
      })

    const report = await withRuntimeNotifications(runtimeDir, refusingRound)

    assert.equal(attempts.length, 3, "the removal is retried inside the round before it is called a failure")
    assert.deepEqual(waits, [250, 1000])
    assert.deepEqual(report.removed, [])
    assert.deepEqual(
      report.rejected.map((r) => ({ id: r.id, reason: r.reason })),
      [{ id: FOSSIL, reason: "remove_failed" }]
    )
    assert.deepEqual(
      report.installed.map((e) => e.id),
      [FOSSIL, KEPT, "stripe/agent-skills@payments"],
      "the skill is still installed, because it really is — the projection never lies to free a slot"
    )
    assert.equal(report.selection_baseline_id, null, "so the slot is not consumed forever: the next pass re-decides and retries")
    assert.match(report.summary, /1 skill could not be removed \(old\/pack@jquery\); this selection is NOT settled/)

    const rows = notifications(runtimeDir)
    assert.equal(rows.length, 1, `ONE row for the whole round — every in-flight emit is silent: ${rows.map((r) => r.event).join(", ")}`)
    assert.equal(rows[0].event, "drop_failed")
    assert.equal(rows[0].level, "error")
    assert.match(rows[0].message, /could not remove its bundle \(old\/pack@jquery\)/)
    assert.match(rows[0].message, /the next start retries the removal on its own$/)

    await withRuntimeNotifications(runtimeDir, refusingRound)

    assert.equal(
      notifications(runtimeDir).length,
      1,
      "and the next start, which re-decides and retries the very same removal, says it no second time"
    )
  })

  it("an owner-driven removal that fails answers in its own response, never twice", async () => {
    await projectWithBoth()
    const report = await removeSkills({
      repoRoot: repo,
      ids: [FOSSIL],
      runRemove: () => ({ code: 1, output: "EACCES: permission denied" }),
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.equal(report.rejected[0].reason, "remove_failed")
    assert.deepEqual(
      skillsNotifications(report),
      [],
      "the click that asked for it gets the report back — a notification would be a receipt"
    )
  })

  it("a removal that fails once and takes on the retry is a plain success", async () => {
    await projectWithBoth()
    let calls = 0
    const report = await removeSkills({
      repoRoot: repo,
      ids: [FOSSIL],
      runRemove: () => {
        calls += 1
        return calls === 1 ? { code: 1, output: "EBUSY" } : { code: 0, output: "removed" }
      },
      sleep: instantSleep(),
      emitReport: () => {},
    })
    assert.equal(calls, 2)
    assert.deepEqual(report.removed, [FOSSIL])
    assert.deepEqual(report.rejected, [])
  })

  it("refuses a verdict set that does not answer for exactly the installed skills", async () => {
    const cases: Array<[string, unknown, RegExp]> = [
      [
        "a missing verdict",
        { add: [], installed: [{ id: KEPT, verdict: "keep", reason: "r" }] },
        /no keep\/drop verdict for old\/pack@jquery/,
      ],
      [
        "no verdict array at all",
        JSON.stringify({ add: [] }),
        /every skill this project already holds needs its own "keep" or "drop" verdict/,
      ],
      [
        "an id the project does not hold",
        { add: [], installed: [{ id: "ghost/x@y", verdict: "drop", reason: "r" }] },
        /"installed" names "ghost\/x@y", which this project does not hold/,
      ],
      [
        "a verdict that is neither",
        {
          add: [],
          installed: [
            { id: FOSSIL, verdict: "maybe" },
            { id: KEPT, verdict: "keep" },
          ],
        },
        /has verdict "maybe" — it must be exactly "keep" or "drop"/,
      ],
      [
        "a drop with no reason",
        {
          add: [],
          installed: [
            { id: FOSSIL, verdict: "drop" },
            { id: KEPT, verdict: "keep" },
          ],
        },
        /is dropped with an empty "reason"/,
      ],
      [
        "the same skill dropped and re-proposed",
        {
          add: [{ id: FOSSIL, reason: "on second thought" }],
          installed: [drops(FOSSIL), { id: KEPT, verdict: "keep", reason: "r" }],
        },
        /is both dropped and proposed for install — keep it or retire it, never both/,
      ],
      ["no add array at all", { installed: [drops(FOSSIL), { id: KEPT, verdict: "keep", reason: "r" }] }, /has no "add" array/],
    ]
    for (const [name, result, expected] of cases) {
      rmSync(repo, { recursive: true, force: true })
      mkdirSync(repo, { recursive: true })
      await projectWithBoth()
      const removals: FakeInstallCall[] = []
      const report = await installSkills({
        repoRoot: repo,
        spawnScout: fakeScout([result, result]),
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
        runRemove: ({ source, skill }) => {
          removals.push({ source, skill })
          return { code: 0 }
        },
        sleep: instantSleep(),
        emitReport: () => {},
      })
      assert.equal(report.phase, "failed", `${name} must not pass validation`)
      assert.match(report.summary, expected, name)
      assert.deepEqual(removals, [], `${name}: not one skill is removed on a result the orchestrator rejected whole`)
      assert.equal(report.selection_baseline_id, null, `${name}: a failed selection never settles`)
    }
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
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["a/b@s1", "a/b@s2", "a/b@s3", "a/b@s4", "a/b@s5"]) })
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
          add: [
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
    assert.deepEqual(declaredIds(), ["good/repo@fine"])
  })

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

describe("every install pins the bytes it landed", () => {
  const RUNTIME = "runtime"

  async function installPinned(files: Record<string, string> = { "scripts/recalc.py": "print('recalc')\n" }): Promise<SkillsReport> {
    return installSkills({
      repoRoot: repo,
      ids: ["acme/pack@spreadsheets"],
      env: { VIVICY_RUNTIME_DIR: resolve(repo, RUNTIME) },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([], new Set(), files),
    })
  }

  it("records the bundle hash and the per-file manifest of exactly what is on disk", async () => {
    const report = await installPinned()
    assert.equal(report.phase, "green")
    const pin = pinOf("acme/pack@spreadsheets")
    const onDisk = hashBundle(bundleDir("spreadsheets"))
    assert.ok(pin && onDisk)
    assert.equal(pin.bundle_hash, onDisk.bundle_hash, "the pin IS the bytes that landed, never a claim about them")
    assert.deepEqual(pin.files, onDisk.files)
    assert.deepEqual(Object.keys(pin.files), ["SKILL.md", "scripts/recalc.py"])
    assert.deepEqual(declaredIds(), ["acme/pack@spreadsheets"])
    assert.match(
      readFileSync(resolve(repo, "vivicy.json"), "utf8"),
      /"bundle_hash": "[0-9a-f]{64}"/,
      "the pin is readable in the owner's file"
    )
  })

  it("caches those very bytes machine-locally, content-addressed, so a later restore needs no network", async () => {
    const report = await installPinned()
    const pin = pinOf("acme/pack@spreadsheets")
    assert.ok(pin)
    const cached = resolve(bundleCacheDir(resolve(repo, RUNTIME)), pin.bundle_hash)
    assert.equal(hashBundle(cached)?.bundle_hash, pin.bundle_hash, "the cache entry is filed under the hash of its own bytes")
    assert.equal(
      readFileSync(resolve(cached, "scripts/recalc.py"), "utf8"),
      readFileSync(resolve(bundleDir("spreadsheets"), "scripts/recalc.py"), "utf8")
    )
    assert.equal(report.verified.length, 0, "an install verifies nothing — it pins")
  })

  it("refuses to pin an install that reported success and left no SKILL.md", async () => {
    const report = await installSkills({
      repoRoot: repo,
      ids: ["acme/pack@spreadsheets"],
      fetchAudit: fakeAudits(),
      runInstall: () => ({ code: 0, output: "pretending" }),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.added, [])
    assert.deepEqual(report.installed, [])
    assert.equal(report.rejected[0].reason, "install_failed")
    assert.match(report.rejected[0].detail ?? "", /left no \.agents\/skills\/spreadsheets\/SKILL\.md .* nothing to pin/)
    assert.ok(!existsSync(resolve(repo, "vivicy.json")), "an unpinnable install declares nothing")

    const partial = await installSkills({
      repoRoot: repo,
      ids: ["acme/pack@spreadsheets"],
      fetchAudit: fakeAudits(),
      runInstall: ({ repoRoot: root, skill }) => {
        const abs = resolve(root, ".agents/skills", skill, "README.md")
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, "docs but no skill\n")
        return { code: 0, output: "pretending harder" }
      },
    })
    assert.deepEqual(partial.added, [], "a bundle directory without a SKILL.md is not a skill either")
    assert.equal(partial.rejected[0].reason, "install_failed")
    assert.match(partial.rejected[0].detail ?? "", /left no \.agents\/skills\/spreadsheets\/SKILL\.md/)
  })

  it("keeps an owner's hand-declared entry in its place and pins only what it installed", async () => {
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["owner/first@handmade"]) })
    await installPinned()
    assert.deepEqual(
      declaredIds(),
      ["owner/first@handmade", "acme/pack@spreadsheets"],
      "declaration order is preserved, new entries append"
    )
    assert.equal(pinOf("owner/first@handmade"), null, "the entry the stage did not install stays unpinned")
    assert.ok(pinOf("acme/pack@spreadsheets"), "the one it installed is pinned")
    assert.equal(readJson("vivicy.json") && (readJson("vivicy.json") as { gateCommand: string }).gateCommand, "npm test")
    assert.equal(maintenanceNeeded(repo), true, "one pinned bundle is enough to owe a verification")
  })

  it("drops the pin together with the declaration when a skill is removed", async () => {
    await installPinned()
    const report = await removeSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], runRemove: () => ({ code: 0 }) })
    assert.deepEqual(report.removed, ["acme/pack@spreadsheets"])
    assert.deepEqual(declaredIds(), [])
    assert.equal(maintenanceNeeded(repo), false, "nothing declared, nothing to verify")
  })

  it("sweeps cache entries no pin references any more, and never sweeps on an empty declaration", async () => {
    const cacheDir = bundleCacheDir(resolve(repo, RUNTIME))
    await installPinned()
    const kept = pinOf("acme/pack@spreadsheets")?.bundle_hash
    assert.ok(kept)
    mkdirSync(resolve(cacheDir, "0".repeat(64)), { recursive: true })
    writeFileSync(resolve(cacheDir, "0".repeat(64), "SKILL.md"), "an entry no pin names\n")

    await installSkills({
      repoRoot: repo,
      ids: ["other/pack@charts"],
      env: { VIVICY_RUNTIME_DIR: resolve(repo, RUNTIME) },
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const alsoKept = pinOf("other/pack@charts")?.bundle_hash
    assert.ok(alsoKept)
    assert.deepEqual(readdirSync(cacheDir).sort(), [kept, alsoKept].sort(), "only the entries the declaration pins survive")

    writeFileSync(resolve(repo, "vivicy.json"), "{ not json at all\n")
    await removeSkills({
      repoRoot: repo,
      ids: ["other/pack@charts"],
      env: { VIVICY_RUNTIME_DIR: resolve(repo, RUNTIME) },
      runRemove: () => ({ code: 0 }),
    })
    assert.deepEqual(readdirSync(cacheDir).sort(), [kept, alsoKept].sort(), "an unreadable declaration sweeps nothing")
  })

  it("sweeps the scratch trees and bundle temps a killed restore left behind", async () => {
    const runtime = resolve(repo, RUNTIME)
    await installPinned()
    const scratch = resolve(runtime, "skill-candidate-abcdef")
    const temp = resolve(repo, ".agents/skills", `.vivicy-tmp.999.spreadsheets`)
    for (const dir of [scratch, temp]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(resolve(dir, "SKILL.md"), "residue\n")
    }

    const report = await maintainSkills({ repoRoot: repo, env: { VIVICY_RUNTIME_DIR: runtime }, runInstall: offlineCli })

    assert.match(report.summary, /verified unchanged/)
    assert.ok(!existsSync(scratch), "the killed restore's scratch tree is gone")
    assert.ok(!existsSync(temp), "and so is the temp it left beside the bundles")
    assert.ok(existsSync(bundleDir("spreadsheets")), "while the bundle itself is untouched")
  })

  it("never fails the pass it closes, even when a residue refuses to go", async () => {
    const cacheDir = bundleCacheDir(resolve(repo, RUNTIME))
    await installPinned()
    const stuck = resolve(cacheDir, "1".repeat(64))
    mkdirSync(stuck, { recursive: true })
    writeFileSync(resolve(stuck, "SKILL.md"), "unremovable\n")
    chmodSync(cacheDir, 0o500)
    try {
      const report = await installSkills({
        repoRoot: repo,
        ids: ["other/pack@charts"],
        env: { VIVICY_RUNTIME_DIR: resolve(repo, RUNTIME) },
        fetchAudit: fakeAudits(),
        runInstall: fakeInstaller([]),
      })
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(report.added, ["other/pack@charts"])
      assert.ok(existsSync(stuck), "the entry really was unremovable, so the case is not vacuous")
    } finally {
      chmodSync(cacheDir, 0o700)
    }
  })

  it("reads a hand-mangled pin as an unpinned declaration", () => {
    writeJson("vivicy.json", {
      skills: [
        { id: "a/b@short", bundle_hash: "abc", files: { "SKILL.md": "sha256:x" } },
        { id: "a/b@nofiles", bundle_hash: "b".repeat(64) },
        { id: "", bundle_hash: "c".repeat(64) },
        "a/b@string",
        { id: "a/b@ok", bundle_hash: "d".repeat(64), files: { "SKILL.md": "sha256:e" } },
      ],
    })
    const declarations = readSkillDeclarations(repo)
    assert.deepEqual(
      declarations.map((d) => [d.id, d.pin === null]),
      [
        ["a/b@short", true],
        ["a/b@nofiles", false],
        ["a/b@ok", false],
      ],
      "a malformed hash unpins the entry, a missing manifest only costs it the diagnostics, and a nameless or non-object entry declares nothing"
    )
    assert.deepEqual(Object.keys(declarations[1].pin?.files ?? {}), [], "no manifest means no file names, never a false one")
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
    assert.deepEqual(declaredIds(), ["supabase/agent-skills@postgres"])
    assert.deepEqual(readFileSync(resolve(repo, "CLAUDE.md")), utf16, "a file Vivicy cannot splice byte-safely is never written at all")
    assert.match(
      readFileSync(resolve(repo, "AGENTS.md"), "utf8"),
      /vivicy:skills:begin/,
      "and the document it CAN write still gets the block"
    )
    assert.equal(skillsNotifications(report)[0]?.event, "skills_failed")
    assert.equal(skillsNotifications(report)[0]?.level, "error")
  })

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

  it("a settled re-run over a converged block writes nothing, even when AGENTS.md is read-only", async () => {
    seedBaseline()
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
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
      spawnScout: fakeScout([{ add: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
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
      spawnScout: fakeScout([{ add: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }] }]),
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
      spawnScout: fakeScout([{ add: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    assert.deepEqual(first.added, ["supabase/agent-skills@postgres"])

    rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
    seedBaseline("baseline-v1.1.0")
    const second = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: [{ id: "stripe/agent-skills@payments", name: "Stripe", reason: "payments" }] }]),
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
      spawnScout: fakeScout([{ add: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
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
      declaredIds(),
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
      spawnScout: fakeScout([{ add: [{ id: "stripe/agent-skills@payments", reason: "the spec takes payments" }] }]),
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
      spawnScout: fakeScout([{ add: [{ id: "supabase/agent-skills@postgres", name: "Supabase Postgres", reason: "database" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: fakeInstaller([]),
    })
    const config = readJson("vivicy.json") as Record<string, unknown>
    writeJson("vivicy.json", { ...config, skills: [...(config.skills as unknown[]), { id: "acme/repo@scraper" }] })

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
    verified: [],
    healed: [],
    updated: [],
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
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["anthropics/skills@pdf", "acme/repo@scraper"]) })
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
    const config = readJson("vivicy.json") as { gateCommand: string; skills: { id: string }[] }
    assert.equal(config.gateCommand, "npm test")
    assert.deepEqual(declaredIds(), ["acme/repo@scraper"])
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
    const config = readJson("vivicy.json") as { skills: { id: string }[] }
    assert.deepEqual(declaredIds(), ["anthropics/skills@pdf"])
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
    const config = readJson("vivicy.json") as { skills: { id: string }[] }
    assert.equal(config.skills.length, 2)
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
    const config = readJson("vivicy.json") as { skills: { id: string }[] }
    assert.deepEqual(declaredIds(), ["anthropics/skills@pdf"], "the failed removal keeps its slot")
  })

  it("renders the empty-set block in the documents that carry it, and creates none in the one that does not", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] })
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["anthropics/skills@pdf"]) })
    writeFileSync(
      resolve(repo, "AGENTS.md"),
      skillsDoc([{ id: "anthropics/skills@pdf", skill: "pdf", name: "pdf", official: true, reason: "" }])
    )

    await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], runRemove: fakeRemover([]) })

    assert.ok(readFileSync(resolve(repo, "AGENTS.md"), "utf8").includes("No project skills are currently installed"))
    assert.ok(!existsSync(resolve(repo, "CLAUDE.md")), "a document with no block is not handed an empty one")
  })

  it("names both refused documents when the empty-set block cannot land", async () => {
    writeJson(SKILLS_REPORT_REL, { ...PRIOR, installed: [PRIOR.installed[0]] })
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["anthropics/skills@pdf"]) })
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

  // No remover may be injected here: the refusal is the id grammar's, upstream of the default remover, and reaching that default — an rmSync of `.agents/skills/<skill>` — is itself the defect.
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
    assert.deepEqual(declaredIds().length, 2)
  })

  it("throws SkillsConfigError without a target or without ids", async () => {
    await assert.rejects(() => removeSkills({ ids: ["a/b@c"] }), SkillsConfigError)
    await assert.rejects(() => removeSkills({ repoRoot: repo, ids: [] }), SkillsConfigError)
  })

  // The default remover is the one path a drop verdict reaches in production; a fake `npx` on PATH is what makes its CLI-less fallback provable offline.
  describe("the default remover's fallback when the skills CLI cannot answer", () => {
    let restorePath: string | undefined

    beforeEach(() => {
      const bin = resolve(repo, "fake-bin")
      mkdirSync(bin, { recursive: true })
      writeFileSync(resolve(bin, "npx"), "#!/bin/sh\necho 'no registry here' >&2\nexit 1\n")
      chmodSync(resolve(bin, "npx"), 0o755)
      restorePath = process.env.PATH
      process.env.PATH = bin
    })

    afterEach(() => {
      process.env.PATH = restorePath
    })

    it("deletes the bundle and its per-agent links itself", async () => {
      seedInstalledState()
      writeBundle(repo, "pdf")
      mkdirSync(resolve(repo, ".claude/skills"), { recursive: true })
      symlinkSync(resolve(repo, ".agents/skills/pdf"), resolve(repo, ".claude/skills/pdf"))

      const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], sleep: instantSleep() })

      assert.deepEqual(report.removed, ["anthropics/skills@pdf"])
      assert.ok(!existsSync(bundleDir("pdf")), "the bundle is gone")
      assert.ok(!existsSync(resolve(repo, ".claude/skills/pdf")), "and the link that now points at nothing went with it")
      assert.deepEqual(declaredIds(), ["acme/repo@scraper"])
    })

    it("treats a declared skill nothing ever installed as already removed, so a drop can never dead-end the retry", async () => {
      seedInstalledState()
      assert.ok(!existsSync(bundleDir("pdf")), "this project declares the id and has no bundle for it")

      const report = await removeSkills({ repoRoot: repo, ids: ["anthropics/skills@pdf"], sleep: instantSleep() })

      assert.deepEqual(report.removed, ["anthropics/skills@pdf"], "the declaration IS what the removal takes away")
      assert.deepEqual(report.rejected, [], "and an absent bundle is never a remove_failed the next pass would retry forever")
      assert.deepEqual(declaredIds(), ["acme/repo@scraper"])
    })
  })
})

describe("stage summaries agree in number", () => {
  async function stageSummaries(ids: string[]): Promise<string[]> {
    seedBaseline()
    const summaries: string[] = []
    await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: ids.map((id) => ({ id, reason: "the canonical needs it" })) }]),
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

  // spawnSync returns only after the child is reaped, so this pid is guaranteed dead: signalling it is ESRCH.
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

  it("falls back to the project's own gitignored runtime dir when no runtime dir is handed in", async () => {
    seedBaseline()
    const abs = resolve(repo, ".vivicy", "runtime", SKILLS_LOCK_FILE)
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

// HOME and XDG_CONFIG_HOME must stay redirected on top of the config vars (git reads its per-user excludes whatever core.excludesFile says, and one inherited ignore turns the clean-tree assertions green), the identity vars must stay unset (so the absorption has to establish one), and process.env itself must be what is mutated: the stage spawns its own git and npx children with the inherited environment.
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

const OWNER_CLAUDE_MD = `<!-- vivicy:method:begin -->
This repository is governed by the **Vivicy** development factory;
the operating guide for every agent working here — Claude included — is [AGENTS.md](./AGENTS.md).
Read it first.

@AGENTS.md
<!-- vivicy:method:end -->
`

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
  const r = spawnSync(resolve(repo, "node_modules/.bin/skills"), ["add", source, "--skill", skill, "-y"], {
    cwd: repoRoot,
    encoding: "utf8",
  })
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() }
}

function initGovernedGitTarget({ ignoresRuntime = true }: { ignoresRuntime?: boolean } = {}): void {
  const runtimeRule = ignoresRuntime ? ".vivicy/runtime/\n" : ""
  writeFileSync(resolve(repo, ".gitignore"), `node_modules\n.vivicy-tmp.*\n${runtimeRule}.vivicy/development/transcripts/\n`)
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
        assert.deepEqual(declaredIds(worktree), ["acme/pack@spreadsheets"])
        assert.equal(config.gateCommand, "npm test", "the owner's own vivicy.json fields ride through untouched")
        const pinned = pinOf("acme/pack@spreadsheets", worktree)
        assert.ok(pinned, "the worktree's declaration carries the pin, not just the id")
        assert.match(pinned.bundle_hash, /^[0-9a-f]{64}$/)
        assert.equal(
          pinned.bundle_hash,
          hashBundle(bundleDir("spreadsheets", worktree))?.bundle_hash,
          "and it is the hash of the bundle beside it"
        )
        assert.deepEqual(Object.keys(pinned.files).sort(), ["LICENSE.txt", "SKILL.md", "scripts/recalc.py"])
      } finally {
        git(repo, ["worktree", "remove", "--force", worktree])
        rmSync(worktreeParent, { recursive: true, force: true })
      }
    })
  })

  it("ends clean on a project whose managed ignore block predates the runtime dir: the dir hides itself from git", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget({ ignoresRuntime: false })
      writeSkillsCliStub(repo, "relative")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "precondition: the owner's tree is clean")

      const report = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(report.phase, "green", report.summary)

      assert.ok(existsSync(resolve(repo, ".vivicy/runtime/skill-bundles")), "the stage really did write under the target's runtime dir")
      assert.equal(readFileSync(resolve(repo, ".vivicy/runtime/.gitignore"), "utf8"), "*\n")
      assert.equal(
        git(repo, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(),
        "",
        "no runtime file reaches the tree the clean-tree gate reads, with no help from the root .gitignore"
      )
      assert.ok(
        !git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.includes(".vivicy/runtime"),
        "and none of it rides the absorption commit"
      )

      // A publish killed between its open and its write leaves an EMPTY marker: the dir must not stay visible to git for good.
      writeFileSync(resolve(repo, ".vivicy/runtime/.gitignore"), "")
      assert.match(
        git(repo, ["status", "--porcelain", "--untracked-files=all"]).stdout,
        /\.vivicy\/runtime\//,
        "non-vacuity: an emptied marker really does expose the whole runtime subtree"
      )

      ensureProjectRuntimeDir(resolve(repo, ".vivicy/runtime"))
      assert.equal(readFileSync(resolve(repo, ".vivicy/runtime/.gitignore"), "utf8"), "*\n")
      assert.equal(
        git(repo, ["status", "--porcelain", "--untracked-files=all"]).stdout.trim(),
        "",
        "the next ensure repairs the marker and git goes blind again"
      )
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

  it("a document this run leaves converged is not in the pathspec at all — an owner's mid-run edit to it stays theirs", async () => {
    await withHermeticGitEnv(async () => {
      seedBaseline()
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      const proposal = { add: [{ id: "acme/pack@spreadsheets", name: "Spreadsheets", reason: "the spec exports CSV" }] }
      await installSkills({ repoRoot: repo, spawnScout: fakeScout([proposal]), fetchAudit: fakeAudits() })
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")

      rmSync(resolve(repo, `.vivicy/baselines/${BASELINE_ID}.json`))
      seedBaseline("baseline-v1.1.0")
      git(repo, ["add", "-A"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: the next freeze"])

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

  it("a document whose write could not be PUBLISHED leaves the pathspec — the owner's mid-run edit to it stays theirs", async () => {
    await withHermeticGitEnv(async () => {
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      mkdirSync(resolve(repo, `.vivicy-tmp.${process.pid}.CLAUDE.md`, "not-vivicy's"), { recursive: true })

      const report = await installSkills({
        repoRoot: repo,
        ids: ["acme/pack@spreadsheets"],
        fetchAudit: fakeAudits(),
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
        fetchAudit: async () => ({ state: "audited", audits: [{ provider: "gateseal", status: "fail" }] }),
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

  it("a settled re-run that converges the block absorbs that write too — the zero-work path still ends clean", async () => {
    await withHermeticGitEnv(async () => {
      seedBaseline()
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      await installSkills({
        repoRoot: repo,
        spawnScout: fakeScout([{ add: [{ id: "acme/pack@spreadsheets", name: "Spreadsheets", reason: "the spec exports CSV" }] }]),
        fetchAudit: fakeAudits(),
      })
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")

      const config = readJson("vivicy.json") as Record<string, unknown>
      writeJson("vivicy.json", { ...config, skills: [...(config.skills as unknown[]), { id: "owner/own@handmade" }] })
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
      assert.match(body, /the deleted bundle and per-agent links, the shrunken vivicy\.json skills declaration/)
      assert.ok(!body.includes("Installed skill bundles"), "the install wording never rides a removal")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
      const removed = git(repo, ["show", "--name-status", "--format=", "HEAD"]).stdout
      assert.match(removed, /^D\t\.agents\/skills\/spreadsheets\/SKILL\.md$/m)
      assert.match(removed, /^D\t\.claude\/skills\/spreadsheets$/m)
    })
  })

  // The install-stage commit now carries DELETIONS too (a scout drop rides the auto path), so its body has to enumerate them — a body claiming only installs over a commit that removed a bundle is the same class of lie as a restore body over an update.
  it("an install-stage commit that also RETIRED a skill says so in its body, and carries the deletions", async () => {
    await withHermeticGitEnv(async () => {
      seedBaseline()
      initGovernedGitTarget()
      writeSkillsCliStub(repo, "relative")
      const seeded = await installSkills({ repoRoot: repo, ids: ["acme/pack@spreadsheets"], fetchAudit: fakeAudits() })
      assert.equal(seeded.phase, "green", seeded.summary)

      const report = await installSkills({
        repoRoot: repo,
        spawnScout: fakeScout([{ add: [], installed: [drops("acme/pack@spreadsheets")] }]),
        fetchAudit: fakeAudits(),
        runRemove: ({ skill }) => {
          rmSync(resolve(repo, ".agents/skills", skill), { recursive: true, force: true })
          rmSync(resolve(repo, ".claude/skills", skill), { force: true })
          return { code: 0, output: "removed" }
        },
        sleep: instantSleep(),
      })

      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(report.removed, ["acme/pack@spreadsheets"])
      const body = git(repo, ["log", "-1", "--format=%B"]).stdout
      assert.match(body, /^skills: absorb the project-skills stage writes\n/)
      assert.match(
        body,
        /for each skill the scout retired the deleted bundle and per-agent links and the shrunken vivicy\.json skills declaration/,
        "the body enumerates the removals the commit really carries"
      )
      const status = git(repo, ["show", "--name-status", "--format=", "HEAD"]).stdout
      assert.match(status, /^D\t\.agents\/skills\/spreadsheets\/SKILL\.md$/m)
      assert.match(status, /^D\t\.claude\/skills\/spreadsheets$/m)
      assert.match(status, /^M\tvivicy\.json$/m)
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "and the tree the dev loop starts on is clean")
    })
  })
})

describe("the maintenance pass verifies every pin and self-heals (real git target, real skills-CLI seam)", () => {
  const ID = "acme/pack@spreadsheets"
  const SKILL = "spreadsheets"
  const TAMPERED = "print('tampered')\n"

  async function governedInstall(): Promise<{ runtimeDir: string; report: SkillsReport; pinnedAt: string }> {
    seedBaseline()
    initGovernedGitTarget()
    writeSkillsCliStub(repo, "relative")
    const report = await installSkills({
      repoRoot: repo,
      spawnScout: fakeScout([{ add: [{ id: ID, name: "Spreadsheets", reason: "the spec exports CSV" }] }]),
      fetchAudit: fakeAudits(),
      runInstall: runStubSkillsCli,
    })
    assert.equal(report.phase, "green", report.summary)
    assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "the install absorbs its own writes")
    const pin = pinOf(ID)
    assert.ok(pin, "the install pinned the bundle")
    return { runtimeDir: resolve(repo, ".vivicy", "runtime"), report, pinnedAt: pin.bundle_hash }
  }

  async function inGovernedProject(fn: (ctx: { runtimeDir: string; pinnedAt: string }) => Promise<void>): Promise<void> {
    await withHermeticGitEnv(async () => {
      const runtimeDir = resolve(repo, ".vivicy", "runtime")
      const previous = process.env.VIVICY_RUNTIME_DIR
      process.env.VIVICY_RUNTIME_DIR = runtimeDir
      try {
        const { pinnedAt } = await governedInstall()
        await fn({ runtimeDir, pinnedAt })
      } finally {
        if (previous === undefined) delete process.env.VIVICY_RUNTIME_DIR
        else process.env.VIVICY_RUNTIME_DIR = previous
      }
    })
  }

  function bundleBytes(): Record<string, string> {
    const files: Record<string, string> = {}
    for (const rel of ["SKILL.md", "LICENSE.txt", "scripts/recalc.py"]) {
      files[rel] = readFileSync(resolve(bundleDir(SKILL), rel), "utf8")
    }
    return files
  }

  it("says NOTHING when every pinned bundle still matches: no report write, no commit, no notification", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
      const reportBefore = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.equal(report.phase, "green")
      assert.equal(report.mode, "maintain")
      assert.deepEqual(report.verified, [ID])
      assert.deepEqual(report.healed, [])
      assert.deepEqual(report.updated, [], "upstream serves exactly the pinned bytes, so there is no newer version to take")
      assert.match(report.summary, /^skills maintenance green: 1 bundle verified unchanged$/)
      assert.equal(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"), reportBefore, "the selection's own record is left standing")
      assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "a clean pass adds no commit")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
      assert.deepEqual(notifications(runtimeDir), [], "a verify-clean pass is as silent as a managed file that needed nothing")
      assert.deepEqual(skillsNotifications(report), [])
    })
  })

  it("restores a tampered file byte-exact from the local cache, commits it, and still says nothing", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const original = bundleBytes()
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

      let fetches = 0
      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: () => {
          fetches += 1
          return offlineCli()
        },
      })

      assert.equal(
        fetches,
        1,
        "the cache answered with no network at all: the ONE upstream touch is the update check, which offline cannot answer"
      )
      assert.equal(report.phase, "green", report.summary)
      assert.deepEqual(report.healed, [ID])
      assert.deepEqual(report.verified, [])
      assert.deepEqual(bundleBytes(), original, "the bundle is byte-identical to what was pinned")
      assert.match(report.summary, /^skills maintenance green: 1 bundle restored to the pinned bytes \(acme\/pack@spreadsheets\)$/)
      assert.deepEqual(notifications(runtimeDir), [], "a successful self-repair asks the owner for nothing")

      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "the restore is absorbed, so the dev loop starts clean")
      const body = git(repo, ["log", "-1", "--format=%B"]).stdout
      assert.match(body, /^skills: absorb the project-skills verification pass\n/)
      assert.deepEqual(
        git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n"),
        [".vivicy/development/reports/skills-report.json"],
        "the restored bundle is byte-identical to the committed one, so only the pass's own report is left to commit"
      )
      const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
      assert.equal(onDisk.mode, "maintain")
      assert.deepEqual(onDisk.healed, [ID])
      assert.equal(onDisk.selection_baseline_id, BASELINE_ID, "maintenance never disturbs the scout's settle marker")
    })
  })

  it("absorbs the restored bundle itself when the drift had been committed", async () => {
    await inGovernedProject(async () => {
      const original = bundleBytes()
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
      git(repo, ["add", "--", ".agents/skills/spreadsheets/scripts/recalc.py"])
      git(repo, ["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "someone: patch the skill"])

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.deepEqual(report.healed, [ID], report.summary)
      assert.deepEqual(bundleBytes(), original)
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
      assert.deepEqual(git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").sort(), [
        ".agents/skills/spreadsheets/scripts/recalc.py",
        ".vivicy/development/reports/skills-report.json",
      ])
      assert.equal(
        git(repo, ["show", "HEAD:.agents/skills/spreadsheets/scripts/recalc.py"]).stdout,
        original["scripts/recalc.py"],
        "HEAD now carries the pinned bytes, so every worktree cut from it does too"
      )
    })
  })

  it("records the restored bundle only, so owner work appearing mid-pass is never absorbed", async () => {
    await inGovernedProject(async () => {
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
      const report = await maintainSkills({
        repoRoot: repo,
        heal: (args) => {
          writeFileSync(resolve(repo, "skills-lock.json"), '{ "version": 1, "skills": { "mine": {} } }\n')
          return healBundle(args)
        },
      })

      assert.deepEqual(report.healed, [ID], report.summary)
      assert.equal(
        git(repo, ["status", "--porcelain", "--", "skills-lock.json"]).stdout.trim(),
        "M skills-lock.json",
        "the owner's mid-pass edit is still uncommitted"
      )
      assert.ok(
        !git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.includes("skills-lock.json"),
        "and it is not in the restore commit"
      )
    })
  })

  it("brings a bundle deleted whole back, links and all", async () => {
    await inGovernedProject(async () => {
      const original = bundleBytes()
      rmSync(bundleDir(SKILL), { recursive: true, force: true })

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.deepEqual(report.healed, [ID])
      assert.deepEqual(bundleBytes(), original)
      assert.equal(
        readFileSync(resolve(repo, ".claude/skills", SKILL, "SKILL.md"), "utf8"),
        original["SKILL.md"],
        "the per-agent link points at the restored directory, so it resolves again"
      )
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
    })
  })

  it("falls back to the repository's own history when the machine has no cache, and warms the cache from it", async () => {
    await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
      const original = bundleBytes()
      chmodSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), 0o755)
      git(repo, ["add", "--", ".agents/skills/spreadsheets/scripts/recalc.py"])
      git(repo, ["-c", "user.email=o@l", "-c", "user.name=O", "commit", "-qm", "owner: mark the script executable"])
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# hijacked\n")

      let fetches = 0
      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: () => {
          fetches += 1
          return offlineCli()
        },
      })

      assert.equal(fetches, 1, "history answered with no network: the one fetch is the update check an offline machine cannot answer")
      assert.deepEqual(report.healed, [ID])
      assert.deepEqual(bundleBytes(), original)
      assert.equal(
        hashBundle(resolve(bundleCacheDir(runtimeDir), pinnedAt))?.bundle_hash,
        pinnedAt,
        "a heal from anywhere but the cache warms it, so the same drift never pays twice"
      )
      assert.notEqual(
        lstatSync(resolve(bundleDir(SKILL), "scripts/recalc.py")).mode & 0o111,
        0,
        "the history rung carries the committed file modes rather than inventing them"
      )
      assert.equal(git(repo, ["diff", "--cached", "--name-only"]).stdout.trim(), "", "the pass leaves nothing staged behind it")
    })
  })

  it("refuses a poisoned cache entry on its hash, heals from the next rung, and repairs the entry", async () => {
    await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
      const original = bundleBytes()
      const cached = resolve(bundleCacheDir(runtimeDir), pinnedAt)
      writeFileSync(resolve(cached, "scripts/recalc.py"), "print('poison')\n")
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

      let fetches = 0
      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: () => {
          fetches += 1
          return offlineCli()
        },
      })

      assert.equal(fetches, 1, "the history rung answered offline; the one fetch is the update check")
      assert.deepEqual(report.healed, [ID])
      assert.deepEqual(bundleBytes(), original, "the poison never reached the project")
      assert.equal(hashBundle(cached)?.bundle_hash, pinnedAt, "and the entry filed under that hash now really is those bytes")
    })
  })

  it("re-fetches as the last rung, and takes the result ONLY when upstream still serves the pinned bytes", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const original = bundleBytes()
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      rmSync(resolve(repo, ".git"), { recursive: true, force: true })
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

      let fetches = 0
      const exact = await maintainSkills({
        repoRoot: repo,
        runInstall: (args) => {
          fetches += 1
          return runStubSkillsCli(args)
        },
      })
      assert.deepEqual(exact.healed, [ID], exact.summary)
      assert.deepEqual(bundleBytes(), original)
      assert.equal(
        fetches,
        1,
        "the last rung IS an upstream fetch, and it succeeded only because upstream still serves the pinned bytes — so the update check has nothing left to buy"
      )
      assert.deepEqual(exact.updated, [])

      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
      let driftedFetches = 0
      const drifted = await maintainSkills({
        repoRoot: repo,
        runInstall: (args) => {
          driftedFetches += 1
          return upstreamServing({ "scripts/recalc.py": "print('upstream moved on')\n" })(args)
        },
      })
      assert.equal(driftedFetches, 1, "and a bundle no rung could restore is never offered an update either")
      assert.equal(drifted.phase, "failed", drifted.summary)
      assert.deepEqual(drifted.healed, [])
      assert.equal(drifted.rejected[0].reason, "heal_failed")
      assert.match(drifted.rejected[0].detail ?? "", /refetch: the restored bytes do not match the pin/)
      assert.equal(
        readFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), "utf8"),
        TAMPERED,
        "a candidate that fails the hash gate never replaces the bundle"
      )
    })
  })

  it("tells the owner exactly once when no rung can reproduce the pinned bytes, and never stops the build", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      rmSync(resolve(repo, ".git"), { recursive: true, force: true })
      rmSync(bundleDir(SKILL), { recursive: true, force: true })

      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: () => ({ code: 1, output: "error: skill not found upstream" }),
      })

      assert.equal(report.phase, "failed")
      assert.deepEqual(
        report.rejected.map((r) => [r.id, r.reason]),
        [[ID, "heal_failed"]]
      )
      const detail = report.rejected[0].detail ?? ""
      assert.match(detail, /^the bundle is gone from the project;/)
      assert.match(detail, /cache: no cached copy of the pinned bundle on this machine/)
      assert.match(detail, /git holds no committed copy of \.agents\/skills\/spreadsheets/)
      assert.match(detail, /refetch: the skills CLI could not re-fetch acme\/pack@spreadsheets/)
      assert.match(report.summary, /^skills maintenance failed: 1 bundle could NOT be restored \(acme\/pack@spreadsheets\)/)
      assert.match(report.summary, /re-install it or drop it from vivicy\.json#skills; the build continues without it/)

      const rows = notifications(runtimeDir)
      assert.equal(rows.length, 1, "exactly one notification, for the one thing the owner must do")
      assert.equal(rows[0].level, "error")
      assert.equal(rows[0].event, "heal_failed")
      assert.match(rows[0].message, /^1 project skill no longer matches the bytes this project pinned/)
      assert.match(
        rows[0].message,
        /\(acme\/pack@spreadsheets\) — re-install it or drop it from vivicy\.json#skills; the build runs without it/
      )
    })
  })

  it("turns a restore that could not even run into the same actionable rejection", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")
      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: offlineCli,
        heal: () => {
          throw new Error("EROFS: read-only file system, mkdir '/nope'")
        },
      })

      assert.equal(report.phase, "failed")
      assert.equal(report.rejected[0].reason, "heal_failed")
      assert.match(report.rejected[0].detail ?? "", /^1 file differs from the pin \(SKILL\.md\); the restore could not run \(EROFS/)
      assert.equal(notifications(runtimeDir).length, 1, "and the owner still gets the one notification that asks for the fix")
      assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).phase, "failed", "the on-disk report is terminal, never stuck in flight")
    })
  })

  it("says the same thing only once, however many starts a broken bundle survives", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      rmSync(bundleDir(SKILL), { recursive: true, force: true })
      git(repo, ["rm", "-r", "-q", "--cached", ".agents/skills/spreadsheets"])
      git(repo, ["-c", "user.email=o@l", "-c", "user.name=O", "commit", "-qm", "someone: drop the bundle"])
      let fetches = 0
      const pass = () =>
        maintainSkills({
          repoRoot: repo,
          runInstall: () => {
            fetches += 1
            return { code: 1, output: "error: 404 upstream" }
          },
        })

      const first = await pass()
      const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
      const stamp = (readJson(SKILLS_REPORT_REL) as SkillsReport).updated_at
      const second = await pass()
      const third = await pass()

      assert.equal(first.phase, "failed")
      assert.deepEqual([second.phase, third.phase], ["failed", "failed"], "every pass still reports the truth")
      assert.equal(fetches, 3, "and every pass still RETRIES the restore — a retry is the only thing that can repair it")
      assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "but an unchanged outcome adds no further commit")
      const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
      assert.equal(onDisk.updated_at, stamp, "and no further report write")
      assert.equal(onDisk.phase, "failed", "the published report is the TERMINAL one, never a pass stranded at `healing`")
      assert.equal(notifications(runtimeDir).length, 1, "the owner is told once, not once per start")
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "and the tree the dev loop meets is clean on every start")
    })
  })

  it("absorbs a restore even when the drifted path was already dirty at open", async () => {
    await inGovernedProject(async () => {
      const original = bundleBytes()
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), "print('committed tamper')\n")
      git(repo, ["add", "--", ".agents/skills/spreadsheets/scripts/recalc.py"])
      git(repo, ["-c", "user.email=o@l", "-c", "user.name=O", "commit", "-qm", "someone: patch the skill"])
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.deepEqual(report.healed, [ID], report.summary)
      assert.deepEqual(bundleBytes(), original)
      assert.equal(
        git(repo, ["status", "--porcelain"]).stdout.trim(),
        "",
        "the restored bytes are committed, never left dirty as if they were the owner's"
      )
      assert.equal(git(repo, ["show", "HEAD:.agents/skills/spreadsheets/scripts/recalc.py"]).stdout, original["scripts/recalc.py"])
    })
  })

  it("carries the selection's own refusals forward when it publishes over them", async () => {
    await inGovernedProject(async () => {
      const prior = readJson(SKILLS_REPORT_REL) as SkillsReport
      writeJson(SKILLS_REPORT_REL, {
        ...prior,
        rejected: [{ id: "evil/pack@miner", reason: "red_audit", detail: "audits [gateseal:fail]" }],
      })
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.deepEqual(report.healed, [ID])
      assert.deepEqual(
        report.rejected,
        [{ id: "evil/pack@miner", reason: "red_audit", detail: "audits [gateseal:fail]" }],
        "the audit refusal survives the verification pass"
      )
      assert.match(report.summary, /^skills maintenance green: 1 bundle restored/, "and it is not counted as a restore failure")
      assert.deepEqual(
        (readJson(SKILLS_REPORT_REL) as SkillsReport).rejected?.map((r) => r.reason),
        ["red_audit"]
      )
    })
  })

  it("carries those refusals into the in-flight write too, not just the terminal one", async () => {
    await inGovernedProject(async () => {
      const standing = { id: "evil/pack@miner", reason: "red_audit", detail: "audits [gateseal:fail]" }
      const prior = readJson(SKILLS_REPORT_REL) as SkillsReport
      writeJson(SKILLS_REPORT_REL, { ...prior, rejected: [standing] })
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")

      const published: SkillsReport[] = []
      const report = await maintainSkills({
        repoRoot: repo,
        runInstall: runStubSkillsCli,
        emitReport: (value) => published.push(JSON.parse(JSON.stringify(value)) as SkillsReport),
      })

      assert.deepEqual(
        published.map((value) => value.phase),
        ["healing", "green"],
        "the pass announced its work and published how it ended"
      )
      assert.deepEqual(published[0].rejected, [standing], "the in-flight write already states the standing refusal")
      assert.deepEqual(
        published[0].installed.map((entry) => entry.id),
        [ID],
        "as it already states the project's whole installed set"
      )
      assert.deepEqual(report.healed, [ID], report.summary)
    })
  })

  it("names an unreadable bundle as unreadable, never as gone", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      chmodSync(bundleDir(SKILL), 0o000)
      try {
        const report = await maintainSkills({ repoRoot: repo, runInstall: () => ({ code: 1, output: "error: 404" }) })
        assert.equal(report.phase, "failed", report.summary)
        assert.match(report.rejected[0].detail ?? "", /^the bundle is on disk but could not be read;/)
      } finally {
        chmodSync(bundleDir(SKILL), 0o700)
      }
    })
  })

  it("never commits the bytes it failed to restore — HEAD keeps the pin, so the next pass heals from history", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const original = bundleBytes()
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")

      const failed = await maintainSkills({
        repoRoot: repo,
        runInstall: offlineCli,
        heal: () => {
          throw new Error("EROFS: read-only file system, mkdir '/nope'")
        },
      })

      assert.equal(failed.phase, "failed", failed.summary)
      assert.equal(
        git(repo, ["show", "HEAD:.agents/skills/spreadsheets/SKILL.md"]).stdout,
        original["SKILL.md"],
        "HEAD still carries the pinned bytes, so the history rung is intact"
      )
      assert.deepEqual(
        git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n"),
        [".vivicy/development/reports/skills-report.json"],
        "the commit carries the pass's own report and NOT the drift"
      )
      assert.equal(
        git(repo, ["status", "--porcelain", "--", ".agents"]).stdout.trim(),
        "M .agents/skills/spreadsheets/SKILL.md",
        "the drift stays uncommitted where the owner left it"
      )

      const healed = await maintainSkills({ repoRoot: repo, runInstall: offlineCli })
      assert.equal(healed.phase, "green", healed.summary)
      assert.deepEqual(healed.healed, [ID])
      assert.deepEqual(bundleBytes(), original)
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
    })
  })

  it("always publishes how a pass it announced ended, even when it ended exactly as the last one did", async () => {
    await inGovernedProject(async () => {
      const first = async () => {
        writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")
        return maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })
      }
      assert.deepEqual((await first()).healed, [ID])
      const between = readJson(SKILLS_REPORT_REL) as SkillsReport
      assert.equal(between.phase, "green")

      const again = await first()

      assert.deepEqual(again.healed, [ID], "the identical repair happened again")
      const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
      assert.equal(onDisk.phase, "green", "and the report on disk is SETTLED, never stranded at `healing`")
      assert.equal(isSkillsPhaseInFlight(onDisk.phase), false, "so no surface reads it as work in progress")
      assert.match(onDisk.summary ?? "", /^skills maintenance green: 1 bundle restored/)
      assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
    })
  })

  it("clears that failure the moment the bundle is whole again", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const original = bundleBytes()
      rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
      rmSync(resolve(repo, ".git"), { recursive: true, force: true })
      rmSync(bundleDir(SKILL), { recursive: true, force: true })
      assert.equal((await maintainSkills({ repoRoot: repo, runInstall: () => ({ code: 1 }) })).phase, "failed")

      writeBundle(repo, SKILL, { "LICENSE.txt": original["LICENSE.txt"], "scripts/recalc.py": original["scripts/recalc.py"] })
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), original["SKILL.md"])

      const clean = await maintainSkills({ repoRoot: repo, runInstall: offlineCli })
      assert.equal(clean.phase, "green")
      assert.deepEqual(clean.verified, [ID])
      const onDisk = readJson(SKILLS_REPORT_REL) as SkillsReport
      assert.deepEqual(onDisk.rejected, [], "the report the surfaces read no longer names a broken skill")
      assert.deepEqual(onDisk.verified, [ID])
    })
  })

  it("bites when the PIN is what changed: no rung can satisfy a hash the bytes never had", async () => {
    await inGovernedProject(async () => {
      const original = bundleBytes()
      const config = readJson("vivicy.json") as { skills: Array<{ id: string; bundle_hash: string }> }
      config.skills[0].bundle_hash = "f".repeat(64)
      writeJson("vivicy.json", config)

      const report = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli })

      assert.equal(report.phase, "failed")
      assert.deepEqual(
        report.rejected.map((r) => r.reason),
        ["heal_failed"]
      )
      assert.match(
        report.rejected[0].detail ?? "",
        /^every file matches the pin's own manifest but not its bundle hash — the pin itself looks hand-edited;/,
        "the cause names the pin, not bytes that never moved"
      )
      assert.match(report.rejected[0].detail ?? "", /cache: no cached copy of the pinned bundle/)
      assert.match(report.rejected[0].detail ?? "", /git: the restored bytes do not match the pin/)
      assert.deepEqual(bundleBytes(), original, "no rung wrote into the project: each candidate is staged and hashed outside it")
      assert.equal(
        git(repo, ["status", "--porcelain", "--", ".agents"]).stdout.trim(),
        "",
        "a pass that could restore nothing leaves the bundle exactly as it found it"
      )
    })
  })

  it("defers to a stage already in flight instead of reading a half-written bundle", async () => {
    await inGovernedProject(async ({ runtimeDir }) => {
      const reportBefore = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")
      writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# mid-install\n")
      writeFileSync(
        join(runtimeDir, "skills-install.lock"),
        `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`
      )

      const report = await maintainSkills({ repoRoot: repo, runInstall: () => assert.fail("a deferred pass touches nothing") })

      assert.match(report.summary, /^skills maintenance deferred: a skills install is already in flight \(pid \d+\)/)
      assert.deepEqual(report.verified, [])
      assert.equal(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"), reportBefore)
      assert.equal(readFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "utf8"), "# mid-install\n", "the holder's bytes are left alone")
      assert.deepEqual(notifications(runtimeDir), [])
    })
  })

  it("costs a project with nothing pinned no lock, no process and no report", async () => {
    writeJson("vivicy.json", { gateCommand: "npm test", skills: declared(["owner/own@handmade"]) })
    assert.equal(maintenanceNeeded(repo), false, "an unpinned declaration is the owner's intent, not bytes to verify")
    const report = await maintainSkills({ repoRoot: repo, runInstall: () => assert.fail("nothing to verify, nothing to check upstream") })
    assert.match(report.summary, /^no pinned skill bundles to verify — vivicy\.json#skills declares none$/)
    assert.ok(!existsSync(resolve(repo, SKILLS_REPORT_REL)), "and it writes no report to say so")
    assert.ok(
      !existsSync(resolve(repo, ".vivicy", "runtime", "skills-install.lock")),
      "and claims no lock: it never opens a stage tree at all"
    )
    await assert.rejects(() => maintainSkills({}), SkillsConfigError)
  })

  it("runs from the CLI as --maintain, exclusive of the install and remove modes", async () => {
    await inGovernedProject(async () => {
      const original = bundleBytes()
      writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
      const script = resolve(dirname(fileURLToPath(import.meta.url)), "install-skills.ts")

      // The real CLI path reaches the real `npx`, so it must stay behind this recording offline shim — no case here may touch the network — and the shim must live OUTSIDE the target, or it is dirt in the tree the pass absorbs.
      const offlineBin = mkdtempSync(join(tmpdir(), "vivicy-offline-bin-"))
      const npx = resolve(offlineBin, "npx")
      const calls = resolve(offlineBin, "calls.log")
      writeFileSync(
        npx,
        `#!/bin/sh\necho "$@" >> ${calls}\necho 'npm error network getaddrinfo ENOTFOUND registry.npmjs.org' >&2\nexit 1\n`
      )
      chmodSync(npx, 0o755)
      const upstreamTouches = (): number => (existsSync(calls) ? readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length : 0)
      const cliEnv = { ...process.env, VIVICY_TARGET_ROOT: repo, PATH: `${offlineBin}:${process.env.PATH ?? ""}` }

      const healed = spawnSync(process.execPath, [script, "--maintain"], { cwd: repo, encoding: "utf8", env: cliEnv })
      assert.equal(healed.status, 0, `${healed.stdout}\n${healed.stderr}`)
      assert.match(healed.stdout, /1 bundle restored to the pinned bytes/)
      assert.deepEqual(bundleBytes(), original)
      assert.equal(upstreamTouches(), 1, "the full pass restored from the cache and still asked upstream once — the update door")

      const restoreOnly = spawnSync(process.execPath, [script, "--maintain", "--restore-only"], {
        cwd: repo,
        encoding: "utf8",
        env: cliEnv,
      })
      assert.equal(restoreOnly.status, 0, `${restoreOnly.stdout}\n${restoreOnly.stderr}`)
      assert.match(restoreOnly.stdout, /1 bundle verified unchanged/)
      assert.equal(upstreamTouches(), 1, "and it added no touch of its own")

      const alone = spawnSync(process.execPath, [script, "--restore-only"], { cwd: repo, encoding: "utf8", env: cliEnv })
      assert.equal(alone.status, 2)
      assert.match(alone.stderr, /--restore-only narrows --maintain/)

      const clash = spawnSync(process.execPath, [script, "--maintain", "--ids", "a/b@c"], {
        cwd: repo,
        encoding: "utf8",
        env: { ...process.env, VIVICY_TARGET_ROOT: repo },
      })
      assert.equal(clash.status, 2)
      assert.match(clash.stderr, /--ids, --remove and --maintain are mutually exclusive/)
    })
  })

  describe("the audited update door (a creator's newer version reaches a governed project, or is refused for the owner)", () => {
    const NEWER: Record<string, string> = {
      "SKILL.md": "---\nname: spreadsheets\ndescription: bundle from acme/pack\n---\n\n## Recalculation\n",
      "LICENSE.txt": "MIT\n",
      "scripts/recalc.py": "print('recalc, faster')\n",
      "scripts/audit.py": "print('new in this version')\n",
    }
    const RED: SkillAuditFetch = { state: "audited", audits: [{ provider: "gateseal", status: "fail" }] }
    const TWO_WARNS: SkillAuditFetch = {
      state: "audited",
      audits: [
        { provider: "gateseal", status: "warn" },
        { provider: "socket", status: "warn" },
      ],
    }
    const UNAUDITED: SkillAuditFetch = { state: "unaudited" }

    function audits(fetch: SkillAuditFetch) {
      return fakeAudits({ [`acme/pack@${SKILL}`]: fetch })
    }

    function newerBundle(): Record<string, string> {
      const files: Record<string, string> = {}
      for (const rel of Object.keys(NEWER)) files[rel] = readFileSync(resolve(bundleDir(SKILL), rel), "utf8")
      return files
    }

    it("takes a green newer version through the same audit gate, re-pins it, warms the cache and says NOTHING", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
        const calls: FakeInstallCall[] = []

        const report = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER, calls), fetchAudit: audits(passAudit()) })

        assert.deepEqual(calls, [{ source: "acme/pack", skill: SKILL }], "ONE upstream check for the one pinned skill, and it is the fetch")
        assert.equal(report.phase, "green", report.summary)
        assert.deepEqual(report.updated, [ID])
        assert.deepEqual(
          report.verified,
          [],
          "one terminal outcome per skill: it holds the NEW bytes, so it is not also verified-unchanged"
        )
        assert.deepEqual(report.rejected, [])
        assert.deepEqual(newerBundle(), NEWER, "the project runs the creator's newer bytes, file for file")

        const pin = pinOf(ID)
        assert.ok(pin)
        assert.notEqual(pin.bundle_hash, pinnedAt, "the pin moved with the bytes")
        assert.equal(pin.bundle_hash, hashBundle(bundleDir(SKILL))?.bundle_hash, "and it IS what is on disk, never a claim about it")
        assert.deepEqual(Object.keys(pin.files).sort(), Object.keys(NEWER).sort(), "the manifest names the new file too")
        assert.deepEqual(
          readdirSync(bundleCacheDir(runtimeDir)),
          [pin.bundle_hash],
          "the cache carries the new pin (so the next drift heals offline) and the superseded entry is swept"
        )
        assert.equal(
          readFileSync(resolve(repo, ".claude/skills", SKILL, "SKILL.md"), "utf8"),
          NEWER["SKILL.md"],
          "the per-agent link points at the directory, so it serves the new version with no relink"
        )

        assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "the update is absorbed, so the dev loop starts clean")
        assert.notEqual(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head)
        assert.deepEqual(git(repo, ["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n").sort(), [
          ".agents/skills/spreadsheets/SKILL.md",
          ".agents/skills/spreadsheets/scripts/audit.py",
          ".agents/skills/spreadsheets/scripts/recalc.py",
          ".vivicy/development/reports/skills-report.json",
          "vivicy.json",
        ])
        assert.match(
          report.summary,
          /^skills maintenance green: 1 bundle updated to a newer audited version \(acme\/pack@spreadsheets\)$/,
          "the settled summary is where an update is reported"
        )
        const body = git(repo, ["log", "-1", "--format=%B"]).stdout
        assert.match(body, /newer upstream version passed the same security audit an install must pass/)
        assert.match(
          body,
          /vivicy\.json pin moved onto it/,
          "the body describes the bytes and the pin it really carries, never a restore it did not make"
        )
        assert.deepEqual(notifications(runtimeDir), [], "a successful update is self-maintenance: it asks the owner for nothing")
        assert.deepEqual(skillsNotifications(report), [])
      })
    })

    it("a settled update is idempotent: the pass after it settles the record, and the one after that says nothing", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        const pass = () => maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(passAudit()) })
        assert.deepEqual((await pass()).updated, [ID])

        const settling = await pass()
        assert.deepEqual(settling.verified, [ID], "upstream now serves what the project pins, so there is nothing left to take")
        assert.deepEqual(settling.updated, [])
        const settled = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")
        const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()

        await pass()

        assert.equal(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"), settled, "the steady state is not rewritten")
        assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "and adds no commit")
        assert.deepEqual(notifications(runtimeDir), [], "and nothing in the whole sequence asks the owner for anything")
      })
    })

    for (const [name, fetch, cause] of [
      ["a red audit", RED, "a security audit fails it"],
      ["more than one warning", TWO_WARNS, "more than one audit warns about it"],
      ["no audit at all", UNAUDITED, "no security audit covers it"],
    ] as const) {
      it(`refuses a newer version on ${name}, keeps the pinned bytes, and warns exactly once`, async () => {
        await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
          const pinnedBytes = bundleBytes()
          const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()

          const report = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(fetch) })

          assert.equal(report.phase, "green", "refusing risk is a successful pass, never a red stage")
          assert.deepEqual(report.updated, [])
          assert.deepEqual(report.verified, [ID], "the pinned bundle still verifies — that is the version the project keeps running")
          assert.deepEqual(bundleBytes(), pinnedBytes, "not one byte of the refused candidate reached the project")
          assert.ok(!existsSync(resolve(bundleDir(SKILL), "scripts/audit.py")), "and none of its new files either")
          assert.equal(pinOf(ID)?.bundle_hash, pinnedAt, "the pin is untouched")

          const refusal = report.rejected[0]
          assert.equal(report.rejected.length, 1)
          assert.equal(refusal.id, ID)
          assert.equal(refusal.reason, "update_refused")
          assert.equal(refusal.verdict, fetch === RED ? "red_audit" : fetch === TWO_WARNS ? "too_many_warnings" : "unaudited")
          assert.match(refusal.detail ?? "", new RegExp(`^a newer version is available upstream but ${cause} —`))
          assert.match(
            refusal.detail ?? "",
            /the project keeps the version it pinned, and the install-time risk waiver is never read on an update$/
          )
          assert.match(refusal.candidate_hash ?? "", /^[0-9a-f]{64}$/)
          assert.notEqual(refusal.candidate_hash, pinnedAt, "the hash recorded is the REFUSED candidate's, not the pin's")
          assert.match(
            report.summary,
            /^skills maintenance green: 1 newer version refused by the security audit \(acme\/pack@spreadsheets\), 1 bundle verified unchanged$/
          )

          const rows = notifications(runtimeDir)
          assert.equal(rows.length, 1, "one warning: the awaited trace of the standing risk switch")
          assert.equal(rows[0].level, "warning", "warning is what arms the Ask-Vivi pill")
          assert.equal(rows[0].event, "update_refused")
          assert.match(
            rows[0].message,
            new RegExp(
              `^Vivicy refused a newer version of a project skill and kept the version this project pinned and audited: acme/pack@spreadsheets \\(${cause}\\)`
            )
          )
          assert.match(rows[0].message, /nothing to install; the risk waiver is an install-time switch and is never read on an update$/)
          assert.notEqual(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "the refusal is recorded in the report the surfaces read")
          assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
        })
      })
    }

    it("says the same refusal only once, and re-evaluates the moment upstream publishes different bytes", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        const refuse = (files: Record<string, string>) =>
          maintainSkills({ repoRoot: repo, runInstall: upstreamServing(files), fetchAudit: audits(RED) })

        await refuse(NEWER)
        const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
        const stamp = (readJson(SKILLS_REPORT_REL) as SkillsReport).updated_at

        const same = await refuse(NEWER)

        assert.equal(same.rejected.length, 1, "the identical candidate is still refused")
        assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).updated_at, stamp, "but nothing is rewritten")
        assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "no second commit")
        assert.equal(notifications(runtimeDir).length, 1, "and the owner is told once, not once per supervisor start")

        const evolved = await refuse({ ...NEWER, "scripts/recalc.py": "print('recalc, third try')\n" })

        assert.equal(notifications(runtimeDir).length, 2, "a DIFFERENT candidate is a new fact and earns its own warning")
        assert.notEqual(
          evolved.rejected[0].candidate_hash,
          same.rejected[0].candidate_hash,
          "the refusal names the bytes it is about, which is what makes the repeat detectable at all"
        )
        assert.notEqual(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head)
      })
    })

    it("re-announces nothing when an unrelated fact republishes the report, and clears the refusal when upstream comes back to the pinned bytes", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        const refused = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        assert.equal(refused.rejected[0]?.reason, "update_refused")
        assert.equal(notifications(runtimeDir).length, 1)

        writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
        const republished = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })

        assert.deepEqual(republished.healed, [ID], republished.summary)
        assert.equal(republished.rejected.length, 1, "the refusal still stands")
        assert.equal(
          notifications(runtimeDir).length,
          1,
          "but the owner is told about a refused candidate ONCE, not again every time anything else moves"
        )

        const reverted = await maintainSkills({ repoRoot: repo, runInstall: runStubSkillsCli, fetchAudit: audits(RED) })

        assert.deepEqual(reverted.verified, [ID], reverted.summary)
        assert.deepEqual(reverted.updated, [])
        assert.deepEqual(reverted.rejected, [], "an upstream that no longer offers anything newer is not a standing refusal")
        assert.deepEqual((readJson(SKILLS_REPORT_REL) as SkillsReport).rejected, [])
        assert.equal(notifications(runtimeDir).length, 1)
      })
    })

    it("states a carried refusal in the in-flight write too, not only in the terminal one", async () => {
      await inGovernedProject(async () => {
        await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

        const published: SkillsReport[] = []
        await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: audits(RED),
          emitReport: (value) => published.push(JSON.parse(JSON.stringify(value)) as SkillsReport),
        })

        assert.equal(published[0].phase, "healing")
        assert.deepEqual(
          published[0].rejected?.map((entry) => entry.reason),
          ["update_refused"],
          "the refusal the probe has not re-decided yet is stated by every write this pass makes"
        )
      })
    })

    it("clears a refusal when its own restore proved upstream still serves the pinned bytes", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const refused = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        assert.equal(refused.rejected[0]?.reason, "update_refused")
        assert.equal(notifications(runtimeDir).length, 1)

        rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
        rmSync(resolve(repo, ".git"), { recursive: true, force: true })
        writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
        let fetches = 0
        const healed = await maintainSkills({
          repoRoot: repo,
          runInstall: (args) => {
            fetches += 1
            return runStubSkillsCli(args)
          },
          fetchAudit: async () => assert.fail("the rung that healed already answered for upstream; nothing is left to audit"),
        })

        assert.deepEqual(healed.healed, [ID], healed.summary)
        assert.equal(fetches, 1, "one upstream touch: the rung's own, and no probe after it")
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt)
        assert.deepEqual(
          healed.rejected,
          [],
          "the pass may not republish a refusal it has just disproved — the bytes it restored came FROM upstream"
        )
        assert.match(healed.summary, /^skills maintenance green: 1 bundle restored to the pinned bytes/)
        assert.deepEqual((readJson(SKILLS_REPORT_REL) as SkillsReport).rejected, [])
        assert.equal(notifications(runtimeDir).length, 1)
      })
    })

    it("never renders an unknown verdict into the owner's warning", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        const stored = readJson(SKILLS_REPORT_REL) as SkillsReport
        writeJson(SKILLS_REPORT_REL, {
          ...stored,
          rejected: (stored.rejected ?? []).map((entry) => ({ ...entry, verdict: "constructor" })),
        })

        writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
        const report = await maintainSkills({ repoRoot: repo, runInstall: offlineCli })

        assert.equal(report.rejected[0]?.reason, "update_refused")
        assert.equal(report.rejected[0]?.verdict, undefined, "the unknown verdict is dropped where every rejection record is built")
        assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).rejected?.[0].verdict, undefined, "and never written back out")
        assert.equal(notifications(runtimeDir).length, 1, "and the refusal is still the one already told, so it stays silent")

        // `constructor` and `toString` are the load-bearing cases: they RESOLVE on a plain object's prototype, so an ordinary unknown key alone would prove nothing here.
        for (const verdict of ["constructor", "toString", "nonsense"]) {
          const direct = skillsNotifications({
            ...report,
            rejected: [{ id: ID, reason: "update_refused", detail: "d", verdict: verdict as never, candidate_hash: "a".repeat(64) }],
          })
          assert.equal(direct.length, 1)
          assert.match(
            direct[0].message,
            /kept the version this project pinned and audited: acme\/pack@spreadsheets — nothing to install/,
            `verdict ${verdict} must fall through to the id-only branch: ${direct[0].message}`
          )
        }
      })
    })

    it("never applies the risk waiver to an update, even for a skill installed under it", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const prior = readJson(SKILLS_REPORT_REL) as SkillsReport
        writeJson(SKILLS_REPORT_REL, {
          ...prior,
          installed: (prior.installed ?? []).map((entry) => ({ ...entry, security_waived: true, reason: "red_audit" })),
        })
        const pinnedBytes = bundleBytes()
        const previous = process.env.VIVICY_ALLOW_UNSAFE_SKILLS
        process.env.VIVICY_ALLOW_UNSAFE_SKILLS = "1"
        try {
          const report = await maintainSkills({
            repoRoot: repo,
            env: { ...process.env, VIVICY_ALLOW_UNSAFE_SKILLS: "1" },
            runInstall: upstreamServing(NEWER),
            fetchAudit: audits(RED),
          })

          assert.deepEqual(report.updated, [], "the waiver that let the skill IN does not let a red update in after it")
          assert.equal(report.rejected[0]?.reason, "update_refused")
          assert.deepEqual(bundleBytes(), pinnedBytes)
          assert.equal(pinOf(ID)?.bundle_hash, pinnedAt)
          assert.equal(report.installed[0].security_waived, true, "and the entry keeps saying what it is: running waived bytes")
          assert.equal(notifications(runtimeDir).filter((row) => row.event === "update_refused").length, 1)
        } finally {
          if (previous === undefined) delete process.env.VIVICY_ALLOW_UNSAFE_SKILLS
          else process.env.VIVICY_ALLOW_UNSAFE_SKILLS = previous
        }
      })
    })

    it("a GREEN update clears the waiver flag and refreshes the audit record", async () => {
      await inGovernedProject(async () => {
        const prior = readJson(SKILLS_REPORT_REL) as SkillsReport
        writeJson(SKILLS_REPORT_REL, {
          ...prior,
          installed: (prior.installed ?? []).map((entry) => ({
            ...entry,
            security_waived: true,
            audits: [{ provider: "gateseal", status: "fail" }],
          })),
        })

        const report = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: audits({ state: "audited", audits: [{ provider: "gateseal", status: "pass" }] }),
        })

        assert.deepEqual(report.updated, [ID])
        assert.equal(report.installed.length, 1)
        assert.equal(report.installed[0].security_waived, false, "the bytes running now passed the gate on their own")
        assert.deepEqual(report.installed[0].audits, [{ provider: "gateseal", status: "pass" }])
        assert.equal(report.installed[0].name, "Spreadsheets", "and everything the selection knew about the skill survives")
        assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).installed?.[0].security_waived, false)
      })
    })

    it("offers no update at all to a bundle it could not restore", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
        rmSync(resolve(repo, ".git"), { recursive: true, force: true })
        writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")

        const broken = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: async () => assert.fail("a bundle nobody could restore is never offered an update, so nothing is audited"),
        })

        assert.equal(broken.phase, "failed", broken.summary)
        assert.deepEqual(broken.updated, [])
        assert.deepEqual(
          broken.rejected.map((entry) => entry.reason),
          ["heal_failed"]
        )
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt, "the pin is the standing contract until the owner acts")
        assert.equal(readFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "utf8"), "# tampered\n", "and the drift is left exactly as found")
      })
    })

    it("never takes a candidate upstream serves without a SKILL.md, and does not bother the owner about it", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const pinnedBytes = bundleBytes()
        const reportBefore = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")

        const docless = await maintainSkills({
          repoRoot: repo,
          runInstall: ({ repoRoot: into, skill }) => {
            const abs = resolve(into, ".agents/skills", skill, "README.md")
            mkdirSync(dirname(abs), { recursive: true })
            writeFileSync(abs, "docs, but no SKILL.md\n")
            return { code: 0, output: "installed" }
          },
          fetchAudit: async () => assert.fail("a candidate with no SKILL.md is not a skill: it never reaches the audit gate"),
        })

        assert.deepEqual(docless.verified, [ID], docless.summary)
        assert.deepEqual(docless.updated, [])
        assert.deepEqual(docless.rejected, [], "silence, not a refusal: upstream failing to describe itself is not the owner's business")
        assert.deepEqual(bundleBytes(), pinnedBytes)
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt)
        assert.equal(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"), reportBefore, "and the pass stays write-free")
        assert.deepEqual(notifications(runtimeDir), [])
      })
    })

    it("restores the pinned bytes first and offers the update to what it repaired", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)

        const report = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(passAudit()) })

        assert.deepEqual(report.updated, [ID], report.summary)
        assert.deepEqual(
          report.healed,
          [],
          "the restore was a step, not the outcome: the bytes it put back were superseded in the same pass"
        )
        assert.deepEqual(newerBundle(), NEWER)
        assert.equal(pinOf(ID)?.bundle_hash, hashBundle(bundleDir(SKILL))?.bundle_hash)
        assert.match(report.summary, /^skills maintenance green: 1 bundle updated to a newer audited version \(acme\/pack@spreadsheets\)$/)
        assert.deepEqual(notifications(runtimeDir), [])
        assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
      })
    })

    it("an offline pass is byte-identical to one with no update door at all", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const head = git(repo, ["rev-parse", "HEAD"]).stdout.trim()
        const reportBefore = readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")

        const report = await maintainSkills({
          repoRoot: repo,
          runInstall: offlineCli,
          fetchAudit: async () => assert.fail("a probe that answered nothing has nothing to audit"),
        })

        assert.equal(report.phase, "green", report.summary)
        assert.deepEqual(report.verified, [ID])
        assert.deepEqual(report.updated, [])
        assert.deepEqual(report.rejected, [], "a transport failure is never an event")
        assert.match(report.summary, /^skills maintenance green: 1 bundle verified unchanged$/)
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt)
        assert.equal(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8"), reportBefore, "no report write")
        assert.equal(git(repo, ["rev-parse", "HEAD"]).stdout.trim(), head, "no commit")
        assert.deepEqual(notifications(runtimeDir), [], "no notification")
        assert.ok(
          readdirSync(runtimeDir).every((entry) => !entry.startsWith("skill-candidate-")),
          "and the scratch the probe opened is gone whatever the probe answered"
        )
      })
    })

    it("keeps a refusal standing while the probe cannot re-decide it, and clears it when upstream comes back green", async () => {
      await inGovernedProject(async ({ runtimeDir }) => {
        const refused = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        assert.equal(refused.rejected[0].reason, "update_refused")
        const stamp = (readJson(SKILLS_REPORT_REL) as SkillsReport).updated_at

        const offline = await maintainSkills({ repoRoot: repo, runInstall: offlineCli, fetchAudit: audits(RED) })

        assert.equal(offline.rejected.length, 1, "the pin is still the older audited version — the fact the owner was told still holds")
        assert.equal(offline.rejected[0].reason, "update_refused")
        assert.deepEqual(offline.rejected[0], refused.rejected[0], "carried forward whole, so the record cannot drift by being re-stated")
        assert.equal((readJson(SKILLS_REPORT_REL) as SkillsReport).updated_at, stamp, "and an unchanged record is not republished")
        assert.equal(notifications(runtimeDir).length, 1)

        const green = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(passAudit()) })

        assert.deepEqual(green.updated, [ID], green.summary)
        assert.deepEqual(green.rejected, [], "the refusal is gone the moment the pass re-decides it")
        assert.deepEqual((readJson(SKILLS_REPORT_REL) as SkillsReport).rejected, [])
        assert.equal(notifications(runtimeDir).length, 1, "and taking the update announces nothing")
      })
    })

    it("an audit that never answers decides nothing either: no refusal is invented, and a standing one is kept", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const waits: number[] = []
        const blind = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: async () => UNREACHABLE,
          sleep: instantSleep(waits),
        })

        assert.deepEqual(waits, [500, 2000], "the same bounded retry the install door uses, and no more")
        assert.deepEqual(blind.rejected, [], "a network blip never refuses a creator's version on the registry's behalf")
        assert.deepEqual(blind.updated, [], "and never takes it unaudited either")
        assert.deepEqual(blind.verified, [ID])
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt, "the project keeps running exactly what it pinned")
        assert.deepEqual(notifications(runtimeDir), [])

        const refused = await maintainSkills({ repoRoot: repo, runInstall: upstreamServing(NEWER), fetchAudit: audits(RED) })
        assert.equal(refused.rejected[0]?.reason, "update_refused")
        assert.equal(notifications(runtimeDir).length, 1)

        const again = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: async () => UNREACHABLE,
          sleep: instantSleep(),
        })
        assert.deepEqual(again.rejected, refused.rejected, "a pass that could not re-decide leaves the standing refusal exactly as it was")
        assert.equal(notifications(runtimeDir).length, 1, "and says it no second time")
      })
    })

    describe("a project with two pinned skills", () => {
      const CHARTS = "other/pack@charts"
      const NEWER_CHARTS: Record<string, string> = { "SKILL.md": "---\nname: charts\n---\n\n## Stacked bars\n" }

      async function pinBoth(): Promise<void> {
        const second = await installSkills({
          repoRoot: repo,
          ids: [CHARTS],
          fetchAudit: fakeAudits(),
          runInstall: runStubSkillsCli,
        })
        assert.equal(second.phase, "green", second.summary)
        assert.deepEqual(
          readSkillDeclarations(repo).map((declaration) => declaration.id),
          [ID, CHARTS]
        )
      }

      // The scratch count must be read from INSIDE the fetch: the pass's janitorial sweep removes them all at the end, so an observation taken afterwards proves nothing.
      function upstreamPerSkill(bySkill: Record<string, Record<string, string>>, scratchesInFlight: number[] = []) {
        return ({ repoRoot: into, skill }: { repoRoot: string; source: string; skill: string }) => {
          scratchesInFlight.push(readdirSync(resolve(repo, ".vivicy", "runtime")).filter((e) => e.startsWith("skill-candidate-")).length)
          writeBundle(into, skill, bySkill[skill])
          return { code: 0, output: "installed" }
        }
      }

      it("takes one skill forward and holds the other back, in one pass and one sentence", async () => {
        await inGovernedProject(async ({ runtimeDir }) => {
          await pinBoth()
          const chartsPinnedAt = pinOf(CHARTS)?.bundle_hash
          const scratchesInFlight: number[] = []

          const report = await maintainSkills({
            repoRoot: repo,
            runInstall: upstreamPerSkill({ [SKILL]: NEWER, charts: NEWER_CHARTS }, scratchesInFlight),
            fetchAudit: fakeAudits({ [`acme/pack@${SKILL}`]: passAudit(), [CHARTS]: RED }),
          })

          assert.deepEqual(
            scratchesInFlight,
            [1, 1],
            "each probe closes its own scratch: two skills never mean two whole bundle copies staged at once"
          )

          assert.equal(report.phase, "green", report.summary)
          assert.deepEqual(report.updated, [ID])
          assert.deepEqual(
            report.verified,
            [CHARTS],
            "the refused skill's own bundle still matches its pin — that is the version it keeps running"
          )
          assert.deepEqual(
            report.rejected.map((entry) => [entry.id, entry.reason]),
            [[CHARTS, "update_refused"]]
          )
          assert.deepEqual(newerBundle(), NEWER, "the audited one moved")
          assert.equal(pinOf(CHARTS)?.bundle_hash, chartsPinnedAt, "the refused one did not")
          assert.match(
            report.summary,
            /^skills maintenance green: 1 newer version refused by the security audit \(other\/pack@charts\), 1 bundle updated to a newer audited version \(acme\/pack@spreadsheets\), 1 bundle verified unchanged$/
          )
          const rows = notifications(runtimeDir)
          assert.equal(rows.length, 1, "the update that succeeded is silent; only the refusal speaks")
          assert.match(rows[0].message, /^Vivicy refused a newer version of a project skill and kept the version this project pinned/)
          assert.match(rows[0].message, /other\/pack@charts \(a security audit fails it\)/)
          assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "")
        })
      })

      it("reads in the plural when both skills are held back, and names each one's own cause", async () => {
        await inGovernedProject(async ({ runtimeDir }) => {
          await pinBoth()

          const report = await maintainSkills({
            repoRoot: repo,
            runInstall: upstreamPerSkill({ [SKILL]: NEWER, charts: NEWER_CHARTS }),
            fetchAudit: fakeAudits({ [`acme/pack@${SKILL}`]: RED, [CHARTS]: UNAUDITED }),
          })

          assert.deepEqual(report.updated, [])
          assert.deepEqual(
            report.rejected.map((entry) => [entry.id, entry.verdict]),
            [
              [ID, "red_audit"],
              [CHARTS, "unaudited"],
            ]
          )
          assert.match(
            report.summary,
            /^skills maintenance green: 2 newer versions refused by the security audit \(acme\/pack@spreadsheets, other\/pack@charts\)/
          )
          const rows = notifications(runtimeDir)
          assert.equal(rows.length, 1, "one notification for the one thing that happened, however many skills it names")
          assert.match(
            rows[0].message,
            /^Vivicy refused newer versions of 2 project skills and kept the versions this project pinned and audited: acme\/pack@spreadsheets \(a security audit fails it\), other\/pack@charts \(no security audit covers it\) —/
          )
        })
      })

      it("tells the owner about an unrestorable bundle once, even when another skill's news republishes the report", async () => {
        await inGovernedProject(async ({ runtimeDir }) => {
          await pinBoth()
          const unhealable = (args: Parameters<typeof healBundle>[0]) => {
            if (args.ref.id === ID) throw new Error("EROFS: read-only file system, mkdir '/nope'")
            return healBundle(args)
          }
          writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered\n")

          const first = await maintainSkills({ repoRoot: repo, runInstall: offlineCli, heal: unhealable })
          assert.deepEqual(
            first.rejected.map((entry) => entry.reason),
            ["heal_failed"]
          )
          assert.equal(notifications(runtimeDir).length, 1)

          writeFileSync(resolve(bundleDir(SKILL), "SKILL.md"), "# tampered again\n")
          writeFileSync(resolve(bundleDir("charts"), "SKILL.md"), "# also tampered\n")
          const second = await maintainSkills({ repoRoot: repo, runInstall: offlineCli, heal: unhealable })

          assert.deepEqual(second.healed, [CHARTS], "the other skill's repair is real news, so the report is republished")
          assert.deepEqual(
            second.rejected.map((entry) => entry.reason),
            ["heal_failed"],
            "and the standing failure is still stated"
          )
          assert.equal(notifications(runtimeDir).length, 1, "but the owner is told about it once, not once per republish")
        })
      })

      it("writes both notifications when a pass has both kinds of news, each with its own level", async () => {
        await inGovernedProject(async ({ runtimeDir }) => {
          await pinBoth()
          rmSync(bundleCacheDir(runtimeDir), { recursive: true, force: true })
          rmSync(resolve(repo, ".git"), { recursive: true, force: true })
          rmSync(bundleDir(SKILL), { recursive: true, force: true })

          const report = await maintainSkills({
            repoRoot: repo,
            runInstall: ({ repoRoot: into, skill }) => {
              if (skill === SKILL) return { code: 1, output: "error: 404 upstream" }
              writeBundle(into, skill, NEWER_CHARTS)
              return { code: 0, output: "installed" }
            },
            fetchAudit: fakeAudits({ [CHARTS]: TWO_WARNS }),
          })

          assert.equal(report.phase, "failed", report.summary)
          assert.deepEqual(
            report.rejected.map((entry) => [entry.id, entry.reason]),
            [
              [CHARTS, "update_refused"],
              [ID, "heal_failed"],
            ],
            "rebuilt in pinned order, refusals before restore failures, so an identical pass serializes identically"
          )
          assert.deepEqual(
            skillsNotifications(report).map((note) => [note.level, note.event]),
            [
              ["error", "heal_failed"],
              ["warning", "update_refused"],
            ],
            "two independent facts, neither of which may swallow the other"
          )
          assert.deepEqual(
            notifications(runtimeDir).map((row) => row.event),
            ["heal_failed", "update_refused"]
          )
          assert.match(report.summary, /^skills maintenance failed: 1 bundle could NOT be restored \(acme\/pack@spreadsheets\)/)
          assert.match(report.summary, /1 newer version refused by the security audit \(other\/pack@charts\)/)
        })
      })
    })

    it("re-derives what is really on disk when its own publish fails, and restores the pin", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const pinnedBytes = bundleBytes()
        const report = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: async () => {
            writeFileSync(resolve(bundleDir(SKILL), "scripts/recalc.py"), TAMPERED)
            for (const entry of readdirSync(runtimeDir)) {
              if (entry.startsWith("skill-candidate-")) rmSync(resolve(runtimeDir, entry), { recursive: true, force: true })
            }
            return passAudit()
          },
        })

        assert.deepEqual(report.updated, [], report.summary)
        assert.deepEqual(report.rejected, [], "a local publish failure is not the owner's action item; the next pass retries it")
        assert.deepEqual(report.verified, [], "the verify's claim is withdrawn: those bytes are not what is on disk any more")
        assert.deepEqual(report.healed, [ID], "and the ladder is what settles the bundle, so the report states the truth")
        assert.deepEqual(bundleBytes(), pinnedBytes, "the pinned bytes are back")
        assert.equal(hashBundle(bundleDir(SKILL))?.bundle_hash, pinnedAt)
        assert.equal(git(repo, ["status", "--porcelain"]).stdout.trim(), "", "and the tree the dev loop meets is clean")
      })
    })

    it("reverts its own published bytes when vivicy.json will not take the new pin", async () => {
      await inGovernedProject(async ({ runtimeDir, pinnedAt }) => {
        const pinnedBytes = bundleBytes()
        const report = await maintainSkills({
          repoRoot: repo,
          runInstall: upstreamServing(NEWER),
          fetchAudit: async () => {
            chmodSync(repo, 0o500)
            return passAudit()
          },
        })
        chmodSync(repo, 0o700)

        assert.deepEqual(report.updated, [], report.summary)
        assert.deepEqual(report.rejected, [], "nothing for the owner to do: the project still runs the version it pinned")
        assert.equal(report.phase, "green")
        assert.equal(pinOf(ID)?.bundle_hash, pinnedAt, "the declaration still pins the bytes it always did")
        assert.deepEqual(bundleBytes(), pinnedBytes, "and the bundle was put back to them, so pin and disk agree")
        assert.deepEqual(report.healed, [ID])
      })
    })
  })
})
