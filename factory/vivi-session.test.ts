import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

import {
  identityDrift,
  openViviSidecar,
  publishViviLegSession,
  readViviLegSession,
  runViviLegSession,
  stableCwd,
  viviSidecarPath,
  type ViviLegAttempt,
  type ViviLegIdentity,
  type ViviLegSession,
} from "./vivi-session.ts"

const PRIOR_CLI_SESSION = "6f1c0f0e-6c3a-4a5c-9b2a-3f5a0d2b1c77"
const FRESH_CLI_SESSION = "a1b2c3d4-5566-4788-99aa-bbccddeeff00"
const VIVI_SESSION = "17aec720-df8e-4f19-959a-795075b2bbf8"

const IDENTITY: ViviLegIdentity = { provider: "claude", model: "claude-sonnet-4-6", cwd: "/work/app", personaHash: "9f".repeat(32) }

function priorSession(over: Partial<ViviLegSession> = {}): ViviLegSession {
  return { ...IDENTITY, cliSessionId: PRIOR_CLI_SESSION, ...over }
}

// An async body must take the directory away only once it is done with it, never at the first await.
function withTmp<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "vivicy-vivi-session-"))
  const sweep = (): void => rmSync(dir, { recursive: true, force: true })
  let out: T
  try {
    out = body(dir)
  } catch (error) {
    sweep()
    throw error
  }
  if (out instanceof Promise) return out.finally(sweep) as T
  sweep()
  return out
}

// Outside every target: a home inside the tree under assertion would be one more untracked entry the assertion has to explain away.
const GIT_HOME = mkdtempSync(join(tmpdir(), "vivicy-vivi-session-home-"))
process.on("exit", () => rmSync(GIT_HOME, { recursive: true, force: true }))

// The file's ONE git seam: git reads its per-user excludes whether or not core.excludesFile is set, and a stray rule can only ADD ignores — which is exactly how an ignore assertion goes green on nothing.
function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const run = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: GIT_HOME,
      XDG_CONFIG_HOME: GIT_HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Vivicy Test",
      GIT_AUTHOR_EMAIL: "test@vivicy.local",
      GIT_COMMITTER_NAME: "Vivicy Test",
      GIT_COMMITTER_EMAIL: "test@vivicy.local",
    },
  })
  assert.ok(run.status !== null && run.status < 128, `git ${args.join(" ")} could not observe the tree: ${run.stderr}`)
  return { status: run.status as number, stdout: run.stdout }
}

function gitOk(cwd: string, args: string[]): string {
  const run = git(cwd, args)
  assert.equal(run.status, 0, `git ${args.join(" ")} failed`)
  return run.stdout
}

test("the sidecar sits beside the conversation store, named by the chat session, and refuses any id that is not one", () => {
  withTmp((dir) => {
    const file = viviSidecarPath(dir, VIVI_SESSION, {})
    assert.equal(file, join(dir, ".vivicy", "runtime", "vivi", `${VIVI_SESSION}.leg.json`))
    assert.equal(
      viviSidecarPath(dir, VIVI_SESSION, { VIVICY_RUNTIME_DIR: join(dir, "rt") }),
      join(dir, "rt", "vivi", `${VIVI_SESSION}.leg.json`)
    )

    for (const hostile of ["../../etc/passwd", `${VIVI_SESSION}/../..`, "", "not-a-uuid"]) {
      assert.throws(() => viviSidecarPath(dir, hostile, {}), /not a usable vivi session id/, `"${hostile}" must never name a file`)
    }
  })
})

test("opening the sidecar creates the store under a runtime dir that ignores itself, so nothing it holds is committable", () => {
  withTmp((dir) => {
    const file = openViviSidecar(dir, VIVI_SESSION, {})
    publishViviLegSession(file, priorSession())
    assert.equal(readFileSync(join(dir, ".vivicy", "runtime", ".gitignore"), "utf8"), "*\n")

    gitOk(dir, ["init", "-q"])
    const rel = `.vivicy/runtime/vivi/${VIVI_SESSION}.leg.json`
    assert.equal(git(dir, ["check-ignore", "-q", "--", rel]).status, 0, "the sidecar must be invisible to every commit the loop makes")
    assert.equal(gitOk(dir, ["status", "--porcelain", "--untracked-files=all"]), "", "publishing a sidecar leaves the target's tree clean")
  })
})

test("a record round-trips whole, and anything less reads as NO session so the turn creates one instead", () => {
  withTmp((dir) => {
    const file = join(dir, "session.leg.json")
    publishViviLegSession(file, priorSession())
    assert.deepEqual(readViviLegSession(file), priorSession())
    assert.equal(
      readFileSync(file, "utf8"),
      [
        "{",
        `  "provider": "${IDENTITY.provider}",`,
        `  "cliSessionId": "${PRIOR_CLI_SESSION}",`,
        `  "cwd": "${IDENTITY.cwd}",`,
        `  "personaHash": "${IDENTITY.personaHash}",`,
        `  "model": "${IDENTITY.model}"`,
        "}",
        "",
      ].join("\n"),
      "one field order and one byte shape, or write-if-different rewrites a record that never changed"
    )

    assert.equal(readViviLegSession(join(dir, "absent.leg.json")), null, "no file at all")
    for (const [body, why] of [
      ["{", "a torn write"],
      ["[]", "an array"],
      ["null", "a JSON null"],
      [JSON.stringify({ ...priorSession(), cliSessionId: "not-a-uuid" }), "an id no CLI ever minted"],
      [JSON.stringify({ ...priorSession(), cliSessionId: PRIOR_CLI_SESSION.toUpperCase() }), "an id in a spelling no CLI mints"],
      [JSON.stringify({ ...priorSession(), provider: "" }), "an empty provider"],
      [JSON.stringify({ ...priorSession(), cwd: 7 }), "a cwd that is not a path"],
      [JSON.stringify({ ...priorSession(), personaHash: undefined }), "no persona hash"],
      [JSON.stringify({ ...priorSession(), model: null }), "a model that is not a string"],
    ] as const) {
      writeFileSync(file, body)
      assert.equal(readViviLegSession(file), null, `${why} must read as no session`)
    }
  })
})

test("publishing is atomic and write-if-different: a healthy record is a zero-write no-op, a drifted one is republished whole", () => {
  withTmp((dir) => {
    const file = join(dir, "session.leg.json")
    publishViviLegSession(file, priorSession())
    const before = statSync(file)

    publishViviLegSession(file, priorSession())
    assert.equal(statSync(file).ino, before.ino, "an unchanged identity must not rewrite the file")

    publishViviLegSession(file, priorSession({ model: "claude-opus-4-6" }))
    assert.equal(readViviLegSession(file)?.model, "claude-opus-4-6")
    assert.notEqual(statSync(file).ino, before.ino, "a rewrite is a temp and a rename, never an edit in place")
    assert.deepEqual(readdirSync(dir), ["session.leg.json"], "no publish temp is ever left behind")
  })
})

test("the fork set is the conversation's identity — a model swapped mid-conversation is free and never one", () => {
  const prior = priorSession()
  assert.equal(identityDrift(prior, IDENTITY), null)
  assert.equal(identityDrift(prior, { ...IDENTITY, model: "claude-opus-4-6" }), null, "a model change costs nothing: measured free")
  assert.equal(identityDrift(prior, { ...IDENTITY, cwd: "/work/app-renamed" }), "cwd_changed")
  assert.equal(identityDrift(prior, { ...IDENTITY, provider: "codex" }), "provider_changed")
  assert.equal(identityDrift(prior, { ...IDENTITY, personaHash: "ab".repeat(32) }), "persona_changed")
})

test("two spellings of one directory are one cwd, so a symlinked target never reads as a moved one", () => {
  withTmp((dir) => {
    const real = join(dir, "real")
    mkdirSync(real)
    const link = join(dir, "link")
    symlinkSync(real, link)
    assert.equal(stableCwd(link), stableCwd(real))
    assert.equal(stableCwd(`${link}/.`), stableCwd(real))
    assert.equal(stableCwd(join(dir, "gone")), resolve(dir, "gone"), "a path that does not exist is still a usable key")
  })
})

interface Drive {
  seen: Array<string | undefined>
  spawn: (resumeSessionId?: string) => Promise<ViviLegAttempt<string>>
}

function drive(...attempts: Array<Partial<ViviLegAttempt<string>>>): Drive {
  const seen: Array<string | undefined> = []
  return {
    seen,
    spawn: async (resumeSessionId) => {
      const over = attempts[seen.length] ?? {}
      seen.push(resumeSessionId)
      return { turn: `turn ${seen.length}`, cliSessionId: FRESH_CLI_SESSION, spoke: true, resumeRefused: false, ...over }
    },
  }
}

test("turn one creates the conversation and records it; turn two resumes that very conversation", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})

    const first = drive()
    const created = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: first.spawn })
    assert.deepEqual(first.seen, [undefined], "a first turn resumes nothing")
    assert.deepEqual(created, { turn: "turn 1", forked: null, resumed: false })
    assert.deepEqual(readViviLegSession(sidecar), { ...IDENTITY, cliSessionId: FRESH_CLI_SESSION })

    const second = drive()
    const resumed = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: second.spawn })
    assert.deepEqual(second.seen, [FRESH_CLI_SESSION], "the recorded conversation is the one a later turn resumes")
    assert.deepEqual(resumed, { turn: "turn 1", forked: null, resumed: true })
  })
})

test("a resume the CLI refuses forks into a fresh conversation, in the same turn and without a word to the owner", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
    publishViviLegSession(sidecar, priorSession())

    const forked = drive({ spoke: false, resumeRefused: true, cliSessionId: undefined }, { cliSessionId: FRESH_CLI_SESSION })
    const run = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: forked.spawn })

    assert.deepEqual(forked.seen, [PRIOR_CLI_SESSION, undefined], "the refused resume is followed by a CREATE, never a second resume")
    assert.deepEqual(run, { turn: "turn 2", forked: "resume_refused", resumed: false })
    assert.equal(readViviLegSession(sidecar)?.cliSessionId, FRESH_CLI_SESSION, "the thread now lives in the conversation the fork made")
  })
})

test("a fork whose create also fails records nothing and leaves the turn retryable — never a dead Vivi", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
    publishViviLegSession(sidecar, priorSession())

    const dead = drive({ spoke: false, resumeRefused: true }, { spoke: false, resumeRefused: false, cliSessionId: undefined })
    const run = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: dead.spawn })

    assert.deepEqual(run, { turn: "turn 2", forked: "resume_refused", resumed: false })
    assert.deepEqual(
      readViviLegSession(sidecar),
      priorSession(),
      "a turn that never spoke rewrites nothing: the next one retries the same conversation"
    )
  })
})

test("a leg the watchdog killed is not a refused conversation: the turn costs one spawn, and the record stands", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
    publishViviLegSession(sidecar, priorSession())

    const wedged = drive({ spoke: false, resumeRefused: false, cliSessionId: undefined })
    const run = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: wedged.spawn })

    assert.deepEqual(wedged.seen, [PRIOR_CLI_SESSION], "a wedged leg says nothing about the session — never fork on it")
    assert.deepEqual(run, { turn: "turn 1", forked: null, resumed: true })
    assert.deepEqual(readViviLegSession(sidecar), priorSession())
  })
})

test("each identity event forks BEFORE the CLI is asked, so a moved target never buys the CLI's ambiguous error", async () => {
  for (const [now, reason] of [
    [{ ...IDENTITY, cwd: "/work/app-renamed" }, "cwd_changed"],
    [{ ...IDENTITY, provider: "codex" }, "provider_changed"],
    [{ ...IDENTITY, personaHash: "ab".repeat(32) }, "persona_changed"],
  ] as const) {
    await withTmp(async (dir) => {
      const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
      publishViviLegSession(sidecar, priorSession())

      const events = drive()
      const run = await runViviLegSession({ sidecar, identity: now, spawn: events.spawn })

      assert.deepEqual(events.seen, [undefined], `${reason}: the refused conversation is never even offered to the CLI`)
      assert.deepEqual(run, { turn: "turn 1", forked: reason, resumed: false })
      assert.deepEqual(readViviLegSession(sidecar), { ...now, cliSessionId: FRESH_CLI_SESSION })
    })
  }
})

test("a conversation the CLI re-identifies on resume is recorded under the id it hands back", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
    publishViviLegSession(sidecar, priorSession())

    const echoed = drive({ cliSessionId: FRESH_CLI_SESSION })
    await runViviLegSession({ sidecar, identity: IDENTITY, spawn: echoed.spawn })

    assert.equal(readViviLegSession(sidecar)?.cliSessionId, FRESH_CLI_SESSION, "the sidecar follows the CLI, never the other way round")
  })
})

test("a turn with no chat session of its own keeps no conversation: it creates, speaks, and records nothing", async () => {
  await withTmp(async (dir) => {
    const anonymous = drive()
    const run = await runViviLegSession({ sidecar: null, identity: IDENTITY, spawn: anonymous.spawn })

    assert.deepEqual(anonymous.seen, [undefined])
    assert.deepEqual(run, { turn: "turn 1", forked: null, resumed: false })
    assert.deepEqual(readdirSync(dir), [], "no session id, no sidecar — a hand-run turn leaves the project untouched")
  })
})

test("a first turn that never spoke records nothing at all", async () => {
  await withTmp(async (dir) => {
    const sidecar = openViviSidecar(dir, VIVI_SESSION, {})
    const mute = drive({ spoke: false })
    const run = await runViviLegSession({ sidecar, identity: IDENTITY, spawn: mute.spawn })

    assert.deepEqual(run, { turn: "turn 1", forked: null, resumed: false })
    assert.equal(readViviLegSession(sidecar), null, "an unspoken turn leaves no conversation for the next one to resume")
  })
})

test("a project that commits its whole tree still carries no sidecar", () => {
  withTmp((dir) => {
    gitOk(dir, ["init", "-q"])
    writeFileSync(join(dir, "README.md"), "# target\n")
    publishViviLegSession(openViviSidecar(dir, VIVI_SESSION, {}), priorSession())
    gitOk(dir, ["add", "-A"])
    gitOk(dir, ["commit", "-q", "-m", "everything"])

    const tracked = gitOk(dir, ["ls-files"])
    assert.equal(tracked.trim(), "README.md", `the commit must carry the owner's files alone, got:\n${tracked}`)
  })
})
