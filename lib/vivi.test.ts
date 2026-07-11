import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ControlError, type RunOptions, type RunResult, type Spawner } from "@/lib/control"
import { UPLOADS_DIR, type RawEntry } from "@/lib/import-docs"
import { appendCardTurn, decideCardAction, decideCardImport, listViviSessions, parseSkillsDirective, readTranscript, runViviTurn, seedViviWelcome, VIVI_WELCOME_MESSAGE, WELCOME_IMPORT_CARD, type ViviTurn } from "@/lib/vivi"

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

function isChangeControlRun(args: string[]): boolean {
  return args.some((a) => a.endsWith("change-control.ts"))
}

function seedFrozenBaseline(root: string): void {
  const dir = path.join(root, ".vivicy", "baselines")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, "baseline-v1.0.0.json"),
    JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen" })
  )
}

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

function replyFileFrom(args: string[]): string {
  const i = args.indexOf("--reply-file")
  return args[i + 1]
}

function writeReply(options: RunOptions, text: string): void {
  const file = replyFileFrom(options.args)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

function writeInTarget(targetRoot: string, rel: string, body: string): void {
  const abs = path.join(targetRoot, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

let factoryRoot: string
let targetRoot: string
let runtimeDir: string
let prevCwd: string

function scaffoldFactory(root: string) {
  mkdirSync(path.join(root, "prompts"), { recursive: true })
  writeFileSync(path.join(root, "vivi-turn.ts"), "// stub\n")
  writeFileSync(path.join(root, "change-control.ts"), "// stub\n")
  writeFileSync(path.join(root, "install-skills.ts"), "// stub\n")
  writeFileSync(path.join(root, "dev-loop-supervised.ts"), "// stub\n")
  writeFileSync(path.join(root, "prompts", "vivi.md"), "# Vivi persona (test stub)\n")
}

function gitInit(root: string): void {
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" })
  git("init", "-q")
  git("config", "user.email", "test@vivicy.local")
  git("config", "user.name", "Vivicy Test")
  git("commit", "--allow-empty", "-q", "-m", "init")
}

function gitCommitFile(root: string, rel: string, body: string): void {
  writeInTarget(root, rel, body)
  execFileSync("git", ["add", "--", rel], { cwd: root, stdio: "ignore" })
  execFileSync("git", ["commit", "-q", "-m", `add ${rel}`], { cwd: root, stdio: "ignore" })
}

beforeEach(() => {
  factoryRoot = mkdtempSync(path.join(tmpdir(), "vivi-factory-"))
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivi-target-"))
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivi-runtime-"))
  scaffoldFactory(factoryRoot)
  mkdirSync(path.join(targetRoot, ".vivicy", "canonical"), { recursive: true })
  mkdirSync(path.join(targetRoot, ".vivicy", "development", "spikes"), { recursive: true })
  gitInit(targetRoot)

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
    await expect(runViviTurn(spawner, { message: "hi" })).rejects.toThrow(/no project selected/)
  })

  it("uses per-turn scratch files so concurrent turns on one session never collide", async () => {
    const sessionId = "22222222-2222-2222-2222-222222222222"
    const seenPromptFiles = new Set<string>()
    const seenReplyFiles = new Set<string>()
    const onRun = (o: RunOptions) => {
      const replyFile = replyFileFrom(o.args)
      seenPromptFiles.add(promptFileFrom(o.args))
      seenReplyFiles.add(replyFile)
      writeReply(o, `reply@${path.basename(replyFile)}`)
    }
    const a = makeFakeSpawner(onRun)
    const b = makeFakeSpawner(onRun)

    const [ra, rb] = await Promise.all([
      runViviTurn(a.spawner, { sessionId, message: "ALPHA" }),
      runViviTurn(b.spawner, { sessionId, message: "BETA" }),
    ])

    expect(seenPromptFiles.size).toBe(2)
    expect(seenReplyFiles.size).toBe(2)
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
    expect(existsSync(path.join(targetRoot, CANONICAL, "01-product.md"))).toBe(true)
    const turns = readTranscript(result.sessionId)
    expect((turns.at(-1) as ViviTurn).wrote).toEqual(result.wrote)
  })

  it("ignores the leg's own transcript write and keeps the legit spike", async () => {
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
    expect(existsSync(path.join(targetRoot, SPIKES, "S01-native-argon2id.md"))).toBe(true)
    expect(
      existsSync(path.join(targetRoot, ".vivicy", "development", "transcripts", "VIVI-CHAT", "claude-vivi-abc.jsonl"))
    ).toBe(true)
  })

  it("rejects a write OUTSIDE the allowlist and REMOVES the offending file", async () => {
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "original\n")

    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "TAMPERED\n")
      writeInTarget(targetRoot, path.join(".vivicy", "development", "issues", "sneaky.md"), "no\n")
      writeReply(o, "I tried to escape.")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "issues", "sneaky.md"))).toBe(false)
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("original\n")
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
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "02-good.md"), "# Good\n")
      writeInTarget(targetRoot, path.join(".vivicy", "baselines", "forged.md"), "# forged a baseline\n")
      writeReply(o, "mixed")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, ".vivicy", "baselines", "forged.md"))).toBe(false)
    expect(existsSync(path.join(targetRoot, CANONICAL, "02-good.md"))).toBe(false)
  })
})

describe("runViviTurn — post-freeze (Change Requests, B8.1)", () => {
  it("accepts a well-formed CR under change-requests/ and reports it in `wrote`", async () => {
    seedFrozenBaseline(targetRoot)
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) return { code: 0, stdout: "change-control: OK\n" }
      writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv-export.md"), wellFormedCr("CR-0001"))
      writeReply(o, "I drafted CR-0001 for CSV export.")
    })
    const result = await runViviTurn(spawner, { message: "Add CSV export to the reports." })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CHANGE_REQUESTS, "CR-0001-add-csv-export.md")])
    expect(existsSync(path.join(targetRoot, CHANGE_REQUESTS, "CR-0001-add-csv-export.md"))).toBe(true)
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(true)
  })

  it("REJECTS a canonical/spike write in the frozen phase and rolls it back", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "frozen original\n")
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "TAMPERED after freeze\n")
      writeInTarget(targetRoot, path.join(SPIKES, "01-late-spike.md"), "# too late\n")
      writeReply(o, "I tried to edit the frozen spec.")
    })
    const result = await runViviTurn(spawner, { message: "Change the product doc." })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.wrote).toEqual([])
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("frozen original\n")
    expect(existsSync(path.join(targetRoot, SPIKES, "01-late-spike.md"))).toBe(false)
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(false)
  })

  it("REJECTS a malformed CR (change-control fails) and rolls the turn back", async () => {
    seedFrozenBaseline(targetRoot)
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
    expect(existsSync(path.join(targetRoot, CHANGE_REQUESTS, "CR-0001-broken.md"))).toBe(false)
    expect((readTranscript(result.sessionId).at(-1) as ViviTurn).rejected).toBeTruthy()
  })

  it("fail-closed: a CR write is REJECTED when the change-control spawn throws", async () => {
    seedFrozenBaseline(targetRoot)
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
    expect(seenPrompt).toContain("spec_frozen: true")
    expect(seenPrompt).toContain("CR-0002")
  })

  it("pre-freeze threads spec_frozen: false (no baseline) and writes canonical as before", async () => {
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
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(false)
  })
})

describe("runViviTurn — settings plumb-through", () => {
  it("passes the configured CLI + model env and cwd=target to the leg", async () => {
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

function promptFileFrom(args: string[]): string {
  const i = args.indexOf("--prompt-file")
  return args[i + 1]
}

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

function replyWithActions(json: string, lead = "On it."): string {
  return `${lead}\n\n\`\`\`vivicy-action\n${json}\n\`\`\``
}

function legRuns(calls: { run: Array<{ args: string[] }> }): Array<{ args: string[] }> {
  return calls.run.filter((c) => c.args.some((a) => a.endsWith("vivi-turn.ts")))
}

describe("runViviTurn — action protocol (the governess loop)", () => {
  afterEach(() => {
    delete process.env.VIVICY_VIVI_MAX_ROUNDS
  })

  it("executes a batch, feeds the results back, and closes on the follow-up round", async () => {
    let leg = 0
    let continuationPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
      } else {
        continuationPrompt = readFileSync(promptFileFrom(o.args), "utf8")
        writeReply(o, "No change requests are on file yet — nothing waits on you.")
      }
    })
    const result = await runViviTurn(spawner, { message: "où en sont les CRs ?" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toBe("No change requests are on file yet — nothing waits on you.")
    expect(result.actions).toHaveLength(1)
    expect(result.actions?.[0]).toMatchObject({ tool: "crs.list", ok: true })
    expect(leg).toBe(2)

    expect(continuationPrompt).toContain("Tool results")
    expect(continuationPrompt).toContain("✓ crs.list")
    expect(continuationPrompt).toContain("close the loop")

    const turns = readTranscript(result.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "vivi", "action", "vivi"])
    expect(turns[1].text).toBe("On it.")
    expect(turns[1].text).not.toContain("vivicy-action")
    expect(turns[2].actions?.[0]).toMatchObject({ tool: "crs.list", ok: true })
  })

  it("executes a real control side effect through the SAME spawner (pipeline.start)", async () => {
    let leg = 0
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      writeReply(o, leg === 1 ? replyWithActions('{"actions": [{"tool": "pipeline.start"}]}') : "The build is running.")
    })
    const result = await runViviTurn(spawner, { message: "lance le build" })

    expect(result.actions?.[0]).toMatchObject({ tool: "pipeline.start", ok: true })
    expect(calls.spawnDetached.some((c) => c.args.some((a) => a.endsWith("dev-loop-supervised.ts")))).toBe(true)
  })

  it("appends an honest note on a malformed action block without executing or rejecting", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeReply(o, replyWithActions("not json"))
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toBeUndefined()
    expect(result.actions).toBeUndefined()
    expect(result.reply).toContain("no action executed: the vivicy-action block is not valid JSON")
    expect(legRuns(calls)).toHaveLength(1)
  })

  it("stops at the bounded round limit and reports the results honestly", async () => {
    process.env.VIVICY_VIVI_MAX_ROUNDS = "2"
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
    })
    const result = await runViviTurn(spawner, { message: "spin" })

    expect(legRuns(calls)).toHaveLength(2)
    expect(result.actions).toHaveLength(2)
    expect(result.reply).toContain("action round limit (2) reached")
    expect(result.reply).toContain("✓ crs.list")
  })

  it("clamps an invalid VIVICY_VIVI_MAX_ROUNDS to the default", async () => {
    process.env.VIVICY_VIVI_MAX_ROUNDS = "banana"
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      writeReply(o, leg === 1 ? replyWithActions('{"actions": [{"tool": "crs.list"}]}') : "done")
    })
    const result = await runViviTurn(spawner, { message: "go" })
    expect(result.reply).toBe("done")
    expect(leg).toBe(2)
  })

  it("a violation on the follow-up round rejects the WHOLE turn's writes but keeps executed actions honest", async () => {
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "original\n")
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "round-one edit\n")
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
      } else {
        writeInTarget(targetRoot, path.join(".vivicy", "baselines", "forged.md"), "no\n")
        writeReply(o, "oops")
      }
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.rejected).toMatch(/1 action\(s\) already executed this turn remain in effect/)
    expect(result.wrote).toEqual([])
    expect(result.actions).toHaveLength(1)
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("original\n")
    expect(existsSync(path.join(targetRoot, ".vivicy", "baselines", "forged.md"))).toBe(false)
  })

  it("accumulates writes across rounds in `wrote` and per-round on the transcript", async () => {
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeInTarget(targetRoot, path.join(CANONICAL, "01-a.md"), "# A\n")
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
      } else {
        writeInTarget(targetRoot, path.join(CANONICAL, "02-b.md"), "# B\n")
        writeReply(o, "wrote the second area")
      }
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-a.md"), path.join(CANONICAL, "02-b.md")])
    const turns = readTranscript(result.sessionId)
    expect(turns[1].wrote).toEqual([path.join(CANONICAL, "01-a.md")])
    expect((turns.at(-1) as ViviTurn).wrote).toEqual([path.join(CANONICAL, "02-b.md")])
  })

  it("the prompt carries the deterministic pipeline snapshot line", async () => {
    let seenPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      seenPrompt = readFileSync(promptFileFrom(o.args), "utf8")
      writeReply(o, "ok")
    })
    await runViviTurn(spawner, { message: "hello" })
    expect(seenPrompt).toContain("Pipeline snapshot: run_active=false; extraction=never; skills=never; spec_frozen=false; spec_kind=project.")
  })
})

describe("runViviTurn — whole-target no-code enforcement", () => {
  it("rejects a net-new code file outside .vivicy, removes it, and rolls the turn back", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join("src", "index.ts"), "console.log('sneaky')\n")
      writeInTarget(targetRoot, path.join(CANONICAL, "01-a.md"), "# A\n")
      writeReply(o, "I implemented it for you.")
    })
    const result = await runViviTurn(spawner, { message: "build it" })

    expect(result.rejected).toMatch(/code writes are forbidden \(src\/index\.ts\)/)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, "src", "index.ts"))).toBe(false)
    expect(existsSync(path.join(targetRoot, CANONICAL, "01-a.md"))).toBe(false)
  })

  it("rejects an edit to a committed product file and restores its committed bytes", async () => {
    gitCommitFile(targetRoot, "README.md", "# The product\n")
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, "README.md", "# Vandalized\n")
      writeReply(o, "I improved the README.")
    })
    const result = await runViviTurn(spawner, { message: "touch the readme" })

    expect(result.rejected).toMatch(/code writes are forbidden \(README\.md\)/)
    expect(readFileSync(path.join(targetRoot, "README.md"), "utf8")).toBe("# The product\n")
  })

  it("never touches the owner's OWN pre-turn dirty files (not Vivi's writes)", async () => {
    gitCommitFile(targetRoot, path.join("src", "wip.ts"), "export const a = 1\n")
    writeInTarget(targetRoot, path.join("src", "wip.ts"), "export const a = 2 // wip\n")

    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-a.md"), "# A\n")
      writeReply(o, "Wrote the first area.")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toBe("Wrote the first area.")
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-a.md")])
    expect(readFileSync(path.join(targetRoot, "src", "wip.ts"), "utf8")).toBe("export const a = 2 // wip\n")
  })

  it("appends a LOUD note (and still enforces .vivicy) when the target has no git", async () => {
    const bareTarget = mkdtempSync(path.join(tmpdir(), "vivi-bare-"))
    mkdirSync(path.join(bareTarget, ".vivicy", "canonical"), { recursive: true })
    process.env.VIVICY_TARGET_ROOT = bareTarget
    try {
      const { spawner } = makeFakeSpawner((o) => {
        writeInTarget(bareTarget, path.join(CANONICAL, "01-a.md"), "# A\n")
        writeReply(o, "Wrote the first area.")
      })
      const result = await runViviTurn(spawner, { message: "go" })

      expect(result.rejected).toBeUndefined()
      expect(result.reply).toContain("Wrote the first area.")
      expect(result.reply).toContain("no usable git repository")
      expect(result.wrote).toEqual([path.join(CANONICAL, "01-a.md")])
    } finally {
      process.env.VIVICY_TARGET_ROOT = targetRoot
      rmSync(bareTarget, { recursive: true, force: true })
    }
  })

  it("catches a code write on a FOLLOW-UP action round too", async () => {
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
      } else {
        writeInTarget(targetRoot, path.join("app", "hack.tsx"), "export default null\n")
        writeReply(o, "also wrote a component")
      }
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/code writes are forbidden \(app\/hack\.tsx\)/)
    expect(existsSync(path.join(targetRoot, "app", "hack.tsx"))).toBe(false)
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
    expect(calls.spawnDetached).toHaveLength(1)
    const spawn = calls.spawnDetached[0]
    expect(spawn.args.some((a) => a.endsWith("install-skills.ts"))).toBe(true)
    expect(spawn.args).toContain("--ids")
    expect(spawn.args[spawn.args.indexOf("--ids") + 1]).toBe("anthropic/skills@pdf")
    expect(spawn.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    expect((readTranscript(result.sessionId).at(-1) as ViviTurn).text).toContain("skills install started")
  })

  it("appends an honest note on a malformed block without rejecting the turn", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeReply(o, replyWithDirective("not json at all"))
    })
    const result = await runViviTurn(spawner, { message: "install something" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md")])
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

describe("decision cards (server contracts)", () => {
  it("appendCardTurn mints a session; decideCardAction executes a control action, stamps, and refuses a second decide", async () => {
    const sessionId = appendCardTurn({
      id: "card-1",
      title: "Où en est le build ?",
      actions: [{ id: "list", label: "List the CRs", action: { kind: "control", tool: "crs.list" } }],
    })
    expect(readTranscript(sessionId).map((t) => t.role)).toEqual(["card"])

    const { spawner } = makeFakeSpawner()
    const result = await decideCardAction(spawner, { sessionId, cardId: "card-1", actionId: "list" })

    expect(result.ok).toBe(true)
    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["card", "action"])
    expect(turns[0].decided?.actionId).toBe("list")
    expect(turns[0].decided?.summary).toContain("change request")
    expect(turns[1].actions?.[0]).toMatchObject({ tool: "crs.list", ok: true })

    const again = await decideCardAction(spawner, { sessionId, cardId: "card-1", actionId: "list" })
    expect(again.ok).toBe(false)
    expect(again.summary).toContain("already decided")
  })

  it("refuses an unknown card or action id loudly", async () => {
    const sessionId = appendCardTurn({
      id: "card-2",
      title: "T",
      actions: [{ id: "a", label: "A", action: { kind: "dismiss" } }],
    })
    const { spawner } = makeFakeSpawner()
    await expect(decideCardAction(spawner, { sessionId, cardId: "ghost", actionId: "a" })).rejects.toThrow(/unknown card/)
    await expect(decideCardAction(spawner, { sessionId, cardId: "card-2", actionId: "ghost" })).rejects.toThrow(/unknown action/)
  })

  it("dismiss records the choice and does nothing else", async () => {
    const sessionId = appendCardTurn({
      id: "card-3",
      title: "T",
      actions: [{ id: "no", label: "Not now", variant: "outline", action: { kind: "dismiss" } }],
    })
    const { spawner, calls } = makeFakeSpawner()
    const result = await decideCardAction(spawner, { sessionId, cardId: "card-3", actionId: "no" })
    expect(result).toMatchObject({ ok: true, summary: "dismissed" })
    expect(calls.run).toHaveLength(0)
    expect(calls.spawnDetached).toHaveLength(0)
    expect(readTranscript(sessionId)).toHaveLength(1)
  })

  it("vivi_message sends the prepared message as a REAL turn on the same session", async () => {
    const sessionId = appendCardTurn({
      id: "card-4",
      title: "Start a new project?",
      actions: [{ id: "go", label: "Start from scratch", action: { kind: "vivi_message", message: "I want to start a new project from scratch." } }],
    })
    const { spawner } = makeFakeSpawner((o) => {
      if (o.args.some((a) => a.endsWith("vivi-turn.ts"))) writeReply(o, "Great — let's define the product. First questions: …")
    })
    const result = await decideCardAction(spawner, { sessionId, cardId: "card-4", actionId: "go" })

    expect(result.ok).toBe(true)
    expect(result.reply?.reply).toContain("let's define the product")
    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["card", "user", "vivi"])
    expect(turns[0].decided?.actionId).toBe("go")
    expect(turns[1].text).toBe("I want to start a new project from scratch.")
  })

  it("cr_decide records the owner decision as owner:vivi-ui (P2 — the click is the human touchpoint)", async () => {
    const sessionId = appendCardTurn({
      id: "card-5",
      title: "CR-0007 — add CSV export",
      body: "Approve or reject this change request.",
      actions: [
        { id: "approve", label: "Approve", action: { kind: "cr_decide", crId: "CR-0007", decision: "approved" } },
        { id: "reject", label: "Reject", variant: "destructive", action: { kind: "cr_decide", crId: "CR-0007", decision: "rejected" } },
      ],
    })
    let decideArgs: string[] = []
    const { spawner } = makeFakeSpawner((o) => {
      if (o.args.some((a) => a.endsWith("change-control.ts"))) {
        decideArgs = o.args
        return { code: 0, stdout: '{"ok":true,"status":"rejected"}\n' }
      }
    })
    const result = await decideCardAction(spawner, { sessionId, cardId: "card-5", actionId: "reject" })

    expect(result.ok).toBe(true)
    expect(decideArgs).toContain("decide")
    expect(decideArgs[decideArgs.indexOf("--by") + 1]).toBe("owner:vivi-ui")
    const turns = readTranscript(sessionId)
    expect(turns[0].decided?.actionId).toBe("reject")
    expect(turns.at(-1)?.text).toContain("cr.decide")
  })

  it("refuses to decide an import_docs action on the JSON path (it needs the upload route)", async () => {
    const sessionId = appendCardTurn(WELCOME_IMPORT_CARD)
    const { spawner } = makeFakeSpawner()
    await expect(
      decideCardAction(spawner, { sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import" })
    ).rejects.toThrow(/imports documents/)
    // Nothing stamped — the card stays live for the upload path.
    expect(readTranscript(sessionId)[0].decided).toBeUndefined()
  })
})

const IMPORT_ENGLISH =
  "The quick brown fox jumps over the lazy dog near the riverbank every single morning without fail. ".repeat(6)

function docEntry(rel: string, text: string): RawEntry {
  return { rel, name: path.basename(rel), bytes: new Uint8Array(Buffer.from(text, "utf8")) }
}

describe("decideCardImport (welcome-card document import into the current project)", () => {
  it("imports the batch, appends a deterministic Vivi acknowledgment, and stamps the card decided", () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)

    const result = decideCardImport({
      sessionId,
      cardId: WELCOME_IMPORT_CARD.id,
      actionId: "import",
      entries: [docEntry("brief.md", IMPORT_ENGLISH), docEntry("data.csv", "a,b\n1,2\n"), docEntry("skip.exe", "x")],
    })

    expect(result.ok).toBe(true)
    expect(result.language).toBe("eng")
    expect(result.accepted?.map((f) => f.path).sort()).toEqual(["brief.md", "data.csv"])
    expect(result.rejected).toEqual([{ path: "skip.exe", code: "unsupported_type" }])
    expect(result.summary).toBe("2 documents imported · English · 1 skipped")

    const batchDir = path.join(targetRoot, UPLOADS_DIR, result.batchId!)
    expect(existsSync(path.join(batchDir, "brief.md"))).toBe(true)
    expect(existsSync(path.join(batchDir, "manifest.json"))).toBe(true)

    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "card", "vivi"])
    expect(turns[1].decided?.actionId).toBe("import")
    expect(turns[1].decided?.summary).toBe(result.summary)
    expect(turns[2].text).toContain("2 documents")
    expect(turns[2].text).toContain("English")
    expect(turns[2].text).toMatch(/what are you building/i)
  })

  it("names a single document and omits the language clause when nothing is scannable", () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    const result = decideCardImport({
      sessionId,
      cardId: WELCOME_IMPORT_CARD.id,
      actionId: "import",
      entries: [docEntry("scan.pdf", "%PDF-1.4 binary-ish")],
    })
    expect(result.summary).toBe("1 document imported")
    const ack = readTranscript(sessionId).at(-1)!.text
    expect(ack).toContain("1 document is now in the kitchen")
    expect(ack).not.toContain(", in ")
  })

  it("refuses a second import (the card is already decided) and refuses a non-import action", () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    decideCardImport({ sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import", entries: [docEntry("a.md", IMPORT_ENGLISH)] })

    const again = decideCardImport({ sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import", entries: [docEntry("b.md", IMPORT_ENGLISH)] })
    expect(again.ok).toBe(false)
    expect(again.summary).toContain("already decided")

    const controlSession = appendCardTurn({
      id: "control-card",
      title: "T",
      actions: [{ id: "list", label: "List", action: { kind: "control", tool: "crs.list" } }],
    })
    expect(() =>
      decideCardImport({ sessionId: controlSession, cardId: "control-card", actionId: "list", entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    ).toThrow(/not a document import/)
  })

  it("leaves the card undecided when the upload has no supported file, so the owner can retry", () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    expect(() =>
      decideCardImport({ sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import", entries: [docEntry("a.exe", "x")] })
    ).toThrow(expect.objectContaining({ code: "no_supported_files" }))

    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "card"])
    expect(turns[1].decided).toBeUndefined()
    expect(existsSync(path.join(targetRoot, UPLOADS_DIR))).toBe(false)
  })
})

describe("seedViviWelcome (deterministic first turn)", () => {
  it("mints a session with a single persisted vivi welcome turn and surfaces it in the rehydration index", () => {
    const sessionId = seedViviWelcome()
    expect(sessionId).toMatch(/[0-9a-f-]{36}/)

    const turns = readTranscript(sessionId)
    expect(turns).toHaveLength(1)
    expect(turns[0]).toMatchObject({ role: "vivi", text: VIVI_WELCOME_MESSAGE })
    expect(turns[0].ts).toBeTruthy()

    // Persists like any real transcript message — a fresh read (what rehydration does) returns it.
    expect(readTranscript(sessionId)).toEqual(turns)
    const listed = listViviSessions().find((s) => s.sessionId === sessionId)
    expect(listed?.turns).toBe(1)
    expect(listed?.preview).toContain("I'm Vivi")
  })

  it("appends a decision card onto the seeded welcome session (the card ride-along seam)", () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(
      {
        id: "welcome-card",
        title: "Pick a stack",
        actions: [{ id: "no", label: "Later", variant: "outline", action: { kind: "dismiss" } }],
      },
      sessionId
    )
    expect(readTranscript(sessionId).map((t) => t.role)).toEqual(["vivi", "card"])
  })
})

describe("listViviSessions (rehydration index)", () => {
  it("lists sessions newest-first with a human preview", async () => {
    const a = makeFakeSpawner((o) => writeReply(o, "reply A"))
    const first = await runViviTurn(a.spawner, { message: "First project conversation" })
    await new Promise((r) => setTimeout(r, 5))
    const b = makeFakeSpawner((o) => writeReply(o, "reply B"))
    const second = await runViviTurn(b.spawner, { message: "Second conversation about billing" })

    const sessions = listViviSessions()
    expect(sessions.map((s) => s.sessionId)).toEqual([second.sessionId, first.sessionId])
    expect(sessions[0].preview).toContain("Second conversation")
    expect(sessions[0].turns).toBe(2)
    expect(sessions[0].updated_at).toBeTruthy()
  })
})

describe("runViviTurn — drafting spec cycle", () => {
  it("an OPEN cycle reopens the pre-freeze allowlist on a frozen target", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(
      targetRoot,
      path.join(".vivicy", "development", "reports", "spec-cycle.json"),
      JSON.stringify({ status: "drafting", kind: "feature", id: "cycle-x", opened_at: "t", opened_by: "owner:test" })
    )
    let seenPrompt = ""
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      seenPrompt = readFileSync(promptFileFrom(o.args), "utf8")
      writeInTarget(targetRoot, path.join(CANONICAL, "07-new-feature.md"), "# New feature\n")
      writeReply(o, "Captured the new feature area.")
    })
    const result = await runViviTurn(spawner, { message: "add the export feature to the spec" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "07-new-feature.md")])
    expect(seenPrompt).toContain("spec_frozen: false")
    expect(calls.run.some((c) => isChangeControlRun(c.args))).toBe(false)
  })
})

describe("runViviTurn — action side effects are orchestrator state, never Vivi's writes", () => {
  it("cycle.open's state file SURVIVES the follow-up round (no false rejection, no rollback)", async () => {
    seedFrozenBaseline(targetRoot)
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) writeReply(o, replyWithActions('{"actions": [{"tool": "cycle.open"}]}'))
      else writeReply(o, "The drafting cycle is open — tell me what the feature should do.")
    })
    const result = await runViviTurn(spawner, { message: "open a feature cycle" })

    expect(result.rejected).toBeUndefined()
    expect(result.actions?.[0]).toMatchObject({ tool: "cycle.open", ok: true })
    expect(leg).toBe(2)
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "reports", "spec-cycle.json"))).toBe(true)
  })

  it("detects Vivi tampering with the OWNER's pre-turn dirty file and restores the owner's bytes", async () => {
    gitCommitFile(targetRoot, path.join("src", "wip.ts"), "export const a = 1\n")
    writeInTarget(targetRoot, path.join("src", "wip.ts"), "export const a = 2 // owner wip\n")

    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join("src", "wip.ts"), "export const a = 666 // vivi was here\n")
      writeReply(o, "tweaked your file")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/modified your uncommitted work in progress \(src\/wip\.ts\)/)
    expect(readFileSync(path.join(targetRoot, "src", "wip.ts"), "utf8")).toBe("export const a = 2 // owner wip\n")
  })

  it("a .gitignore self-hiding write is cleaned up in the second pass", async () => {
    gitCommitFile(targetRoot, ".gitignore", "node_modules\n")
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, ".gitignore", "node_modules\nsrc/evil.ts\n")
      writeInTarget(targetRoot, path.join("src", "evil.ts"), "export const pwned = true\n")
      writeReply(o, "nothing to see")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toBeTruthy()
    expect(readFileSync(path.join(targetRoot, ".gitignore"), "utf8")).toBe("node_modules\n")
    expect(existsSync(path.join(targetRoot, "src", "evil.ts"))).toBe(false)
  })
})

describe("runViviTurn — pending CRs become in-chat decision cards", () => {
  it("appends one card per pending CR after a crs.list action, idempotently", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv.md"), wellFormedCr("CR-0001"))
    let leg = 0
    const onRun = (o: RunOptions) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      writeReply(o, leg % 2 === 1 ? replyWithActions('{"actions": [{"tool": "crs.list"}]}') : "Here are your pending CRs.")
    }
    const first = makeFakeSpawner(onRun)
    const result = await runViviTurn(first.spawner, { message: "des CRs en attente ?" })

    const turns = readTranscript(result.sessionId)
    const cards = turns.filter((t) => t.role === "card")
    expect(cards).toHaveLength(1)
    expect(cards[0].card).toMatchObject({ id: "cr-CR-0001", title: expect.stringContaining("CR-0001") })
    expect(cards[0].card?.actions.map((a) => a.id)).toEqual(["approve", "reject", "later"])
    expect(cards[0].card?.actions[0].action).toEqual({ kind: "cr_decide", crId: "CR-0001", decision: "approved" })

    const second = makeFakeSpawner(onRun)
    await runViviTurn(second.spawner, { sessionId: result.sessionId, message: "re-liste" })
    const after = readTranscript(result.sessionId).filter((t) => t.role === "card")
    expect(after).toHaveLength(1)
  })
})
