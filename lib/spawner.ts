import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { readDevStatusFromDisk } from "@/lib/dev-status-fs"
import { readRunState, type DetachedHandle, type RunOptions, type RunResult, type Spawner } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"
import { getTargetRoot } from "@/lib/target"

const FIRST_FAKE_PID = 424242

interface FakeProcesses {
  alive: Set<number>
  nextPid: number
}

// Module scope is not process scope: a second evaluation of this module (a server that duplicates or re-evaluates it per entry) would fork the writer (control routes) from the readers (status routes), so the fake process table is process-global — see AGENTS.md "Platform traps".
const FAKE_PROCESSES = Symbol.for("vivicy.fake-spawner.processes")

function fakeProcesses(): FakeProcesses {
  const registry = globalThis as unknown as Record<symbol, FakeProcesses | undefined>
  const existing = registry[FAKE_PROCESSES]
  if (existing) return existing
  const created: FakeProcesses = { alive: new Set<number>(), nextPid: FIRST_FAKE_PID }
  registry[FAKE_PROCESSES] = created
  return created
}

function scriptName(args: string[]): string {
  const scriptArg = args.find((a) => a.endsWith(".ts")) ?? ""
  return scriptArg.split("/").pop() ?? scriptArg
}

function writeFakeViviReply(args: string[]): void {
  const flag = args.indexOf("--reply-file")
  const replyFile = flag >= 0 ? args[flag + 1] : undefined
  if (!replyFile) return
  try {
    mkdirSync(path.dirname(replyFile), { recursive: true })
    writeFileSync(
      replyFile,
      "Vivi is running in dry mode — no agent was spawned this turn. Connect an agent CLI to grill your spec for real."
    )
  } catch {
    // Best-effort: the fake path must never throw and break the demo flow.
  }
}

function writeFakeExtractionStatus(targetRoot: string): void {
  try {
    const file = path.join(targetRoot, ".vivicy/development/reports/extraction-status.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ phase: "green", summary: "extraction green (fake spawn)" }, null, 2)}\n`
    )
  } catch {
    // Best-effort: the fake path must never throw and break the demo flow.
  }
}

export const fakeSpawner: Spawner = {
  spawnDetached(): DetachedHandle {
    const processes = fakeProcesses()
    const pid = processes.nextPid++
    processes.alive.add(pid)
    return { pid }
  },

  async run({ args }: RunOptions): Promise<RunResult> {
    const name = scriptName(args)
    // resolveContext() asserts a target before any run reaches here, so a null targetRoot would be a caller bug.
    const targetRoot = getTargetRoot()
    if (name === "dev-status.ts" && targetRoot !== null) {
      const status = readDevStatusFromDisk(targetRoot)
      const supervisor = readRunState()
      const withLive = {
        ...status,
        process_alive: supervisor !== null && fakeProcesses().alive.has(supervisor.pid),
      }
      const json = JSON.stringify(withLive, null, 2)
      return { code: 0, lastLine: json.split("\n").at(-1) ?? "", stdout: json, stderr: "" }
    }
    if (name === "extract-issues.ts" && targetRoot !== null) {
      writeFakeExtractionStatus(targetRoot)
      return { code: 0, lastLine: "extraction green (fake spawn)", stdout: "extraction green (fake spawn)\n", stderr: "" }
    }
    if (name === "vivi-turn.ts") {
      writeFakeViviReply(args)
      return { code: 0, lastLine: "vivi turn: fake", stdout: "vivi turn: fake\n", stderr: "" }
    }
    return {
      code: 0,
      lastLine: `${name}: OK (fake spawn)`,
      stdout: `${name}: OK (fake spawn)\n`,
      stderr: "",
    }
  },

  killGroup(pid: number): boolean {
    return fakeProcesses().alive.delete(pid)
  },

  isAlive(pid: number): boolean {
    return fakeProcesses().alive.has(pid)
  },
}

export function getSpawner(): Spawner {
  return process.env.VIVICY_FAKE_SPAWN === "1" ? fakeSpawner : nodeSpawner
}
