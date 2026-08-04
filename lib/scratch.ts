// Must stay a LEAF — loaded by the Next app and by plain node from the factory, so no Next alias and no relative value import.

import { randomUUID } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// Check the pid shape before the signal — `kill(0, 0)`/`kill(-1, 0)` succeed and would read as an owner; only ESRCH proves the owner gone, EPERM is a live process this user does not own.
function livePid(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

function ownerOf(name: string, prefix: string): number | null {
  const owner = Number.parseInt(name.slice(prefix.length), 10)
  return Number.isInteger(owner) && owner > 0 ? owner : null
}

// Sweep on the pid the name carries, never on the sweeper's position: this root is shared by every project and every process on the machine, so only what a DEAD owner left may go. Never throws — a caller is mid-work.
export function sweepAbandonedScratch(dir: string, prefix: string, isAlive: (pid: number) => boolean = livePid): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    const owner = ownerOf(name, prefix)
    if (owner === process.pid || (owner !== null && isAlive(owner))) continue
    try {
      rmSync(path.join(dir, name), { recursive: true, force: true })
    } catch {}
  }
}

// Scratch lives in the OS temp dir, never inside a governed repo, and planting one sweeps its abandoned siblings: a hard kill skips every finally, so the next plant is the only sweeper that can be counted on.
export function openScratchDir(prefix: string, isAlive: (pid: number) => boolean = livePid): string {
  const root = tmpdir()
  sweepAbandonedScratch(root, prefix, isAlive)
  return mkdtempSync(path.join(root, `${prefix}${process.pid}-`))
}

// For a temp that must be published by rename BESIDE its target, where the OS temp dir is another filesystem away.
export function scratchName(prefix: string): string {
  return `${prefix}${process.pid}-${randomUUID()}`
}
