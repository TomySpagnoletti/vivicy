import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ControlError, type RunOptions, type RunResult, type Spawner } from "@/lib/control"
import { parseSkillsDirective, readTranscript, runViviTurn, type ViviTurn } from "@/lib/vivi"

/**
 * A recording fake spawner whose `run` DELEGATES to a per-test `onRun` so a test
 * can simulate exactly what the Vivi leg does to the target (write .md files, write
 * the --reply-file, or misbehave by writing outside the allowlist). Records every
 * run's args + env so tests assert the settings plumb-through. `onRun` may return a
 * partial {@link RunResult} to override the default success — the post-freeze CR
 * validation spawns change-control.ts and a test simulates its verdict this way.
 */
function makeFakeSpawner(onRun: (options: RunOptions) => Partial<RunResult> | void = () => {}) {
  const calls = {
    run: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }>,
    spawnDetached: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv; cwd: string }>,
  }
  const spawner: Spawner = {
    spawnDetached: (options) => {
      calls.spawnDetached.push({ args: options.args, env: options.env, cwd: options.cwd })
      return { pid: 1 }
    },
    run: async (options): Promise<RunResult> => {
      calls.run.push({ args: options.args, env: options.env, cwd: options.cwd })
      const override = onRun(options) ?? {}
      return { code: 0, lastLine: "vivi turn: fake", stdout: "vivi turn: fake\n", stderr: "", ...override }
    },
    killGroup: () => true,
    isAlive: () => false,
  }
  return { spawner, calls }
}

/** Does a recorded run drive change-control.ts (the post-freeze CR validator)? */
function isChangeControlRun(args: string[]): boolean {
  return args.some((a) => a.endsWith("change-control.ts"))
}

/** Seed an active frozen baseline manifest so the target is in the post-freeze phase. */
function seedFrozenBaseline(root: string): void {
  const dir = path.join(root, ".vivicy", "baselines")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, "baseline-v1.0.0.json"),
    JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen" })
  )
}

/** A minimally well-formed CR body the change-control checker would accept. */
function wellFormedCr(id: string): string {
  return [
    "---",
    `id: ${id}`,
    "title: Add CSV export",
    "status: idea",
    "classification: minor_product_change",
    "created_at: 2026-07-03",
    "updated_at: 2026-07-03",
    "source: user",
    "owner_decision: pending",
    "owner_decision_by: null",
    "owner_decision_at: null",
    "owner_decision_evidence: null",
    "previous_baseline_id: null",
    "previous_baseline_version: null",
    "previous_baseline_manifest_path: null",
    "previous_document_set_hash: null",
    "previous_manifest_hash: null",
    "supersedes: []",
    "superseded_by: null",
    "---",
    "",
    `# ${id} - Add CSV export`,
    "",
    "## Idea",
    "",
    "The user asked to add CSV export.",
    "",
  ].join("\n")
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

/** Build a fake factory dir with the scripts the control plane resolves. The
 *  change-control stub only needs to EXIST — the fake spawner supplies its verdict, so a
 *  turn never launches a real Node validator. */
function scaffoldFactory(root: string) {
  mkdirSync(path.join(root, "prompts"), { recursive: true })
  writeFileSync(path.join(root, "vivi-turn.ts"), "// stub\n")
  writeFileSync(path.join(root, "change-control.ts"), "// stub\n")
  writeFileSync(path.join(root, "install-skills.ts"), "// stub\n")
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
const CHANGE_REQUESTS = path.join(".vivicy", "change-requests")

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

  it("ignores the leg's own transcript write and keeps the legit spike", async () => {
    // The real agent leg writes its transcript under .vivicy/development/transcripts/
    // (gitignored infrastructure). That must NOT be treated as an allowlist violation
    // — otherwise every real turn rolls back and destroys the spikes it just wrote.
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(SPIKES, "S01-native-argon2id.md"), "# S01\n")
      writeInTarget(
        targetRoot,
        path.join(".vivicy", "development", "transcripts", "VIVI-CHAT", "claude-vivi-abc.jsonl"),
        '{"type":"assistant"}\n'
      )
      writeReply(o, "Wrote 3 spikes.")
    })
    const result = await runViviTurn(spawner, { message: "start" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(SPIKES, "S01-native-argon2id.md")])
    // The spike SURVIVES (not rolled back), and the transcript is left in place.
    expect(existsSync(path.join(targetRoot, SPIKES, "S01-native-argon2id.md"))).toBe(true)
    expect(
      existsSync(path.join(targetRoot, ".vivicy", "development", "transcripts", "VIVI-CHAT", "claude-vivi-abc.jsonl"))
    ).toBe(true)
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

describe("runViviTurn — post-freeze (Change Requests, B8.1)", () => {
  it("accepts a well-formed CR under change-requests/ and reports it in `wrote`", async () => {
    seedFrozenBaseline(targetRoot)
    // The leg writes a valid CR; the change-control validator (second spawn) passes.
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) return { code: 0, stdout: "change-control: OK\n" }
      writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv-export.md"), wellFormedCr("CR-0001"))
      writeReply(o, "I drafted CR-0001 for CSV export.")
    })
    const result = await runViviTurn(spawner, { message: "Add CSV export to the reports." })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CHANGE_REQUESTS, "CR-0001-add-csv-export.md")])
    // The CR survives (a valid turn is never rolled back)...
    expect(existsSync(path.join(targetRoot, CHANGE_REQUESTS, "CR-0001-add-csv-export.md"))).toBe(true)
    // ...and change-control WAS consulted (the validator ran as its own spawn).
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(true)
  })

  it("REJECTS a canonical/spike write in the frozen phase and rolls it back", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "frozen original\n")
    // Post-freeze the canonical is locked: editing it (or writing a spike) is a violation.
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "TAMPERED after freeze\n")
      writeInTarget(targetRoot, path.join(SPIKES, "01-late-spike.md"), "# too late\n")
      writeReply(o, "I tried to edit the frozen spec.")
    })
    const result = await runViviTurn(spawner, { message: "Change the product doc." })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    // The canonical is restored byte-for-byte and the spike is gone.
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("frozen original\n")
    expect(existsSync(path.join(targetRoot, SPIKES, "01-late-spike.md"))).toBe(false)
    // A pure allowlist violation never even reaches the CR validator.
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(false)
  })

  it("REJECTS a malformed CR (change-control fails) and rolls the turn back", async () => {
    seedFrozenBaseline(targetRoot)
    // The leg writes a CR into the allowed dir, but its shape is bad: the validator's
    // second spawn returns non-zero, so the whole turn is rejected + rolled back.
    const { spawner } = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) {
        return { code: 1, stderr: "error:\nRule: cr_id_filename_match\n", lastLine: "change-control: FAILED with 1 error(s)" }
      }
      writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-broken.md"), "---\nid: CR-9999\n---\n# broken\n")
      writeReply(o, "Here is a change request.")
    })
    const result = await runViviTurn(spawner, { message: "Add a broken change." })

    expect(result.rejected).toMatch(/did not pass change-control/)
    expect(result.wrote).toEqual([])
    // The malformed CR is removed by the rollback.
    expect(existsSync(path.join(targetRoot, CHANGE_REQUESTS, "CR-0001-broken.md"))).toBe(false)
    expect((readTranscript(result.sessionId).at(-1) as ViviTurn).rejected).toBeTruthy()
  })

  it("fail-closed: a CR write is REJECTED when the change-control spawn throws", async () => {
    seedFrozenBaseline(targetRoot)
    // The validator spawn itself errors (not just a non-zero exit). Fail-closed: the turn
    // is rejected + rolled back rather than keeping an unproven CR.
    const spawner: Spawner = {
      spawnDetached: () => ({ pid: 1 }),
      run: async (options) => {
        if (isChangeControlRun(options.args)) throw new Error("boom: validator crashed")
        writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-x.md"), wellFormedCr("CR-0001"))
        writeReply(options, "drafted a CR")
        return { code: 0, lastLine: "", stdout: "", stderr: "" }
      },
      killGroup: () => true,
      isAlive: () => false,
    }
    const result = await runViviTurn(spawner, { message: "change something" })

    expect(result.rejected).toMatch(/did not pass change-control/)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, CHANGE_REQUESTS, "CR-0001-x.md"))).toBe(false)
  })

  it("threads spec_frozen + the next CR id into the leg's env and prompt", async () => {
    seedFrozenBaseline(targetRoot)
    // Seed one existing CR so the next id is CR-0002 (proves lib computes it, not the agent).
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-first.md"), wellFormedCr("CR-0001"))
    let seenPrompt = ""
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) return { code: 0 }
      seenPrompt = readFileSync(promptFileFrom(o.args), "utf8")
      writeReply(o, "ack")
    })
    await runViviTurn(spawner, { message: "hello" })

    const legRun = calls.run.find((c) => c.args.some((a) => a.endsWith("vivi-turn.ts")))
    expect(legRun?.env.VIVICY_SPEC_FROZEN).toBe("true")
    // The composed prompt announces the phase and the exact next id for the CR filename.
    expect(seenPrompt).toContain("spec_frozen: true")
    expect(seenPrompt).toContain("CR-0002")
  })

  it("pre-freeze threads spec_frozen: false (no baseline) and writes canonical as before", async () => {
    // No frozen baseline seeded: the phase is pre-freeze, so the flag is false and the
    // canonical write path is unchanged (requirement 1, made explicit for the flag).
    let seenPrompt = ""
    const { spawner, calls } = makeFakeSpawner((o) => {
      seenPrompt = readFileSync(promptFileFrom(o.args), "utf8")
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeReply(o, "wrote the product doc")
    })
    const result = await runViviTurn(spawner, { message: "start" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md")])
    expect(seenPrompt).toContain("spec_frozen: false")
    const legRun = calls.run.find((c) => c.args.some((a) => a.endsWith("vivi-turn.ts")))
    expect(legRun?.env.VIVICY_SPEC_FROZEN).toBe("false")
    // Pre-freeze never consults change-control (that gate is post-freeze only).
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(false)
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
    expect(call.args.some((a) => a.endsWith("vivi-turn.ts"))).toBe(true)
  })

  it("fails clearly when the vivi-turn script is missing", async () => {
    rmSync(path.join(factoryRoot, "vivi-turn.ts"))
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "ok"))
    await expect(runViviTurn(spawner, { message: "hi" })).rejects.toThrow(/not found/)
  })
})

/** Pull the `--prompt-file` path out of a recorded run's args. */
function promptFileFrom(args: string[]): string {
  const i = args.indexOf("--prompt-file")
  return args[i + 1]
}

/** A reply text ending with the persona's skills-install fenced block. */
function replyWithDirective(json: string): string {
  return `Sure, I will ask the control plane to install those.\n\n\`\`\`vivicy-skills\n${json}\n\`\`\``
}

describe("parseSkillsDirective — pure parser", () => {
  it("returns null when the reply carries no vivicy-skills block", () => {
    expect(parseSkillsDirective("just a normal reply")).toBeNull()
    expect(parseSkillsDirective("```json\n{\"install\": [\"a\"]}\n```")).toBeNull()
  })

  it("parses a strict install list, trimming ids", () => {
    const directive = parseSkillsDirective(
      replyWithDirective('{"install": ["anthropic/skills@pdf", " https://skills.sh/acme/repo/scraper "]}')
    )
    expect(directive).toEqual({ ids: ["anthropic/skills@pdf", "https://skills.sh/acme/repo/scraper"] })
  })

  it("flags invalid JSON as malformed instead of throwing", () => {
    const directive = parseSkillsDirective(replyWithDirective('{"install": ["a",]}'))
    expect(directive).toEqual({ malformed: "the vivicy-skills block is not valid JSON" })
  })

  it("flags a wrong shape (no install array / empty list) as malformed", () => {
    expect(parseSkillsDirective(replyWithDirective('{"skills": ["a"]}'))).toMatchObject({
      malformed: expect.stringContaining('{"install":'),
    })
    expect(parseSkillsDirective(replyWithDirective('{"install": []}'))).toMatchObject({
      malformed: expect.stringContaining("at least one id"),
    })
  })

  it("flags non-string or empty entries as malformed (never a partial install)", () => {
    expect(parseSkillsDirective(replyWithDirective('{"install": ["ok", 5]}'))).toEqual({
      malformed: "the vivicy-skills block must list only non-empty string ids",
    })
    expect(parseSkillsDirective(replyWithDirective('{"install": ["ok", "  "]}'))).toEqual({
      malformed: "the vivicy-skills block must list only non-empty string ids",
    })
  })
})

describe("runViviTurn — skills directive (explicit installs via chat)", () => {
  it("starts an explicit skills install and appends the status line to the reply", async () => {
    const { spawner, calls } = makeFakeSpawner((o) =>
      writeReply(o, replyWithDirective('{"install": ["anthropic/skills@pdf"]}'))
    )
    const result = await runViviTurn(spawner, { message: "install the pdf skill please" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toContain("skills install started (explicit mode)")
    // The control plane spawned install-skills.ts DETACHED with the exact ids.
    expect(calls.spawnDetached).toHaveLength(1)
    const spawn = calls.spawnDetached[0]
    expect(spawn.args.some((a) => a.endsWith("install-skills.ts"))).toBe(true)
    expect(spawn.args).toContain("--ids")
    expect(spawn.args[spawn.args.indexOf("--ids") + 1]).toBe("anthropic/skills@pdf")
    expect(spawn.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    // The augmented reply (with the status line) is what the transcript records.
    expect((readTranscript(result.sessionId).at(-1) as ViviTurn).text).toContain("skills install started")
  })

  it("appends an honest note on a malformed block without rejecting the turn", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeReply(o, replyWithDirective("not json at all"))
    })
    const result = await runViviTurn(spawner, { message: "install something" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md")]) // the turn's writes survive
    expect(result.reply).toContain("skills install NOT started: the vivicy-skills block is not valid JSON")
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("surfaces a control refusal instead of the started line (missing installer script)", async () => {
    rmSync(path.join(factoryRoot, "install-skills.ts"))
    const { spawner, calls } = makeFakeSpawner((o) =>
      writeReply(o, replyWithDirective('{"install": ["acme/repo@x"]}'))
    )
    const result = await runViviTurn(spawner, { message: "install acme/repo@x" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toContain("skills install NOT started:")
    expect(result.reply).toContain("install-skills.ts")
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("never acts on a directive carried by a REJECTED turn", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(".vivicy", "development", "issues", "sneaky.md"), "no\n")
      writeReply(o, replyWithDirective('{"install": ["acme/repo@x"]}'))
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.reply).not.toContain("skills install started")
    expect(calls.spawnDetached).toHaveLength(0)
  })
})
