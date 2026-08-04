// Server-only: the launcher's process manager. One Next server per governed project, its root fixed at spawn.

import { existsSync } from "node:fs"
import path from "node:path"

import { describeProject } from "@/lib/project"
import { allocatePort, findRow, serverLogPath, withRegistry, type RegistryClock, type RegistryRow } from "@/lib/project-registry"
import type { RegisteredProject } from "@/lib/project-types"

export interface ServerHost extends RegistryClock {
  spawn(options: { root: string; port: number; logFile: string }): number
  isAlive(pid: number): boolean
  stop(pid: number, signal: NodeJS.Signals): void
  portFree(port: number): Promise<boolean>
  ready(port: number, root: string): Promise<boolean>
  logTail(port: number): string
}

export class ProjectServerError extends Error {
  constructor(
    message: string,
    readonly code: "not_built" | "spawn_failed" | "not_ready" | "unknown_project"
  ) {
    super(message)
    this.name = "ProjectServerError"
  }
}

export interface OpenedProject {
  root: string
  name: string
  port: number
  url: string
}

const READY_TIMEOUT_MS = 60_000
const READY_POLL_MS = 250
const STOP_TIMEOUT_MS = 8_000
const STOP_POLL_MS = 100

export function serverUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

// EVERY verb names a project by the same key `openProject` registered it under — the realpath — or a symlinked spelling of a live project refuses as unknown. A vanished folder has no realpath left, so its resolved spelling stands (which is what the launcher sends: the row's own root).
function projectKey(candidate: string): string {
  try {
    return describeProject(candidate).root
  } catch {
    return path.resolve(candidate.trim())
  }
}

// A recorded pid whose process is gone is residue, never a running server: every read of the registry reclaims before it reports.
function reclaim(rows: RegistryRow[], host: ServerHost): void {
  for (const row of rows) {
    if (row.pid !== null && !host.isAlive(row.pid)) {
      row.pid = null
      row.started_at = null
    }
  }
}

function view(row: RegistryRow, host: ServerHost): RegisteredProject {
  return {
    root: row.root,
    name: row.name,
    port: row.port,
    url: serverUrl(row.port),
    running: row.pid !== null && host.isAlive(row.pid),
    missing: !existsSync(row.root),
  }
}

export async function listProjects(host: ServerHost): Promise<RegisteredProject[]> {
  return withRegistry((rows) => {
    reclaim(rows, host)
    return rows.map((row) => view(row, host))
  }, host)
}

export async function openProject(host: ServerHost, candidate: string): Promise<OpenedProject> {
  const described = describeProject(candidate)

  // Two passes so a refused spawn still leaves the project KNOWN: the first records its identity and port, the second alone may fail.
  await withRegistry(async (rows) => {
    reclaim(rows, host)
    const row = findRow(rows, described.root)
    if (row === undefined) {
      rows.push({
        root: described.root,
        name: described.name,
        port: await allocatePort(rows, described.root, host.portFree),
        pid: null,
        started_at: null,
      })
      return
    }
    row.name = described.name
    if (row.pid === null && !(await host.portFree(row.port))) {
      row.port = await allocatePort(rows, described.root, host.portFree)
    }
  }, host)

  const live = await withRegistry((rows) => {
    const row = findRow(rows, described.root)
    if (row === undefined) throw new ProjectServerError(`project is not registered: ${described.root}`, "unknown_project")
    if (row.pid !== null && host.isAlive(row.pid)) return row.port
    row.pid = host.spawn({ root: row.root, port: row.port, logFile: serverLogPath(row.port) })
    row.started_at = new Date(host.now()).toISOString()
    return row.port
  }, host)

  await waitReady(host, live, described.root)
  return { root: described.root, name: described.name, port: live, url: serverUrl(live) }
}

// Every opener waits, the one that spawned and the ones that only focused: handing the browser a port nothing answers on yet is the same failure either way.
async function waitReady(host: ServerHost, port: number, root: string): Promise<void> {
  const deadline = host.now() + READY_TIMEOUT_MS
  for (;;) {
    if (await host.ready(port, root)) return
    if (host.now() >= deadline) break
    await host.sleep(READY_POLL_MS)
  }
  await abandon(host, root)
  const tail = host.logTail(port)
  throw new ProjectServerError(
    `the server for ${root} never answered on port ${port}${tail.length > 0 ? ` — last output: ${tail}` : ""}`,
    "not_ready"
  )
}

async function abandon(host: ServerHost, root: string): Promise<void> {
  await withRegistry((rows) => {
    const row = findRow(rows, root)
    if (row === undefined || row.pid === null) return
    host.stop(row.pid, "SIGKILL")
    row.pid = null
    row.started_at = null
  }, host)
}

export async function stopProject(host: ServerHost, candidate: string): Promise<void> {
  const root = projectKey(candidate)
  const pid = await withRegistry((rows) => {
    const row = findRow(rows, root)
    if (row === undefined) throw new ProjectServerError(`project is not registered: ${root}`, "unknown_project")
    const live = row.pid !== null && host.isAlive(row.pid) ? row.pid : null
    row.pid = null
    row.started_at = null
    return live
  }, host)
  if (pid === null) return
  host.stop(pid, "SIGTERM")
  const deadline = host.now() + STOP_TIMEOUT_MS
  while (host.isAlive(pid)) {
    if (host.now() >= deadline) {
      host.stop(pid, "SIGKILL")
      return
    }
    await host.sleep(STOP_POLL_MS)
  }
}

export async function restartProject(host: ServerHost, root: string): Promise<OpenedProject> {
  await stopProject(host, root)
  return openProject(host, root)
}

// Never leave a server behind that nothing can reach any more: the row is what the launcher stops it through.
export async function forgetProject(host: ServerHost, candidate: string): Promise<void> {
  await stopProject(host, candidate)
  const root = projectKey(candidate)
  await withRegistry((rows) => {
    const index = rows.findIndex((row) => row.root === root)
    if (index >= 0) rows.splice(index, 1)
  }, host)
}
