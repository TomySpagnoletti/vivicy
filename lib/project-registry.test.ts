import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  allocatePort,
  PORT_BASE,
  PORT_SPAN,
  readRegistry,
  REGISTRY_LOCK_FILE,
  RegistryError,
  registryPath,
  serverLogPath,
  withRegistry,
  type RegistryClock,
  type RegistryRow,
} from "@/lib/project-registry"
import { claimStageLock } from "@/lib/stage-lock"

let home: string
let prevHome: string | undefined

function fakeClock(): RegistryClock & { elapsed: number } {
  const clock = {
    elapsed: 0,
    now: () => clock.elapsed,
    sleep: async (ms: number) => {
      clock.elapsed += ms
    },
  }
  return clock
}

function row(root: string, port: number, pid: number | null = null): RegistryRow {
  return { root, name: path.basename(root), port, pid, started_at: null }
}

const alwaysFree = async () => true

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-registry-")))
  prevHome = process.env.VIVICY_HOME
  process.env.VIVICY_HOME = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.VIVICY_HOME
  else process.env.VIVICY_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
})

describe("registryPath / serverLogPath", () => {
  it("hang off the ONE machine home, so the Vivicy repo holds no per-project file", () => {
    expect(registryPath()).toBe(path.join(home, "projects.json"))
    expect(serverLogPath(3100)).toBe(path.join(home, "logs", "3100.log"))
  })
})

describe("readRegistry", () => {
  it("is empty when nothing was ever written", () => {
    expect(readRegistry()).toEqual([])
  })

  it("degrades an unparseable or wrong-shaped file to empty rather than wedging the launcher", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(registryPath(), "{ not json")
    expect(readRegistry()).toEqual([])
    writeFileSync(registryPath(), JSON.stringify({ projects: "nope" }))
    expect(readRegistry()).toEqual([])
  })

  it("drops malformed rows and keeps the FIRST of two rows claiming one root", () => {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      registryPath(),
      JSON.stringify({
        projects: [
          { root: "/a", name: "a", port: 3100, pid: null },
          { root: "", name: "blank", port: 3101, pid: null },
          { root: "/b", name: "b", port: "3102", pid: null },
          { root: "/a", name: "a-again", port: 3103, pid: null },
        ],
      })
    )
    expect(readRegistry().map((r) => [r.root, r.port])).toEqual([["/a", 3100]])
  })
})

describe("withRegistry", () => {
  it("publishes a mutation and releases the lock on the way out", async () => {
    await withRegistry((rows) => rows.push(row("/a", 3100)), fakeClock())

    expect(readRegistry()).toEqual([{ root: "/a", name: "a", port: 3100, pid: null, started_at: null }])
    expect(existsSync(path.join(home, REGISTRY_LOCK_FILE))).toBe(false)
  })

  it("writes NOTHING when the mutation changed nothing — a poll is a zero-write no-op", async () => {
    await withRegistry((rows) => rows.push(row("/a", 3100)), fakeClock())
    const before = readFileSync(registryPath())

    await withRegistry((rows) => rows.length, fakeClock())

    expect(readFileSync(registryPath()).equals(before)).toBe(true)
  })

  it("releases the lock when the mutation throws, and lands no partial write", async () => {
    await withRegistry((rows) => rows.push(row("/a", 3100)), fakeClock())
    const before = readFileSync(registryPath())

    await expect(
      withRegistry((rows) => {
        rows.push(row("/b", 3101))
        throw new Error("mid-mutation")
      }, fakeClock())
    ).rejects.toThrow("mid-mutation")

    expect(readFileSync(registryPath()).equals(before)).toBe(true)
    expect(existsSync(path.join(home, REGISTRY_LOCK_FILE))).toBe(false)
  })

  it("refuses with registry_busy once the wait for a LIVE holder runs out — never by writing over it", async () => {
    mkdirSync(home, { recursive: true })
    const held = claimStageLock(home, REGISTRY_LOCK_FILE)
    expect(held).not.toBeNull()
    const clock = fakeClock()

    await expect(withRegistry((rows) => rows.push(row("/a", 3100)), clock)).rejects.toMatchObject({ code: "registry_busy" })
    expect(clock.elapsed).toBeGreaterThanOrEqual(5_000)
    expect(readRegistry()).toEqual([])

    held?.release()
  })
})

describe("allocatePort", () => {
  it("takes the first free port above the base", async () => {
    expect(await allocatePort([], "/a", alwaysFree)).toBe(PORT_BASE)
  })

  it("never hands out a port another project already recorded, but reuses the caller's own", async () => {
    const rows = [row("/a", PORT_BASE), row("/b", PORT_BASE + 1)]
    expect(await allocatePort(rows, "/c", alwaysFree)).toBe(PORT_BASE + 2)
    expect(await allocatePort(rows, "/a", alwaysFree)).toBe(PORT_BASE)
  })

  it("skips a port a foreign process holds", async () => {
    const busy = new Set([PORT_BASE, PORT_BASE + 1])
    expect(await allocatePort([], "/a", async (port) => !busy.has(port))).toBe(PORT_BASE + 2)
  })

  it("refuses loudly with no_free_port instead of scanning forever", async () => {
    await expect(allocatePort([], "/a", async () => false)).rejects.toBeInstanceOf(RegistryError)
    await expect(allocatePort([], "/a", async () => false)).rejects.toMatchObject({ code: "no_free_port" })
  })

  it("bounds the scan to the reserved span", async () => {
    const probed: number[] = []
    await expect(
      allocatePort([], "/a", async (port) => {
        probed.push(port)
        return false
      })
    ).rejects.toMatchObject({ code: "no_free_port" })
    expect(probed).toHaveLength(PORT_SPAN)
    expect(probed.at(-1)).toBe(PORT_BASE + PORT_SPAN - 1)
  })
})
