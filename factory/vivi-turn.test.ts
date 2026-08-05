import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { legFailureReason, runViviTurn } from "./vivi-turn.ts"
import type { ViviTurnOutcome } from "./vivi-turn.ts"
import { readReply } from "./agent-spawn.ts"
import type { LegResult } from "./leg-timeout.ts"
import { openViviSidecar, publishViviLegSession } from "./vivi-session.ts"
import { FACTORY_PROMPTS_DIR } from "./target-root.ts"

const VIVI_TURN = resolve(dirname(fileURLToPath(import.meta.url)), "vivi-turn.ts")

// The measured shape of a failed `claude --resume`: exit 1, EMPTY stdout, the whole story on stderr.
const RESUME_FAILURE = "No conversation found with session ID: 6f1c0f0e-6c3a-4a5c-9b2a-3f5a0d2b1c77"

const VIVI_SESSION = "17aec720-df8e-4f19-959a-795075b2bbf8"
const FORKED_SESSION = "a1b2c3d4-5566-4788-99aa-bbccddeeff00"

// The chat session lib/vivi.ts owns — distinct from the CLI conversation the sidecar it names points at.
const CHAT_SESSION = "3f2a91be-08c7-4d1e-9c44-6b0e2f7a5d13"

const LEG_MODEL = "vivi-turn-test-model"

// The two halves lib/vivi.ts composes for every turn: the seed opens a conversation, the increment continues one.
const SEED_PROMPT = "SEED — the persona, the whole render, the state, the order"
const INCREMENT_PROMPT = "INCREMENT — what is new since your last reply, and the order"

const PERSONA_HASH = createHash("sha256")
  .update(readFileSync(join(FACTORY_PROMPTS_DIR, "vivi.md"), "utf8"))
  .digest("hex")

function outcome(over: Partial<LegResult>): Promise<ViviTurnOutcome> {
  const result: LegResult = { status: 0, stdout: "", stderr: "", ...over }
  return runViviTurn({
    seedText: SEED_PROMPT,
    incrementText: INCREMENT_PROMPT,
    targetRoot: "/vivicy-vivi-turn/target",
    spawnVivi: async () => ({
      result,
      output: `${result.stdout}\n${result.stderr}`,
      transcriptRel: "T/vivi.jsonl",
      reply: readReply(result.stdout, false).reply,
      sessionId: VIVI_SESSION,
      usage: { output_tokens: 88 },
    }),
  })
}

test("the turn result keeps the leg's streams apart and carries its exit status", async () => {
  const failed = await outcome({ status: 1, stdout: "", stderr: `${RESUME_FAILURE}\n` })

  assert.equal(failed.reply, "", "stderr must never reach the reply — a merged stream is Vivi speaking the CLI's error")
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr, `${RESUME_FAILURE}\n`)
  assert.equal(failed.transcriptRel, "T/vivi.jsonl")

  const spoke = await outcome({ status: 0, stdout: "  Ciao!  \n", stderr: "a warning nobody asked for\n" })
  assert.equal(spoke.reply, "Ciao!", "the reply is what the leg said, trimmed")
  assert.equal(spoke.stderr, "a warning nobody asked for\n")
  assert.equal(spoke.cliSessionId, VIVI_SESSION, "the CLI session the turn ran in rides the outcome — it is what a later turn resumes")
  assert.deepEqual(spoke.usage, { output_tokens: 88 })
})

test("legFailureReason is the one verdict on whether the leg spoke", async () => {
  assert.equal(legFailureReason(await outcome({ status: 0, stdout: "Ciao!" })), null)
  assert.equal(
    legFailureReason(await outcome({ status: 1, stdout: "", stderr: `earlier chatter\n${RESUME_FAILURE}\n` })),
    `the agent CLI exited 1 — ${RESUME_FAILURE}`
  )
  assert.equal(legFailureReason(await outcome({ status: 1 })), "the agent CLI exited 1")
  assert.equal(
    legFailureReason(await outcome({ status: 0, stdout: "", stderr: "quota exhausted\n" })),
    "the agent CLI exited 0 without writing a reply — quota exhausted"
  )
  assert.equal(legFailureReason(await outcome({ status: null })), "the agent CLI reported no exit status")

  const long = "x".repeat(400)
  const clipped = legFailureReason(await outcome({ status: 1, stderr: `${long}\n` })) as string
  assert.ok(clipped.length < 240, `an unbounded CLI line must be clipped, got ${clipped.length} chars`)
  assert.ok(clipped.endsWith("…"))
})

// A resumed turn whose leg came back like this: how many spawns it costs is the whole question.
async function resumeAttempt(over: Partial<LegResult>): Promise<{ spawns: number; forked: ViviTurnOutcome["forked"] }> {
  const root = mkdtempSync(join(tmpdir(), "vivicy-vivi-turn-resume-"))
  try {
    const sidecar = openViviSidecar(root, CHAT_SESSION, {})
    publishViviLegSession(sidecar, {
      provider: "claude",
      cliSessionId: VIVI_SESSION,
      cwd: realpathSync(root),
      personaHash: PERSONA_HASH,
      model: LEG_MODEL,
    })
    let spawns = 0
    const turn = await runViviTurn({
      seedText: SEED_PROMPT,
      incrementText: INCREMENT_PROMPT,
      targetRoot: root,
      sessionId: CHAT_SESSION,
      cfg: { promptsDir: FACTORY_PROMPTS_DIR },
      spawnVivi: async () => {
        spawns += 1
        const result: LegResult = { status: 0, stdout: "", stderr: "", ...over }
        return { result, output: "", transcriptRel: undefined, reply: "", sessionId: undefined }
      },
    })
    return { spawns, forked: turn.forked }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("only the CLI REFUSING the conversation forks it: a wedged leg and a CLI that never started each cost one spawn", async () => {
  assert.deepEqual(await resumeAttempt({ status: 1, stderr: `${RESUME_FAILURE}\n` }), { spawns: 2, forked: "resume_refused" })
  assert.deepEqual(
    await resumeAttempt({ status: 143, timedOut: true, timeoutReason: "idle for 12 min" }),
    { spawns: 1, forked: null },
    "a leg the watchdog killed says nothing about the session — re-running it as a create doubles a 45-minute wall clock"
  )
  assert.deepEqual(
    await resumeAttempt({ status: null, error: new Error("spawn claude ENOENT") }),
    { spawns: 1, forked: null },
    "a CLI that never started refuses nothing"
  )
})

interface CliRun {
  status: number | null
  stdout: string
  stderr: string
  invocations: string[][]
  argv: string[]
  reply: string | null
  failure: string | null
}

const ARGV_RECORD_END = "END"

// Every fake CLI invocation appends its own argv record: one turn can spawn twice, and the fork drives read both.
function readInvocations(argvPath: string): string[][] {
  if (!existsSync(argvPath)) return []
  const out: string[][] = []
  let current: string[] = []
  for (const token of readFileSync(argvPath, "utf8").split("\0").slice(0, -1)) {
    if (token === ARGV_RECORD_END) {
      out.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  return out
}

interface CliHarness {
  target: string
  sidecarOf: (sessionId: string) => string
  run: (claudeScript: string, extra?: string[]) => CliRun
}

function withCli<T>(body: (harness: CliHarness) => T): T {
  const root = mkdtempSync(join(tmpdir(), "vivicy-vivi-turn-"))
  const bin = join(root, "bin")
  const target = join(root, "target")
  mkdirSync(bin, { recursive: true })
  mkdirSync(target, { recursive: true })
  const seedFile = join(root, "seed.txt")
  const incrementFile = join(root, "increment.txt")
  const reply = join(root, "reply.txt")
  const failure = join(root, "failure.txt")
  const argvPath = join(root, "argv")
  writeFileSync(seedFile, SEED_PROMPT)
  writeFileSync(incrementFile, INCREMENT_PROMPT)
  try {
    return body({
      target,
      sidecarOf: (sessionId) => join(target, ".vivicy", "runtime", "vivi", `${sessionId}.leg.json`),
      run: (claudeScript, extra = []) => {
        writeFileSync(join(bin, "claude"), claudeScript, { mode: 0o755 })
        for (const stale of [argvPath, reply, failure]) rmSync(stale, { force: true })
        const run = spawnSync(
          process.execPath,
          [
            VIVI_TURN,
            "--seed-file",
            seedFile,
            "--increment-file",
            incrementFile,
            "--target",
            target,
            "--reply-file",
            reply,
            "--failure-file",
            failure,
            ...extra,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH ?? ""}`,
              VIVICY_TARGET_ROOT: target,
              VIVICY_LEG_TIMEOUT_MS: "60000",
              VIVICY_LEG_IDLE_MS: "60000",
              VIVICY_FAKE_ARGV: argvPath,
              VIVICY_IMPLEMENTER_CLI: "claude",
              VIVICY_CLAUDE_MODEL: LEG_MODEL,
            },
          }
        )
        const invocations = readInvocations(argvPath)
        return {
          status: run.status,
          stdout: run.stdout ?? "",
          stderr: run.stderr ?? "",
          invocations,
          argv: invocations[0] ?? [],
          reply: existsSync(reply) ? readFileSync(reply, "utf8") : null,
          failure: existsSync(failure) ? readFileSync(failure, "utf8") : null,
        }
      },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function runCli(claudeScript: string, extra: string[] = []): CliRun {
  return withCli(({ run }) => run(claudeScript, extra))
}

test("a failing agent CLI leaves the reply file untouched and names its reason on the failure channel", () => {
  const run = runCli(`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(RESUME_FAILURE)} >&2\nexit 1\n`)

  assert.equal(run.status, 1, "a leg that never spoke must not exit 0")
  assert.equal(run.reply, null, "the reply file carries Vivi's own words or nothing at all — never the CLI's stderr")
  assert.equal(run.failure, `the agent CLI exited 1 — ${RESUME_FAILURE}`)
  assert.match(run.stderr, /vivi turn failed: the agent CLI exited 1/)
})

const SPOKEN = "Ciao, allora — what are we building?"

// The measured `--output-format json` envelope: the reply lives in .result, and session_id + usage ride beside it.
const ENVELOPE = JSON.stringify({
  is_error: false,
  session_id: VIVI_SESSION,
  usage: { input_tokens: 10, output_tokens: 88 },
  subtype: "success",
  result: SPOKEN,
  type: "result",
})

const RECORD_ARGV = `printf '%s\\0' "$@" >> "$VIVICY_FAKE_ARGV"\nprintf '%s\\0' ${JSON.stringify(ARGV_RECORD_END)} >> "$VIVICY_FAKE_ARGV"\n`

function fakeClaude(stdout: string, extra = ""): string {
  return `#!/bin/sh\n${RECORD_ARGV}${extra}printf '%s' ${JSON.stringify(stdout)}\nexit 0\n`
}

// The measured shape of a claude that no longer holds the conversation: it refuses the resume and says so on stderr, exit 1.
function fakeClaudeRefusingResume(stdout: string): string {
  return (
    `#!/bin/sh\n${RECORD_ARGV}` +
    `case " $* " in *" --resume "*) printf '%s\\n' ${JSON.stringify(RESUME_FAILURE)} >&2; exit 1;; esac\n` +
    `printf '%s' ${JSON.stringify(stdout)}\nexit 0\n`
  )
}

test("a speaking agent CLI writes the reply its json envelope carries to the reply file and nothing to the failure channel", () => {
  const run = runCli(fakeClaude(ENVELOPE, `printf 'a warning\\n' >&2\n`))

  assert.equal(run.status, 0)
  assert.equal(run.reply, SPOKEN, "the reply file carries the envelope's .result, never the envelope")
  assert.equal(run.failure, null, "a turn that spoke names no failure")
  assert.deepEqual(
    run.argv.slice(0, 4),
    ["-p", SEED_PROMPT, "--safe-mode", "--dangerously-skip-permissions"],
    "the vivi leg keeps the whole isolation vector, and the persona rides the conversation's first MESSAGE — never a system-prompt flag"
  )
  assert.equal(
    run.argv.some((arg) => arg.includes("system-prompt")),
    false,
    "the persona is the first message of the conversation: no --system-prompt / --append-system-prompt, whose interaction with --resume is unmeasured"
  )
  assert.equal(run.argv[4], "--session-id", "a first turn mints its session; only a later one resumes it")
  assert.match(run.argv[5], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.deepEqual(run.argv.slice(6, 8), ["--output-format", "json"], "the vivi path asks for the envelope that carries session_id + usage")
})

test("an agent CLI that exits 0 without a usable envelope leaves the reply file untouched instead of speaking JSON as Vivi", () => {
  for (const [stdout, why] of [
    [SPOKEN, "plain prose where the envelope was asked for"],
    ['{"type":"result","is_error":true,"result":"Credit balance too low","subtype":"error"}', "an envelope the CLI itself marks failed"],
    ['{"type":"result","result":', "a truncated envelope"],
  ] as const) {
    const run = runCli(fakeClaude(stdout, `printf 'the CLI had something to say\\n' >&2\n`))
    assert.equal(run.status, 1, `${why}: a turn nobody can read must not exit 0`)
    assert.equal(run.reply, null, `${why}: the reply file carries Vivi's own words or nothing at all`)
    assert.equal(run.failure, "the agent CLI exited 0 without writing a reply — the CLI had something to say")
  }
})

const FORKED_SPOKEN = "Allora, where were we — the CSV export."

const FORKED_ENVELOPE = JSON.stringify({
  is_error: false,
  session_id: FORKED_SESSION,
  usage: { input_tokens: 12, output_tokens: 40 },
  subtype: "success",
  result: FORKED_SPOKEN,
  type: "result",
})

function sidecarRecord(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
}

test("the conversation a turn creates is recorded beside the thread, and the next turn resumes that very one", () => {
  withCli(({ target, sidecarOf, run }) => {
    const first = run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])

    assert.equal(first.status, 0)
    assert.equal(first.reply, SPOKEN)
    assert.equal(first.argv[4], "--session-id", "turn one mints its conversation")
    assert.deepEqual(
      sidecarRecord(sidecarOf(CHAT_SESSION)),
      { provider: "claude", cliSessionId: VIVI_SESSION, cwd: realpathSync(target), personaHash: PERSONA_HASH, model: LEG_MODEL },
      "the sidecar records what the conversation runs as, the CLI's own id included"
    )
    assert.match(
      first.stdout,
      new RegExp(`new conversation ${VIVI_SESSION}`),
      "the conversation is named on the server log, never in the chat"
    )

    const second = run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])

    assert.equal(second.invocations.length, 1, "a resume that works costs exactly one spawn")
    assert.deepEqual(second.argv.slice(4, 6), ["--resume", VIVI_SESSION], "turn two continues the recorded conversation")
    assert.equal(second.reply, SPOKEN)
    assert.match(second.stdout, new RegExp(`resumed ${VIVI_SESSION}`))
  })
})

test("a resume the CLI refuses forks inside the same turn: the owner still gets a reply, and turn three carries on in the fork", () => {
  withCli(({ sidecarOf, run }) => {
    run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])

    const forked = run(fakeClaudeRefusingResume(FORKED_ENVELOPE), ["--session", CHAT_SESSION])

    assert.equal(forked.status, 0, "a refused resume must never reach the owner as a failed turn")
    assert.equal(forked.reply, FORKED_SPOKEN, "the reply is the fork's, seeded with the whole render the prompt already carries")
    assert.equal(forked.invocations.length, 2, "the refused resume, then the create that replaces it")
    assert.deepEqual(forked.invocations[0].slice(4, 6), ["--resume", VIVI_SESSION])
    assert.equal(forked.invocations[1][4], "--session-id", "the fork mints a new conversation, never resumes a second time")
    assert.equal(sidecarRecord(sidecarOf(CHAT_SESSION)).cliSessionId, FORKED_SESSION)
    assert.match(forked.stdout, /forked \(resume_refused\)/)

    const third = run(fakeClaude(FORKED_ENVELOPE), ["--session", CHAT_SESSION])
    assert.deepEqual(third.argv.slice(4, 6), ["--resume", FORKED_SESSION], "the thread carries on in the conversation the fork made")
  })
})

test("one seed per conversation, one increment per later turn — and a fork reseeds instead of continuing on a delta", () => {
  withCli(({ run }) => {
    const created = run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])
    assert.equal(created.argv[1], SEED_PROMPT, "the conversation opens on the seed: persona, whole render, state, order")
    assert.match(created.stdout, new RegExp(`new conversation ${VIVI_SESSION} — seed ${SEED_PROMPT.length} chars`))

    const resumed = run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])
    assert.equal(
      resumed.argv[1],
      INCREMENT_PROMPT,
      "a resumed conversation carries the increment ALONE — the seed's bytes are already in it"
    )
    assert.equal(
      resumed.argv.includes(SEED_PROMPT),
      false,
      "re-sending the seed on a resume is the cost regression this split exists to kill"
    )
    assert.match(resumed.stdout, new RegExp(`resumed ${VIVI_SESSION} — increment ${INCREMENT_PROMPT.length} chars`))

    const forked = run(fakeClaudeRefusingResume(FORKED_ENVELOPE), ["--session", CHAT_SESSION])
    assert.equal(forked.invocations[0][1], INCREMENT_PROMPT, "the resume is attempted on the increment")
    assert.equal(
      forked.invocations[1][1],
      SEED_PROMPT,
      "the fork's create RESEEDS: a new conversation on a delta would start with no persona and no thread"
    )
    assert.match(forked.stdout, new RegExp(`forked \\(resume_refused\\) into ${FORKED_SESSION} — seed ${SEED_PROMPT.length} chars`))
  })
})

test("a target that moved is caught in the sidecar and forks BEFORE the CLI is asked, never on its ambiguous refusal", () => {
  withCli(({ target, sidecarOf, run }) => {
    run(fakeClaude(ENVELOPE), ["--session", CHAT_SESSION])
    const sidecar = sidecarOf(CHAT_SESSION)
    writeFileSync(sidecar, JSON.stringify({ ...sidecarRecord(sidecar), cwd: "/somewhere/it/used/to/live" }))

    const moved = run(fakeClaude(FORKED_ENVELOPE), ["--session", CHAT_SESSION])

    assert.equal(moved.invocations.length, 1, "the stale conversation is never offered to the CLI at all")
    assert.equal(moved.argv[4], "--session-id")
    assert.equal(moved.argv[1], SEED_PROMPT, "a drift-driven fork reseeds its new conversation too")
    assert.equal(moved.reply, FORKED_SPOKEN)
    assert.match(moved.stdout, /forked \(cwd_changed\)/)
    assert.equal(sidecarRecord(sidecar).cwd, realpathSync(target), "the record now names where the target actually is")
  })
})

test("a turn with no chat session of its own writes no sidecar: only the thread's own session names one", () => {
  withCli(({ target, run }) => {
    const anonymous = run(fakeClaude(ENVELOPE))

    assert.equal(anonymous.status, 0)
    assert.equal(anonymous.argv[4], "--session-id", "a sessionless turn always creates, never resumes")
    assert.equal(
      existsSync(join(target, ".vivicy", "runtime", "vivi")),
      false,
      "a hand-run turn leaves the project's conversation store alone"
    )
  })
})

test("the CLI entry refuses a turn missing a half, and one whose prompt file is not on disk, before it spawns anything", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-vivi-turn-usage-"))
  try {
    const seed = join(root, "seed.txt")
    writeFileSync(seed, SEED_PROMPT)
    const entry = (args: string[]) => spawnSync(process.execPath, [VIVI_TURN, ...args], { encoding: "utf8" })

    for (const [args, why] of [
      [["--seed-file", seed, "--reply-file", join(root, "reply.txt")], "no --increment-file"],
      [["--increment-file", seed, "--reply-file", join(root, "reply.txt")], "no --seed-file"],
      [["--seed-file", seed, "--increment-file", seed], "no --reply-file"],
    ] as const) {
      const run = entry([...args])
      assert.equal(run.status, 2, `${why}: a usage error is exit 2`)
      assert.match(run.stderr, /vivi-turn requires --seed-file <abs>, --increment-file <abs> and --reply-file <abs>/)
    }

    const missing = entry(["--seed-file", seed, "--increment-file", join(root, "gone.txt"), "--reply-file", join(root, "reply.txt")])
    assert.equal(missing.status, 2)
    assert.match(missing.stderr, /prompt file not found: .*gone\.txt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a chat session id that could name anything but a sidecar is refused outright", () => {
  const run = runCli(fakeClaude(ENVELOPE), ["--session", "../../../etc/passwd"])

  assert.equal(run.status, 1)
  assert.equal(run.reply, null)
  assert.match(run.failure ?? "", /not a usable vivi session id/)
})
