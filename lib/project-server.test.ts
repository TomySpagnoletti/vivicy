import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ProjectError } from "@/lib/project"
import { PORT_BASE, readRegistry, serverLogPath } from "@/lib/project-registry"
import {
  forgetProject,
  listProjects,
  openProject,
  ProjectServerError,
  restartProject,
  stopProject,
  type ServerHost,
} from "@/lib/project-server"

interface FakeHost extends ServerHost {
  spawns: Array<{ root: string; port: number; logFile: string }>
  signals: Array<{ pid: number; signal: NodeJS.Signals }>
  alive: Set<number>
  busyPorts: Set<number>
  answering: Set<number>
  tail: string
  nextPid: number
  elapsed: number
  spawnError: Error | null
  deaf: boolean
  portOf: Map<number, number>
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    spawns: [],
    signals: [],
    alive: new Set<number>(),
    busyPorts: new Set<number>(),
    answering: new Set<number>(),
    tail: "",
    nextPid: 5000,
    elapsed: 0,
    spawnError: null,
    deaf: false,
    portOf: new Map<number, number>(),

    now: () => host.elapsed,
    sleep: async (ms: number) => {
      host.elapsed += ms
    },
    spawn(options) {
      if (host.spawnError) throw host.spawnError
      host.spawns.push(options)
      const pid = host.nextPid++
      host.alive.add(pid)
      host.portOf.set(pid, options.port)
      host.busyPorts.add(options.port)
      if (!host.deaf) host.answering.add(options.port)
      return pid
    },
    isAlive: (pid) => host.alive.has(pid),
    // A dead process gives its port back — the fake would flatter the manager otherwise.
    stop(pid, signal) {
      host.signals.push({ pid, signal })
      host.alive.delete(pid)
      const port = host.portOf.get(pid)
      if (port !== undefined) {
        host.busyPorts.delete(port)
        host.answering.delete(port)
      }
    },
    portFree: async (port) => !host.busyPorts.has(port),
    ready: async (port, root) => host.answering.has(port) && host.spawns.some((s) => s.port === port && s.root === root),
    logTail: () => host.tail,
  }
  return host
}

let home: string
let work: string
let prevHome: string | undefined

function project(name: string): string {
  const root = path.join(work, name)
  mkdirSync(root, { recursive: true })
  return root
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-manager-home-")))
  work = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-manager-work-")))
  prevHome = process.env.VIVICY_HOME
  process.env.VIVICY_HOME = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env.VIVICY_HOME
  else process.env.VIVICY_HOME = prevHome
  rmSync(home, { recursive: true, force: true })
  rmSync(work, { recursive: true, force: true })
})

describe("openProject", () => {
  it("registers an unknown folder, spawns one server bound to it, and hands back its own port", async () => {
    const host = fakeHost()
    const root = project("alpha")

    const opened = await openProject(host, root)

    expect(opened).toEqual({ root, name: "alpha", port: PORT_BASE, url: `http://127.0.0.1:${PORT_BASE}` })
    expect(host.spawns).toEqual([{ root, port: PORT_BASE, logFile: serverLogPath(PORT_BASE) }])
    expect(readRegistry()).toEqual([{ root, name: "alpha", port: PORT_BASE, pid: 5000, started_at: new Date(0).toISOString() }])
  })

  it("gives a second project its own port, and never two servers for one project", async () => {
    const host = fakeHost()
    const alpha = project("alpha")
    const beta = project("beta")

    await openProject(host, alpha)
    await openProject(host, beta)
    const again = await openProject(host, alpha)

    expect(again.port).toBe(PORT_BASE)
    expect(host.spawns.map((s) => s.port)).toEqual([PORT_BASE, PORT_BASE + 1])
  })

  it("focuses a live server through ANY spelling of its folder — a symlink is not a second project", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    const opened = await openProject(host, `${root}/.`)

    expect(opened.port).toBe(PORT_BASE)
    expect(host.spawns).toHaveLength(1)
  })

  it("waits for readiness even when it only FOCUSED — a port nothing answers on is never handed to the browser", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    host.answering.delete(PORT_BASE)

    await expect(openProject(host, root)).rejects.toMatchObject({ code: "not_ready" })
  })

  it("respawns a project whose recorded pid is gone, keeping its port", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    host.alive.clear()
    host.busyPorts.clear()

    const reopened = await openProject(host, root)

    expect(reopened.port).toBe(PORT_BASE)
    expect(host.spawns).toHaveLength(2)
    expect(readRegistry()[0].pid).toBe(5001)
  })

  it("moves a stopped project to a free port when a foreign process took its own", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    host.alive.clear()
    host.answering.clear()

    const reopened = await openProject(host, root)

    expect(reopened.port).toBe(PORT_BASE + 1)
    expect(readRegistry()[0].port).toBe(PORT_BASE + 1)
  })

  it("keeps the project KNOWN when the spawn is refused, so the launcher can still list and retry it", async () => {
    const host = fakeHost()
    const root = project("alpha")
    host.spawnError = new ProjectServerError("no build", "not_built")

    await expect(openProject(host, root)).rejects.toMatchObject({ code: "not_built" })

    expect(readRegistry()).toEqual([{ root, name: "alpha", port: PORT_BASE, pid: null, started_at: null }])
  })

  it("kills the child, clears the row and names the log tail when the server never answers", async () => {
    const host = fakeHost()
    const root = project("alpha")
    host.deaf = true
    host.tail = "Error: listen EADDRINUSE"

    await expect(openProject(host, root)).rejects.toMatchObject({ code: "not_ready" })
    await expect(openProject(host, root)).rejects.toThrow(/EADDRINUSE/)

    expect(host.signals.every((s) => s.signal === "SIGKILL")).toBe(true)
    expect(readRegistry()[0].pid).toBeNull()
  })

  it("refuses a path that is not a folder with the typed project error, touching the registry not at all", async () => {
    const host = fakeHost()

    await expect(openProject(host, "relative/path")).rejects.toBeInstanceOf(ProjectError)
    expect(readRegistry()).toEqual([])
  })
})

describe("listProjects", () => {
  it("reclaims a killed server's pid ON DISK and reports it stopped", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    host.alive.clear()
    const listed = await listProjects(host)

    expect(listed).toEqual([{ root, name: "alpha", port: PORT_BASE, url: `http://127.0.0.1:${PORT_BASE}`, running: false, missing: false }])
    expect(readRegistry()[0].pid).toBeNull()
  })

  it("flags a project whose folder is gone instead of dropping it from the list", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    rmSync(root, { recursive: true, force: true })

    expect((await listProjects(host))[0]).toMatchObject({ running: true, missing: true })
  })
})

describe("stopProject", () => {
  it("clears the row and terminates the group", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    await stopProject(host, root)

    expect(host.signals).toEqual([{ pid: 5000, signal: "SIGTERM" }])
    expect(readRegistry()[0]).toMatchObject({ pid: null, started_at: null })
  })

  it("escalates to SIGKILL when the process outlives the grace period", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    host.stop = (pid, signal) => {
      host.signals.push({ pid, signal })
      if (signal === "SIGKILL") host.alive.delete(pid)
    }

    await stopProject(host, root)

    expect(host.signals.at(0)).toEqual({ pid: 5000, signal: "SIGTERM" })
    expect(host.signals.at(-1)).toEqual({ pid: 5000, signal: "SIGKILL" })
  })

  it("names the project by the SAME key openProject registered it under, whatever spelling the caller uses", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    await stopProject(host, `${root}/.`)

    expect(host.signals, "a spelling the registry did not store must not read as an unknown project").toEqual([
      { pid: 5000, signal: "SIGTERM" },
    ])
    expect(readRegistry()[0].pid).toBeNull()
  })

  it("is a no-op on an already-stopped project and refuses an unknown one", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    await stopProject(host, root)
    host.signals.length = 0

    await stopProject(host, root)
    expect(host.signals).toEqual([])

    await expect(stopProject(host, path.join(work, "never-opened"))).rejects.toBeInstanceOf(ProjectServerError)
  })
})

describe("restartProject / forgetProject", () => {
  it("restart stops the old server and brings a fresh one up on the same port", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    const restarted = await restartProject(host, root)

    expect(restarted.port).toBe(PORT_BASE)
    expect(host.spawns).toHaveLength(2)
    expect(host.signals).toEqual([{ pid: 5000, signal: "SIGTERM" }])
    expect(readRegistry()[0].pid).toBe(5001)
  })

  it("forget reaches a project whose folder VANISHED — the row is the only way left to stop and drop it", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)
    rmSync(root, { recursive: true, force: true })

    await forgetProject(host, root)

    expect(host.signals).toEqual([{ pid: 5000, signal: "SIGTERM" }])
    expect(readRegistry()).toEqual([])
  })

  it("forget stops the server first — never leaves a process nothing can reach any more", async () => {
    const host = fakeHost()
    const root = project("alpha")
    await openProject(host, root)

    await forgetProject(host, root)

    expect(host.signals).toEqual([{ pid: 5000, signal: "SIGTERM" }])
    expect(readRegistry()).toEqual([])
  })

  it("frees the forgotten project's port for the next one", async () => {
    const host = fakeHost()
    const alpha = project("alpha")
    await openProject(host, alpha)
    await forgetProject(host, alpha)

    expect((await openProject(host, project("beta"))).port).toBe(PORT_BASE)
  })
})
