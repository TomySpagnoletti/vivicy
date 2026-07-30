// Imported by the Next app (`@/lib/stage-lock`) AND by plain node from the factory (raw `../lib/stage-lock.ts`), so it must stay a LEAF with no Next alias and no relative value import: an extensionless one fails NodeNext, a `.ts` one fails the app program (TS5097).

import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

export const SKILLS_LOCK_FILE = "skills-install.lock"

export interface HeldStageLock {
  release(): void
}

// EPERM is a live process this user does not own; only ESRCH proves the recorded holder is gone. A pid that is not a positive integer would make `kill(0, 0)`/`kill(-1, 0)` succeed and read as a holder, so the shape is checked before the signal.
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

// The marker is published temp-then-LINK, never written in place: an exclusive create is two syscalls (open, write) and a kill between them would leave a PARTIAL marker, which reads as abandoned and lets a live breaker be dispossessed — the one thing the destructive step below cannot survive. The lock file itself keeps its plain exclusive create, where a torn read costs a bounded race the identity guards contain instead of the break's exclusivity.
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

// A marker whose owner is GONE is residue (a killed break must never dead-end the stage), and taking it over runs the same discipline as the residue below: hard-linked aside so the marker path is never freed, the linked marker re-proved by the owner that was judged abandoned AND by the entry that was linked, unlinked only on a match. That makes a REFUSING taker non-destructive — moving the marker aside to inspect it would instead dispossess a breaker that published in the window, its own cleanup deleting what it moved. A SUCCEEDING taker's unlink is still path-based, so two takers of one abandoned marker can both pass these re-proofs and the second's unlink can remove the first's freshly published marker: this function does NOT promise one breaker at a time, and what contains that ordering is the residue's own re-proofs below, not an assumption here. An UNPARSEABLE marker cannot come from this protocol (publication is atomic), so it is a foreign artifact, refused rather than taken over; the sweep clears one whenever anyone holds the lock.
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

// The residue is unlinked only once its identity is CONFIRMED, and the path is never freed to confirm it: `abs` is hard-linked aside, the linked bytes must be the residue that was inspected, the marker must still name THIS process, and `abs` must still be the very entry that was linked. These two re-proofs are where the protocol's containment actually lives — the marker's takeover can hand the break to a second taker, so a breaker that lost its marker or whose path was replaced meanwhile stops HERE rather than unlinking someone's live claim. The residual they cannot cover is an ordering that needs two simultaneous one-syscall stalls in two processes (measured, `cli-supervisor-process-infra.557`): POSIX offers no compare-and-swap on a path, so an unlink names a path while every proof is about an inode. A residue whose bytes could not be READ is broken on that entry-identity alone, which is sound only because the ENOENT case never reaches here and a claim this protocol writes is readable by its own writer.
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

// A break killed inside its own window leaves its aside-name and its marker behind, and only the pid recorded in each says whether it is still owned — never the sweeper's position, since a break can run while another process holds the lock. Janitorial by nature: whoever just won the lock does the sweeping, and a sweep that could throw would replace the claim its caller just won.
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
