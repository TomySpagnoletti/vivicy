import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { after, afterEach, beforeEach, describe, it } from "node:test"

import { declaredSkillStates, preflightSkills, skillsDirective } from "./dev-preflight.ts"
import type { DeclaredSkillState } from "./dev-preflight.ts"
import { cacheBundle } from "./skill-heal.ts"
import { hashBundle, readSkillDeclarations, writeSkillDeclarations } from "./skill-pin.ts"
import { SKILLS_REPORT_REL } from "./install-skills.ts"
import type { SkillsReport } from "./install-skills.ts"
import { FACTORY_DIR } from "./target-root.ts"
import { claimStageLock, SKILLS_LOCK_FILE } from "../lib/stage-lock.ts"

const ID = "acme/pack@spreadsheets"
const SKILL = "spreadsheets"
const BUNDLE: Record<string, string> = {
  "SKILL.md": "---\nname: spreadsheets\ndescription: bundle from acme/pack\n---\n",
  "scripts/recalc.py": "print('recalc')\n",
}

let repo: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "vivicy-preflight-test-")))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

function writeBundle(files: Record<string, string> = BUNDLE, skill = SKILL, root = repo): string {
  const dir = resolve(root, ".agents/skills", skill)
  rmSync(dir, { recursive: true, force: true })
  for (const [rel, body] of Object.entries(files)) {
    const abs = resolve(dir, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, body)
  }
  return dir
}

function writeJson(rel: string, value: unknown): void {
  const abs = resolve(repo, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`)
}

// The pin is taken from the bytes on disk by the very function the installer pins with, so the fixture can never disagree with what the ladder verifies against.
function pin(id = ID, skill = SKILL): void {
  const bundle = hashBundle(resolve(repo, ".agents/skills", skill))
  assert.ok(bundle, "fixture: the bundle must exist before it can be pinned")
  assert.ok(writeSkillDeclarations(repo, [{ id, pin: bundle }]), "fixture: vivicy.json took the pin")
}

function state(states: readonly DeclaredSkillState[], id: string): DeclaredSkillState {
  const found = states.find((entry) => entry.id === id)
  assert.ok(found, `no state for ${id}`)
  return found
}

describe("what a declared skill's state IS (the one derivation the preflight and the legs both read)", () => {
  it("no target, no vivicy.json, and an explicitly empty declaration each declare nothing", () => {
    assert.deepEqual(declaredSkillStates(null), [])
    assert.deepEqual(declaredSkillStates(repo), [])
    writeJson("package.json", { vivicy: { skills: [{ id: "from-pkg" }] } })
    assert.deepEqual(declaredSkillStates(repo), [], "a `vivicy` field in package.json declares nothing — vivicy.json is the only source")
    writeJson("vivicy.json", { gateCommand: "npm test", skills: [] })
    assert.deepEqual(declaredSkillStates(repo), [])
  })

  it("reads the owner's own declaration verbatim: a hand-declared id is unpinned, and usable exactly when its bundle is there", () => {
    writeJson("vivicy.json", { gateCommand: "cargo test", skills: [{ id: ID }, { id: "plain-name" }] })
    assert.deepEqual(declaredSkillStates(repo), [
      { id: ID, pinned: false, usable: false },
      { id: "plain-name", pinned: false, usable: false },
    ])

    writeBundle()
    writeBundle({ "SKILL.md": "---\nname: plain-name\n---\n" }, "plain-name")
    assert.deepEqual(declaredSkillStates(repo), [
      { id: ID, pinned: false, usable: true },
      { id: "plain-name", pinned: false, usable: true },
    ])
  })

  it("a pinned bundle is usable only while it holds the pinned bytes — tampered or gone, it is not that skill", () => {
    writeBundle()
    pin()
    assert.deepEqual(declaredSkillStates(repo), [{ id: ID, pinned: true, usable: true }])

    writeFileSync(resolve(repo, ".agents/skills", SKILL, "scripts/recalc.py"), "print('tampered')\n")
    assert.deepEqual(declaredSkillStates(repo), [{ id: ID, pinned: true, usable: false }], "bytes nobody vouched for are not the skill")

    rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
    assert.deepEqual(declaredSkillStates(repo), [{ id: ID, pinned: true, usable: false }], "and a bundle that is gone stays pinned")
  })

  // The block promises every leg a readable SKILL.md at that path; a directory without one promises nothing.
  it("a bundle directory with no SKILL.md is not an installed skill", () => {
    writeBundle({ "scripts/recalc.py": "print('recalc')\n" })
    writeJson("vivicy.json", { gateCommand: "npm test", skills: [{ id: ID }] })
    assert.equal(state(declaredSkillStates(repo), ID).usable, false)
  })

  it("matches the bundle by the declared id's own name — `next-auth` never answers for `auth`", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", skills: [{ id: "vendor/x@auth" }] })
    writeBundle({ "SKILL.md": "---\nname: next-auth\n---\n" }, "next-auth")
    assert.equal(state(declaredSkillStates(repo), "vendor/x@auth").usable, false, "a longer name is a different skill")

    writeBundle({ "SKILL.md": "---\nname: auth\n---\n" }, "auth")
    assert.equal(state(declaredSkillStates(repo), "vendor/x@auth").usable, true)
  })

  it("two vendors' ids with the same name resolve to the one bundle that carries it", () => {
    writeBundle({ "SKILL.md": "---\nname: postgres\n---\n" }, "postgres")
    writeJson("vivicy.json", {
      gateCommand: "npm test",
      skills: [{ id: "supabase/agent-skills@postgres" }, { id: "other/pack@postgres" }, { id: "supabase/agent-skills@other" }],
    })
    const states = declaredSkillStates(repo)
    assert.equal(state(states, "supabase/agent-skills@postgres").usable, true)
    assert.equal(state(states, "other/pack@postgres").usable, true)
    assert.equal(state(states, "supabase/agent-skills@other").usable, false)
  })

  it("a traversal-shaped declaration names no bundle at all, and no path is probed for it", () => {
    writeBundle({ "SKILL.md": "---\nname: plain-name\n---\n" }, "plain-name")
    writeJson("vivicy.json", { gateCommand: "npm test", skills: [{ id: "plain-name" }, { id: "a/b@.." }, { id: ".." }, { id: "." }] })
    const states = declaredSkillStates(repo)
    assert.equal(state(states, "plain-name").usable, true)
    for (const id of ["a/b@..", "..", "."]) assert.equal(state(states, id).usable, false, `${id} names no bundle`)
    assert.ok(
      existsSync(resolve(repo, ".agents/skills/..")),
      "the parent directory really is there, so it is the segment rule that refuses `..` — never a path that happens not to exist"
    )
  })
})

describe("the preflight heals what drifted and degrades what it cannot", () => {
  function run(deps: { restorePins?: (targetRoot: string) => void } = {}): { states: DeclaredSkillState[]; said: string[] } {
    const said: string[] = []
    const states = preflightSkills(repo, { ...deps, announce: (line) => said.push(line) })
    return { states, said }
  }

  it("says nothing and restores nothing when there is nothing to say", () => {
    let restores = 0
    assert.deepEqual(run({ restorePins: () => (restores += 1) }).said, [], "a project declaring no skills")

    writeBundle()
    pin()
    const whole = run({ restorePins: () => (restores += 1) })
    assert.deepEqual(whole.said, [], "and a project whose every pinned bundle still holds its bytes")
    assert.deepEqual(whole.states, [{ id: ID, pinned: true, usable: true }])
    assert.equal(restores, 0, "the maintenance pass is spawned only when a pinned bundle actually needs it")
  })

  it("restores a drifted pin through the maintenance pass, once, and then has nothing to report", () => {
    writeBundle()
    pin()
    rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })

    const roots: string[] = []
    const { states, said } = run({
      restorePins: (targetRoot) => {
        roots.push(targetRoot)
        writeBundle()
      },
    })

    assert.deepEqual(roots, [repo], "the pass is asked once, for the root the preflight resolved")
    assert.equal(said.length, 1, "the restore is announced; a repair that worked owes the owner nothing else")
    assert.match(
      said[0],
      /^dev-loop preflight: 1 pinned project skill no longer holds the bytes vivicy\.json#skills pins \(acme\/pack@spreadsheets\) — running the skills maintenance pass to restore it\.\n$/
    )
    assert.deepEqual(states, [{ id: ID, pinned: true, usable: true }], "the run proceeds on the bytes the repair really left")
  })

  it("degrades the run when no restore path reproduces the bytes — never refuses it, never throws", () => {
    writeBundle()
    pin()
    writeFileSync(resolve(repo, ".agents/skills", SKILL, "scripts/recalc.py"), "print('tampered')\n")

    const { states, said } = run({ restorePins: () => {} })

    assert.deepEqual(states, [{ id: ID, pinned: true, usable: false }])
    assert.equal(said.length, 2)
    assert.match(
      said[1],
      /^dev-loop preflight: the run continues WITHOUT 1 declared project skill — acme\/pack@spreadsheets \(no restore path could reproduce the bytes vivicy\.json#skills pins for it\)\. The implementer and the reviewer are told to treat it as absent in the tree each works in\.\n$/
    )
  })

  // Nothing pinned it, so nothing can reproduce it: installing a hand-declared id needs the audit gate the skills stage owns, and the preflight neither heals it nor stops the run for it.
  it("never spawns the pass for an unpinned declaration, and states the fact instead", () => {
    writeJson("vivicy.json", { gateCommand: "npm test", skills: [{ id: ID }] })
    let restores = 0
    const { states, said } = run({ restorePins: () => (restores += 1) })

    assert.equal(restores, 0)
    assert.deepEqual(states, [{ id: ID, pinned: false, usable: false }])
    assert.equal(said.length, 1)
    assert.match(
      said[0],
      /the run continues WITHOUT 1 declared project skill — acme\/pack@spreadsheets \(vivicy\.json#skills declares it with no pin, and no bundle for it is installed here\)/
    )
  })

  it("counts what it announces, and never hands the owner an install command", () => {
    writeBundle()
    writeBundle({ "SKILL.md": "---\nname: charts\n---\n" }, "charts")
    const bundle = hashBundle(resolve(repo, ".agents/skills/charts"))
    assert.ok(bundle)
    assert.ok(
      writeSkillDeclarations(repo, [
        { id: ID, pin: hashBundle(resolve(repo, ".agents/skills", SKILL)) },
        { id: "acme/pack@charts", pin: bundle },
        { id: "owner/pack@ghost", pin: null },
      ])
    )
    rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
    rmSync(resolve(repo, ".agents/skills/charts"), { recursive: true, force: true })

    const { said } = run({ restorePins: () => {} })

    assert.match(
      said[0],
      /^dev-loop preflight: 2 pinned project skills no longer hold the bytes .* — running the skills maintenance pass to restore them\.\n$/
    )
    assert.match(said[1], /the run continues WITHOUT 3 declared project skills —/)
    assert.match(said[1], /are told to treat them as absent in the tree each works in\.\n$/)
    for (const line of said) {
      assert.doesNotMatch(line, /npx|skills add|install it|install them/, "the loop repairs itself; it never asks the owner to run a CLI")
    }
  })

  it("is idempotent: a second preflight over a whole tree restores nothing and says nothing", () => {
    writeBundle()
    pin()
    rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
    let restores = 0
    const restorePins = (): void => {
      restores += 1
      writeBundle()
    }

    assert.equal(run({ restorePins }).said.length, 1)
    assert.deepEqual(run({ restorePins }).said, [])
    assert.equal(restores, 1, "the repaired state is read back from disk, so a replay is a no-op")
  })
})

describe("the legs are told by name (the absent-skills directive)", () => {
  it("says nothing at all while every declared skill is usable", () => {
    assert.equal(skillsDirective(null), "")
    assert.equal(skillsDirective(repo), "")
    writeBundle()
    pin()
    assert.equal(skillsDirective(repo), "", "a whole project injects no correction into its legs' prompts")
  })

  it("names each unusable skill and keeps every other one mandatory", () => {
    writeBundle()
    writeBundle({ "SKILL.md": "---\nname: charts\n---\n" }, "charts")
    const spreadsheets = hashBundle(resolve(repo, ".agents/skills", SKILL))
    const charts = hashBundle(resolve(repo, ".agents/skills/charts"))
    assert.ok(spreadsheets && charts)
    assert.ok(
      writeSkillDeclarations(repo, [
        { id: ID, pin: spreadsheets },
        { id: "acme/pack@charts", pin: charts },
      ])
    )
    // One bundle drifts from its pin AFTER both were taken: its SKILL.md is still on disk, which is exactly why the leg has to be told not to read it.
    writeFileSync(resolve(repo, ".agents/skills", SKILL, "SKILL.md"), "tampered\n")

    const directive = skillsDirective(repo)
    assert.match(directive, /^## Project skills NOT available for this run\n/)
    assert.match(directive, /^This project declares 1 skill you cannot use in this tree — whatever the \*\*Project skills\*\* block/m)
    assert.match(directive, /in this repository's `AGENTS\.md` and `CLAUDE\.md` says about it, and that block may not name it at all/)
    assert.match(directive, /with the reason it is not here:/)
    assert.match(directive, /^- `acme\/pack@spreadsheets` — no restore path could reproduce the bytes vivicy\.json#skills pins for it$/m)
    assert.doesNotMatch(directive, /acme\/pack@charts/, "a skill that IS there is never named as absent")
    assert.match(directive, /do NOT read, cite, follow, or claim to have applied that skill/)
    assert.match(directive, /Every OTHER skill that block lists IS installed and stays mandatory\./)
  })

  // The leg gets the SAME cause the owner's line carries, per skill: telling it Vivicy "could not restore" a skill nothing ever pinned would be the inverse of the promise this directive exists to withdraw.
  it("gives each absent skill its own true reason, never the pinned one for a hand-declared id", () => {
    writeBundle()
    pin()
    rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
    const pinned = readSkillDeclarations(repo)
    assert.ok(writeSkillDeclarations(repo, [...pinned, { id: "owner/pack@ghost", pin: null }]))

    const directive = skillsDirective(repo)
    assert.match(directive, /^This project declares 2 skills you cannot use in this tree — whatever the \*\*Project skills\*\* block/m)
    assert.match(directive, /says about them, and that block may not name them at all — with the reason each is not here:/)
    assert.match(
      directive,
      /Every OTHER skill that block lists IS installed and stays mandatory\./,
      "the block is a FILE the leg opens, not this prompt"
    )
    assert.match(directive, /^- `acme\/pack@spreadsheets` — no restore path could reproduce the bytes vivicy\.json#skills pins for it$/m)
    assert.match(
      directive,
      /^- `owner\/pack@ghost` — vivicy\.json#skills declares it with no pin, and no bundle for it is installed here$/m
    )
    assert.doesNotMatch(directive, /could not reproduce[^\n]*ghost/, "the pinned cause never speaks for an unpinned declaration")
    assert.match(directive, /do NOT read, cite, follow, or claim to have applied those skills/)
  })

  // A file that is not a JSON object declares nothing, exactly as it does for every other reader of vivicy.json: the run is not stopped by an unreadable declaration, and no skill is invented from one.
  it("declares nothing on a vivicy.json that is not a JSON object, and stops nothing", () => {
    writeBundle()
    writeFileSync(resolve(repo, "vivicy.json"), "{ not json at all\n")
    assert.deepEqual(declaredSkillStates(repo), [])
    assert.equal(skillsDirective(repo), "")
    const said: string[] = []
    assert.deepEqual(
      preflightSkills(repo, {
        restorePins: () => assert.fail("nothing is declared, so nothing can be restored"),
        announce: (line) => said.push(line),
      }),
      []
    )
    assert.deepEqual(said, [])
  })
})

const HERMETIC_HOME = mkdtempSync(join(tmpdir(), "vivicy-preflight-home-"))
const OFFLINE_BIN = mkdtempSync(join(tmpdir(), "vivicy-preflight-bin-"))

// The ONE upstream touch the real ladder makes is `npx skills add`; a stub that always refuses is what makes "the cache answered" and "no rung could" provable offline, on any machine, in bounded time — and one that RECORDS its invocations is what makes the door's cost contract provable too: this door restores, it never sweeps for newer versions.
const UPSTREAM_CALLS = resolve(OFFLINE_BIN, "calls.log")
writeFileSync(resolve(OFFLINE_BIN, "npx"), `#!/bin/sh\necho "$@" >> ${UPSTREAM_CALLS}\necho 'offline: no registry reachable' >&2\nexit 1\n`)
chmodSync(resolve(OFFLINE_BIN, "npx"), 0o755)

function upstreamTouches(): number {
  return existsSync(UPSTREAM_CALLS) ? readFileSync(UPSTREAM_CALLS, "utf8").trim().split("\n").filter(Boolean).length : 0
}

after(() => {
  rmSync(HERMETIC_HOME, { recursive: true, force: true })
  rmSync(OFFLINE_BIN, { recursive: true, force: true })
})

// HOME and XDG_CONFIG_HOME are redirected, not just the config files: git reads its default per-user excludes ($XDG_CONFIG_HOME/git/ignore, else $HOME/.config/git/ignore) whether or not core.excludesFile is set, and a per-user rule can only ADD ignores — which silently turns the "tree clean" assertions below green. process.env itself is mutated because the preflight spawns the maintenance pass, which spawns git and the skills CLI, with the inherited environment.
function withRealTarget(fn: (ctx: { runtimeDir: string }) => void): void {
  const runtimeDir = resolve(repo, ".vivicy-runtime")
  rmSync(UPSTREAM_CALLS, { force: true })
  const overrides: Record<string, string | undefined> = {
    HOME: HERMETIC_HOME,
    XDG_CONFIG_HOME: HERMETIC_HOME,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_EMAIL: undefined,
    GIT_AUTHOR_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    PATH: `${OFFLINE_BIN}:${process.env.PATH ?? ""}`,
    VIVICY_TARGET_ROOT: repo,
    VIVICY_RUNTIME_DIR: runtimeDir,
  }
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]))
  const apply = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  for (const [key, value] of Object.entries(overrides)) apply(key, value)
  try {
    fn({ runtimeDir })
  } finally {
    for (const [key, value] of previous) apply(key, value)
  }
}

function git(args: string[], root = repo): { status: number; stdout: string } {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  return { status: r.status ?? 1, stdout: r.stdout ?? "" }
}

function notifications(runtimeDir: string): Array<{ level: string; event: string; message: string }> {
  const file = join(runtimeDir, "notifications.jsonl")
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

// A governed project as the skills stage leaves one: the bundle committed, the pin in vivicy.json, and — unless the case is about a cold machine — the pinned bytes in the content-addressed cache, deposited by the very function the installer deposits with.
function governedTarget({ warmCache = true } = {}): void {
  writeFileSync(resolve(repo, ".gitignore"), ".vivicy-runtime/\n.vivicy-tmp.*\n")
  writeFileSync(resolve(repo, "AGENTS.md"), "# Agent instructions\n")
  const dir = writeBundle()
  writeJson("vivicy.json", { gateCommand: "npm test" })
  pin()
  const bundle = hashBundle(dir)
  assert.ok(bundle)
  if (warmCache) assert.ok(cacheBundle(resolve(repo, ".vivicy-runtime"), bundle, dir))
  git(["init", "-q"])
  git(["add", "-A"])
  git(["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "owner: a governed project with one pinned skill"])
}

// The state no rung can answer: the bundle holds bytes that are not the pin, and so does the project's own history — which is what makes the git rung refuse rather than restore, exactly like an upstream that moved on.
function commitTamper(): void {
  writeFileSync(resolve(repo, ".agents/skills", SKILL, "scripts/recalc.py"), "print('tampered')\n")
  git(["add", "-A"])
  git(["-c", "user.email=owner@local", "-c", "user.name=Owner", "commit", "-qm", "someone: patch the skill"])
  assert.equal(git(["status", "--porcelain"]).stdout.trim(), "", "fixture: the tamper is committed, so the tree starts clean")
}

describe("driven on a real target: the preflight runs the maintenance pass itself (real ladder, real cache, real notifications)", () => {
  it("restores a deleted bundle from the warm cache: the run starts, the tree is clean, the owner is told nothing", () => {
    withRealTarget(({ runtimeDir }) => {
      governedTarget()
      const pinned = readFileSync(resolve(repo, ".agents/skills", SKILL, "scripts/recalc.py"), "utf8")
      rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })

      const states = preflightSkills(repo, { announce: () => {} })

      assert.deepEqual(states, [{ id: ID, pinned: true, usable: true }], "the bundle is back and holds the pinned bytes")
      assert.equal(readFileSync(resolve(repo, ".agents/skills", SKILL, "scripts/recalc.py"), "utf8"), pinned)
      assert.equal(git(["status", "--porcelain"]).stdout.trim(), "", "the pass absorbed its own writes, so the clean-tree gate passes")
      assert.deepEqual(notifications(runtimeDir), [], "a successful self-repair asks the owner for nothing")
      assert.equal(
        upstreamTouches(),
        0,
        "the cache answered and this door never sweeps for newer versions — a process start costs no network"
      )
      const report = JSON.parse(readFileSync(resolve(repo, SKILLS_REPORT_REL), "utf8")) as SkillsReport
      assert.deepEqual(report.healed, [ID])
      assert.equal(report.mode, "maintain")
    })
  })

  it("degrades the run when every rung fails: ONE notification, the drift never committed, the loop still starts", () => {
    withRealTarget(({ runtimeDir }) => {
      governedTarget({ warmCache: false })
      commitTamper()
      const said: string[] = []

      const states = preflightSkills(repo, { announce: (line) => said.push(line) })

      assert.deepEqual(states, [{ id: ID, pinned: true, usable: false }])
      assert.match(said[1], /the run continues WITHOUT 1 declared project skill/)
      const fired = notifications(runtimeDir)
      assert.equal(fired.length, 1, "exactly one, and it is the maintenance pass's own — the preflight never writes a second")
      assert.equal(fired[0].event, "heal_failed")
      assert.equal(fired[0].level, "error")
      assert.match(fired[0].message, /acme\/pack@spreadsheets/)
      assert.match(fired[0].message, /the build runs without it/)
      assert.equal(git(["status", "--porcelain"]).stdout.trim(), "", "nothing of the pass's is left dirty for the clean-tree gate")
      assert.deepEqual(
        git(["show", "--name-only", "--format=", "HEAD"]).stdout.trim().split("\n"),
        [SKILLS_REPORT_REL],
        "the pass committed its own record and NOT the bytes it could not vouch for"
      )

      assert.equal(
        upstreamTouches(),
        1,
        "one touch, and it is the ladder's own re-fetch rung for the broken bundle — never a version sweep"
      )

      // Told once: the retry still runs on the next start, but a failure the owner already knows about is not announced again.
      preflightSkills(repo, { announce: () => {} })
      assert.equal(notifications(runtimeDir).length, 1)
      assert.equal(upstreamTouches(), 2, "and the retry is never suppressed: nothing but a re-fetch can repair it without a human")
    })
  })

  it("defers to a skills stage that already holds the lock, writes nothing, and still degrades honestly", () => {
    withRealTarget(({ runtimeDir }) => {
      governedTarget()
      rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
      const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
      assert.ok(held, "fixture: the lock is ours to hold")
      try {
        const states = preflightSkills(repo, { announce: () => {} })

        assert.deepEqual(states, [{ id: ID, pinned: true, usable: false }], "the installer owns those bytes; this run degrades instead")
        assert.equal(existsSync(resolve(repo, SKILLS_REPORT_REL)), false, "a deferred pass publishes nothing")
        assert.deepEqual(notifications(runtimeDir), [])
        assert.equal(
          JSON.parse(readFileSync(join(runtimeDir, SKILLS_LOCK_FILE), "utf8")).pid,
          process.pid,
          "the claim we hold is untouched — the pass never broke a live holder's lock"
        )
      } finally {
        held.release()
      }
      // The next start asks again, and with the lock free the same cache rung repairs it.
      assert.deepEqual(preflightSkills(repo, { announce: () => {} }), [{ id: ID, pinned: true, usable: true }])
    })
  })

  it("the dev-loop CLI entry no longer dies on an unrestorable skill — it degrades and goes on to the loop's own gates", () => {
    withRealTarget(({ runtimeDir }) => {
      governedTarget({ warmCache: false })
      commitTamper()

      const run = spawnSync(process.execPath, [resolve(FACTORY_DIR, "dev-loop.ts")], { cwd: repo, encoding: "utf8", env: process.env })

      assert.match(run.stderr, /the run continues WITHOUT 1 declared project skill/)
      assert.doesNotMatch(run.stderr, /required development skill/, "the old missing-skills refusal is gone from the start path")
      assert.match(
        run.stderr,
        /no frozen baseline manifest found/,
        "the run got past the skills gate AND the clean-tree gate, and stopped only at the loop's own precondition"
      )
      assert.equal(run.status, 1)
      assert.equal(notifications(runtimeDir).length, 1, "the degraded start still tells the owner exactly once")
    })
  })

  // A committed bundle that was deleted leaves the tree DIRTY, so the repair has to happen before the clean-tree gate reads it — otherwise the owner's run is refused for bytes Vivicy is about to put back itself.
  it("the dev-loop CLI entry repairs the tree the clean-tree gate is about to read, instead of being refused by it", () => {
    withRealTarget(({ runtimeDir }) => {
      governedTarget()
      rmSync(resolve(repo, ".agents/skills", SKILL), { recursive: true, force: true })
      assert.notEqual(git(["status", "--porcelain"]).stdout.trim(), "", "precondition: the deleted bundle IS dirt the gate would refuse")

      const run = spawnSync(process.execPath, [resolve(FACTORY_DIR, "dev-loop.ts")], { cwd: repo, encoding: "utf8", env: process.env })

      assert.match(run.stderr, /1 pinned project skill no longer holds the bytes vivicy\.json#skills pins/)
      assert.doesNotMatch(run.stderr, /refuses to start on a dirty working tree/, "the repair landed before the gate looked")
      assert.doesNotMatch(run.stderr, /the run continues WITHOUT/, "and the repair worked, so nothing degrades")
      assert.match(run.stderr, /no frozen baseline manifest found/, "the run reached the loop's own precondition")
      assert.equal(git(["status", "--porcelain"]).stdout.trim(), "")
      assert.deepEqual(notifications(runtimeDir), [], "a start that repaired itself asks the owner for nothing")
    })
  })
})
