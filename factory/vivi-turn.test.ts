import assert from "node:assert/strict"
import test from "node:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { legFailureReason, runViviTurn } from "./vivi-turn.ts"
import type { ViviTurnOutcome } from "./vivi-turn.ts"
import { readReply } from "./agent-spawn.ts"
import type { LegResult } from "./leg-timeout.ts"

const VIVI_TURN = resolve(dirname(fileURLToPath(import.meta.url)), "vivi-turn.ts")

// The measured shape of a failed `claude --resume`: exit 1, EMPTY stdout, the whole story on stderr.
const RESUME_FAILURE = "No conversation found with session ID: 6f1c0f0e-6c3a-4a5c-9b2a-3f5a0d2b1c77"

const VIVI_SESSION = "17aec720-df8e-4f19-959a-795075b2bbf8"

function outcome(over: Partial<LegResult>): Promise<ViviTurnOutcome> {
  const result: LegResult = { status: 0, stdout: "", stderr: "", ...over }
  return runViviTurn({
    promptText: "prompt",
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

function runCli(claudeScript: string, args: (paths: { reply: string; failure: string }) => string[]) {
  const root = mkdtempSync(join(tmpdir(), "vivicy-vivi-turn-"))
  try {
    const bin = join(root, "bin")
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, "claude"), claudeScript, { mode: 0o755 })
    const target = join(root, "target")
    mkdirSync(target, { recursive: true })
    const promptFile = join(root, "prompt.txt")
    const reply = join(root, "reply.txt")
    const failure = join(root, "failure.txt")
    writeFileSync(promptFile, "say something")
    const argvPath = join(root, "argv")
    const run = spawnSync(process.execPath, [VIVI_TURN, "--prompt-file", promptFile, "--target", target, ...args({ reply, failure })], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        VIVICY_TARGET_ROOT: target,
        VIVICY_LEG_TIMEOUT_MS: "60000",
        VIVICY_LEG_IDLE_MS: "60000",
        VIVICY_FAKE_ARGV: argvPath,
      },
    })
    return {
      status: run.status,
      stderr: run.stderr ?? "",
      argv: existsSync(argvPath) ? readFileSync(argvPath, "utf8").split("\0").slice(0, -1) : [],
      reply: existsSync(reply) ? readFileSync(reply, "utf8") : null,
      failure: existsSync(failure) ? readFileSync(failure, "utf8") : null,
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a failing agent CLI leaves the reply file untouched and names its reason on the failure channel", () => {
  const run = runCli(`#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(RESUME_FAILURE)} >&2\nexit 1\n`, ({ reply, failure }) => [
    "--reply-file",
    reply,
    "--failure-file",
    failure,
  ])

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

function fakeClaude(stdout: string, extra = ""): string {
  return `#!/bin/sh\nprintf '%s\\0' "$@" > "$VIVICY_FAKE_ARGV"\n${extra}printf '%s' ${JSON.stringify(stdout)}\nexit 0\n`
}

test("a speaking agent CLI writes the reply its json envelope carries to the reply file and nothing to the failure channel", () => {
  const run = runCli(fakeClaude(ENVELOPE, `printf 'a warning\\n' >&2\n`), ({ reply, failure }) => [
    "--reply-file",
    reply,
    "--failure-file",
    failure,
  ])

  assert.equal(run.status, 0)
  assert.equal(run.reply, SPOKEN, "the reply file carries the envelope's .result, never the envelope")
  assert.equal(run.failure, null, "a turn that spoke names no failure")
  assert.deepEqual(
    run.argv.slice(0, 4),
    ["-p", "say something", "--safe-mode", "--dangerously-skip-permissions"],
    "the vivi leg keeps the whole isolation vector"
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
    const run = runCli(fakeClaude(stdout, `printf 'the CLI had something to say\\n' >&2\n`), ({ reply, failure }) => [
      "--reply-file",
      reply,
      "--failure-file",
      failure,
    ])
    assert.equal(run.status, 1, `${why}: a turn nobody can read must not exit 0`)
    assert.equal(run.reply, null, `${why}: the reply file carries Vivi's own words or nothing at all`)
    assert.equal(run.failure, "the agent CLI exited 0 without writing a reply — the CLI had something to say")
  }
})
