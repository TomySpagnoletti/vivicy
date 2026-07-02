import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ControlError, type RunOptions, type RunResult, type Spawner } from "@/lib/control"
import { readTranscript, runViviTurn, type ViviTurn } from "@/lib/vivi"

/**
 * A recording fake spawner whose `run` DELEGATES to a per-test `onRun` so a test
 * can simulate exactly what the Vivi leg does to the target (write .md files, write
 * the --reply-file, or misbehave by writing outside the allowlist). Records every
 * run's args + env so tests assert the settings plumb-through.
 */
function makeFakeSpawner(onRun: (options: RunOptions) => void = () => {}) {
  const calls = { run: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }> }
  const spawner: Spawner = {
    spawnDetached: () => ({ pid: 1 }),
    run: async (options): Promise<RunResult> => {
      calls.run.push({ args: options.args, env: options.env, cwd: options.cwd })
      onRun(options)
      return { code: 0, lastLine: "vivi turn: fake", stdout: "vivi turn: fake\n", stderr: "" }
    },
    killGroup: () => true,
    isAlive: () => false,
  }
  return { spawner, calls }
}

/** Pull the `--reply-file` path out of a recorded run's args. */
function replyFileFrom(args: string[]): string {
  const i = args.indexOf("--reply-file")
  return args[i + 1]
}

/** Write the agent's textual reply to the reply file (what a real leg does). */
function writeReply(options: RunOptions, text: string): void {
  const file = replyFileFrom(options.args)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

/** Write a file at a repo-relative path under the target (what a misbehaving or
 *  well-behaved leg does inside cwd=targetRoot). */
function writeInTarget(targetRoot: string, rel: string, body: string): void {
  const abs = path.join(targetRoot, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

let factoryRoot: string
let targetRoot: string
let runtimeDir: string
let prevCwd: string

/** Build a fake factory dir with the vivi-turn script the control plane resolves. */
function scaffoldFactory(root: string) {
  mkdirSync(path.join(root, "prompts"), { recursive: true })
  writeFileSync(path.join(root, "vivi-turn.mjs"), "// stub\n")
  writeFileSync(path.join(root, "prompts", "vivi.md"), "# Vivi persona (test stub)\n")
}

beforeEach(() => {
  factoryRoot = mkdtempSync(path.join(tmpdir(), "vivi-factory-"))
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivi-target-"))
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivi-runtime-"))
  scaffoldFactory(factoryRoot)
  // The target must have a .vivicy so the allowlist dirs resolve.
  mkdirSync(path.join(targetRoot, ".vivicy", "canonical"), { recursive: true })
  mkdirSync(path.join(targetRoot, ".vivicy", "development", "spikes"), { recursive: true })

  process.env.VIVICY_FACTORY_ROOT = factoryRoot
  process.env.VIVICY_TARGET_ROOT = targetRoot
  process.env.VIVICY_RUNTIME_DIR = runtimeDir

  prevCwd = process.cwd()
  process.chdir(runtimeDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  for (const dir of [factoryRoot, targetRoot, runtimeDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.VIVICY_FACTORY_ROOT
  delete process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_RUNTIME_DIR
})

const CANONICAL = path.join(".vivicy", "canonical")
const SPIKES = path.join(".vivicy", "development", "spikes")

describe("runViviTurn — transcript", () => {
  it("appends the user turn then the vivi reply, and replays across turns", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "Reply one."))
    const first = await runViviTurn(spawner, { message: "I want a todo app." })

    expect(first.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(first.reply).toBe("Reply one.")

    let turns = readTranscript(first.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "vivi"])
    expect(turns[0].text).toBe("I want a todo app.")
    expect(turns[1].text).toBe("Reply one.")

    // Second turn on the SAME session appends, and the composed prompt carries the
    // prior transcript (replay) to the leg.
    let seenPrompt = ""
    const second = makeFakeSpawner((o) => {
      seenPrompt = readFileSync(promptFileFrom(o.args), "utf8")
      writeReply(o, "Reply two.")
    })
    await runViviTurn(second.spawner, { sessionId: first.sessionId, message: "It needs due dates." })

    turns = readTranscript(first.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "vivi", "user", "vivi"])
    expect(seenPrompt).toContain("I want a todo app.")
    expect(seenPrompt).toContain("Reply one.")
    expect(seenPrompt).toContain("It needs due dates.")
  })

  it("refuses an empty message and a missing target without spawning", async () => {
    const { spawner, calls } = makeFakeSpawner()
    await expect(runViviTurn(spawner, { message: "   " })).rejects.toThrow(ControlError)
    expect(calls.run).toHaveLength(0)

    delete process.env.VIVICY_TARGET_ROOT
    // No persisted project + no env target => missing_target.
    await expect(runViviTurn(spawner, { message: "hi" })).rejects.toThrow(/no project selected/)
  })

  it("uses per-turn scratch files so concurrent turns on one session never collide", async () => {
    // Two turns on the SAME session, running concurrently. The fix: each turn gets
    // its OWN prompt/reply scratch files (a per-turn token, not just the session id),
    // so a leg's reply is captured from ITS file and can never be clobbered by the
    // sibling turn — the reply-file race the reviewer flagged. We key each reply to
    // its own reply-file basename to prove each caller reads back exactly its own.
    const sessionId = "22222222-2222-2222-2222-222222222222"
    const seenPromptFiles = new Set<string>()
    const seenReplyFiles = new Set<string>()
    const onRun = (o: RunOptions) => {
      const replyFile = replyFileFrom(o.args)
      seenPromptFiles.add(promptFileFrom(o.args))
      seenReplyFiles.add(replyFile)
      // The reply is tied to THIS turn's own reply file, so a mixed-up capture would
      // surface as one caller getting the other's file token.
      writeReply(o, `reply@${path.basename(replyFile)}`)
    }
    const a = makeFakeSpawner(onRun)
    const b = makeFakeSpawner(onRun)

    const [ra, rb] = await Promise.all([
      runViviTurn(a.spawner, { sessionId, message: "ALPHA" }),
      runViviTurn(b.spawner, { sessionId, message: "BETA" }),
    ])

    // Distinct scratch files per turn (the fix): two prompt files, two reply files.
    expect(seenPromptFiles.size).toBe(2)
    expect(seenReplyFiles.size).toBe(2)
    // Each caller read back the reply written to ITS OWN reply file — no cross-talk.
    // (Each fake spawner recorded exactly one run, so run[0] is that turn's run.)
    expect(ra.reply).toBe(`reply@${path.basename(replyFileFrom(a.calls.run[0].args))}`)
    expect(rb.reply).toBe(`reply@${path.basename(replyFileFrom(b.calls.run[0].args))}`)
    expect(ra.reply).not.toBe(rb.reply)
    expect(ra.sessionId).toBe(sessionId)
    expect(rb.sessionId).toBe(sessionId)
  })
})

describe("runViviTurn — allowlist enforcement", () => {
  it("reports legit canonical + spike writes in `wrote`", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeInTarget(targetRoot, path.join(SPIKES, "S01-provider.md"), "# S01\n")
      writeReply(o, "Wrote your first docs.")
    })
    const result = await runViviTurn(spawner, { message: "start" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([
      path.join(CANONICAL, "01-product.md"),
      path.join(SPIKES, "S01-provider.md"),
    ])
    // The files survive (a legit turn is never rolled back), and the transcript
    // records the writes on the vivi turn.
    expect(existsSync(path.join(targetRoot, CANONICAL, "01-product.md"))).toBe(true)
    const turns = readTranscript(result.sessionId)
    expect((turns.at(-1) as ViviTurn).wrote).toEqual(result.wrote)
  })

  it("rejects a write OUTSIDE the allowlist and REMOVES the offending file", async () => {
    // Seed an existing canonical doc so we can prove the legit dirs are restored
    // byte-for-byte even when the turn also touches a legit file.
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "original\n")

    const { spawner } = makeFakeSpawner((o) => {
      // A legit edit...
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "TAMPERED\n")
      // ...plus a forbidden write outside the two allowed dirs.
      writeInTarget(targetRoot, path.join(".vivicy", "development", "issues", "sneaky.md"), "no\n")
      writeReply(o, "I tried to escape.")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    // The forbidden file is gone...
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "issues", "sneaky.md"))).toBe(false)
    // ...and the legit dir is restored to its pre-turn bytes (the tamper is undone).
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("original\n")
    // The rejection is recorded on the transcript.
    expect((readTranscript(result.sessionId).at(-1) as ViviTurn).rejected).toBeTruthy()
  })

  it("rejects a NON-md write into the canonical dir and removes it", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "notes.txt"), "not markdown\n")
      writeReply(o, "oops")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, CANONICAL, "notes.txt"))).toBe(false)
  })

  it("discards a legit canonical .md written in the SAME turn as an in-.vivicy violation", async () => {
    // The whole turn is atomic: a good doc that lands alongside a forbidden
    // in-.vivicy write (here, into .vivicy/baselines) is rolled back WITH the turn,
    // never kept partially.
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "02-good.md"), "# Good\n")
      writeInTarget(targetRoot, path.join(".vivicy", "baselines", "forged.md"), "# forged a baseline\n")
      writeReply(o, "mixed")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    // Both the forbidden baseline write and the good doc are gone.
    expect(existsSync(path.join(targetRoot, ".vivicy", "baselines", "forged.md"))).toBe(false)
    expect(existsSync(path.join(targetRoot, CANONICAL, "02-good.md"))).toBe(false)
  })
})

describe("runViviTurn — settings plumb-through", () => {
  it("passes the configured CLI + model env and cwd=target to the leg", async () => {
    // Persist non-default settings so the leg env reflects the user's choice.
    writeFileSync(
      path.join(runtimeDir, "settings.json"),
      JSON.stringify({
        implementer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
        reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
        maxParallel: 1,
      })
    )

    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, "ok"))
    await runViviTurn(spawner, { message: "hi" })

    const call = calls.run[0]
    expect(call.cwd).toBe(targetRoot)
    expect(call.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    // The implementer CLI is Vivi's engine; its model rides the CLI-keyed env.
    expect(call.env.VIVICY_IMPLEMENTER_CLI).toBe("codex")
    expect(call.env.VIVICY_CODEX_MODEL).toBe("gpt-5.5")
    expect(call.args.some((a) => a.endsWith("vivi-turn.mjs"))).toBe(true)
  })

  it("fails clearly when the vivi-turn script is missing", async () => {
    rmSync(path.join(factoryRoot, "vivi-turn.mjs"))
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "ok"))
    await expect(runViviTurn(spawner, { message: "hi" })).rejects.toThrow(/not found/)
  })
})

/** Pull the `--prompt-file` path out of a recorded run's args. */
function promptFileFrom(args: string[]): string {
  const i = args.indexOf("--prompt-file")
  return args[i + 1]
}
