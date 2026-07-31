// Must stay a LEAF — loaded by the Next app and by plain node from the factory, so no Next alias and no relative value import.

import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export const SKILLS_LOCK_FILE = "skills-install.lock"

export interface HeldStageLock {
  release(): void
}

// Check the pid shape before the signal — `kill(0, 0)`/`kill(-1, 0)` succeed and would read as a holder; only ESRCH proves the holder gone, EPERM is a live process this user does not own.
function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readOrNull(abs: string): Buffer | null {
  try {
    return readFileSync(abs)
  } catch {
    return null
  }
}

function pidOf(bytes: Buffer | null): number | null {
  if (bytes === null) return null
  try {
    const raw = JSON.parse(bytes.toString("utf8")) as { pid?: unknown }
    return typeof raw.pid === "number" ? raw.pid : null
  } catch {
    return null
  }
}

function abandoned(pid: number | null, isAlive: (pid: number) => boolean): boolean {
  return pid !== process.pid && (pid === null || !isAlive(pid))
}

function readResidue(abs: string): { bytes: Buffer | null; gone: boolean } {
  try {
    return { bytes: readFileSync(abs), gone: false }
  } catch (error) {
    return { bytes: null, gone: (error as NodeJS.ErrnoException).code === "ENOENT" }
  }
}

function entryId(abs: string): string | null {
  try {
    const s = lstatSync(abs)
    return `${s.dev}-${s.ino}`
  } catch {
    return null
  }
}

export function stageLockHolder(runtimeDir: string, file: string, isAlive: (pid: number) => boolean = livePid): number | null {
  const pid = pidOf(readOrNull(path.join(runtimeDir, file)))
  return pid !== null && isAlive(pid) ? pid : null
}

function claimBytes(): string {
  return `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }, null, 2)}\n`
}

function create(abs: string): boolean {
  try {
    writeFileSync(abs, claimBytes(), { flag: "wx" })
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return false
  }
}

// Publish the marker temp-then-LINK, never an exclusive create: a kill between its open and its write leaves a PARTIAL marker that reads as abandoned.
function publishMarker(marker: string): boolean {
  const temp = `${marker}.new.${process.pid}`
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, claimBytes(), { flag: "wx" })
    try {
      linkSync(temp, marker)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      return false
    }
  } finally {
    rmSync(temp, { force: true })
  }
}

// Never move the marker aside to inspect it — hard-link, re-prove owner and entry, unlink last; refuse an unparseable marker rather than take it over, and never assume this admits one breaker at a time.
function claimBreakMarker(marker: string, isAlive: (pid: number) => boolean): boolean {
  if (publishMarker(marker)) return true
  const owner = pidOf(readOrNull(marker))
  if (owner === null || !abandoned(owner, isAlive)) return false
  const taken = `${marker}.taken.${process.pid}`
  try {
    rmSync(taken, { force: true })
    try {
      linkSync(marker, taken)
    } catch {
      return false
    }
    const linked = entryId(taken)
    if (pidOf(readOrNull(taken)) !== owner) return false
    if (linked === null || linked !== entryId(marker)) return false
    rmSync(marker, { force: true })
    return publishMarker(marker)
  } finally {
    rmSync(taken, { force: true })
  }
}

// Never free the path to confirm identity: hard-link aside, then re-prove the bytes, the marker's owner and the entry immediately before the unlink — those re-proofs are the whole containment.
function breakResidue(abs: string, residue: Buffer | null, isAlive: (pid: number) => boolean): boolean {
  const marker = `${abs}.break`
  if (!claimBreakMarker(marker, isAlive)) return false
  const aside = `${abs}.stale.${process.pid}`
  try {
    rmSync(aside, { force: true })
    try {
      linkSync(abs, aside)
    } catch {
      return false
    }
    const linked = entryId(aside)
    if (residue !== null) {
      const bytes = readOrNull(aside)
      if (bytes === null || !residue.equals(bytes)) return false
    }
    if (pidOf(readOrNull(marker)) !== process.pid) return false
    if (linked === null || linked !== entryId(abs)) return false
    rmSync(abs, { force: true })
    return true
  } finally {
    rmSync(aside, { force: true })
    if (pidOf(readOrNull(marker)) === process.pid) rmSync(marker, { force: true })
  }
}

// Sweep on the pid recorded in each name, never on the sweeper's position, and never throw: the caller has already won its claim.
function sweepAbandonedBreaks(abs: string, isAlive: (pid: number) => boolean): void {
  try {
    const dir = path.dirname(abs)
    const base = path.basename(abs)
    const perProcess = [`${base}.stale.`, `${base}.break.taken.`, `${base}.break.new.`]
    for (const name of readdirSync(dir)) {
      const prefix = perProcess.find((candidate) => name.startsWith(candidate))
      if (prefix === undefined) continue
      const owner = Number(name.slice(prefix.length))
      if (abandoned(Number.isInteger(owner) ? owner : null, isAlive)) rmSync(path.join(dir, name), { force: true })
    }
    const marker = `${abs}.break`
    const bytes = readOrNull(marker)
    if (bytes !== null && abandoned(pidOf(bytes), isAlive)) rmSync(marker, { force: true })
  } catch {}
}

function heldBy(abs: string): HeldStageLock {
  return {
    release: () => {
      if (pidOf(readOrNull(abs)) === process.pid) rmSync(abs, { force: true })
    },
  }
}

function admit(abs: string, isAlive: (pid: number) => boolean): HeldStageLock | null {
  if (create(abs)) return heldBy(abs)
  const { bytes, gone } = readResidue(abs)
  if (gone) return create(abs) ? heldBy(abs) : null
  const pid = pidOf(bytes)
  if (pid !== null && isAlive(pid)) return null
  return breakResidue(abs, bytes, isAlive) && create(abs) ? heldBy(abs) : null
}

export function claimStageLock(runtimeDir: string, file: string, isAlive: (pid: number) => boolean = livePid): HeldStageLock | null {
  const abs = path.join(runtimeDir, file)
  mkdirSync(runtimeDir, { recursive: true })
  const held = admit(abs, isAlive)
  if (held !== null) sweepAbandonedBreaks(abs, isAlive)
  return held
}
