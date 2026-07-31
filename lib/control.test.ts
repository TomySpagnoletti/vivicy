import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  cancelSpecCycle,
  ControlError,
  decideCr,
  getCycles,
  getExtractionStatus,
  getSpecCycle,
  isRunActive,
  listChangeRequests,
  openSpecCycle,
  readDevStatus,
  readDocPrepReport,
  readProductRun,
  readRetroReport,
  readRunState,
  readSkillsReport,
  readSkillUsage,
  removeSkills,
  startDocPrep,
  startProductRun,
  runExtract,
  startSkillsInstall,
  startSupervisor,
  stopProductRun,
  stopSupervisor,
  type RunResult,
  type Spawner,
} from "@/lib/control"
import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { SKILLS_IN_FLIGHT_PHASES } from "@/lib/skills-report"

function makeFakeSpawner(overrides: Partial<Spawner> = {}) {
  const alive = new Set<number>()
  let nextPid = 1000
  const calls = {
    spawnDetached: [] as Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; shell?: boolean }>,
    run: [] as Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
    kill: [] as number[],
  }
  const spawner: Spawner = {
    spawnDetached: (options) => {
      calls.spawnDetached.push({ command: options.command, args: options.args, cwd: options.cwd, env: options.env, shell: options.shell })
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

function scaffoldFactory(root: string) {
  mkdirSync(root, { recursive: true })
  for (const rel of [
    "dev-loop-supervised.ts",
    "dev-status.ts",
    "extract-issues.ts",
    "change-control.ts",
    "cr-apply.ts",
    "install-skills.ts",
    "prepare-docs.ts",
    "doc-baseline.ts",
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
    expect(call.args.some((a) => a.endsWith("dev-loop-supervised.ts"))).toBe(true)
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
    expect(calls.spawnDetached).toHaveLength(1)
  })

  it("allows a restart once the prior pid is no longer alive (stale lock)", () => {
    const { spawner, calls, alive } = makeFakeSpawner()
    const first = startSupervisor(spawner)
    alive.delete(first.pid)

    const second = startSupervisor(spawner)
    expect(second.pid).not.toBe(first.pid)
    expect(calls.spawnDetached).toHaveLength(2)
  })

  it("fails clearly when the supervisor script is missing", () => {
    rmSync(path.join(factoryRoot, "dev-loop-supervised.ts"))
    const { spawner } = makeFakeSpawner()
    expect(() => startSupervisor(spawner)).toThrow(/not found/)
    try {
      startSupervisor(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("missing_script")
    }
  })

  it("holds the lock atomically before the spawn returns", () => {
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

describe("product run (serve the pizza)", () => {
  function writeVivicy(runCommand: string | null, extra: Record<string, unknown> = {}): void {
    writeFileSync(path.join(targetRoot, "vivicy.json"), JSON.stringify({ gateCommand: null, runCommand, ...extra }, null, 2))
  }
  function productRunLogPath(): string {
    return path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "product-run.log")
  }

  it("reports not_established while runCommand is the null sentinel, and refuses to start", () => {
    writeVivicy(null)
    const { spawner, calls } = makeFakeSpawner()

    expect(readProductRun(spawner).phase).toBe("not_established")
    try {
      startProductRun(spawner)
      throw new Error("expected throw")
    } catch (error) {
      expect((error as ControlError).code).toBe("run_not_established")
    }
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("reports stopped once runCommand is established but nothing is running", () => {
    writeVivicy("npm run dev")
    const { spawner } = makeFakeSpawner()
    const view = readProductRun(spawner)
    expect(view.phase).toBe("stopped")
    expect(view.command).toBe("npm run dev")
  })

  it("starts the product's own runCommand through the shell in the target cwd, fresh log per run, without leaking Vivicy's PORT", () => {
    writeVivicy("npm run dev")
    const prevPort = process.env.PORT
    process.env.PORT = "4319"
    try {
      const { spawner, calls } = makeFakeSpawner()
      const state = startProductRun(spawner)

      expect(state.pid).toBeGreaterThan(0)
      expect(state.command).toBe("npm run dev")
      expect(calls.spawnDetached).toHaveLength(1)
      const call = calls.spawnDetached[0]
      expect(call.command).toBe("npm run dev")
      expect(call.shell).toBe(true)
      expect(call.cwd).toBe(targetRoot)
      expect(call.env.PORT, "the product must not inherit Vivicy's own port").toBeUndefined()
      expect(existsSync(productRunLogPath())).toBe(true)
    } finally {
      if (prevPort === undefined) delete process.env.PORT
      else process.env.PORT = prevPort
    }
  })

  it("surfaces a running product with a URL sniffed from the log", () => {
    writeVivicy("next dev --port 3000")
    const { spawner } = makeFakeSpawner()
    startProductRun(spawner)
    writeFileSync(productRunLogPath(), "  ▲ Next.js\n  - Local: http://localhost:3000\n")

    const view = readProductRun(spawner)
    expect(view.phase).toBe("running")
    expect(view.url).toBe("http://localhost:3000")
    expect(view.url_source).toBe("log")
    expect(view.log_tail).toMatch(/Local: http/)
  })

  it("falls back to the command-string port when the log has not printed a URL yet", () => {
    writeVivicy("next dev --port 4321")
    const { spawner } = makeFakeSpawner()
    startProductRun(spawner)
    writeFileSync(productRunLogPath(), "starting the compiler...\n")

    const view = readProductRun(spawner)
    expect(view.url).toBe("http://localhost:4321")
    expect(view.url_source).toBe("command")
  })

  it("refuses a double start while the product is alive, allows a restart once its pid dies", () => {
    writeVivicy("npm run dev")
    const { spawner, alive } = makeFakeSpawner()
    const first = startProductRun(spawner)
    try {
      startProductRun(spawner)
      throw new Error("expected throw")
    } catch (error) {
      expect((error as ControlError).code).toBe("already_running")
    }
    alive.delete(first.pid)
    const second = startProductRun(spawner)
    expect(second.pid).not.toBe(first.pid)
  })

  it("surfaces an exited product loudly with an exit hint when the process dies without an owner stop", () => {
    writeVivicy("npm run dev")
    const { spawner, alive } = makeFakeSpawner()
    const state = startProductRun(spawner)
    writeFileSync(productRunLogPath(), "Error: EADDRINUSE :::3000\n")
    alive.delete(state.pid)

    const view = readProductRun(spawner)
    expect(view.phase).toBe("exited")
    expect(view.url).toBeNull()
    expect(view.log_tail).toMatch(/EADDRINUSE/)
  })

  it("stop kills the process group and clears the state (back to stopped, not exited)", () => {
    writeVivicy("npm run dev")
    const { spawner, calls } = makeFakeSpawner()
    const state = startProductRun(spawner)

    const result = stopProductRun(spawner)
    expect(result.pid).toBe(state.pid)
    expect(calls.kill).toContain(state.pid)
    expect(readProductRun(spawner).phase).toBe("stopped")

    try {
      stopProductRun(spawner)
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

function writeExtractionStatus(phase: string, summary: string) {
  const file = path.join(targetRoot, ".vivicy/development/reports/extraction-status.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ phase, summary }, null, 2))
}

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
        seenScript = path.basename(args.find((a) => a.endsWith(".ts")) ?? "")
        expect(env.VIVICY_TARGET_ROOT).toBe(targetRoot)
        writeExtractionStatus("green", "extraction green after 1 attempt: 8 issues")
        return { code: 0, lastLine: "extraction green", stdout: "extraction green\n", stderr: "" }
      },
    })

    const result = await runExtract(spawner)

    expect(seenScript).toBe("extract-issues.ts")
    expect(result.ok).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.status).toBe("green")
    expect(result.summary).toMatch(/8 issue/)
  })

  it("surfaces the blocked case honestly when the orchestrator stays red", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => {
        writeExtractionStatus("extraction_blocked", "extraction_blocked: checks still red after 4 attempts")
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
    rmSync(path.join(factoryRoot, "extract-issues.ts"))
    const { spawner } = makeFakeSpawner()
    await expect(runExtract(spawner)).rejects.toThrow(ControlError)
  })
})

describe("getExtractionStatus (workflow widget read)", () => {
  it("returns null when extraction has never run", () => {
    expect(getExtractionStatus()).toBeNull()
  })

  it("surfaces the orchestrator's in-flight/terminal status verbatim", () => {
    writeExtractionStatus("green", "extraction green after 1 attempt: 8 issues")
    const status = getExtractionStatus()
    expect(status?.phase).toBe("green")
    expect(status?.summary).toMatch(/8 issue/)
  })

  it("fails clearly when the target root does not exist", () => {
    rmSync(targetRoot, { recursive: true, force: true })
    expect(() => getExtractionStatus()).toThrow(ControlError)
  })
})

function writeSkillsReport(report: Record<string, unknown>) {
  const file = path.join(targetRoot, ".vivicy", "development", "reports", "skills-report.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2))
}

describe("readSkillsReport", () => {
  it("returns null when no install has ever run", () => {
    expect(readSkillsReport()).toBeNull()
  })

  it("surfaces the installer's report verbatim", () => {
    writeSkillsReport({
      phase: "green",
      mode: "explicit",
      installed: [{ id: "acme/a@x", official: false, security_waived: true }],
      rejected: [],
      summary: "1 skill installed",
      updated_at: "2026-07-04T09:00:00Z",
    })
    const report = readSkillsReport()
    expect(report?.phase).toBe("green")
    expect(report?.mode).toBe("explicit")
    expect(report?.installed?.[0]?.security_waived).toBe(true)
  })

  it("treats an unparseable report as null (best-effort read)", () => {
    const file = path.join(targetRoot, ".vivicy", "development", "reports", "skills-report.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{ not json")
    expect(readSkillsReport()).toBeNull()
  })
})

function writeProgressLedger(ledger: Record<string, unknown>) {
  const file = path.join(targetRoot, ".vivicy", "development", "progress-ledger.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(ledger, null, 2))
}

describe("readSkillUsage", () => {
  const report = {
    phase: "green",
    installed: [{ id: "acme/a@x" }, { id: "acme/b@y" }],
  }

  it("counts the ledger's per-issue declarations against the project's installed set", () => {
    writeProgressLedger({
      schema_version: 1,
      revision: 3,
      graph_item_states: [],
      active_items: [],
      skill_usage: [
        { issue_id: "ISSUE-1", installed: ["acme/a@x", "acme/b@y"], applied: ["acme/a@x"], not_installed: ["ghost/z@w"] },
        { issue_id: "ISSUE-2", installed: ["acme/a@x", "acme/b@y"], applied: ["acme/a@x"], not_installed: [] },
        { issue_id: "ISSUE-3", installed: ["acme/a@x"], applied: [], not_installed: [] },
      ],
    })
    expect(readSkillUsage(report as never)).toEqual({
      issues: 3,
      applied: [
        { id: "acme/a@x", applied: 2, issues: 3 },
        { id: "acme/b@y", applied: 0, issues: 2 },
      ],
      not_installed: [{ id: "ghost/z@w", issues: 1 }],
    })
  })

  it("answers with an empty denominator — never a throw — when the ledger is absent or unreadable", () => {
    expect(readSkillUsage(report as never).issues).toBe(0)
    writeProgressLedger({} as Record<string, unknown>)
    expect(readSkillUsage(report as never).issues).toBe(0)
    writeFileSync(path.join(targetRoot, ".vivicy", "development", "progress-ledger.json"), "{ not json")
    expect(readSkillUsage(report as never)).toEqual({
      issues: 0,
      applied: [
        { id: "acme/a@x", applied: 0, issues: 0 },
        { id: "acme/b@y", applied: 0, issues: 0 },
      ],
      not_installed: [],
    })
  })

  it("names no skill — and never opens the ledger — when the project has none, since three surfaces poll this route", () => {
    writeProgressLedger({ skill_usage: [{ issue_id: "ISSUE-1", installed: ["acme/a@x"], applied: ["acme/a@x"], not_installed: [] }] })
    expect(readSkillUsage(null)).toEqual({ issues: 0, applied: [], not_installed: [] })
    expect(readSkillUsage({ installed: [] } as never)).toEqual({ issues: 0, applied: [], not_installed: [] })
    rmSync(targetRoot, { recursive: true, force: true })
    expect(readSkillUsage(null)).toEqual({ issues: 0, applied: [], not_installed: [] })
  })
})

function writeRetroReport(report: Record<string, unknown>) {
  const file = path.join(targetRoot, ".vivicy", "development", "reports", "retro-report.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2))
}

describe("readRetroReport", () => {
  it("returns null when the post-cycle retro has never run", () => {
    expect(readRetroReport()).toBeNull()
  })

  it("surfaces the retro leg's recorded proposals verbatim", () => {
    writeRetroReport({
      phase: "proposals",
      baseline_id: "baseline-v1.0.0",
      recurring_classes: [{ id: "gate-flake", kind: "gate_flake", signature: "typecheck flaked twice", occurrences: 2 }],
      proposals: [{ landing: "method_block", title: "Prime the gate", detail: "Add a bullet." }],
      summary: "1 method amendment proposed",
      updated_at: "2026-07-24T09:00:00Z",
    })
    const report = readRetroReport()
    expect(report?.phase).toBe("proposals")
    expect(report?.proposals?.[0]?.landing).toBe("method_block")
    expect(report?.recurring_classes?.[0]?.occurrences).toBe(2)
  })

  it("treats an unparseable report as null (best-effort read)", () => {
    const file = path.join(targetRoot, ".vivicy", "development", "reports", "retro-report.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, "{ not json")
    expect(readRetroReport()).toBeNull()
  })

  it("throws missing_target when the target root is absent", () => {
    rmSync(targetRoot, { recursive: true, force: true })
    expect(() => readRetroReport()).toThrow(ControlError)
  })
})

describe("startSkillsInstall", () => {
  function skillsStageLockPath(): string {
    return path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "skills-install.lock")
  }

  function writeStageLock(pid: number): string {
    const abs = skillsStageLockPath()
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, `${JSON.stringify({ pid, started_at: new Date().toISOString() }, null, 2)}\n`)
    return abs
  }

  it("spawns install-skills.ts detached with the target + runtime + settings env (auto mode)", () => {
    const { spawner, calls } = makeFakeSpawner()

    const started = startSkillsInstall(spawner)

    expect(started.mode).toBe("auto")
    expect(started.pid).toBeGreaterThan(0)
    expect(calls.spawnDetached).toHaveLength(1)
    const call = calls.spawnDetached[0]
    expect(call.args.some((a) => a.endsWith("install-skills.ts"))).toBe(true)
    expect(call.args).not.toContain("--ids")
    expect(call.cwd).toBe(factoryRoot)
    expect(call.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    expect(call.env.VIVICY_RUNTIME_DIR).toBeTruthy()
    expect(call.env.VIVICY_ALLOW_UNSAFE_SKILLS).toBe("0")
    expect(call.env.VIVICY_IMPLEMENTER_CLI).toBe("claude")
  })

  it("passes explicit ids as --ids <comma-list> and reports explicit mode", () => {
    const { spawner, calls } = makeFakeSpawner()

    const started = startSkillsInstall(spawner, { ids: [" acme/a@x ", "acme/b@y", "  "] })

    expect(started.mode).toBe("explicit")
    expect(started.ids).toEqual(["acme/a@x", "acme/b@y"])
    const args = calls.spawnDetached[0].args
    expect(args[args.indexOf("--ids") + 1]).toBe("acme/a@x,acme/b@y")
  })

  it.each(SKILLS_IN_FLIGHT_PHASES)("refuses while a fresh in-flight report says the stage is %s", (phase) => {
    writeSkillsReport({ phase, updated_at: new Date().toISOString() })
    const { spawner, calls } = makeFakeSpawner()

    expect(() => startSkillsInstall(spawner)).toThrow(ControlError)
    try {
      startSkillsInstall(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("already_running")
    }
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("refuses while the STAGE holds the lock, whatever the report says", () => {
    const { spawner, calls, alive } = makeFakeSpawner()
    alive.add(5150)
    writeStageLock(5150)

    expect(() => startSkillsInstall(spawner)).toThrow(ControlError)
    try {
      startSkillsInstall(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("already_running")
    }
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("claims no lock of its own: a start over a free lock path writes nothing there, and a dead holder's residue is left for the stage to reclaim", () => {
    const fresh = makeFakeSpawner()
    startSkillsInstall(fresh.spawner)
    expect(fresh.calls.spawnDetached).toHaveLength(1)
    expect(
      existsSync(skillsStageLockPath()),
      "the app used to write the child's pid here; the child does it now, under its own exclusive create"
    ).toBe(false)

    const stale = `${JSON.stringify({ pid: 5150, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`
    writeFileSync(writeStageLock(5150), stale)
    const next = makeFakeSpawner()
    startSkillsInstall(next.spawner)
    expect(next.calls.spawnDetached).toHaveLength(1)
    expect(readFileSync(skillsStageLockPath(), "utf8"), "the probe is read-only — reclaiming is the stage's exclusive move").toBe(stale)
  })

  it("removeSkills refuses while the stage holds the lock too", async () => {
    const { spawner, calls, alive } = makeFakeSpawner()
    alive.add(5150)
    writeStageLock(5150)
    await expect(removeSkills(spawner, { ids: ["acme/a@x"] })).rejects.toThrow(/already in flight/)
    expect(calls.run).toHaveLength(0)
  })

  it("removeSkills returns a terminal failed report rather than a generic spawn error", async () => {
    writeSkillsReport({ phase: "green", mode: "remove", summary: "a PREVIOUS run", updated_at: "2026-07-04T09:00:00Z" })
    const { spawner } = makeFakeSpawner()
    spawner.run = async () => {
      writeSkillsReport({
        phase: "failed",
        mode: "remove",
        summary: "skills stage failed: CLAUDE.md refused the project skills block (EACCES: permission denied).",
        updated_at: new Date().toISOString(),
      })
      return { code: 1, lastLine: "", stdout: "", stderr: "error: boom\n" }
    }

    const report = await removeSkills(spawner, { ids: ["acme/a@x"] })
    expect(report.phase).toBe("failed")
    expect(report.summary).toContain("CLAUDE.md refused the project skills block")
  })

  it("removeSkills refuses to answer with a report this invocation did not produce", async () => {
    for (const prior of ["failed", "green"]) {
      writeSkillsReport({ phase: prior, mode: "remove", summary: `a PREVIOUS run ended ${prior}`, updated_at: "2026-07-04T09:00:00Z" })
      const { spawner } = makeFakeSpawner()
      spawner.run = async () => ({
        code: 1,
        lastLine: "",
        stdout: "",
        stderr: "error: a skills install is already in flight (pid 4242)\n",
      })

      await expect(removeSkills(spawner, { ids: ["acme/a@x"] }), `prior ${prior}`).rejects.toThrow(/already in flight \(pid 4242\)/)
      expect(readSkillsReport()?.summary, "and the previous outcome is left exactly as it was").toBe(`a PREVIOUS run ended ${prior}`)
    }
  })

  it("treats an in-flight report with NO timestamp as live (fail toward refusal)", () => {
    writeSkillsReport({ phase: "installing" })
    const { spawner } = makeFakeSpawner()
    expect(() => startSkillsInstall(spawner)).toThrow(/already in flight/)
  })

  it("allows a start over a STALE in-flight report (the installer died)", () => {
    writeSkillsReport({
      phase: "installing",
      updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    })
    const { spawner, calls } = makeFakeSpawner()
    startSkillsInstall(spawner)
    expect(calls.spawnDetached).toHaveLength(1)
  })

  it("removeSkills runs install-skills.ts --remove to completion and returns the final report", async () => {
    const { spawner, calls } = makeFakeSpawner()
    spawner.run = async (options) => {
      calls.run.push({ args: options.args, env: options.env })
      writeSkillsReport({
        phase: "green",
        mode: "remove",
        installed: [],
        added: [],
        removed: ["acme/a@x"],
        rejected: [],
        updated_at: new Date().toISOString(),
      })
      return { code: 0, lastLine: "ok", stdout: "ok\n", stderr: "" }
    }

    const report = await removeSkills(spawner, { ids: [" acme/a@x "] })

    expect(report.phase).toBe("green")
    expect(report.removed).toEqual(["acme/a@x"])
    const call = calls.run.at(-1)!
    expect(call.args.some((a) => a.endsWith("install-skills.ts"))).toBe(true)
    expect(call.args[call.args.indexOf("--remove") + 1]).toBe("acme/a@x")
    expect(call.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    expect(existsSync(skillsStageLockPath()), "the stage owns that lock — the app leaves no claim of its own behind").toBe(false)
    const again = makeFakeSpawner()
    expect(() => startSkillsInstall(again.spawner)).not.toThrow()
  })

  it("removeSkills refuses while an install is in flight, and requires ids", async () => {
    writeSkillsReport({ phase: "auditing", updated_at: new Date().toISOString() })
    const { spawner } = makeFakeSpawner()
    await expect(removeSkills(spawner, { ids: ["acme/a@x"] })).rejects.toThrow(/already in flight/)

    writeSkillsReport({ phase: "green", updated_at: new Date().toISOString() })
    await expect(removeSkills(spawner, { ids: [] })).rejects.toThrow(/at least one skill id/)
  })

  it("allows a start over any terminal report (green/failed/skipped)", () => {
    for (const phase of ["green", "failed", "skipped"]) {
      writeSkillsReport({ phase, updated_at: new Date().toISOString() })
      const { spawner, calls } = makeFakeSpawner()
      startSkillsInstall(spawner)
      expect(calls.spawnDetached).toHaveLength(1)
    }
  })

  it("fails clearly when the installer script is missing from the factory", () => {
    rmSync(path.join(factoryRoot, "install-skills.ts"))
    const { spawner } = makeFakeSpawner()
    expect(() => startSkillsInstall(spawner)).toThrow(/not found/)
  })
})

function writeDocPrepReport(report: Record<string, unknown>) {
  const file = path.join(targetRoot, ".vivicy", "development", "reports", "doc-prep-report.json")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(report, null, 2))
}

describe("startDocPrep", () => {
  it("spawns prepare-docs.ts detached and claims the doc-prep lock under the project runtime namespace", () => {
    const { spawner, calls } = makeFakeSpawner()

    const started = startDocPrep(spawner)

    expect(started.pid).toBeGreaterThan(0)
    expect(calls.spawnDetached).toHaveLength(1)
    const call = calls.spawnDetached[0]
    expect(call.args.some((a) => a.endsWith("prepare-docs.ts"))).toBe(true)
    expect(call.cwd).toBe(factoryRoot)
    expect(call.env.VIVICY_TARGET_ROOT).toBe(targetRoot)
    expect(call.env.VIVICY_RUNTIME_DIR).toBeTruthy()
    const lock = path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "doc-prep.lock")
    expect(existsSync(lock)).toBe(true)
  })

  it("refuses while a fresh in-flight report says preparation is running", () => {
    writeDocPrepReport({ phase: "extracting", updated_at: new Date().toISOString() })
    const { spawner, calls } = makeFakeSpawner()

    expect(() => startDocPrep(spawner)).toThrow(ControlError)
    try {
      startDocPrep(spawner)
    } catch (error) {
      expect((error as ControlError).code).toBe("already_running")
    }
    expect(calls.spawnDetached).toHaveLength(0)
  })

  it("allows a start over a STALE in-flight report (the preparer died)", () => {
    writeDocPrepReport({ phase: "placing", updated_at: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
    const { spawner, calls } = makeFakeSpawner()
    startDocPrep(spawner)
    expect(calls.spawnDetached).toHaveLength(1)
  })

  it("readDocPrepReport returns null when the stage has not run and the report verbatim otherwise", () => {
    expect(readDocPrepReport()).toBeNull()
    writeDocPrepReport({
      phase: "green",
      cycle_id: "project",
      batches_consumed: ["b1"],
      batches_pending: [],
      language: "eng",
      placed: [],
      rejected: [],
      summary: "ok",
      updated_at: "2026-07-05T09:00:00Z",
    })
    expect(readDocPrepReport()?.phase).toBe("green")
    expect(readDocPrepReport()?.cycle_id).toBe("project")
  })
})

describe("path safety", () => {
  it("keeps the lock inside the PROJECT's runtime namespace", () => {
    const { spawner } = makeFakeSpawner()
    startSupervisor(spawner)
    const lock = path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "run-state.json")
    expect(existsSync(lock)).toBe(true)
    expect(lock.startsWith(getRuntimeDir())).toBe(true)
    const other = mkdtempSync(path.join(tmpdir(), "control-other-"))
    try {
      expect(getProjectRuntimeDir(getRuntimeDir(), other)).not.toBe(getProjectRuntimeDir(getRuntimeDir(), targetRoot))
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})

function writeCr(name: string, fields: Record<string, string>) {
  const lines = ["---", ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`), "---", "", `# ${fields.id ?? name}`, ""]
  const file = path.join(targetRoot, ".vivicy", "change-requests", name)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.join("\n"))
}

function writeCrApplyReport(id: string, report: { status: string; summary: string }) {
  const file = path.join(targetRoot, ".vivicy", "development", "reports", `apply-${id}.json`)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ cr: id, ...report }, null, 2))
}

describe("listChangeRequests", () => {
  it("parses seeded CR files into display rows, skipping the template and readme", () => {
    writeCr("CR-0001-first.md", {
      id: "CR-0001",
      title: "First",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    })
    writeCr("CR-0002-second.md", {
      id: "CR-0002",
      title: "Second",
      status: "accepted_current_build",
      classification: "major_product_change",
      created_at: "2026-07-02",
      source: "owner",
    })
    writeCr("CR-TEMPLATE.md", { id: "CR-0000", title: "tpl", status: "idea", classification: "pending", created_at: "x", source: "owner" })
    writeFileSync(path.join(targetRoot, ".vivicy", "change-requests", "README.md"), "# Change Requests\n")

    const { crs } = listChangeRequests()

    expect(crs.map((c) => c.id)).toEqual(["CR-0001", "CR-0002"])
    expect(crs[0]).toEqual({
      id: "CR-0001",
      title: "First",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    })
    expect(crs[1].status).toBe("accepted_current_build")
  })

  it("returns an empty list when there is no registry directory", () => {
    expect(listChangeRequests().crs).toEqual([])
  })
})

describe("decideCr", () => {
  it("approves: records the decision, runs cr-apply, and reports the chain green", async () => {
    writeCr("CR-0001-x.md", {
      id: "CR-0001",
      title: "x",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    })
    const seen: string[][] = []
    const { spawner } = makeFakeSpawner({
      run: async ({ args }) => {
        seen.push(args)
        if (args.some((a) => a.endsWith("change-control.ts"))) {
          return {
            code: 0,
            lastLine: "{}",
            stdout: JSON.stringify({ ok: true, id: "CR-0001", status: "accepted_current_build" }),
            stderr: "",
          }
        }
        writeCrApplyReport("CR-0001", { status: "green", summary: "CR-0001 applied — re-frozen, re-extracted green" })
        return { code: 0, lastLine: "green", stdout: "green\n", stderr: "" }
      },
    })

    const result = await decideCr(spawner, { id: "CR-0001", decision: "approved", decidedBy: "owner:ui" })

    expect(result.ok).toBe(true)
    expect(result.decision).toBe("approved")
    expect(result.status).toBe("accepted_current_build")
    expect(result.applied?.status).toBe("green")
    expect(result.applied?.blocked).toBe(false)
    expect(result.summary).toMatch(/re-extracted green/)
    const decideCall = seen.find((a) => a.some((x) => x.endsWith("change-control.ts")))
    const applyCall = seen.find((a) => a.some((x) => x.endsWith("cr-apply.ts")))
    expect(decideCall).toContain("decide")
    expect(decideCall).toContain("CR-0001")
    expect(decideCall).toContain("owner:ui")
    expect(applyCall).toContain("--cr")
    expect(applyCall).toContain("CR-0001")
  })

  it("approves but surfaces a blocked apply chain honestly (ok:false, blocked:true)", async () => {
    writeCr("CR-0001-x.md", {
      id: "CR-0001",
      title: "x",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    })
    const { spawner } = makeFakeSpawner({
      run: async ({ args }) => {
        if (args.some((a) => a.endsWith("change-control.ts"))) {
          return {
            code: 0,
            lastLine: "{}",
            stdout: JSON.stringify({ ok: true, id: "CR-0001", status: "accepted_current_build" }),
            stderr: "",
          }
        }
        writeCrApplyReport("CR-0001", {
          status: "blocked",
          summary: "cr-apply: reference-check stayed red — CR left accepted_current_build",
        })
        return { code: 1, lastLine: "blocked", stdout: "", stderr: "blocked\n" }
      },
    })

    const result = await decideCr(spawner, { id: "CR-0001", decision: "approved", decidedBy: "owner:ui" })

    expect(result.ok).toBe(false)
    expect(result.applied?.blocked).toBe(true)
    expect(result.applied?.status).toBe("blocked")
    expect(result.summary).toMatch(/reference-check stayed red/)
  })

  it("rejects: records the decision only, never launching the apply chain", async () => {
    writeCr("CR-0001-x.md", {
      id: "CR-0001",
      title: "x",
      status: "idea",
      classification: "minor_product_change",
      created_at: "2026-07-01",
      source: "agent",
    })
    const scripts: string[] = []
    const { spawner } = makeFakeSpawner({
      run: async ({ args }) => {
        scripts.push(path.basename(args.find((a) => a.endsWith(".ts")) ?? ""))
        return { code: 0, lastLine: "{}", stdout: JSON.stringify({ ok: true, id: "CR-0001", status: "rejected" }), stderr: "" }
      },
    })

    const result = await decideCr(spawner, { id: "CR-0001", decision: "rejected", decidedBy: "owner:ui" })

    expect(result.ok).toBe(true)
    expect(result.status).toBe("rejected")
    expect(result.applied).toBeUndefined()
    expect(scripts).toEqual(["change-control.ts"])
  })

  it("maps an unknown CR id to an unknown_cr ControlError", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => ({
        code: 1,
        lastLine: "{}",
        stdout: JSON.stringify({ ok: false, error: "decideChangeRequest: no CR with id CR-9999 under .vivicy/change-requests" }),
        stderr: "",
      }),
    })
    await expect(decideCr(spawner, { id: "CR-9999", decision: "approved", decidedBy: "owner:ui" })).rejects.toThrow(ControlError)
    try {
      await decideCr(spawner, { id: "CR-9999", decision: "approved", decidedBy: "owner:ui" })
    } catch (error) {
      expect((error as ControlError).code).toBe("unknown_cr")
    }
  })

  it("maps an undecidable CR (already decided) to a cr_not_decidable ControlError", async () => {
    const { spawner } = makeFakeSpawner({
      run: async () => ({
        code: 1,
        lastLine: "{}",
        stdout: JSON.stringify({
          ok: false,
          error: 'decideChangeRequest: CR CR-0001 is "docs_applied", only idea|under_review CRs can be decided',
        }),
        stderr: "",
      }),
    })
    try {
      await decideCr(spawner, { id: "CR-0001", decision: "approved", decidedBy: "owner:ui" })
      throw new Error("expected throw")
    } catch (error) {
      expect((error as ControlError).code).toBe("cr_not_decidable")
    }
  })
})

describe("spec cycles (open/cancel guards)", () => {
  function seedFrozenBaseline(): void {
    const dir = path.join(targetRoot, ".vivicy", "baselines")
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, "baseline-v1.0.0.json"),
      JSON.stringify({ baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen" })
    )
  }

  it("open requires a frozen baseline, refuses a double open, and start refuses while open", () => {
    const { spawner } = makeFakeSpawner()
    expect(() => openSpecCycle(spawner, "owner:test")).toThrow(/no frozen baseline/)

    seedFrozenBaseline()
    const cycle = openSpecCycle(spawner, "owner:test")
    expect(cycle.status).toBe("drafting")
    expect(cycle.kind).toBe("feature")
    expect(cycle.opened_by).toBe("owner:test")
    expect(existsSync(path.join(targetRoot, ".vivicy", "development", "reports", "spec-cycle.json"))).toBe(true)

    expect(() => openSpecCycle(spawner, "owner:test")).toThrow(/already open/)
    expect(() => startSupervisor(spawner)).toThrow(/spec cycle is open/)
  })

  it("open refuses while a supervised run is active", () => {
    seedFrozenBaseline()
    const { spawner } = makeFakeSpawner()
    startSupervisor(spawner)
    expect(() => openSpecCycle(spawner, "owner:test")).toThrow(/supervised run is active/)
  })

  it("cancel is legal only while the canonical has NOT drifted (doc-baseline verify is the judge)", async () => {
    seedFrozenBaseline()
    const { spawner } = makeFakeSpawner()
    openSpecCycle(spawner, "owner:test")

    const drifted = makeFakeSpawner({
      run: async (options) => {
        if (options.args.some((a) => a.endsWith("doc-baseline.ts"))) {
          return { code: 1, lastLine: "changed: 01-a.md", stdout: "", stderr: "changed: 01-a.md" }
        }
        return { code: 0, lastLine: "", stdout: "", stderr: "" }
      },
    })
    await expect(cancelSpecCycle(drifted.spawner)).rejects.toThrow(/drifted/)
    expect(getSpecCycle()).not.toBeNull()

    const clean = makeFakeSpawner()
    const { id } = await cancelSpecCycle(clean.spawner)
    expect(id).toMatch(/^cycle-/)
    expect(getSpecCycle()).toBeNull()
    await expect(cancelSpecCycle(clean.spawner)).rejects.toThrow(/no drafting spec cycle/)
  })
})

describe("getCycles (active cycle + history reader)", () => {
  function seedBaseline(
    id: string,
    version: string,
    opts: { spec_kind?: string; approval_ref?: string; approved_at?: string; superseded?: string } = {}
  ): void {
    const dir = path.join(targetRoot, ".vivicy", "baselines")
    mkdirSync(dir, { recursive: true })
    const manifest: Record<string, unknown> = {
      baseline_id: id,
      version,
      status: "frozen",
      spec_kind: opts.spec_kind ?? "feature",
      generated_at: opts.approved_at ?? "2026-01-01T00:00:00Z",
      approval: { approval_ref: opts.approval_ref ?? id, approved_at: opts.approved_at ?? "2026-01-01T00:00:00Z" },
    }
    if (opts.superseded) manifest.superseded = { by_baseline_id: opts.superseded, at: opts.approved_at ?? "2026-01-01T00:00:00Z" }
    writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(manifest))
  }

  function seedBatch(batchId: string, cycle?: unknown): void {
    const dir = path.join(targetRoot, ".vivicy", "uploads", batchId)
    mkdirSync(dir, { recursive: true })
    const manifest: Record<string, unknown> = {
      batchId,
      createdAt: "2026-01-01T00:00:00Z",
      files: [{ path: `${batchId}.md`, size: 1, sha256: "x" }],
    }
    if (cycle !== undefined) manifest.cycle = cycle
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest))
  }

  it("greenfield pre-freeze: an implicit editable project cycle with no history", () => {
    const view = getCycles()
    expect(view.active).toEqual({ id: null, kind: "project", editable: true, pending_batches: 0 })
    expect(view.history).toEqual([])
  })

  it("pre-freeze counts unconsumed, complete, active-cycle upload batches as pending", () => {
    seedBatch("b1")
    seedBatch("b2")
    mkdirSync(path.join(targetRoot, ".vivicy", "uploads", "interrupted"), { recursive: true })
    expect(getCycles().active?.pending_batches).toBe(2)
  })

  it("a frozen baseline with no drafting cycle is the active (non-editable) cycle and is NOT listed in history", () => {
    seedBaseline("baseline-v1.0.0", "1.0.0", { spec_kind: "project", approval_ref: "project" })
    const view = getCycles()
    expect(view.active).toEqual({ id: "project", kind: "project", editable: false, pending_batches: 0 })
    expect(view.history).toEqual([])
  })

  it("opening a feature cycle reopens editable and moves the frozen baseline into history as a delivered (non-superseded) cycle", () => {
    seedBaseline("baseline-v1.0.0", "1.0.0", { spec_kind: "project", approval_ref: "project" })
    const { spawner } = makeFakeSpawner()
    openSpecCycle(spawner, "owner:test")

    const view = getCycles()
    expect(view.active?.editable).toBe(true)
    expect(view.active?.kind).toBe("feature")
    expect(view.active?.id).toMatch(/^cycle-/)
    expect(view.history).toHaveLength(1)
    expect(view.history[0]).toMatchObject({ version: "1.0.0", kind: "project", superseded: false })
  })

  it("history lists superseded baselines most-recent-first, excluding the current live baseline", () => {
    seedBaseline("baseline-v1.0.0", "1.0.0", {
      spec_kind: "project",
      approval_ref: "project",
      approved_at: "2026-02-01T00:00:00Z",
      superseded: "baseline-v1.1.0",
    })
    seedBaseline("baseline-v1.0.5", "1.0.5", {
      approval_ref: "cycle-mid",
      approved_at: "2026-03-01T00:00:00Z",
      superseded: "baseline-v1.1.0",
    })
    seedBaseline("baseline-v1.1.0", "1.1.0", { approval_ref: "cycle-latest", approved_at: "2026-04-01T00:00:00Z" })

    const view = getCycles()
    expect(view.active).toMatchObject({ id: "cycle-latest", kind: "feature", editable: false })
    expect(view.history.map((c) => c.version)).toEqual(["1.0.5", "1.0.0"])
    expect(view.history.every((c) => c.superseded)).toBe(true)
  })
})
