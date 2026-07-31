import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readDevStatus, startSupervisor, stopSupervisor } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"
import { fakeSpawner, getSpawner } from "@/lib/spawner"

const FACTORY_SCRIPTS = ["dev-loop-supervised.ts", "dev-status.ts"]

let factoryRoot: string
let targetRoot: string
let runtimeDir: string

async function reimportSpawner() {
  vi.resetModules()
  return (await import("@/lib/spawner")).fakeSpawner
}

beforeEach(() => {
  factoryRoot = mkdtempSync(path.join(tmpdir(), "vivicy-factory-"))
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivicy-target-"))
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-runtime-"))
  for (const script of FACTORY_SCRIPTS) {
    writeFileSync(path.join(factoryRoot, script), "// stub\n")
  }
  mkdirSync(path.join(targetRoot, ".vivicy", "development"), { recursive: true })

  process.env.VIVICY_FACTORY_ROOT = factoryRoot
  process.env.VIVICY_TARGET_ROOT = targetRoot
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
  delete process.env.VIVICY_FAKE_SPAWN
})

afterEach(() => {
  for (const dir of [factoryRoot, targetRoot, runtimeDir]) {
    rmSync(dir, { recursive: true, force: true })
  }
  delete process.env.VIVICY_FACTORY_ROOT
  delete process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_RUNTIME_DIR
  delete process.env.VIVICY_FAKE_SPAWN
  vi.resetModules()
})

describe("getSpawner", () => {
  it("returns the fake spawner when VIVICY_FAKE_SPAWN=1", () => {
    process.env.VIVICY_FAKE_SPAWN = "1"
    expect(getSpawner()).toBe(fakeSpawner)
  })

  it("returns the real node spawner when VIVICY_FAKE_SPAWN is unset or not 1", () => {
    expect(getSpawner()).toBe(nodeSpawner)
    process.env.VIVICY_FAKE_SPAWN = "true"
    expect(getSpawner()).toBe(nodeSpawner)
    process.env.VIVICY_FAKE_SPAWN = "0"
    expect(getSpawner()).toBe(nodeSpawner)
  })
})

describe("fakeSpawner process table", () => {
  it("mints one pid per spawn and kills only the pid it is given", () => {
    const first = fakeSpawner.spawnDetached({
      command: "node",
      args: [],
      cwd: targetRoot,
      env: process.env,
      logFile: path.join(runtimeDir, "a.log"),
    })
    const second = fakeSpawner.spawnDetached({
      command: "node",
      args: [],
      cwd: targetRoot,
      env: process.env,
      logFile: path.join(runtimeDir, "b.log"),
    })

    expect(second.pid).not.toBe(first.pid)
    expect(fakeSpawner.isAlive(first.pid)).toBe(true)
    expect(fakeSpawner.isAlive(second.pid)).toBe(true)

    expect(fakeSpawner.killGroup(first.pid)).toBe(true)
    expect(fakeSpawner.isAlive(first.pid)).toBe(false)
    expect(fakeSpawner.isAlive(second.pid)).toBe(true)
    expect(fakeSpawner.killGroup(first.pid)).toBe(false)
  })

  it("reports a pid it never spawned as dead", () => {
    expect(fakeSpawner.isAlive(999_999)).toBe(false)
  })

  it("shares liveness across a re-evaluation of the module", async () => {
    const { pid } = fakeSpawner.spawnDetached({
      command: "node",
      args: [],
      cwd: targetRoot,
      env: process.env,
      logFile: path.join(runtimeDir, "supervisor.log"),
    })

    const reloaded = await reimportSpawner()

    expect(reloaded).not.toBe(fakeSpawner)
    expect(reloaded.isAlive(pid)).toBe(true)
    reloaded.killGroup(pid)
    expect(fakeSpawner.isAlive(pid)).toBe(false)
  })
})

describe("the fake Run → running chain", () => {
  it("reports the run active to a reader holding another instance of the module", async () => {
    const before = await readDevStatus(fakeSpawner)
    expect(before.run_active).toBe(false)
    expect(before.process_alive).toBe(false)

    startSupervisor(fakeSpawner, "start")

    const reader = await reimportSpawner()
    const running = await readDevStatus(reader)
    expect(running.run_active).toBe(true)
    expect(running.process_alive).toBe(true)

    stopSupervisor(reader)
    const stopped = await readDevStatus(fakeSpawner)
    expect(stopped.run_active).toBe(false)
    expect(stopped.process_alive).toBe(false)
  })
})
