import { mkdirSync, readFileSync } from "node:fs"
import path from "node:path"

import { replaceFileAtomically } from "@/lib/managed-block"
import { claimStageLock } from "@/lib/stage-lock"
import { vivicyHome } from "@/lib/vivicy-home"

export const REGISTRY_FILE = "projects.json"
export const REGISTRY_LOCK_FILE = "projects.lock"

export const PORT_BASE = 3100
export const PORT_SPAN = 200

export interface RegistryRow {
  root: string
  name: string
  port: number
  pid: number | null
  started_at: string | null
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly code: "registry_busy" | "no_free_port"
  ) {
    super(message)
    this.name = "RegistryError"
  }
}

export function registryPath(): string {
  return path.join(vivicyHome(), REGISTRY_FILE)
}

export function serverLogPath(port: number): string {
  return path.join(vivicyHome(), "logs", `${port}.log`)
}

function isRow(value: unknown): value is RegistryRow {
  const row = value as RegistryRow | null
  return (
    !!row &&
    typeof row === "object" &&
    typeof row.root === "string" &&
    row.root.length > 0 &&
    typeof row.name === "string" &&
    Number.isInteger(row.port) &&
    (row.pid === null || Number.isInteger(row.pid))
  )
}

// A hand-mangled or half-written registry degrades to "no projects known" rather than wedging the launcher: rows are re-earned by opening a folder again.
export function readRegistry(): RegistryRow[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(registryPath(), "utf8"))
  } catch {
    return []
  }
  const rows = (parsed as { projects?: unknown })?.projects
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  return rows.filter(isRow).filter((row) => {
    if (seen.has(row.root)) return false
    seen.add(row.root)
    return true
  })
}

function serialize(rows: RegistryRow[]): string {
  return `${JSON.stringify({ projects: rows }, null, 2)}\n`
}

const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5_000

export interface RegistryClock {
  now(): number
  sleep(ms: number): Promise<void>
}

export const systemClock: RegistryClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}

// EVERY registry mutation rides this one critical section: the lock is what makes "same project twice = one server" a decision instead of a race.
export async function withRegistry<T>(mutate: (rows: RegistryRow[]) => T | Promise<T>, clock: RegistryClock = systemClock): Promise<T> {
  const home = vivicyHome()
  mkdirSync(home, { recursive: true })
  const deadline = clock.now() + LOCK_TIMEOUT_MS
  let held = claimStageLock(home, REGISTRY_LOCK_FILE)
  while (held === null) {
    if (clock.now() >= deadline) {
      throw new RegistryError("the project registry is busy — another window is opening a project right now", "registry_busy")
    }
    await clock.sleep(LOCK_RETRY_MS)
    held = claimStageLock(home, REGISTRY_LOCK_FILE)
  }
  try {
    const rows = readRegistry()
    const before = serialize(rows)
    const result = await mutate(rows)
    const after = serialize(rows)
    if (after !== before) replaceFileAtomically(registryPath(), Buffer.from(after))
    return result
  } finally {
    held.release()
  }
}

export function findRow(rows: RegistryRow[], root: string): RegistryRow | undefined {
  return rows.find((row) => row.root === root)
}

// First-free above the base, recorded once and kept for the project's life: a hashed port has no collision guarantee and would need this probe anyway, so the registry — not an arithmetic trick — is the allocation record.
export async function allocatePort(rows: RegistryRow[], exclude: string, isFree: (port: number) => Promise<boolean>): Promise<number> {
  const taken = new Set(rows.filter((row) => row.root !== exclude).map((row) => row.port))
  for (let port = PORT_BASE; port < PORT_BASE + PORT_SPAN; port += 1) {
    if (taken.has(port)) continue
    if (await isFree(port)) return port
  }
  throw new RegistryError(`no free port between ${PORT_BASE} and ${PORT_BASE + PORT_SPAN - 1}`, "no_free_port")
}
