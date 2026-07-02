import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ControlError,
  isRunActive,
  readDevStatus,
  readRunState,
  runExtract,
  startSupervisor,
  stopSupervisor,
  type RunResult,
  type Spawner,
} from "@/lib/control"

/**
 * A recording fake spawner so tests assert real control behavior without
 * launching claude/codex. `alivePids` models which detached pids are live.
 */
function makeFakeSpawner(overrides: Partial<Spawner> = {}) {
  const alive = new Set<number>()
  let nextPid = 1000
  const calls = {
    spawnDetached: [] as Array<{ args: string[]; cwd: string; env: NodeJS.ProcessEnv }>,
    run: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
    kill: [] as number[],
  }
  const spawner: Spawner = {
    spawnDetached: (options) => {
      calls.spawnDetached.push({ args: options.args, cwd: options.cwd, env: options.env })
      const pid = nextPid++
      alive.add(pid)
      return { pid }
    },
    run: async (options): Promise<RunResult> => {
      calls.run.push({ args: options.args, env: options.env })
      return { code: 0, lastLine: "OK", stdout: "OK\n", stderr: "" }
    },
    killGroup: (pid) => {
      calls.kill.push(pid)
      alive.delete(pid)
      return true
    },
    isAlive: (pid) => alive.has(pid),
    ...overrides,
  }
  return { spawner, calls, alive }
}

let factoryRoot: string
let targetRoot: string
let runtimeDir: string
let prevCwd: string

/** Build a fake factory dir with the scripts the control plane resolves. */
function scaffoldFactory(root: string) {
  mkdirSync(root, { recursive: true })
  for (const rel of [
    "dev-loop-supervised.mjs",
    "dev-status.mjs",
    "extract-issues.mjs",
  ]) {
    writeFileSync(path.join(root, rel), "// stub\n")
  }
}

beforeEach(() => {
  factoryRoot = mkdtempSync(path.join(tmpdir(), "vivicy-factory-"))
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivicy-target-"))
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-cwd-"))
  scaffoldFactory(factoryRoot)

  process.env.VIVICY_FACTORY_ROOT = factoryRoot
  process.env.VIVICY_TARGET_ROOT = targetRoot
  delete process.env.VIVICY_FAKE_SPAWN

  // getRuntimeDir() is relative to cwd; isolate it per test.
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
})

describe("startSupervisor", () => {
  it("sets the lock and spawns the supervisor with VIVICY_TARGET_ROOT=target", () => {
    const { spawner, calls } = makeFakeSpawner()

    const state = startSupervisor(spawner, "start")

    expect(calls.spawnDetached).toHaveLength(1)
    const call = calls.spawnDetached[0]
    expect(call.args.some((a) => a.endsWith("dev-loop-supervised.mjs"))).toBe(true)
    expect(call.cwd).toBe(factoryRoot)
    expect(call.env.VIVICY_TARGET_ROOT).toBe(targetRoot)

    expect(state.pid).toBeGreaterThan(0)
    expect(state.mode).toBe("start")
    const persisted = readRunState()
    expect(persisted?.pid).toBe(state.pid)
    expect(persisted?.target_root).toBe(targetRoot)
    expect(isRunActive(spawner)).toBe(true)
  })

  it("refuses a double start while a run is active (single-run lock)", () => {
    const { spawner, calls } = makeFakeSpawner()
    startSupervisor(spawner)

    expect(() => startSupervisor(spawner)).toThrow(ControlError)
    try {
      startSupervisor(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("already_running")
    }
    // Only the first start actually spawned.
    expect(calls.spawnDetached).toHaveLength(1)
  })

  it("allows a restart once the prior pid is no longer alive (stale lock)", () => {
    const { spawner, calls, alive } = makeFakeSpawner()
    const first = startSupervisor(spawner)
    alive.delete(first.pid) // process died without a clean stop

    const second = startSupervisor(spawner)
    expect(second.pid).not.toBe(first.pid)
    expect(calls.spawnDetached).toHaveLength(2)
  })

  it("fails clearly when the supervisor script is missing", () => {
    rmSync(path.join(factoryRoot, "dev-loop-supervised.mjs"))
    const { spawner } = makeFakeSpawner()
    expect(() => startSupervisor(spawner)).toThrow(/not found/)
    try {
      startSupervisor(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("missing_script")
    }
  })

  it("holds the lock atomically before the spawn returns", () => {
    // Inspect the lock from inside spawnDetached: the claim must already exist.
    let lockedDuringSpawn = false
    const { spawner } = makeFakeSpawner({
      spawnDetached: () => {
        lockedDuringSpawn = readRunState() !== null
        return { pid: 5555 }
      },
      isAlive: (pid) => pid === 5555,
    })
    startSupervisor(spawner)
    expect(lockedDuringSpawn).toBe(true)
  })

  it("releases the lock when the spawn throws so a retry can proceed", () => {
    let attempts = 0
    const { spawner } = makeFakeSpawner({
      spawnDetached: () => {
        attempts += 1
        if (attempts === 1) throw new Error("boom")
        return { pid: 6000 }
      },
      isAlive: (pid) => pid === 6000,
    })

    expect(() => startSupervisor(spawner)).toThrow(/failed to spawn/)
    // Lock was released; the retry succeeds.
    expect(readRunState()).toBeNull()
    const state = startSupervisor(spawner)
    expect(state.pid).toBe(6000)
  })

  it("fails clearly when the target root does not exist", () => {
    rmSync(targetRoot, { recursive: true, force: true })
    const { spawner } = makeFakeSpawner()
    try {
      startSupervisor(spawner)
      throw new Error("expected throw")
    } catch (error) {
      expect((error as ControlError).code).toBe("missing_target")
    }
  })
})

describe("stopSupervisor", () => {
  it("kills the recorded pid and clears the lock", () => {
    const { spawner, calls } = makeFakeSpawner()
    const state = startSupervisor(spawner)

    const result = stopSupervisor(spawner)

    expect(result.pid).toBe(state.pid)
    expect(calls.kill).toContain(state.pid)
    expect(readRunState()).toBeNull()
    expect(isRunActive(spawner)).toBe(false)
  })

  it("refuses to stop when nothing is recorded", () => {
    const { spawner } = makeFakeSpawner()
    try {
      stopSupervisor(spawner)
      throw new Error("expected throw")
    } catch (error) {
      expect((error as ControlError).code).toBe("not_running")
    }
  })
})

describe("resume", () => {
  it("resumes by spawning again and records mode=resume", () => {
    const { spawner } = makeFakeSpawner()
    const started = startSupervisor(spawner)
    stopSupervisor(spawner)

    const resumed = startSupervisor(spawner, "resume")
    expect(resumed.mode).toBe("resume")
    expect(resumed.pid).not.toBe(started.pid)
  })
})

describe("readDevStatus", () => {
  it("parses the dev-status JSON and runs it against the target via --dir", async () => {
    const payload = {
      verdict: "RUNNING",
      issues_total: 4,
      issues_done: 1,
      done: ["A"],
      remaining: ["B", "C", "D"],
      active: [],
      process_alive: true,
      idle_seconds: 3,
      gates: { pass: 2, fail: 0 },
    }
    let seenArgs: string[] = []
    let seenDevRoot: string | undefined
    const { spawner } = makeFakeSpawner({
      run: async ({ args, env }) => {
        seenArgs = args
        seenDevRoot = env.VIVICY_TARGET_ROOT
        return { code: 0, lastLine: "}", stdout: JSON.stringify(payload), stderr: "" }
      },
    })

    const status = await readDevStatus(spawner)

    expect(status.issues_total).toBe(4)
    expect(status.issues_done).toBe(1)
    expect(status.verdict).toBe("RUNNING")
    expect(status.run_active).toBe(false)
    // Invoked with --dir <target> --json.
    expect(seenArgs).toContain("--dir")
    expect(seenArgs).toContain(targetRoot)
    expect(seenArgs).toContain("--json")
    expect(seenDevRoot).toBe(targetRoot)
  })

  it("reflects an active run via the lock in run_active", async () => {
    const payload = JSON.stringify({
      verdict: "RUNNING",
      issues_total: 1,
      issues_done: 0,
      done: [],
      remaining: ["A"],
      active: [],
      process_alive: true,
      idle_seconds: 1,
      gates: { pass: 0, fail: 0 },
    })
    const { spawner } = makeFakeSpawner({
      run: async () => ({ code: 0, lastLine: "}", stdout: payload, stderr: "" }),
    })
    startSupervisor(spawner)

    const status = await readDevStatus(spawner)
    expect(status.run_active).toBe(true)
  })

  it("throws a clear error when dev-status returns non-JSON", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => ({ code: 1, lastLine: "boom", stdout: "not json", stderr: "boom" }),
    })
    await expect(readDevStatus(spawner)).rejects.toThrow(/did not return JSON/)
  })
})

/** Write the status file the extraction orchestrator emits, so runExtract reads
 *  the terminal state back exactly as it would in production. */
function writeExtractionStatus(phase: string, summary: string) {
  const file = path.join(targetRoot, ".vivicy/development/reports/extraction-status.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ phase, summary }, null, 2))
}

/** Give the target a real canonical doc so the empty-canonical guard passes. */
function writeCanonicalDoc(name = "01-product.md", body = "# Product\n\nThe product must exist.\n") {
  const file = path.join(targetRoot, ".vivicy", "canonical", name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, body)
}

describe("runExtract empty-canonical guard", () => {
  it("refuses to extract when the canonical directory is missing", async () => {
    const { spawner, calls } = makeFakeSpawner()
    await expect(runExtract(spawner)).rejects.toThrow(/no canonical directory/)
    try {
      await runExtract(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("empty_canonical")
    }
    // The guard fires before any spawn: no agents launched into an empty spec.
    expect(calls.run).toHaveLength(0)
  })

  it("refuses to extract when canonical holds only the scaffold README", async () => {
    writeCanonicalDoc("README.md", "# Canonical Documentation — placeholder\n")
    const { spawner, calls } = makeFakeSpawner()
    await expect(runExtract(spawner)).rejects.toThrow(/only the scaffold README/)
    expect(calls.run).toHaveLength(0)
  })

  it("accepts a real canonical doc even when nested in a subdirectory", async () => {
    writeCanonicalDoc(path.join("areas", "01-core.md"))
    const { spawner } = makeFakeSpawner({
      run: async () => {
        writeExtractionStatus("green", "extraction green")
        return { code: 0, lastLine: "green", stdout: "green\n", stderr: "" }
      },
    })
    const result = await runExtract(spawner)
    expect(result.ok).toBe(true)
  })
})

describe("runExtract", () => {
  beforeEach(() => {
    writeCanonicalDoc()
  })
  it("drives the single extract-issues orchestrator with VIVICY_TARGET_ROOT=target and reports green", async () => {
    let seenScript = ""
    const { spawner } = makeFakeSpawner({
      run: async ({ args, env }) => {
        seenScript = path.basename(args.find((a) => a.endsWith(".mjs")) ?? "")
        expect(env.VIVICY_TARGET_ROOT).toBe(targetRoot)
        // The orchestrator writes its terminal status, then exits 0 on green.
        writeExtractionStatus("green", "extraction green after 1 attempt(s): 8 issue(s)")
        return { code: 0, lastLine: "extraction green", stdout: "extraction green\n", stderr: "" }
      },
    })

    const result = await runExtract(spawner)

    expect(seenScript).toBe("extract-issues.mjs")
    expect(result.ok).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.status).toBe("green")
    expect(result.summary).toMatch(/8 issue/)
  })

  it("surfaces the blocked case honestly when the orchestrator stays red", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => {
        writeExtractionStatus("extraction_blocked", "extraction_blocked: checks still red after 4 attempt(s)")
        return { code: 1, lastLine: "extraction_blocked", stdout: "", stderr: "blocked\n" }
      },
    })

    const result = await runExtract(spawner)

    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.status).toBe("extraction_blocked")
    expect(result.summary).toMatch(/extraction_blocked/)
  })

  it("reports a non-blocked failure when the orchestrator errors without a status file", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => ({ code: 1, lastLine: "boom", stdout: "", stderr: "boom\n" }),
    })

    const result = await runExtract(spawner)
    expect(result.ok).toBe(false)
    expect(result.blocked).toBe(false)
    expect(result.status).toBe("error")
  })

  it("fails clearly when the orchestrator script is missing", async () => {
    rmSync(path.join(factoryRoot, "extract-issues.mjs"))
    const { spawner } = makeFakeSpawner()
    await expect(runExtract(spawner)).rejects.toThrow(ControlError)
  })
})

describe("path safety", () => {
  it("keeps the runtime dir and lock inside the app cwd", () => {
    const { spawner } = makeFakeSpawner()
    startSupervisor(spawner)
    const lock = path.join(process.cwd(), ".vivicy-runtime", "run-state.json")
    expect(existsSync(lock)).toBe(true)
    expect(lock.startsWith(process.cwd())).toBe(true)
  })
})
