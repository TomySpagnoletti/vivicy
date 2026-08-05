import { execFileSync, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ControlError, type RunOptions, type RunResult, type Spawner } from "@/lib/control"
import { importIntoGoverned, UPLOADS_DIR, type BatchResult, type RawEntry } from "@/lib/import-docs"
import { nodeSpawner } from "@/lib/node-spawner"
import { getProjectRuntimeDir } from "@/lib/project-runtime"
import {
  answerViviQuestion,
  appendCardTurn,
  decideCardAction,
  decideCardImport,
  dispatchImportRead,
  importDocsIntoSession,
  isViviTurnRunning,
  listViviSessions,
  parseSkillsDirective,
  readTranscript,
  recoverInterruptedReads,
  runViviTurn,
  seedViviWelcome,
  VIVI_WELCOME_MESSAGE,
  WELCOME_IMPORT_CARD,
  type SessionImportResult,
  type ViviTurn,
} from "@/lib/vivi"
import { MAX_OTHER_ANSWER_LENGTH, remainingQuestions } from "@/lib/vivi-questions"

// Captured at module load: every test body runs after beforeEach has chdir'd away from the repo.
const REPO_ROOT = process.cwd()

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

// A pid nothing can be alive under: the child is awaited to its exit before its number is used.
async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise((resolve) => child.on("exit", resolve))
  return child.pid as number
}

function writeInTarget(targetRoot: string, rel: string, body: string): void {
  const abs = path.join(targetRoot, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
}

let factoryRoot: string
let targetRoot: string
let appCwd: string
let scratchRoot: string
let prevCwd: string
let prevTmpdir: string | undefined

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
  appCwd = mkdtempSync(path.join(tmpdir(), "vivi-app-cwd-"))
  scratchRoot = mkdtempSync(path.join(tmpdir(), "vivi-scratch-root-"))
  prevTmpdir = process.env.TMPDIR
  process.env.TMPDIR = scratchRoot
  scaffoldFactory(factoryRoot)
  mkdirSync(path.join(targetRoot, ".vivicy", "canonical"), { recursive: true })
  mkdirSync(path.join(targetRoot, ".vivicy", "development", "spikes"), { recursive: true })
  gitInit(targetRoot)

  process.env.VIVICY_FACTORY_ROOT = factoryRoot
  process.env.VIVICY_TARGET_ROOT = targetRoot
  delete process.env.VIVICY_RUNTIME_DIR

  prevCwd = process.cwd()
  process.chdir(appCwd)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = prevTmpdir
  for (const dir of [factoryRoot, targetRoot, appCwd, scratchRoot]) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.VIVICY_FACTORY_ROOT
  delete process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_RUNTIME_DIR
})

const CANONICAL = path.join(".vivicy", "canonical")
const SPIKES = path.join(".vivicy", "development", "spikes")
const CHANGE_REQUESTS = path.join(".vivicy", "change-requests")
const RUNTIME = path.join(".vivicy", "runtime")

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
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
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
    await expect(runViviTurn(spawner, { message: "hi" })).rejects.toThrow(/governs no project/)
  })

  it("uses per-turn scratch files so concurrent turns on one session never collide", async () => {
    const sessionId = "22222222-2222-2222-2222-222222222222"
    const seenSeedFiles = new Set<string>()
    const seenReplyFiles = new Set<string>()
    const onRun = (o: RunOptions) => {
      const replyFile = replyFileFrom(o.args)
      seenSeedFiles.add(seedFileFrom(o.args))
      seenReplyFiles.add(replyFile)
      writeReply(o, `reply@${replyFile}`)
    }
    const a = makeFakeSpawner(onRun)
    const b = makeFakeSpawner(onRun)

    const [ra, rb] = await Promise.all([
      runViviTurn(a.spawner, { sessionId, message: "ALPHA" }),
      runViviTurn(b.spawner, { sessionId, message: "BETA" }),
    ])

    expect(seenSeedFiles.size).toBe(2)
    expect(seenReplyFiles.size).toBe(2)
    expect(ra.reply).toBe(`reply@${replyFileFrom(a.calls.run[0].args)}`)
    expect(rb.reply).toBe(`reply@${replyFileFrom(b.calls.run[0].args)}`)
    expect(ra.reply).not.toBe(rb.reply)
    expect(ra.sessionId).toBe(sessionId)
    expect(rb.sessionId).toBe(sessionId)
  })

  it("stages the turn in the OS temp dir, never in the project, and takes it away on the way out", async () => {
    let scratchDuringTurn = ""
    const { spawner } = makeFakeSpawner((o) => {
      const seedFile = seedFileFrom(o.args)
      scratchDuringTurn = path.dirname(seedFile)
      expect(path.dirname(scratchDuringTurn)).toBe(scratchRoot)
      for (const staged of [incrementFileFrom(o.args), replyFileFrom(o.args), failureFileFrom(o.args)]) {
        expect(path.dirname(staged)).toBe(scratchDuringTurn)
      }
      writeReply(o, "Reply one.")
    })

    const { sessionId } = await runViviTurn(spawner, { message: "I want a todo app." })

    expect(existsSync(scratchDuringTurn)).toBe(false)
    expect(readdirSync(scratchRoot)).toEqual([])
    expect(readdirSync(path.join(targetRoot, RUNTIME, "vivi"))).toEqual([`${sessionId}.jsonl`])
  })

  it("sweeps the turn scratch a KILLED turn left behind, and leaves a live owner's alone", async () => {
    const dead = await exitedPid()
    const orphan = path.join(scratchRoot, `vivicy-vivi-turn-${dead}-AbCdEf`)
    const live = path.join(scratchRoot, `vivicy-vivi-turn-${process.pid}-GhIjKl`)
    for (const dir of [orphan, live]) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "seed.txt"), "a killed turn's argv workaround")
    }

    const { spawner } = makeFakeSpawner((o) => writeReply(o, "Reply one."))
    await runViviTurn(spawner, { message: "I want a todo app." })

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(live)).toBe(true)
  })

  it("sweeps the transcript publish temp a KILLED rewrite left beside the conversation", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv.md"), wellFormedCr("CR-0001"))
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      writeReply(o, leg % 2 === 1 ? replyWithActions('{"actions": [{"tool": "crs.list"}]}') : "Here are your pending CRs.")
    })
    const { sessionId } = await runViviTurn(spawner, { message: "des CRs en attente ?" })

    const viviDir = path.join(targetRoot, RUNTIME, "vivi")
    const dead = await exitedPid()
    const orphan = path.join(viviDir, `.publish-${dead}-9f3d1c2b-0000-4000-8000-000000000000`)
    const live = path.join(viviDir, `.publish-${process.pid}-9f3d1c2b-0000-4000-8000-000000000001`)
    for (const file of [orphan, live]) writeFileSync(file, "half a conversation")

    await decideCardAction(spawner, { sessionId, cardId: "cr-CR-0001", actionId: "later" })

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(live)).toBe(true)
    expect(readTranscript(sessionId).find((t) => t.role === "card")?.decided?.actionId).toBe("later")
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
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md"), path.join(SPIKES, "S01-provider.md")])
    expect(existsSync(path.join(targetRoot, CANONICAL, "01-product.md"))).toBe(true)
    const turns = readTranscript(result.sessionId)
    expect((turns.at(-1) as ViviTurn).wrote).toEqual(result.wrote)
  })

  it("ignores the leg's own transcript write and keeps the legit spike", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(SPIKES, "S01-native-argon2id.md"), "# S01\n")
      writeInTarget(
        targetRoot,
        path.join(".vivicy", "development", "transcripts", "VIVI", "claude-vivi-abc.jsonl"),
        '{"type":"assistant"}\n'
      )
      writeReply(o, "Wrote 3 spikes.")
    })
    const result = await runViviTurn(spawner, { message: "start" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(SPIKES, "S01-native-argon2id.md")])
    expect(existsSync(path.join(targetRoot, SPIKES, "S01-native-argon2id.md"))).toBe(true)
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "transcripts", "VIVI", "claude-vivi-abc.jsonl"))).toBe(true)
  })

  it("leaves the orchestrator's runtime subtree alone: written, modified, never reported, never rolled back", async () => {
    writeInTarget(targetRoot, path.join(RUNTIME, "skills-cache", "sha256-abc"), "cached\n")

    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(RUNTIME, "skills-cache", "sha256-abc"), "refreshed\n")
      writeInTarget(targetRoot, path.join(RUNTIME, "vivi", "turn.log"), "line\n")
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeReply(o, "Ran the stage.")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toBeUndefined()
    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md")])
    expect(readFileSync(path.join(targetRoot, RUNTIME, "skills-cache", "sha256-abc"), "utf8")).toBe("refreshed\n")
    expect(existsSync(path.join(targetRoot, RUNTIME, "vivi", "turn.log"))).toBe(true)
  })

  it("keeps the runtime subtree's writes when the SAME turn is rejected for a real violation", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(RUNTIME, "run-state.json"), '{"phase":"running"}\n')
      writeInTarget(targetRoot, path.join(".vivicy", "development", "issues", "sneaky.md"), "no\n")
      writeReply(o, "I tried to escape.")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(result.rejected).not.toMatch(/runtime/)
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "issues", "sneaky.md"))).toBe(false)
    expect(readFileSync(path.join(targetRoot, RUNTIME, "run-state.json"), "utf8")).toBe('{"phase":"running"}\n')
  })

  it("guards the project's settings override: the owner's surface writes it, a turn never does", async () => {
    writeInTarget(targetRoot, path.join(".vivicy", "settings.json"), '{"maxParallel":3}\n')

    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(".vivicy", "settings.json"), '{"maxParallel":12}\n')
      writeReply(o, "I raised your concurrency.")
    })
    const result = await runViviTurn(spawner, { message: "go faster" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(readFileSync(projectSettingsFile(), "utf8")).toBe('{"maxParallel":3}\n')
  })

  it("guards a sibling whose name merely STARTS with an ignored subtree's", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(".vivicy", "runtime-notes", "draft.txt"), "not the runtime dir\n")
      writeReply(o, "oops")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/outside its allowlist/)
    expect(existsSync(path.join(targetRoot, ".vivicy", "runtime-notes", "draft.txt"))).toBe(false)
  })

  it("judges CONTENT, not the file's stat: an identical rewrite is no write, a same-length edit is", async () => {
    const guarded = path.join(".vivicy", "development", "issues", "ISSUE-001.md")
    writeInTarget(targetRoot, guarded, "same length\n")

    const { spawner: rewriter } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, guarded, "same length\n")
      writeReply(o, "touched nothing")
    })
    const untouched = await runViviTurn(rewriter, { message: "go" })
    expect(untouched.rejected).toBeUndefined()
    expect(untouched.wrote).toEqual([])

    const { spawner: editor } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, guarded, "SAME LENGTH\n")
      writeReply(o, "edited")
    })
    const edited = await runViviTurn(editor, { message: "go" })
    expect(edited.rejected).toMatch(/outside its allowlist/)
    expect(readFileSync(path.join(targetRoot, guarded), "utf8")).toBe("same length\n")
  })

  it("catches a leg that rewrites a file and forges its timestamps back to the exact nanosecond", async () => {
    const guarded = path.join(".vivicy", "development", "issues", "ISSUE-002.md")
    const abs = path.join(targetRoot, guarded)
    writeInTarget(targetRoot, guarded, "same length\n")
    const forged = Math.floor(Date.now() / 1000) - 3600
    utimesSync(abs, forged, forged)

    // Hold the capture clock past the racy window, so the forged stat identity is the only witness left.
    const capturedAt = Date.now() + 60_000
    const clock = vi.spyOn(Date, "now").mockImplementation(() => capturedAt)
    try {
      const { spawner } = makeFakeSpawner((o) => {
        writeInTarget(targetRoot, guarded, "SAME LENGTH\n")
        utimesSync(abs, forged, forged)
        writeReply(o, "forged")
      })
      const result = await runViviTurn(spawner, { message: "go" })

      expect(result.rejected).toMatch(/outside its allowlist/)
      expect(readFileSync(abs, "utf8")).toBe("same length\n")
    } finally {
      clock.mockRestore()
    }
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

describe("runViviTurn — post-freeze (Change Requests)", () => {
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
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
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
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
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
  it("passes the CLI + model env the PROJECT's own settings resolve to, and cwd=target, to the leg", async () => {
    writeFileSync(
      projectSettingsFile(),
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

  it("names the chat session to the leg on every turn of it — the one thing that makes turn two a resume of turn one", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, "ok"))
    const first = await runViviTurn(spawner, { message: "hi" })
    await runViviTurn(spawner, { sessionId: first.sessionId, message: "again" })

    const sessionArgs = legRuns(calls).map((c) => c.args[c.args.indexOf("--session") + 1])
    expect(sessionArgs).toEqual([first.sessionId, first.sessionId])
  })
})

function seedFileFrom(args: string[]): string {
  const i = args.indexOf("--seed-file")
  return args[i + 1]
}

function incrementFileFrom(args: string[]): string {
  const i = args.indexOf("--increment-file")
  return args[i + 1]
}

function readIncrement(options: RunOptions): string {
  return readFileSync(incrementFileFrom(options.args), "utf8")
}

function transcriptSection(prompt: string): string {
  const start = prompt.indexOf("## Conversation so far")
  const end = prompt.indexOf("## Current state —")
  if (start === -1 || end === -1 || end < start) throw new Error("the composed prompt carries no conversation section")
  return prompt.slice(start, end)
}

function failureFileFrom(args: string[]): string {
  const i = args.indexOf("--failure-file")
  return args[i + 1]
}

function writeFailure(options: RunOptions, text: string): void {
  const file = failureFileFrom(options.args)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}

// The measured shape of a failed `claude --resume`: exit 1, EMPTY stdout, the whole story on stderr.
const RESUME_FAILURE = "No conversation found with session ID: 6f1c0f0e-6c3a-4a5c-9b2a-3f5a0d2b1c77"

describe("runViviTurn — a leg that never spoke (the orchestrator's note, never Vivi's voice)", () => {
  it("turns a non-zero leg into a note carrying its reason, and keeps the raw stderr out of the thread", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeFailure(o, `the agent CLI exited 1 — ${RESUME_FAILURE}`)
      return { code: 1, stdout: "", stderr: `some earlier chatter\n${RESUME_FAILURE}\n` }
    })

    const result = await runViviTurn(spawner, { message: "reprends la conversation" })

    expect(result.orchestratorNote).toBe(true)
    expect(result.wrote).toEqual([])
    const turns = readTranscript(result.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "note"])
    expect(turns[1].text).toBe(result.reply)
    expect(turns[1].text).toBe(
      `Vivi's turn could not run: the agent CLI exited 1 — ${RESUME_FAILURE}. Your message is still in the thread — send it again to retry.`
    )
    expect(turns[1].text).not.toContain("some earlier chatter")
    // P9/F-087: the in-chat note IS the surface — a failed turn writes no notification.
    expect(existsSync(path.join(getProjectRuntimeDir(targetRoot), "notifications.jsonl"))).toBe(false)
  })

  it("falls back to the leg's own last stderr line, then to the exit code, when no reason was named", async () => {
    const { spawner: silentReason } = makeFakeSpawner(() => ({ code: 1, stdout: "", stderr: `warming up\n${RESUME_FAILURE}\n` }))
    const fromStderr = await runViviTurn(silentReason, { message: "go" })
    expect(fromStderr.reply).toBe(
      `Vivi's turn could not run: ${RESUME_FAILURE}. Your message is still in the thread — send it again to retry.`
    )

    const { spawner: mute } = makeFakeSpawner(() => ({ code: 3, stdout: "", stderr: "" }))
    const fromCode = await runViviTurn(mute, { message: "go" })
    expect(fromCode.reply).toContain("the turn process exited 3 in silence")

    const { spawner: dead } = makeFakeSpawner(() => ({ code: null, stdout: "", stderr: "" }))
    const fromDeath = await runViviTurn(dead, { message: "go" })
    expect(fromDeath.reply).toContain("the turn process died without an exit status")
  })

  it("answers an empty-reply success with the same honest note, never an empty bubble and never the leg's stdout", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeFailure(o, "the agent CLI exited 0 without writing a reply")
      return { code: 1, stdout: "Ciao! I am Vivi and this line lives on stdout.\n", stderr: "" }
    })

    const result = await runViviTurn(spawner, { message: "hello" })

    expect(result.orchestratorNote).toBe(true)
    expect(result.reply).toBe(
      "Vivi's turn could not run: the agent CLI exited 0 without writing a reply. Your message is still in the thread — send it again to retry."
    )
    const turns = readTranscript(result.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "note"])
    expect(turns.some((t) => t.text.includes("this line lives on stdout"))).toBe(false)
  })

  it("never trusts a failed leg's own words: the reply file it left is ignored and its fences are never executed", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => {
      writeReply(o, replyWithActions('{"actions": [{"tool": "workflow.start"}]}'))
      writeFailure(o, "the agent CLI exited 1 — killed right after it wrote")
      return { code: 1, stdout: "", stderr: "" }
    })

    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.orchestratorNote).toBe(true)
    expect(result.actions).toBeUndefined()
    expect(viviLegRuns(calls.run)).toBe(1)
    expect(calls.spawnDetached).toHaveLength(0)
    const turns = readTranscript(result.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "note"])
    expect(turns[1].text).toBe(
      "Vivi's turn could not run: the agent CLI exited 1 — killed right after it wrote. Your message is still in the thread — send it again to retry."
    )
  })

  it("still judges what a failed leg wrote: the violation is rolled back and the note carries the refusal", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(".vivicy", "development", "issues", "sneaky.md"), "no\n")
      writeFailure(o, "the agent CLI exited 1 — killed mid-write")
      return { code: 1, stdout: "", stderr: "" }
    })

    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/wrote outside its allowlist/)
    expect(result.orchestratorNote).toBe(true)
    expect(result.wrote).toEqual([])
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "issues", "sneaky.md"))).toBe(false)
    const last = readTranscript(result.sessionId).at(-1)!
    expect(last.role).toBe("note")
    expect(last.text).toContain("Vivi's turn could not run: the agent CLI exited 1 — killed mid-write")
    expect(last.rejected).toBe(result.rejected)
  })

  it("keeps a failed leg's LEGAL writes and names them in the note, so nothing it changed goes unsaid", async () => {
    const { spawner } = makeFakeSpawner((o) => {
      writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
      writeFailure(o, "the agent CLI exited 1 — killed right after it wrote")
      return { code: 1, stdout: "", stderr: "" }
    })

    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.wrote).toEqual([path.join(CANONICAL, "01-product.md")])
    expect(existsSync(path.join(targetRoot, CANONICAL, "01-product.md"))).toBe(true)
    expect(result.reply).toContain(`The file she had already written is kept: ${path.join(CANONICAL, "01-product.md")}.`)
  })

  it("does not invite a re-send once an action ran: the note names what remains in effect instead", async () => {
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
        return
      }
      writeFailure(o, "the agent CLI exited 1 — killed on the second round")
      return { code: 1, stdout: "", stderr: "" }
    })

    const result = await runViviTurn(spawner, { message: "où en est le build ?" })

    expect(result.orchestratorNote).toBe(true)
    expect(result.actions).toHaveLength(1)
    expect(result.reply).toBe(
      "Vivi's turn could not run: the agent CLI exited 1 — killed on the second round. Your message is still in the thread, and 1 action already executed this turn remains in effect — say what you want next rather than sending it again, which would start the whole turn over."
    )
    expect(readTranscript(result.sessionId).map((t) => t.role)).toEqual(["user", "vivi", "action", "note"])
  })

  it("leaves the turn retryable: the message is untouched, the queue released, and the next turn carries both", async () => {
    const { spawner: failing } = makeFakeSpawner((o) => {
      writeFailure(o, `the agent CLI exited 1 — ${RESUME_FAILURE}`)
      return { code: 1, stdout: "", stderr: "" }
    })
    const failed = await runViviTurn(failing, { message: "un todo app, avec des dates" })
    expect(isViviTurnRunning(targetRoot)).toBe(false)

    let seenPrompt = ""
    const { spawner: recovered } = makeFakeSpawner((o) => {
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "Eccoci — reprenons.")
    })
    const second = await runViviTurn(recovered, { sessionId: failed.sessionId, message: "vas-y" })

    expect(second.orchestratorNote).toBeUndefined()
    expect(second.reply).toBe("Eccoci — reprenons.")
    expect(readTranscript(failed.sessionId).map((t) => t.role)).toEqual(["user", "note", "user", "vivi"])
    expect(seenPrompt).toContain("User: un todo app, avec des dates")
    expect(transcriptSection(seenPrompt)).toContain(`Orchestrator: ${failed.reply}`)
  })
})

const PLANTED_FACT = "on ne facture jamais apres le 25 du mois"

const OWNER_SYNTHESIS_LENGTH = 2724

function ownerSynthesis(): string {
  const head = "Allora, ecco la sintesi di quello che ho letto.\n\n"
  const rule = `Regola non negoziabile : ${PLANTED_FACT}, quoi qu'il arrive.\n\n`
  const tail = "\n\nEcco — dimmi cosa manca, poi passiamo alle domande."
  const body = "Chaque commande traverse le meme tunnel : panier, controle du stock, paiement, facture, archivage. ".repeat(40)
  return `${head}${rule}${body.slice(0, OWNER_SYNTHESIS_LENGTH - head.length - rule.length - tail.length)}${tail}`
}

const FOUR_QUESTION_CARDS = JSON.stringify([
  {
    id: "datastore",
    question: "Sur quelle base v1 doit-il tourner ?",
    options: [{ label: "Postgres", recommended: true }, { label: "SQLite" }],
  },
  {
    id: "auth",
    question: "Comment vos clients se connectent-ils ?",
    options: [{ label: "Email + mot de passe", recommended: true }, { label: "Lien magique" }],
  },
  {
    id: "billing",
    question: "Qui declenche la facturation ?",
    options: [{ label: "Le systeme, chaque nuit", recommended: true }, { label: "Un humain, a la main" }],
  },
  {
    id: "roles",
    question: "Combien de roles distincts des le depart ?",
    options: [{ label: "Deux : admin et client", recommended: true }, { label: "Un seul" }],
  },
])

describe("the composed prompt carries the WHOLE thread — every turn, never a clip", () => {
  it("holds the owner's long synthesis and all four questions, and the next leg recalls a fact planted past its first line", async () => {
    const synthesis = ownerSynthesis()
    expect(synthesis).toHaveLength(OWNER_SYNTHESIS_LENGTH)
    expect(synthesis.split("\n", 1)[0]).not.toContain(PLANTED_FACT)
    let leg = 0
    let continuationPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithQuestions(FOUR_QUESTION_CARDS, synthesis))
        return
      }
      continuationPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      const recalled = transcriptSection(continuationPrompt).includes(PLANTED_FACT)
      writeReply(o, recalled ? `Confermo : ${PLANTED_FACT}.` : "La regle de facturation n'est plus sous mes yeux.")
    })
    const { sessionId, stackId } = await stackedSession(spawner, FOUR_QUESTION_CARDS)

    for (const questionId of ["datastore", "auth", "billing", "roles"]) {
      answerViviQuestion(spawner, { sessionId, stackId, questionId, optionIndex: 0 })
    }
    await settleDispatchedTurn()

    expect(readTranscript(sessionId).at(-1)?.text).toBe(`Confermo : ${PLANTED_FACT}.`)
    const rendered = transcriptSection(continuationPrompt)
    expect(rendered).toContain(`Vivi: ${synthesis}`)
    for (const q of JSON.parse(FOUR_QUESTION_CARDS) as Array<{ question: string }>) {
      expect(rendered).toContain(`${q.question} [answered above]`)
    }
    expect(rendered).not.toContain("…")
  })

  it("keeps a NON-last Tool results turn's every line and the orchestrator's whole note — neither is its first 200 characters", async () => {
    const tools = ["status.read", "crs.list", "notifications.read"]
    let leg = 0
    let laterPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions(JSON.stringify({ actions: tools.map((tool) => ({ tool })) })))
        return
      }
      if (leg === 2) {
        writeFailure(o, "the agent CLI exited 1 — killed on the second round")
        return { code: 1, stdout: "", stderr: "" }
      }
      laterPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "Va bene, riprendiamo.")
    })
    const failed = await runViviTurn(spawner, { message: "où en est le build ?" })
    expect(failed.orchestratorNote).toBe(true)
    expect(failed.reply.length).toBeGreaterThan(200)
    await runViviTurn(spawner, { sessionId: failed.sessionId, message: "et les CRs ?" })

    expect(readTranscript(failed.sessionId).map((t) => t.role)).toEqual(["user", "vivi", "action", "note", "user", "vivi"])
    const rendered = transcriptSection(laterPrompt)
    expect(rendered).toContain("Tool results:")
    for (const tool of tools) expect(rendered).toMatch(new RegExp(`[✓✗] ${tool.replace(".", "\\.")}:`))
    expect(rendered).toContain(`Orchestrator: ${failed.reply}`)
  })

  it("keeps the persona's promise: the shipped vivi.md claims the full running transcript and the prompt delivers one", async () => {
    const persona = readFileSync(path.join(REPO_ROOT, "factory", "prompts", "vivi.md"), "utf8")
    expect(persona).toContain("the full running transcript")
    writeFileSync(path.join(factoryRoot, "prompts", "vivi.md"), persona)

    const synthesis = ownerSynthesis()
    let leg = 0
    let seenPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, synthesis)
        return
      }
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "Va bene.")
    })
    const first = await runViviTurn(spawner, { message: "voici mon dossier de facturation" })
    await runViviTurn(spawner, { sessionId: first.sessionId, message: "et maintenant ?" })

    expect(seenPrompt).toContain("the full running transcript")
    expect(transcriptSection(seenPrompt)).toContain(`Vivi: ${synthesis}`)
  })
})

function volatileSection(prompt: string): string {
  const start = prompt.indexOf("## Current state —")
  if (start === -1) throw new Error("the composed prompt carries no current-state block")
  return prompt.slice(start)
}

function installRealPersona(): string {
  const persona = readFileSync(path.join(REPO_ROOT, "factory", "prompts", "vivi.md"), "utf8")
  writeFileSync(path.join(factoryRoot, "prompts", "vivi.md"), persona)
  return persona
}

describe("one seed per conversation, one increment per turn (the composition the child chooses between)", () => {
  it("sends the whole render in the seed and only what is new in the increment — no persona, no re-sent thread", async () => {
    const persona = installRealPersona()
    const first = makeFakeSpawner((o) => writeReply(o, "Reply one."))
    const opened = await runViviTurn(first.spawner, { message: "I want a todo app." })

    let seed = ""
    let increment = ""
    const second = makeFakeSpawner((o) => {
      seed = readFileSync(seedFileFrom(o.args), "utf8")
      increment = readIncrement(o)
      writeReply(o, "Reply two.")
    })
    await runViviTurn(second.spawner, { sessionId: opened.sessionId, message: "It needs due dates." })

    expect(seed.startsWith(persona)).toBe(true)
    expect(transcriptSection(seed)).toContain("User: I want a todo app.")
    expect(transcriptSection(seed)).toContain("Vivi: Reply one.")

    expect(increment).toContain("## New in this thread since your last reply")
    expect(increment).toContain("User: It needs due dates.")
    expect(increment).not.toContain("I want a todo app.")
    expect(increment).not.toContain("Reply one.")
    expect(increment).not.toContain("## Conversation so far")
    expect(increment).not.toContain("la Nonna")
    expect(seed.length - increment.length).toBeGreaterThan(persona.length)
    expect(increment.length).toBeLessThan(seed.length / 10)
  })

  it("re-states ONE volatile block in both halves — the phase imperatively, the CR id, the snapshot, the live file list", async () => {
    seedFrozenBaseline(targetRoot)
    writeInTarget(targetRoot, path.join(CANONICAL, "01-product.md"), "# Product\n")
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-first.md"), wellFormedCr("CR-0001"))
    const first = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) return { code: 0 }
      writeReply(o, "Noted.")
    })
    const opened = await runViviTurn(first.spawner, { message: "hello" })

    let seed = ""
    let increment = ""
    const second = makeFakeSpawner((o) => {
      if (isChangeControlRun(o.args)) return { code: 0 }
      seed = readFileSync(seedFileFrom(o.args), "utf8")
      increment = readIncrement(o)
      writeReply(o, "Noted again.")
    })
    await runViviTurn(second.spawner, { sessionId: opened.sessionId, message: "and now?" })

    expect(volatileSection(increment)).toBe(volatileSection(seed))
    const block = volatileSection(increment)
    expect(block).toContain("re-stated every turn, and it OVERRIDES anything older in this conversation")
    expect(block).toContain("spec_frozen: true")
    expect(block).toContain("do NOT write or edit anything under `.vivicy/canonical/`")
    expect(block).toContain("whatever an earlier turn of this conversation told you")
    expect(block).toContain("Next Change Request id: CR-0002.")
    expect(block).toContain("Workflow snapshot: run_active=false; extraction=never; skills=never; spec_frozen=true; spec_kind=project.")
    expect(block).toContain(path.join(CANONICAL, "01-product.md"))
    expect(block).toContain(path.join(CHANGE_REQUESTS, "CR-0001-first.md"))
  })

  it("states the pre-freeze phase just as imperatively, and moves the whole block with the phase mid-conversation", async () => {
    let prefreeze = ""
    const first = makeFakeSpawner((o) => {
      prefreeze = readIncrement(o)
      writeReply(o, "Grilling.")
    })
    const opened = await runViviTurn(first.spawner, { message: "start" })
    expect(prefreeze).toContain("spec_frozen: false")
    expect(prefreeze).toContain("are yours to write this turn, whatever an earlier turn of this conversation told you")

    seedFrozenBaseline(targetRoot)
    let frozen = ""
    const second = makeFakeSpawner((o) => {
      frozen = readIncrement(o)
      writeReply(o, "Locked.")
    })
    await runViviTurn(second.spawner, { sessionId: opened.sessionId, message: "and now?" })

    expect(frozen).toContain("spec_frozen: true")
    expect(frozen).not.toContain("spec_frozen: false")
  })

  it("carries every turn the conversation has not seen: the round's tool results, and an action decided between two turns", async () => {
    let leg = 0
    let continuation = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
        return
      }
      continuation = readIncrement(o)
      writeReply(o, "Nothing pending.")
    })
    const opened = await runViviTurn(spawner, { message: "où en sont les CRs ?" })

    expect(continuation).toContain("Tool results: ✓ crs.list")
    expect(continuation).not.toContain("## Conversation so far")
    expect(continuation).not.toContain("User: où en sont les CRs ?")
    expect(continuation).toContain("close the loop")

    appendCardTurn(
      { id: "card-mid", title: "List them", actions: [{ id: "list", label: "List", action: { kind: "control", tool: "crs.list" } }] },
      opened.sessionId
    )
    await decideCardAction(spawner, { sessionId: opened.sessionId, cardId: "card-mid", actionId: "list" })

    let next = ""
    const third = makeFakeSpawner((o) => {
      next = readIncrement(o)
      writeReply(o, "Va bene.")
    })
    await runViviTurn(third.spawner, { sessionId: opened.sessionId, message: "et maintenant ?" })

    expect(next).toContain("Choice card: List them [decided: list")
    expect(next).toContain("Tool results: ✓ crs.list")
    expect(next).toContain("User: et maintenant ?")
    expect(next).not.toContain("Nothing pending.")
  })

  it("re-sends what a leg that never spoke was told: a failed turn moves no watermark", async () => {
    const opening = makeFakeSpawner((o) => writeReply(o, "Reply one."))
    const opened = await runViviTurn(opening.spawner, { message: "un todo app" })

    const failing = makeFakeSpawner((o) => {
      writeFailure(o, "the agent CLI exited 1 — killed")
      return { code: 1, stdout: "", stderr: "" }
    })
    await runViviTurn(failing.spawner, { sessionId: opened.sessionId, message: "avec des dates" })

    let increment = ""
    const recovered = makeFakeSpawner((o) => {
      increment = readIncrement(o)
      writeReply(o, "Eccoci.")
    })
    await runViviTurn(recovered.spawner, { sessionId: opened.sessionId, message: "vas-y" })

    expect(increment).toContain("User: avec des dates")
    expect(increment).toContain("User: vas-y")
    expect(increment).not.toContain("Reply one.")
  })

  it("never buries a message the owner sent WHILE a turn was in flight: delivery is the set a prompt carried, not a cut at the last reply", async () => {
    const sessionId = seedViviWelcome()
    const increments: string[] = []
    const spawner: Spawner = {
      spawnDetached: () => ({ pid: 1 }),
      run: async (options) => {
        increments.push(readIncrement(options))
        const reading = readFileSync(seedFileFrom(options.args), "utf8").includes("the import IS the request")
        // The owner types while the reading turn is mid-flight: runTurn records their message before the queue wait, so it lands between this prompt and its reply.
        if (reading) await new Promise((resolve) => setTimeout(resolve, 40))
        writeReply(options, reading ? "Both read, cover to cover." : "Va bene.")
        return { code: 0, lastLine: "", stdout: "", stderr: "" }
      },
      killGroup: () => true,
      isAlive: () => false,
    }

    const reading = importDocsIntoSession(spawner, { sessionId, entries: [docEntry("cdc.md", IMPORT_ENGLISH)] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const answered = runViviTurn(spawner, { sessionId, message: "et les délais de paiement ?" })
    await reading
    await answered
    await settleTranscript(sessionId, 5)

    const roles = readTranscript(sessionId).map((t) => t.role)
    expect(roles).toEqual(["vivi", "vivi", "user", "vivi", "vivi"])
    const owners = readTranscript(sessionId).filter((t) => t.role === "user")
    expect(owners.map((t) => t.text)).toEqual(["et les délais de paiement ?"])

    const last = increments.at(-1) as string
    expect(last).toContain("User: et les délais de paiement ?")
    expect(last).toContain("Respond to the user's latest message above")
    // The reading turn's own reply is the conversation's own output: it records the prefix it answered and is never re-sent.
    expect(last).not.toContain("Both read, cover to cover.")
    expect(increments).toHaveLength(2)
  })
})

const CLI_CONVERSATION = "8c1d5f2a-3b47-4e69-8f10-2d4c6a8b0e35"

// A scripted agent CLI: it records its argv, obeys the phase the prompt STATES, and takes the CR id from the current-state block — never from anything it was told before.
function scriptedClaude(): string {
  return (
    [
      "#!/bin/sh",
      `printf '%s\\0' "$@" >> "$VIVICY_FAKE_ARGV"`,
      `printf 'END\\0' >> "$VIVICY_FAKE_ARGV"`,
      "prompt=$2",
      `say() { printf '{"type":"result","is_error":false,"subtype":"success","session_id":"${CLI_CONVERSATION}","result":"%s"}' "$1"; }`,
      `case "$prompt" in`,
      "  *DISOBEY*)",
      `    printf '# tampered after the freeze\\n' > .vivicy/canonical/01-product.md`,
      `    say "I rewrote the product doc."`,
      "    exit 0;;",
      `  *"spec_frozen: false"*)`,
      "    mkdir -p .vivicy/canonical",
      `    printf '# Product\\n' > .vivicy/canonical/01-product.md`,
      `    say "Wrote .vivicy/canonical/01-product.md. Next Change Request id: CR-0001."`,
      "    exit 0;;",
      "esac",
      `crid=$(printf '%s\\n' "$prompt" | sed -n 's/^Next Change Request id: \\(CR-[0-9][0-9]*\\)\\.$/\\1/p' | head -1)`,
      `if [ -z "$crid" ]; then say "This turn named no current Change Request id."; exit 0; fi`,
      "mkdir -p .vivicy/change-requests",
      `sed "s/__CRID__/$crid/g" "$VIVICY_CR_TEMPLATE" > ".vivicy/change-requests/$crid-add-csv-export.md"`,
      `say "Drafted .vivicy/change-requests/$crid-add-csv-export.md."`,
    ].join("\n") + "\n"
  )
}

function readInvocations(argvPath: string): string[][] {
  if (!existsSync(argvPath)) return []
  const out: string[][] = []
  let current: string[] = []
  for (const token of readFileSync(argvPath, "utf8").split("\0").slice(0, -1)) {
    if (token === "END") {
      out.push(current)
      current = []
    } else {
      current.push(token)
    }
  }
  return out
}

describe("driven live across the freeze boundary — the real turn child, a scripted agent CLI, ONE conversation", () => {
  it("writes canonical pre-freeze, reroutes to the CR id the block names post-freeze, and is rolled back when it ignores the phase", async () => {
    const bin = mkdtempSync(path.join(tmpdir(), "vivi-bin-"))
    const argvPath = path.join(bin, "argv")
    const template = path.join(bin, "cr-template.md")
    writeFileSync(template, wellFormedCr("__CRID__"))
    writeFileSync(path.join(bin, "claude"), scriptedClaude(), { mode: 0o755 })
    const prevPath = process.env.PATH
    process.env.VIVICY_FACTORY_ROOT = path.join(REPO_ROOT, "factory")
    process.env.PATH = `${bin}:${prevPath ?? ""}`
    process.env.VIVICY_FAKE_ARGV = argvPath
    process.env.VIVICY_CR_TEMPLATE = template
    try {
      const prefreeze = await runViviTurn(nodeSpawner, { message: "voici le produit, commence la ricetta" })
      expect(prefreeze.rejected).toBeUndefined()
      expect(prefreeze.wrote).toEqual([path.join(CANONICAL, "01-product.md")])

      // The stale id is now in the conversation's own memory (Vivi's turn-one reply names CR-0001) — and CR-0001 exists, so the current id has moved.
      writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-first-request.md"), wellFormedCr("CR-0001"))
      seedFrozenBaseline(targetRoot)

      const rerouted = await runViviTurn(nodeSpawner, { sessionId: prefreeze.sessionId, message: "ajoute l'export CSV" })
      expect(rerouted.rejected).toBeUndefined()
      expect(rerouted.wrote).toEqual([path.join(CHANGE_REQUESTS, "CR-0002-add-csv-export.md")])
      expect(rerouted.reply).toContain("CR-0002-add-csv-export.md")
      expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("# Product\n")

      const disobeyed = await runViviTurn(nodeSpawner, {
        sessionId: prefreeze.sessionId,
        message: "DISOBEY: rewrite the product doc anyway",
      })
      expect(disobeyed.rejected).toMatch(/outside its allowlist/)
      expect(disobeyed.wrote).toEqual([])
      expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("# Product\n")

      const invocations = readInvocations(argvPath)
      expect(invocations).toHaveLength(3)
      const [opened, resumedFrozen, resumedDisobedient] = invocations
      expect(opened[4]).toBe("--session-id")
      expect(opened[1]).toContain("la Nonna")
      expect(resumedFrozen.slice(4, 6)).toEqual(["--resume", CLI_CONVERSATION])
      expect(resumedDisobedient.slice(4, 6)).toEqual(["--resume", CLI_CONVERSATION])

      for (const increment of [resumedFrozen[1], resumedDisobedient[1]]) {
        expect(increment).not.toContain("la Nonna")
        expect(increment).toContain("spec_frozen: true")
        expect(increment).toContain("re-stated every turn, and it OVERRIDES anything older in this conversation")
        expect(increment.length).toBeLessThan(opened[1].length / 10)
      }
      // Newest wins, live: the conversation still holds "CR-0001" from its own turn-one reply, and each turn's block states the id that is current THEN.
      expect(resumedFrozen[1].match(/^Next Change Request id: .*$/gm)).toEqual(["Next Change Request id: CR-0002."])
      expect(resumedDisobedient[1].match(/^Next Change Request id: .*$/gm)).toEqual(["Next Change Request id: CR-0003."])
      expect(resumedDisobedient[1]).toContain(path.join(CHANGE_REQUESTS, "CR-0002-add-csv-export.md"))
      expect(transcriptSection(opened[1])).not.toContain("CR-0001")

      expect(readTranscript(prefreeze.sessionId).map((t) => t.role)).toEqual(["user", "vivi", "user", "vivi", "user", "vivi"])
    } finally {
      process.env.PATH = prevPath
      delete process.env.VIVICY_FAKE_ARGV
      delete process.env.VIVICY_CR_TEMPLATE
      rmSync(bin, { recursive: true, force: true })
    }
  }, 90_000)
})

const ROUND_ACTION_REPLY = 'On it.\\n\\n```vivicy-action\\n{\\"actions\\": [{\\"tool\\": \\"crs.list\\"}]}\\n```'

// A scripted agent CLI with a MEMORY: one rollout file per conversation, one line per prompt it was sent. It refuses a resume whose rollout is gone (the CLI's own "No conversation found"), decides from what its conversation holds, and recalls only from lines it was sent BEFORE this one — so a recall can never come from the prompt in its hand.
function scriptedRoundsClaude(): string {
  return (
    [
      "#!/bin/sh",
      `printf '%s\\0' "$@" >> "$VIVICY_FAKE_ARGV"`,
      `printf 'END\\0' >> "$VIVICY_FAKE_ARGV"`,
      "prompt=$2",
      "mode=$5",
      "sid=$6",
      `rollout="$VIVICY_FAKE_ROLLOUTS/$sid.jsonl"`,
      `say() { printf '{"type":"result","is_error":false,"subtype":"success","session_id":"%s","result":"%s"}' "$sid" "$1"; }`,
      `if [ "$mode" = "--resume" ] && [ ! -f "$rollout" ]; then`,
      `  printf 'No conversation found with session ID: %s\\n' "$sid" >&2`,
      "  exit 1",
      "fi",
      `mkdir -p "$VIVICY_FAKE_ROLLOUTS"`,
      `printf '%s' "$prompt" | tr '\\n' ' ' >> "$rollout"`,
      `printf '\\n' >> "$rollout"`,
      `rounds=$(grep -o 'Tool results:' "$rollout" | wc -l | tr -d ' ')`,
      `if [ "$rounds" -ge 2 ]; then`,
      `  if sed '$d' "$rollout" | grep -q "$VIVICY_FAKE_FACT"; then`,
      `    say "Confermo : $VIVICY_FAKE_FACT."`,
      "  else",
      `    say "La regola non e piu sotto i miei occhi."`,
      "  fi",
      "else",
      `  say '${ROUND_ACTION_REPLY}'`,
      `  [ "$VIVICY_FAKE_LOSE" = "1" ] && [ "$rounds" = "0" ] && rm -f "$rollout"`,
      "fi",
      "exit 0",
    ].join("\n") + "\n"
  )
}

interface DrivenRounds {
  argvPath: string
  rollouts: string
}

async function drivenRounds<T>(opts: { lose?: boolean }, body: (ctx: DrivenRounds) => Promise<T>): Promise<T> {
  const bin = mkdtempSync(path.join(tmpdir(), "vivi-bin-"))
  const ctx: DrivenRounds = { argvPath: path.join(bin, "argv"), rollouts: path.join(bin, "rollouts") }
  writeFileSync(path.join(bin, "claude"), scriptedRoundsClaude(), { mode: 0o755 })
  const prevPath = process.env.PATH
  process.env.VIVICY_FACTORY_ROOT = path.join(REPO_ROOT, "factory")
  process.env.PATH = `${bin}:${prevPath ?? ""}`
  process.env.VIVICY_FAKE_ARGV = ctx.argvPath
  process.env.VIVICY_FAKE_ROLLOUTS = ctx.rollouts
  process.env.VIVICY_FAKE_FACT = PLANTED_FACT
  if (opts.lose) process.env.VIVICY_FAKE_LOSE = "1"
  try {
    return await body(ctx)
  } finally {
    process.env.PATH = prevPath
    delete process.env.VIVICY_FAKE_ARGV
    delete process.env.VIVICY_FAKE_ROLLOUTS
    delete process.env.VIVICY_FAKE_FACT
    delete process.env.VIVICY_FAKE_LOSE
    rmSync(bin, { recursive: true, force: true })
  }
}

const ROUNDS_MESSAGE = `où en sont les CRs ? Et retiens bien : ${PLANTED_FACT}.`

const ROUNDS_TRANSCRIPT = ["user", "vivi", "action", "card", "vivi", "action", "vivi"]

const CLOSE_THE_LOOP_ORDER = 'The tool results of the actions you just requested are in the "Tool results" entry'

describe("driven live across three action rounds — the real turn child, a scripted agent CLI with a memory, ONE conversation", () => {
  beforeEach(() => {
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv.md"), wellFormedCr("CR-0001"))
  })

  it("resumes the turn's own conversation every round, so round three recalls what round one was told and no round re-injects it", async () => {
    const result = await drivenRounds({}, async ({ argvPath, rollouts }) => {
      const turn = await runViviTurn(nodeSpawner, { message: ROUNDS_MESSAGE })

      const invocations = readInvocations(argvPath)
      expect(invocations).toHaveLength(3)
      const [opened, second, third] = invocations
      expect(opened[4]).toBe("--session-id")
      const conversation = opened[5]
      expect(second.slice(4, 6)).toEqual(["--resume", conversation])
      expect(third.slice(4, 6)).toEqual(["--resume", conversation])
      expect(readdirSync(rollouts)).toEqual([`${conversation}.jsonl`])
      expect(
        readFileSync(path.join(rollouts, `${conversation}.jsonl`), "utf8")
          .trim()
          .split("\n")
      ).toHaveLength(3)

      expect(opened[1]).toContain(PLANTED_FACT)
      for (const increment of [second[1], third[1]]) {
        expect(increment).not.toContain(PLANTED_FACT)
        expect(increment).not.toContain("la Nonna")
        expect(increment).toContain("Tool results: ✓ crs.list")
        expect(increment).toContain(CLOSE_THE_LOOP_ORDER)
      }
      expect(second[1]).toContain("Choice card: CR-0001 — Add CSV export [awaiting the owner's choice]")
      return turn
    })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toBe(`Confermo : ${PLANTED_FACT}.`)
    expect(result.actions).toHaveLength(2)
    expect(readTranscript(result.sessionId).map((t) => t.role)).toEqual(ROUNDS_TRANSCRIPT)
  }, 120_000)

  it("forks MID-TURN on a refused resume and reseeds with the turn's own earlier rounds — one adjudicated path, invisible to the owner", async () => {
    const result = await drivenRounds({ lose: true }, async ({ argvPath, rollouts }) => {
      const turn = await runViviTurn(nodeSpawner, { message: ROUNDS_MESSAGE })

      const invocations = readInvocations(argvPath)
      expect(invocations).toHaveLength(4)
      const [opened, refused, forked, resumed] = invocations
      const lost = opened[5]
      expect(refused.slice(4, 6)).toEqual(["--resume", lost])
      expect(forked[4]).toBe("--session-id")
      const conversation = forked[5]
      expect(conversation).not.toBe(lost)
      expect(resumed.slice(4, 6)).toEqual(["--resume", conversation])
      expect(readdirSync(rollouts)).toEqual([`${conversation}.jsonl`])

      expect(forked[1]).toContain("la Nonna")
      expect(forked[1]).toContain(PLANTED_FACT)
      expect(forked[1]).toContain("Vivi: On it.")
      expect(forked[1]).toContain("Tool results: ✓ crs.list")
      expect(forked[1]).toContain(CLOSE_THE_LOOP_ORDER)
      return turn
    })

    expect(result.rejected).toBeUndefined()
    expect(result.orchestratorNote).toBeUndefined()
    expect(result.reply).toBe(`Confermo : ${PLANTED_FACT}.`)
    expect(result.actions).toHaveLength(2)
    expect(readTranscript(result.sessionId).map((t) => t.role)).toEqual(ROUNDS_TRANSCRIPT)
  }, 120_000)
})

function replyWithDirective(json: string): string {
  return `Sure, I will ask the control plane to install those.\n\n\`\`\`vivicy-skills\n${json}\n\`\`\``
}

describe("parseSkillsDirective — pure parser", () => {
  it("returns null when the reply carries no vivicy-skills block", () => {
    expect(parseSkillsDirective("just a normal reply")).toBeNull()
    expect(parseSkillsDirective('```json\n{"install": ["a"]}\n```')).toBeNull()
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
        continuationPrompt = readFileSync(seedFileFrom(o.args), "utf8")
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

  it("keeps the continuation order when a pending-CR card lands beside the results: the ROUND decides it, never the thread's last role", async () => {
    writeInTarget(targetRoot, path.join(CHANGE_REQUESTS, "CR-0001-add-csv.md"), wellFormedCr("CR-0001"))
    let leg = 0
    let continuation = ""
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
        return
      }
      continuation = readIncrement(o)
      writeReply(o, "Une seule CR t'attend.")
    })
    const result = await runViviTurn(spawner, { message: "où en sont les CRs ?" })

    expect(readTranscript(result.sessionId).map((t) => t.role)).toEqual(["user", "vivi", "action", "card", "vivi"])
    expect(continuation).toContain("Tool results: ✓ crs.list")
    expect(continuation).toContain("Choice card: CR-0001 — Add CSV export [awaiting the owner's choice]")
    expect(continuation).toContain('The tool results of the actions you just requested are in the "Tool results" entry')
    expect(continuation).not.toContain("Respond to the user's latest message above")
  })

  it("executes a real control side effect through the SAME spawner (workflow.start)", async () => {
    let leg = 0
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      writeReply(o, leg === 1 ? replyWithActions('{"actions": [{"tool": "workflow.start"}]}') : "The build is running.")
    })
    const result = await runViviTurn(spawner, { message: "lance le build" })

    expect(result.actions?.[0]).toMatchObject({ tool: "workflow.start", ok: true })
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
    expect(result.reply).toContain("✓ crs.list")
    expect(result.reply).toContain("→ action round limit (2) reached this turn; the result above is recorded.")
  })

  it("counts the closing round's results in the plural when it ran several", async () => {
    process.env.VIVICY_VIVI_MAX_ROUNDS = "1"
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}, {"tool": "crs.list"}]}'))
    })
    const result = await runViviTurn(spawner, { message: "spin" })

    expect(result.actions).toHaveLength(2)
    expect(result.reply).toContain("→ action round limit (1) reached this turn; the results above are recorded.")
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
    expect(result.rejected).toMatch(/1 action already executed this turn remains in effect/)
    expect(result.wrote).toEqual([])
    expect(result.actions).toHaveLength(1)
    expect(readFileSync(path.join(targetRoot, CANONICAL, "01-product.md"), "utf8")).toBe("original\n")
    expect(existsSync(path.join(targetRoot, ".vivicy", "baselines", "forged.md"))).toBe(false)
  })

  it("counts the executed actions in the plural when the rejected turn ran several", async () => {
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}, {"tool": "crs.list"}]}'))
      } else {
        writeInTarget(targetRoot, path.join(".vivicy", "baselines", "forged.md"), "no\n")
        writeReply(o, "oops")
      }
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.actions).toHaveLength(2)
    expect(result.rejected).toMatch(/2 actions already executed this turn remain in effect/)
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

  it("the prompt carries the deterministic workflow snapshot line", async () => {
    let seenPrompt = ""
    const { spawner } = makeFakeSpawner((o) => {
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "ok")
    })
    await runViviTurn(spawner, { message: "hello" })
    expect(seenPrompt).toContain(
      "Workflow snapshot: run_active=false; extraction=never; skills=never; spec_frozen=false; spec_kind=project."
    )
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
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, replyWithDirective('{"install": ["anthropic/skills@pdf"]}')))
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
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, replyWithDirective('{"install": ["acme/repo@x"]}')))
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
      actions: [
        { id: "go", label: "Start from scratch", action: { kind: "vivi_message", message: "I want to start a new project from scratch." } },
      ],
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

  it("vivi_message reports a turn the leg never answered instead of claiming the message landed", async () => {
    const sessionId = appendCardTurn({
      id: "card-9",
      title: "Start from scratch?",
      actions: [{ id: "go", label: "Start", action: { kind: "vivi_message", message: "I want to start from scratch." } }],
    })
    const { spawner } = makeFakeSpawner((o) => {
      writeFailure(o, `the agent CLI exited 1 — ${RESUME_FAILURE}`)
      return { code: 1, stdout: "", stderr: "" }
    })

    const result = await decideCardAction(spawner, { sessionId, cardId: "card-9", actionId: "go" })

    expect(result.ok).toBe(false)
    expect(result.summary).toContain("Vivi's turn could not run")
    expect(result.reply?.orchestratorNote).toBe(true)
    expect(readTranscript(sessionId).map((t) => t.role)).toEqual(["card", "user", "note"])
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
    await expect(decideCardAction(spawner, { sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import" })).rejects.toThrow(
      /imports documents/
    )
    expect(readTranscript(sessionId)[0].decided).toBeUndefined()
  })
})

const IMPORT_ENGLISH = "The quick brown fox jumps over the lazy dog near the riverbank every single morning without fail. ".repeat(6)
const IMPORT_PLANTED_KEY = "sk-ant-" + "api03-Qz7Rp2Kw9Vn4Bh6Tm1Yj3Lf5Gd8Sx0UaWc"

function docEntry(rel: string, text: string): RawEntry {
  return { rel, name: path.basename(rel), bytes: new Uint8Array(Buffer.from(text, "utf8")) }
}

// The reading turn is detached: every import test MUST settle it, or a background turn outlives the temp target.
async function settleTranscript(sessionId: string, turns: number): Promise<ViviTurn[]> {
  return vi.waitFor(() => {
    const settled = readTranscript(sessionId)
    if (settled.length < turns) throw new Error(`transcript has ${settled.length} of ${turns} turns`)
    if (settled.some((t) => t.imported?.read?.status === "pending")) throw new Error("a reading turn is still pending")
    return settled
  })
}

function viviLegRuns(calls: Array<{ args: string[] }>): number {
  return calls.filter((c) => c.args.some((a) => a.endsWith("vivi-turn.ts"))).length
}

function viviSessionDir(): string {
  return path.join(getProjectRuntimeDir(targetRoot), "vivi")
}

function projectSettingsFile(): string {
  return path.join(targetRoot, ".vivicy", "settings.json")
}

// Guaranteed-dead pid: spawnSync returns only after the child is reaped.
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid
}

function stampReadOnDisk(sessionId: string, batchId: string, read: unknown): void {
  const turns = readTranscript(sessionId).map((turn) =>
    turn.imported?.batchId === batchId ? { ...turn, imported: { ...turn.imported, read } } : turn
  )
  writeFileSync(path.join(viviSessionDir(), `${sessionId}.jsonl`), `${turns.map((t) => JSON.stringify(t)).join("\n")}\n`)
}

function batchOf(result: SessionImportResult): BatchResult {
  return {
    batchId: result.batchId,
    targetPath: targetRoot,
    language: result.language,
    cycle: result.cycle,
    accepted: result.accepted,
    rejected: result.rejected,
    findings: [],
  }
}

describe("decideCardImport (welcome-card document import into the current project)", () => {
  it("imports the batch, appends a deterministic Vivi acknowledgment, and stamps the card decided", async () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "Read them: here is what they say."))

    const result = await decideCardImport(spawner, {
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

    const turns = await settleTranscript(sessionId, 4)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "card", "vivi", "vivi"])
    expect(turns[1].decided?.actionId).toBe("import")
    expect(turns[1].decided?.summary).toBe(result.summary)
    expect(turns[2].text).toContain("2 documents")
    expect(turns[2].text).toContain("English")
    expect(turns[2].text).not.toMatch(/what are you building/i)
    expect(turns[2].text).not.toMatch(/nothing for you to check/i)
    expect(turns[2].imported).toEqual({
      batchId: result.batchId,
      files: ["brief.md", "data.csv"],
      read: { status: "done" },
    })
    expect(turns[3].text).toBe("Read them: here is what they say.")
  })

  it("names a single document and omits the language clause when nothing is scannable", async () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    const result = await decideCardImport(spawner, {
      sessionId,
      cardId: WELCOME_IMPORT_CARD.id,
      actionId: "import",
      entries: [docEntry("scan.pdf", "%PDF-1.4 binary-ish")],
    })
    expect(result.summary).toBe("1 document imported")
    const ack = readTranscript(sessionId)[2].text
    expect(ack).toContain("1 document is now in the kitchen")
    expect(ack).not.toContain(", in ")
    await settleTranscript(sessionId, 4)
  })

  it("refuses a second import (the card is already decided) and refuses a non-import action", async () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    await decideCardImport(spawner, {
      sessionId,
      cardId: WELCOME_IMPORT_CARD.id,
      actionId: "import",
      entries: [docEntry("a.md", IMPORT_ENGLISH)],
    })
    await settleTranscript(sessionId, 4)

    const again = await decideCardImport(spawner, {
      sessionId,
      cardId: WELCOME_IMPORT_CARD.id,
      actionId: "import",
      entries: [docEntry("b.md", IMPORT_ENGLISH)],
    })
    expect(again.ok).toBe(false)
    expect(again.summary).toContain("already decided")

    const controlSession = appendCardTurn({
      id: "control-card",
      title: "T",
      actions: [{ id: "list", label: "List", action: { kind: "control", tool: "crs.list" } }],
    })
    await expect(
      decideCardImport(spawner, {
        sessionId: controlSession,
        cardId: "control-card",
        actionId: "list",
        entries: [docEntry("a.md", IMPORT_ENGLISH)],
      })
    ).rejects.toThrow(/not a document import/)
  })

  it("leaves the card undecided when the upload has no supported file, so the owner can retry", async () => {
    const sessionId = seedViviWelcome()
    appendCardTurn(WELCOME_IMPORT_CARD, sessionId)
    const { spawner, calls } = makeFakeSpawner()
    await expect(
      decideCardImport(spawner, { sessionId, cardId: WELCOME_IMPORT_CARD.id, actionId: "import", entries: [docEntry("a.exe", "x")] })
    ).rejects.toMatchObject({ code: "no_supported_files" })

    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "card"])
    expect(turns[1].decided).toBeUndefined()
    expect(existsSync(path.join(targetRoot, UPLOADS_DIR))).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(0)
  })
})

describe("importDocsIntoSession (standing composer import into the current project)", () => {
  it("imports into the active cycle pre-freeze, appends the reading-promise ack, and reuses the passed session", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "Synthesis of your brief."))

    const result = await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("brief.md", IMPORT_ENGLISH), docEntry("data.csv", "a,b\n1,2\n"), docEntry("skip.exe", "x")],
    })

    expect(result.ok).toBe(true)
    expect(result.sessionId).toBe(sessionId)
    expect(result.cycle).toEqual({ binding: "active", id: "project" })
    expect(result.language).toBe("eng")
    expect(result.accepted.map((f) => f.path).sort()).toEqual(["brief.md", "data.csv"])
    expect(result.rejected).toEqual([{ path: "skip.exe", code: "unsupported_type" }])
    expect(result.summary).toBe("2 documents imported · English · 1 skipped")

    const batchDir = path.join(targetRoot, UPLOADS_DIR, result.batchId)
    expect(existsSync(path.join(batchDir, "manifest.json"))).toBe(true)

    const turns = await settleTranscript(sessionId, 3)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "vivi", "vivi"])
    const ack = turns[1].text
    expect(ack).toContain("2 documents, in English, are now in the kitchen")
    expect(ack).toContain("reading them cover to cover right now")
    expect(ack).not.toMatch(/what are you building/i)
    expect(ack).not.toMatch(/nothing for you to check|fold them into the spec/i)
    expect(turns[2].text).toBe("Synthesis of your brief.")
  })

  it("seeds the NEXT cycle when the canonical is frozen and says so honestly, and still reads the batch", async () => {
    seedFrozenBaseline(targetRoot)
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "Read; here is what it would change."))

    const result = await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("notes.md", IMPORT_ENGLISH)],
    })

    expect(result.ok).toBe(true)
    expect(result.cycle).toEqual({ binding: "seed" })

    const turns = await settleTranscript(sessionId, 3)
    const ack = turns[1].text
    expect(ack).toContain("1 document, in English, is now in the kitchen")
    expect(ack).toContain("frozen")
    expect(ack).toContain("NEXT cycle")
    expect(ack).toContain("reading it cover to cover right now")
    expect(ack).not.toMatch(/what are you building|nothing for you to check/i)
    expect(turns.at(-1)!.text).toBe("Read; here is what it would change.")
  })

  it("mints a session the client adopts when none is passed", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    const result = await importDocsIntoSession(spawner, { entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    expect(result.sessionId).toMatch(/[0-9a-f-]{36}/)
    expect(readTranscript(result.sessionId)[0].text).toContain("in the kitchen")
    const turns = await settleTranscript(result.sessionId, 2)
    expect(turns.map((t) => t.role)).toEqual(["vivi", "vivi"])
  })

  it("names a planted secret and the fix in the ack (redacted), without blocking the import", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    const result = await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("brief.md", `${IMPORT_ENGLISH}\n\n${IMPORT_PLANTED_KEY}\n`)],
    })
    expect(result.ok).toBe(true)
    const ack = readTranscript(sessionId)[1].text
    expect(ack).toContain("in the kitchen")
    expect(ack).toContain(
      "⚠ Attenzione — I spotted what looks like a real secret key in 1 file: brief.md:3 (sk-a…). A credential must never live in the spec or in git history, so please remove or rotate it and re-import the cleaned file before we build."
    )
    expect(ack).not.toContain(IMPORT_PLANTED_KEY)
    await settleTranscript(sessionId, 3)
  })

  it("names several planted secrets in the plural, still redacted", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    await importDocsIntoSession(spawner, {
      sessionId,
      entries: [
        docEntry("brief.md", `${IMPORT_ENGLISH}\n\n${IMPORT_PLANTED_KEY}\n`),
        docEntry("notes.md", `${IMPORT_ENGLISH}\n\n${IMPORT_PLANTED_KEY}\n`),
      ],
    })
    const ack = readTranscript(sessionId)[1].text
    expect(ack).toContain(
      "⚠ Attenzione — I spotted what look like real secret keys in 2 files: brief.md:3 (sk-a…), notes.md:3 (sk-a…). A credential must never live in the spec or in git history, so please remove or rotate them and re-import the cleaned files before we build."
    )
    expect(ack).not.toContain(IMPORT_PLANTED_KEY)
    await settleTranscript(sessionId, 3)
  })

  it("counts the secrets past the listing cap instead of trailing off", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    await importDocsIntoSession(spawner, {
      sessionId,
      entries: Array.from({ length: 7 }, (_, i) => docEntry(`leak-${i}.md`, `${IMPORT_ENGLISH}\n\n${IMPORT_PLANTED_KEY}\n`)),
    })
    expect(readTranscript(sessionId)[1].text).toContain(
      "in 7 files: leak-0.md:3 (sk-a…), leak-1.md:3 (sk-a…), leak-2.md:3 (sk-a…), leak-3.md:3 (sk-a…), leak-4.md:3 (sk-a…), and 2 more. A credential must never live"
    )
    await settleTranscript(sessionId, 3)
  })

  it("a clean import ack carries no secret warning clause", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    await importDocsIntoSession(spawner, { sessionId, entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    expect(readTranscript(sessionId)[1].text).not.toContain("Attenzione")
    await settleTranscript(sessionId, 3)
  })

  it("throws before writing anything when the upload has no supported file", async () => {
    const sessionId = seedViviWelcome()
    const { spawner, calls } = makeFakeSpawner()
    await expect(importDocsIntoSession(spawner, { sessionId, entries: [docEntry("a.exe", "x")] })).rejects.toMatchObject({
      code: "no_supported_files",
    })

    expect(readTranscript(sessionId).map((t) => t.role)).toEqual(["vivi"])
    expect(existsSync(path.join(targetRoot, UPLOADS_DIR))).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(0)
  })
})

describe("the import acknowledgment's English (both cycle bindings × both counts, verbatim)", () => {
  async function ackOf(files: string[]): Promise<string> {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, "read"))
    const result = await importDocsIntoSession(spawner, {
      entries: files.map((f) => docEntry(f, IMPORT_ENGLISH)),
    })
    return (await settleTranscript(result.sessionId, 2))[0].text
  }

  it("an active cycle: one document is in the kitchen and read, several documents are", async () => {
    expect(await ackOf(["brief.md"])).toBe(
      "Perfetto — 1 document, in English, is now in the kitchen. I'm reading it cover to cover right now — un attimo — then I'll tell you what's inside and what's still open."
    )
    expect(await ackOf(["brief.md", "notes.md"])).toBe(
      "Perfetto — 2 documents, in English, are now in the kitchen. I'm reading them cover to cover right now — un attimo — then I'll tell you what's inside and what's still open."
    )
  })

  it("a frozen canonical: the seed batch feeds the NEXT cycle, one document or several", async () => {
    seedFrozenBaseline(targetRoot)
    expect(await ackOf(["brief.md"])).toBe(
      "Perfetto — 1 document, in English, is now in the kitchen. The canonical spec is frozen and building right now, so it feeds the NEXT cycle rather than the frozen corpus. I'm reading it cover to cover right now — un attimo — then I'll tell you what's inside and what's still open."
    )
    expect(await ackOf(["brief.md", "notes.md"])).toBe(
      "Perfetto — 2 documents, in English, are now in the kitchen. The canonical spec is frozen and building right now, so they feed the NEXT cycle rather than the frozen corpus. I'm reading them cover to cover right now — un attimo — then I'll tell you what's inside and what's still open."
    )
  })
})

describe("the auto-dispatched reading turn (importing documents IS the request)", () => {
  it("orders the read of the exact batch, names every file, and never asks the user what they are building", async () => {
    const sessionId = seedViviWelcome()
    const prompts: string[] = []
    const { spawner, calls } = makeFakeSpawner((o) => {
      prompts.push(readFileSync(seedFileFrom(o.args), "utf8"))
      writeReply(o, "Here is what your two documents say.")
    })

    const result = await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("brief.md", IMPORT_ENGLISH), docEntry("notes/extra.md", IMPORT_ENGLISH)],
    })
    await settleTranscript(sessionId, 3)

    expect(viviLegRuns(calls.run)).toBe(1)
    expect(prompts).toHaveLength(1)
    const prompt = prompts[0]
    expect(prompt).toContain(`.vivicy/uploads/${result.batchId}`)
    expect(prompt).toContain("- brief.md")
    expect(prompt).toContain("- notes/extra.md")
    expect(prompt).toMatch(/the import IS the request/i)
    expect(prompt).toMatch(/under your document-intake law/i)
    expect(prompt).toMatch(/only the questions the corpus leaves open/i)
    expect(prompt).not.toMatch(/Respond to the user's latest message/)
  })

  it("orders a Change Request instead of a canonical write when the batch lands on a frozen canonical", async () => {
    seedFrozenBaseline(targetRoot)
    const sessionId = seedViviWelcome()
    const prompts: string[] = []
    const { spawner } = makeFakeSpawner((o) => {
      prompts.push(readFileSync(seedFileFrom(o.args), "utf8"))
      writeReply(o, "read")
    })

    await importDocsIntoSession(spawner, { sessionId, entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    await settleTranscript(sessionId, 3)

    expect(prompts[0]).toContain("spec_frozen: true")
    expect(prompts[0]).toMatch(/draft ONE Change Request/)
    expect(prompts[0]).toContain("CR-0001")
    expect(prompts[0]).not.toMatch(/write or update the canonical docs/)
  })

  it("fires exactly once per batch: the transcript claim makes a replayed dispatch a no-op", async () => {
    const sessionId = seedViviWelcome()
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, "read"))

    const result = await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("a.md", IMPORT_ENGLISH)],
    })
    const turns = await settleTranscript(sessionId, 3)
    expect(viviLegRuns(calls.run)).toBe(1)

    const replayed = await dispatchImportRead(spawner, { sessionId, batch: batchOf(result) })

    expect(replayed).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(1)
    expect(readTranscript(sessionId)).toEqual(turns)
    // The whole directory, never a name filter: a filter keyed on the publish temp's spelling goes vacuous the day that spelling changes.
    expect(readdirSync(viviSessionDir())).toEqual([`${sessionId}.jsonl`])
  })

  it("reads the corpus handed over AT governance: the seeded welcome is claimable, once, and a replay after reload adds nothing", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, "Both read, cover to cover."))
    const batch = await importIntoGoverned({
      root: targetRoot,
      entries: [docEntry("cdc.md", IMPORT_ENGLISH), docEntry("annexe.md", IMPORT_ENGLISH)],
    })
    const sessionId = seedViviWelcome(batch)

    expect(await dispatchImportRead(spawner, { sessionId, batch })).toBe(true)
    const turns = await settleTranscript(sessionId, 2)

    expect(turns.map((t) => t.role)).toEqual(["vivi", "vivi"])
    expect(turns[0].imported?.read).toEqual({ status: "done" })
    expect(turns[1].text).toBe("Both read, cover to cover.")
    expect(viviLegRuns(calls.run)).toBe(1)

    expect(await dispatchImportRead(spawner, { sessionId, batch })).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(1)
    expect(readTranscript(sessionId)).toEqual(turns)
  })

  it("picks a read back up when the process holding it died, exactly once, and never while its owner is alive", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, "Picked it back up — here is what they say."))
    const batch = await importIntoGoverned({ root: targetRoot, entries: [docEntry("cdc.md", IMPORT_ENGLISH)] })
    const sessionId = seedViviWelcome(batch)

    stampReadOnDisk(sessionId, batch.batchId, { status: "pending", pid: process.pid })
    expect(recoverInterruptedReads(spawner, sessionId)).toBe(0)
    expect(await dispatchImportRead(spawner, { sessionId, batch })).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(0)
    expect(readTranscript(sessionId)).toHaveLength(1)

    stampReadOnDisk(sessionId, batch.batchId, { status: "pending", pid: deadPid() })
    expect(recoverInterruptedReads(spawner, sessionId)).toBe(1)
    const turns = await settleTranscript(sessionId, 3)

    expect(turns.map((t) => t.role)).toEqual(["vivi", "vivi", "vivi"])
    expect(turns[1].text).toBe(
      "My reading of that document was cut short — Vivicy stopped while I was still in it. Nothing is lost: I'm picking it straight back up."
    )
    expect(turns[2].text).toBe("Picked it back up — here is what they say.")
    expect(turns[0].imported?.read).toEqual({ status: "done" })
    expect(viviLegRuns(calls.run)).toBe(1)

    expect(recoverInterruptedReads(spawner, sessionId)).toBe(0)
    expect(await dispatchImportRead(spawner, { sessionId, batch })).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(1)
  })

  it("exposes the target's turn liveness, so a thread awaiting a reply nobody is producing is detectable", async () => {
    let duringTurn: boolean | null = null
    const { spawner } = makeFakeSpawner((o) => {
      duringTurn = isViviTurnRunning(targetRoot)
      writeReply(o, "answered")
    })

    expect(isViviTurnRunning(targetRoot)).toBe(false)
    await runViviTurn(spawner, { message: "hello" })

    expect(duringTurn).toBe(true)
    expect(isViviTurnRunning(targetRoot)).toBe(false)
  })

  it("never dispatches a batch no turn claims", async () => {
    const sessionId = seedViviWelcome()
    const { spawner, calls } = makeFakeSpawner()
    const batch = await importIntoGoverned({ root: targetRoot, entries: [docEntry("a.md", IMPORT_ENGLISH)] })

    expect(await dispatchImportRead(spawner, { sessionId, batch })).toBe(false)
    expect(viviLegRuns(calls.run)).toBe(0)
    expect(readTranscript(sessionId)).toHaveLength(1)
  })

  it("says so in the thread as the orchestrator's own note when the reading turn cannot run at all, instead of leaving it silently pending", async () => {
    const sessionId = seedViviWelcome()
    const { spawner, calls } = makeFakeSpawner()
    rmSync(path.join(factoryRoot, "vivi-turn.ts"))

    await importDocsIntoSession(spawner, { sessionId, entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    const turns = await settleTranscript(sessionId, 3)

    expect(viviLegRuns(calls.run)).toBe(0)
    expect(turns[1].imported?.read).toEqual({ status: "done" })
    expect(turns[2].role).toBe("note")
    expect(turns[2].text).toMatch(/^Vivi could not read the document just imported/)
    expect(turns[2].text).toMatch(/It is safe in the kitchen — ask her to read it and she picks it straight up\.$/)
    expect(turns[2].text).toMatch(/vivi-turn\.ts/)
  })

  it("words the note for a READING turn whose leg fails: there is no message to re-send, so it says where the documents are", async () => {
    const sessionId = seedViviWelcome()
    const { spawner } = makeFakeSpawner((o) => {
      writeFailure(o, `the agent CLI exited 1 — ${RESUME_FAILURE}`)
      return { code: 1, stdout: "", stderr: "" }
    })

    await importDocsIntoSession(spawner, {
      sessionId,
      entries: [docEntry("a.md", IMPORT_ENGLISH), docEntry("b.md", IMPORT_ENGLISH)],
    })
    const turns = await settleTranscript(sessionId, 3)

    expect(turns[2].role).toBe("note")
    expect(turns[2].text).toBe(
      `Vivi could not read the documents just imported: the agent CLI exited 1 — ${RESUME_FAILURE}. They are safe in the kitchen — ask her to read them and she picks them straight up.`
    )
    expect(turns[2].text).not.toContain("send it again")
  })

  it("serializes turns on one target so a reading turn and the owner's next message never roll each other back", async () => {
    const sessionId = seedViviWelcome()
    const order: string[] = []
    const spawner: Spawner = {
      spawnDetached: () => ({ pid: 1 }),
      run: async (options) => {
        const reading = readFileSync(seedFileFrom(options.args), "utf8").includes("the import IS the request")
        const who = reading ? "read" : "message"
        order.push(`${who}:start`)
        // The asymmetric delay is what discriminates: with both legs equal-speed the order assertion would pass unserialized too.
        await new Promise((resolve) => setTimeout(resolve, reading ? 40 : 0))
        order.push(`${who}:end`)
        writeReply(options, reading ? "READ" : "ANSWER")
        return { code: 0, lastLine: "", stdout: "", stderr: "" }
      },
      killGroup: () => true,
      isAlive: () => false,
    }

    await importDocsIntoSession(spawner, { sessionId, entries: [docEntry("a.md", IMPORT_ENGLISH)] })
    await runViviTurn(spawner, { sessionId, message: "Any questions for me?" })
    const turns = await settleTranscript(sessionId, 5)

    expect(order).toEqual(["read:start", "read:end", "message:start", "message:end"])
    expect(turns.map((t) => t.role)).toEqual(["vivi", "vivi", "user", "vivi", "vivi"])
    expect(turns.map((t) => t.text).slice(-2)).toEqual(["READ", "ANSWER"])
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

  it("greets a governance-with-corpus session with the same intro plus the import acknowledgment — never the what-are-you-building question", async () => {
    const batch = await importIntoGoverned({
      root: targetRoot,
      entries: [docEntry("brief.md", IMPORT_ENGLISH), docEntry("notes.md", IMPORT_ENGLISH)],
    })
    const sessionId = seedViviWelcome(batch)

    const turns = readTranscript(sessionId)
    expect(turns).toHaveLength(1)
    expect(turns[0].role).toBe("vivi")
    expect(turns[0].text).toContain("Ciao, I'm Vivi")
    expect(turns[0].text).toContain("2 documents, in English, are now in the kitchen")
    expect(turns[0].text).toContain("reading them cover to cover right now")
    expect(turns[0].text).not.toMatch(/what do you want to build|what are you building/i)
    expect(turns[0].imported).toEqual({ batchId: batch.batchId, files: ["brief.md", "notes.md"] })
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
      seenPrompt = readFileSync(seedFileFrom(o.args), "utf8")
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

  it("names the executed actions on a TAMPER rejection too, and still restores the owner's pre-turn bytes from the turn-start capture", async () => {
    gitCommitFile(targetRoot, path.join("src", "wip.ts"), "export const a = 1\n")
    writeInTarget(targetRoot, path.join("src", "wip.ts"), "export const a = 2 // owner wip\n")
    let leg = 0
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithActions('{"actions": [{"tool": "crs.list"}]}'))
        return
      }
      writeInTarget(targetRoot, path.join("src", "wip.ts"), "export const a = 666 // vivi was here\n")
      writeReply(o, "tidied your work in progress")
    })
    const result = await runViviTurn(spawner, { message: "go" })

    expect(result.rejected).toMatch(/modified your uncommitted work in progress \(src\/wip\.ts\)/)
    expect(result.rejected).toMatch(/1 action already executed this turn remains in effect/)
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

const QUESTION_CARDS = JSON.stringify([
  {
    id: "datastore",
    question: "Which datastore should v1 run on?",
    options: [{ label: "SQLite" }, { label: "Postgres", recommended: true }, { label: "MongoDB" }],
    allowOther: true,
  },
  {
    id: "auth",
    question: "How do people sign in?",
    options: [{ label: "Email + password", recommended: true }, { label: "Magic link" }],
    allowOther: true,
  },
])

function replyWithQuestions(json: string, lead = "Due cose, poi si cucina."): string {
  return `${lead}\n\n\`\`\`vivicy-questions\n${json}\n\`\`\``
}

async function settleDispatchedTurn(): Promise<void> {
  for (let i = 0; i < 400 && isViviTurnRunning(targetRoot); i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function stackedSession(spawner: Spawner, json = QUESTION_CARDS): Promise<{ sessionId: string; stackId: string }> {
  const result = await runViviTurn(spawner, { message: "on part sur quoi ?" })
  const stack = readTranscript(result.sessionId).find((t) => t.role === "questions")?.questions
  if (!stack) throw new Error(`no question stack in the transcript for ${json}`)
  return { sessionId: result.sessionId, stackId: stack.id }
}

describe("question cards — the validated fence becomes a pile in the thread", () => {
  it("appends the stack as its own turn, mints the stack id server-side, and keeps the fence out of her prose", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const result = await runViviTurn(spawner, { message: "un todo app" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toBe("Due cose, poi si cucina.")
    expect(result.reply).not.toContain("vivicy-questions")

    const turns = readTranscript(result.sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "vivi", "questions"])
    expect(turns[1].text).toBe("Due cose, poi si cucina.")
    const stack = turns[2].questions!
    expect(stack.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(stack.id).not.toContain("datastore")
    expect(turns[2].text).toBe("2 question cards")
    expect(stack.questions.map((q) => q.id)).toEqual(["datastore", "auth"])
    expect(stack.questions[0].options[0]).toEqual({ label: "Postgres", recommended: true })
  })

  it("drops a malformed fence WHOLE, keeps her prose, and says so once — no half a pile", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions('[{"id": "a",}]')))
    const result = await runViviTurn(spawner, { message: "vas-y" })

    expect(result.rejected).toBeUndefined()
    expect(result.reply).toContain("Due cose, poi si cucina.")
    expect(result.reply).toContain("no question cards rendered: the vivicy-questions block is not valid JSON")
    expect(result.reply).not.toContain("vivicy-questions\n")
    expect(readTranscript(result.sessionId).some((t) => t.role === "questions")).toBe(false)
  })

  it("skips the empty bubble when the reply is the fence and nothing else", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS, "")))
    const result = await runViviTurn(spawner, { message: "vas-y" })

    expect(readTranscript(result.sessionId).map((t) => t.role)).toEqual(["user", "questions"])
  })

  it("answering an option appends ONE ordinary user turn carrying the SERVER-held label, and nothing else", async () => {
    const { spawner, calls } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)
    const legsBefore = legRuns(calls).length

    const outcome = answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 0 })

    expect(outcome).toEqual({ ok: true, summary: "Postgres", answer: "Postgres", remaining: 1 })
    const turns = readTranscript(sessionId)
    expect(turns.map((t) => t.role)).toEqual(["user", "vivi", "questions", "user"])
    expect(turns[3].text).toBe("Which datastore should v1 run on? → Postgres")
    expect(turns[3].answered).toEqual({ stackId, questionId: "datastore" })
    expect(turns[3].actions).toBeUndefined()
    expect(legRuns(calls)).toHaveLength(legsBefore)
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("answering in the owner's own words appends their words, whitespace-normalized", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)

    const outcome = answerViviQuestion(spawner, {
      sessionId,
      stackId,
      questionId: "datastore",
      other: "  DuckDB,\n  embedded  ",
    })

    expect(outcome).toMatchObject({ ok: true, answer: "DuckDB, embedded" })
    expect(readTranscript(sessionId).at(-1)?.text).toBe("Which datastore should v1 run on? → DuckDB, embedded")
  })

  it("puts a pasted free answer through the same boundary strip as her labels", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)

    const outcome = answerViviQuestion(spawner, {
      sessionId,
      stackId,
      questionId: "datastore",
      other: "Post​gres‮ ⁦managed⁩",
    })

    expect(outcome).toMatchObject({ ok: true, answer: "Postgres managed" })
    expect(readTranscript(sessionId).at(-1)?.text).not.toMatch(/[​‮⁦⁩]/)
  })

  it.each([
    ["family emoji (ZWJ)", "Un Raspberry Pi chez moi \uD83D\uDC68\u200D\uD83D\uDC69\u200D\uD83D\uDC67"],
    ["Persian mi-ravad (ZWNJ)", "\u0645\u06CC\u200C\u0631\u0648\u062F"],
    ["Devanagari k-ssa (ZWJ)", "\u0915\u094D\u200D\u0937"],
  ])("records a free answer carrying a joiner byte-identical, as typing it would: %s", async (_name, typed) => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)

    const outcome = answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", other: typed })

    expect(outcome).toMatchObject({ ok: true, answer: typed })
    expect(readTranscript(sessionId).at(-1)?.text).toBe(`Which datastore should v1 run on? \u2192 ${typed}`)
  })

  it("refuses a second answer to the same card without appending a second line", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 1 })

    const replay = answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 2 })

    expect(replay).toMatchObject({ ok: false, remaining: 1 })
    expect(replay.summary).toContain("already answered")
    expect(readTranscript(sessionId).filter((t) => t.answered?.questionId === "datastore")).toHaveLength(1)
    expect(readTranscript(sessionId).at(-1)?.text).toContain("SQLite")
  })

  it("refuses an unknown stack, an unknown question, an out-of-range option, and a doubly-shaped answer", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)
    const answer = (over: Record<string, unknown>) => answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", ...over })

    expect(() => answerViviQuestion(spawner, { sessionId, stackId: "nope", questionId: "datastore", optionIndex: 0 })).toThrow(ControlError)
    expect(() => answer({ questionId: "ghost", optionIndex: 0 })).toThrow(/unknown question "ghost"/)
    expect(() => answer({ optionIndex: 3 })).toThrow(/one of its 3 options/)
    expect(() => answer({ optionIndex: -1 })).toThrow(/one of its 3 options/)
    expect(() => answer({})).toThrow(/one of its 3 options/)
    expect(() => answer({ optionIndex: 0, other: "both" })).toThrow(/never both/)
    expect(() => answer({ other: "   " })).toThrow(/write an answer/)
    expect(() => answer({ other: "x".repeat(401) })).toThrow(/keep it under 400/)
    expect(readTranscript(sessionId).filter((t) => t.answered !== undefined)).toHaveLength(0)
  })

  it("rejects an invalid session id before touching a transcript path", () => {
    const { spawner } = makeFakeSpawner()
    expect(() =>
      answerViviQuestion(spawner, {
        sessionId: "../../etc/passwd",
        stackId: "s",
        questionId: "q",
        optionIndex: 0,
      })
    ).toThrow(/invalid vivi session id/)
  })

  it("only the answer that empties the pile dispatches the continuation turn — exactly once, with the answers as the message", async () => {
    let leg = 0
    let continuationPrompt = ""
    const { spawner, calls } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithQuestions(QUESTION_CARDS))
        return
      }
      continuationPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "Perfetto — Postgres e magic link, je note.")
    })
    const { sessionId, stackId } = await stackedSession(spawner)

    answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 0 })
    expect(legRuns(calls)).toHaveLength(1)

    const last = answerViviQuestion(spawner, { sessionId, stackId, questionId: "auth", optionIndex: 1 })
    expect(last.remaining).toBe(0)
    await settleDispatchedTurn()

    expect(legRuns(calls)).toHaveLength(2)
    expect(continuationPrompt).toContain("Which datastore should v1 run on? → Postgres")
    expect(continuationPrompt).toContain("How do people sign in? → Magic link")
    expect(continuationPrompt).toContain("never re-ask a card that already carries its line")
    expect(continuationPrompt).toContain("Question cards")
    expect(continuationPrompt).toContain("1. Which datastore should v1 run on? [answered above]")
    expect(readTranscript(sessionId).at(-1)?.text).toBe("Perfetto — Postgres e magic link, je note.")
  })

  it("carries the owner's own words into the continuation prompt WHOLE — a MAX-length free answer and a 199+79 option line alike", async () => {
    let leg = 0
    let continuationPrompt = ""
    const question = `Quelle est la regle ${"x".repeat(178)}?`
    const label = `Toujours ${"y".repeat(70)}`
    expect(question).toHaveLength(199)
    expect(label).toHaveLength(79)
    const cards = JSON.stringify([
      { id: "rule", question, options: [{ label, recommended: true }, { label: "Jamais" }] },
      {
        id: "auth",
        question: "How do people sign in?",
        options: [{ label: "Email + password", recommended: true }, { label: "Magic link" }],
        allowOther: true,
      },
    ])
    const { spawner } = makeFakeSpawner((o) => {
      if (!o.args.some((a) => a.endsWith("vivi-turn.ts"))) return
      leg += 1
      if (leg === 1) {
        writeReply(o, replyWithQuestions(cards))
        return
      }
      continuationPrompt = readFileSync(seedFileFrom(o.args), "utf8")
      writeReply(o, "Ricevuto.")
    })
    const { sessionId, stackId } = await stackedSession(spawner, cards)

    const head = "On facture a la main les dix premiers clients, "
    const tail = ", mais seulement quand on depasse trente commandes par jour"
    const long = `${head}${"e".repeat(MAX_OTHER_ANSWER_LENGTH - head.length - tail.length)}${tail}`
    expect(long).toHaveLength(MAX_OTHER_ANSWER_LENGTH)
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "auth", other: long })
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "rule", optionIndex: 0 })
    await settleDispatchedTurn()

    const rendered = transcriptSection(continuationPrompt)
    expect(rendered).toContain(`How do people sign in? \u2192 ${long}`)
    expect(rendered).toContain(`${question} \u2192 ${label}`)
    expect(rendered).not.toContain("\u2026")
  })

  it("survives a reload mid-stack: the standing pile and the answered lines are exactly what the thread holds", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "auth", optionIndex: 0 })

    const reloaded = readTranscript(sessionId)
    const stack = reloaded.find((t) => t.role === "questions")!.questions!
    expect(stack.questions).toHaveLength(2)
    expect(remainingQuestions(stack, reloaded).map((q) => q.id)).toEqual(["datastore"])
    expect(reloaded.filter((t) => t.answered).map((t) => t.text)).toEqual(["How do people sign in? → Email + password"])
  })

  it("words the note for the ANSWERS continuation when its leg fails: the answers are in the thread, and nothing is re-sendable", async () => {
    let fail = false
    const { spawner } = makeFakeSpawner((o) => {
      if (fail) {
        writeFailure(o, "the agent CLI exited 1 — killed")
        return { code: 1, stdout: "", stderr: "" }
      }
      writeReply(o, replyWithQuestions(QUESTION_CARDS))
    })
    const { sessionId, stackId } = await stackedSession(spawner)
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 0 })
    fail = true
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "auth", optionIndex: 0 })
    await settleDispatchedTurn()

    const last = readTranscript(sessionId).at(-1)!
    expect(last.role).toBe("note")
    expect(last.text).toBe(
      "Vivi could not pick up your answers: the agent CLI exited 1 — killed. They are safe in the thread — send her a message and she carries on from there."
    )
  })

  it("tells the owner in the thread when the continuation cannot run at all — as the orchestrator's note, never in Vivi's voice", async () => {
    const { spawner } = makeFakeSpawner((o) => writeReply(o, replyWithQuestions(QUESTION_CARDS)))
    const { sessionId, stackId } = await stackedSession(spawner)
    answerViviQuestion(spawner, { sessionId, stackId, questionId: "datastore", optionIndex: 0 })
    rmSync(path.join(factoryRoot, "vivi-turn.ts"))

    answerViviQuestion(spawner, { sessionId, stackId, questionId: "auth", optionIndex: 0 })
    await settleDispatchedTurn()

    const last = readTranscript(sessionId).at(-1)!
    expect(last.role).toBe("note")
    expect(last.text).toContain("Vivi could not pick up your answers")
    expect(last.text).toContain("vivi-turn.ts")
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
