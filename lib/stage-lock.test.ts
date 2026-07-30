import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// The protocol's dangerous instants are all reads — of the residue, of the aside-name, of the entry the unlink is about to remove — so interposing the module's OWN fs reads is what lets another party act INSIDE one of those windows, which is the only place the ordering guarantees are observable.
const interposed = vi.hoisted(() => ({
  hooks: [] as { call: "read" | "lstat"; match: (file: string) => boolean; after: boolean; fire: () => void }[],
}))

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  const take = (call: "read" | "lstat", file: unknown) => {
    if (typeof file !== "string") return null
    const at = interposed.hooks.findIndex((hook) => hook.call === call && hook.match(file))
    return at === -1 ? null : interposed.hooks.splice(at, 1)[0]
  }
  const readFileSync = ((file: string, options: never) => {
    const hook = take("read", file)
    if (hook && !hook.after) hook.fire()
    const bytes = actual.readFileSync(file, options)
    if (hook?.after) hook.fire()
    return bytes
  }) as typeof actual.readFileSync
  const lstatSync = ((file: string, options: never) => {
    const hook = take("lstat", file)
    if (hook && !hook.after) hook.fire()
    const stats = actual.lstatSync(file, options)
    if (hook?.after) hook.fire()
    return stats
  }) as typeof actual.lstatSync
  return { ...actual, default: { ...actual, readFileSync, lstatSync }, readFileSync, lstatSync }
})

import { claimStageLock, SKILLS_LOCK_FILE, stageLockHolder } from "@/lib/stage-lock"

let runtimeDir: string

beforeEach(() => {
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-stage-lock-"))
})

afterEach(() => {
  interposed.hooks.length = 0
  rmSync(runtimeDir, { recursive: true, force: true })
})

const lockPath = () => path.join(runtimeDir, SKILLS_LOCK_FILE)

const arm = (match: string, fire: () => void) => {
  interposed.hooks.push({ call: "read", match: (file) => file.includes(match), after: false, fire })
}

const armAfterLstat = (target: () => string, fire: () => void) => {
  interposed.hooks.push({ call: "lstat", match: (file) => file === target(), after: true, fire })
}

const armAfterRead = (target: () => string, fire: () => void) => {
  interposed.hooks.push({ call: "read", match: (file) => file === target(), after: true, fire })
}

const MODULE = path.resolve("lib/stage-lock.ts")

// A REAL second process running the very same protocol: the only faithful co-breaker, since two claims inside one process share a pid and the protocol reads pids.
function claimInChild(dir: string): { claimed: boolean; pid: number } {
  const script = `const { claimStageLock, SKILLS_LOCK_FILE } = await import(${JSON.stringify(MODULE)})
const held = claimStageLock(process.env.STAGE_LOCK_DIR, SKILLS_LOCK_FILE)
process.stdout.write(JSON.stringify({ claimed: held !== null, pid: process.pid }))`
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: { ...process.env, STAGE_LOCK_DIR: dir },
  })
  expect(child.status, child.stderr).toBe(0)
  return JSON.parse(child.stdout) as { claimed: boolean; pid: number }
}

function writeLock(pid: number, file = SKILLS_LOCK_FILE): string {
  const abs = path.join(runtimeDir, file)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, `${JSON.stringify({ pid, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`)
  return abs
}

function recordedPid(abs: string): number | null {
  try {
    return (JSON.parse(readFileSync(abs, "utf8")) as { pid?: number }).pid ?? null
  } catch {
    return null
  }
}

let reaped: number | null = null

// spawnSync returns only after the child has been reaped, so signalling this pid is ESRCH — a killed run's residue, not a holder. One suffices for the whole file, a reaped pid staying dead, and spawning per call would load every other suite's budget for nothing.
function reapedPid(): number {
  if (reaped === null) {
    const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" })
    expect(child.status).toBe(0)
    reaped = child.pid as number
  }
  return reaped
}

describe("claimStageLock — exactly one holder", () => {
  it("admits the first caller and refuses while it holds", () => {
    const first = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(first).not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "the exclusive create is the only door").toBeNull()

    first!.release()
    expect(existsSync(lockPath())).toBe(false)
  })

  it("reclaims a killed run's residue and leaves no break residue of its own", () => {
    writeLock(reapedPid())
    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held).not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
    expect(readdirSync(runtimeDir), "no .stale and no .break survive a completed break").toEqual([])
  })

  it("release removes only its OWN claim", () => {
    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    const successor = `${JSON.stringify({ pid: 1, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`
    writeFileSync(lockPath(), successor)
    held!.release()
    expect(readFileSync(lockPath(), "utf8"), "a predecessor never deletes a successor's lock").toBe(successor)
  })
})

// The break is the one destructive step in the protocol, and its guard has to be IDENTITY, not the path: between reading the residue's liveness and breaking it, a competitor can claim that very path.
describe("claimStageLock — breaking residue is exactly-once", () => {
  it("refuses instead of stealing a claim that appeared between the liveness read and the break", () => {
    writeLock(reapedPid())
    let competitor: ReturnType<typeof claimStageLock> = null

    // Fires at the ordinary instruction boundary between the residue read and the break: a real competing stage takes the lock there.
    const stolenBy = claimStageLock(runtimeDir, SKILLS_LOCK_FILE, () => {
      competitor ??= claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
      return false
    })

    expect(competitor, "the competitor genuinely won the residue").not.toBeNull()
    expect(stolenBy, "and the second breaker must refuse rather than touch their live claim").toBeNull()
    expect(recordedPid(lockPath()), "the competitor's claim is still the one on disk").toBe(process.pid)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE), "so a third caller still sees a live holder — never a free path").toBe(
      process.pid
    )

    competitor!.release()
    expect(existsSync(lockPath())).toBe(false)
  })

  it("keeps the path OCCUPIED through the whole break, so a third party's exclusive create cannot take it", () => {
    writeLock(reapedPid())
    const foreign = `${JSON.stringify({ pid: 4242, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`
    let holder: ReturnType<typeof claimStageLock> = null
    let claimed = ""
    let thirdParty: "took the path" | "refused" | "never ran" = "never ran"

    const stolenBy = claimStageLock(runtimeDir, SKILLS_LOCK_FILE, () => {
      holder ??= claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
      claimed = readFileSync(lockPath(), "utf8")
      arm(".stale.", () => {
        try {
          writeFileSync(lockPath(), foreign, { flag: "wx" })
          thirdParty = "took the path"
        } catch {
          thirdParty = "refused"
        }
      })
      return false
    })

    expect(holder, "the live holder claimed the path in the preemption window").not.toBeNull()
    expect(thirdParty, "a third real party, doing nothing but the protocol's own exclusive create inside the break's window").toBe(
      "refused"
    )
    expect(stolenBy, "the breaker refuses without ever having freed the path").toBeNull()
    expect(readFileSync(lockPath(), "utf8"), "the holder's own claim is still the file on disk, byte for byte").toBe(claimed)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE), "so every later caller sees that live holder").toBe(process.pid)

    holder!.release()
    expect(readdirSync(runtimeDir), "and the refused break took its own residue with it").toEqual([])
  })

  it("leaves a killed breaker a state no later caller can read as a free path, and its residue is swept", () => {
    writeLock(reapedPid())
    let holder: ReturnType<typeof claimStageLock> = null
    let killed: Record<string, Buffer> = {}

    const stolenBy = claimStageLock(runtimeDir, SKILLS_LOCK_FILE, () => {
      holder ??= claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
      arm(".stale.", () => {
        killed = Object.fromEntries(readdirSync(runtimeDir).map((name) => [name, readFileSync(path.join(runtimeDir, name))]))
      })
      return false
    })
    expect(holder).not.toBeNull()
    expect(stolenBy).toBeNull()
    expect(Object.keys(killed), "at the break's most dangerous instant the claim is still AT the lock path").toContain(SKILLS_LOCK_FILE)

    // Replay those artifacts with the breaker HARD-KILLED: its marker and its aside-name now name a pid that is gone.
    const dead = reapedPid()
    const replay = path.join(runtimeDir, "killed-breaker")
    mkdirSync(replay)
    for (const [name, bytes] of Object.entries(killed)) {
      writeFileSync(path.join(replay, name.replace(`.stale.${process.pid}`, `.stale.${dead}`)), bytes)
    }
    writeLock(dead, path.join("killed-breaker", `${SKILLS_LOCK_FILE}.break`))

    expect(claimStageLock(replay, SKILLS_LOCK_FILE), "the next caller is NOT admitted alongside the live holder").toBeNull()
    expect(recordedPid(path.join(replay, SKILLS_LOCK_FILE)), "whose claim is exactly where the break left it").toBe(process.pid)

    rmSync(path.join(replay, SKILLS_LOCK_FILE))
    const next = claimStageLock(replay, SKILLS_LOCK_FILE)
    expect(next, "and once that holder is gone the killed break dead-ends nothing").not.toBeNull()
    expect(readdirSync(replay), "the killed breaker's aside-name and marker are swept by whoever ends up holding").toEqual([
      SKILLS_LOCK_FILE,
    ])

    next!.release()
    holder!.release()
  })

  it("refuses when a later taker of an abandoned marker owns the break — the robbed breaker destroys nothing", () => {
    const residue = writeLock(reapedPid())
    const before = readFileSync(residue, "utf8")
    writeLock(reapedPid(), `${SKILLS_LOCK_FILE}.break`)
    const taker = `${JSON.stringify({ pid: 4242, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`

    // Taking over an abandoned marker is a remove and a create, so a later taker can end up holding the marker while this break is still verifying.
    arm(".stale.", () => writeFileSync(`${lockPath()}.break`, taker))

    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "the break belongs to whoever holds the marker NOW").toBeNull()
    expect(readFileSync(residue, "utf8"), "so the residue it was about to remove is untouched").toBe(before)
    expect(readFileSync(`${lockPath()}.break`, "utf8"), "and the taker's marker is left to the taker").toBe(taker)
  })

  it("refuses when another breaker already replaced the path — an unlink names a path, the proof is about an inode", () => {
    writeLock(reapedPid())
    const winner = `${JSON.stringify({ pid: process.pid, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`

    // Another breaker of the same residue completing between this one's identity read and its unlink: what it verified is gone and a LIVE claim stands in its place.
    arm(".stale.", () => {
      rmSync(lockPath())
      writeFileSync(lockPath(), winner, { flag: "wx" })
    })

    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "a breaker whose subject was replaced refuses").toBeNull()
    expect(readFileSync(lockPath(), "utf8"), "the winner's live claim survives its verification").toBe(winner)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBe(process.pid)
  })

  it("its own leftover aside-name from an earlier break never blocks it", () => {
    writeLock(reapedPid())
    writeLock(reapedPid(), `${SKILLS_LOCK_FILE}.stale.${process.pid}`)

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "the aside-name is per-process, so a leftover of ours is ours to clear").not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
  })

  it("claims a lock that vanished under it — a holder releasing between the create and the read is no refusal", () => {
    writeLock(process.pid)
    arm(SKILLS_LOCK_FILE, () => rmSync(lockPath()))

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "the path is free by the time it is read, so it is simply taken").not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
  })

  it("refuses a successor's live claim that replaced the residue under its own read", () => {
    writeLock(reapedPid())
    const successor = `${JSON.stringify({ pid: process.pid, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`

    arm(SKILLS_LOCK_FILE, () => {
      rmSync(lockPath())
      writeFileSync(lockPath(), successor, { flag: "wx" })
    })

    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "what the read returns is what liveness is judged on").toBeNull()
    expect(readFileSync(lockPath(), "utf8"), "so the successor's claim was never a break's subject").toBe(successor)
  })

  it("breaks a lock it cannot READ by identity alone, and refuses an entry whose identity cannot be pinned", () => {
    const unreadable = writeLock(reapedPid())
    chmodSync(unreadable, 0o000)

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "an unreadable residue is broken through the aside link's inode rather than dead-ending the stage").not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()

    symlinkSync(path.join(runtimeDir, "nowhere.json"), lockPath())
    expect(
      claimStageLock(runtimeDir, SKILLS_LOCK_FILE),
      "a dangling link cannot be linked aside on this platform, so it is refused — never removed on sight, which is how a live claim gets destroyed"
    ).toBeNull()
    expect(lstatSync(lockPath()).isSymbolicLink(), "the entry is left exactly as it was").toBe(true)
    expect(readdirSync(runtimeDir), "and the refusal writes nothing beside it").toEqual([SKILLS_LOCK_FILE])
  })

  it("a sweep that cannot remove what it found still hands back the claim it just won", () => {
    mkdirSync(`${lockPath()}.stale.${reapedPid()}`)

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "a throwing janitor would leak a lock nothing can ever release").not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
    expect(existsSync(lockPath())).toBe(false)
  })

  it("a REAL co-breaker never takes the break from a live one, so nothing can claim inside the last window", () => {
    writeLock(reapedPid())
    let liveMarker: { claimed: boolean; pid: number } | null = null
    let tornMarker: { claimed: boolean; pid: number } | null = null

    // This process links the residue aside, compares its bytes, re-reads its marker and re-proves the entry — then STALLS on that last proof, which is the only window left in the protocol. A real second process runs the whole protocol there, twice: once against this breaker's live marker, once against a PARTIAL one — the artifact a killed create would leave if the marker were written in place instead of published atomically.
    armAfterLstat(lockPath, () => {
      liveMarker = claimInChild(runtimeDir)
      writeFileSync(`${lockPath()}.break`, "")
      tornMarker = claimInChild(runtimeDir)
    })

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)

    expect(liveMarker, "the co-breaker really ran inside the window").not.toBeNull()
    expect(liveMarker!.claimed, "a live breaker's marker refuses every other breaker").toBe(false)
    expect(tornMarker!.claimed, "and an UNPARSEABLE marker is a foreign artifact, refused rather than taken over").toBe(false)
    expect(held, "so the residue this breaker verified is the only thing its unlink removes").not.toBeNull()
    expect(recordedPid(lockPath()), "exactly one holder").toBe(process.pid)

    held!.release()
  })

  it("a refusing TAKER destroys nothing — a live breaker's marker survives it", () => {
    writeLock(reapedPid())
    const markerPath = `${lockPath()}.break`
    writeLock(reapedPid(), `${SKILLS_LOCK_FILE}.break`)
    const published = `${JSON.stringify({ pid: process.ppid, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`

    // Between this taker's owner read and its destructive step, a LIVE breaker (a real process — this one's parent) takes that abandoned marker over and publishes its own.
    armAfterRead(
      () => markerPath,
      () => {
        rmSync(markerPath)
        writeFileSync(markerPath, published)
      }
    )

    expect(
      claimStageLock(runtimeDir, SKILLS_LOCK_FILE),
      "the marker it linked is not the one it judged abandoned, so it refuses"
    ).toBeNull()
    expect(readFileSync(markerPath, "utf8"), "and a taker that moved the marker aside to look at it would have deleted this").toBe(
      published
    )
    expect(recordedPid(lockPath()), "the residue is untouched too").not.toBe(process.pid)
  })

  it("a taker whose marker is replaced WHILE it verifies refuses on the entry, not on the bytes", () => {
    const owner = reapedPid()
    writeLock(reapedPid())
    const markerPath = `${lockPath()}.break`
    writeLock(owner, `${SKILLS_LOCK_FILE}.break`)

    // Fires between the link and the checks: a different entry appears at the marker path carrying the very pid this taker judged abandoned, so only its identity separates them.
    armAfterLstat(
      () => `${markerPath}.taken.${process.pid}`,
      () => {
        rmSync(markerPath)
        writeLock(owner, `${SKILLS_LOCK_FILE}.break`)
      }
    )

    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "same bytes, different entry — the taker refuses").toBeNull()
    expect(recordedPid(markerPath), "and the entry that replaced it is still there").toBe(owner)
  })

  it("refuses while another breaker of the same residue is alive", () => {
    writeLock(reapedPid())
    writeFileSync(`${lockPath()}.break`, `${JSON.stringify({ pid: process.pid, started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`)

    expect(claimStageLock(runtimeDir, SKILLS_LOCK_FILE), "one breaker per residue").toBeNull()
    expect(recordedPid(lockPath()), "and the residue is left exactly as it was").not.toBe(process.pid)
  })

  it("takes over a break marker whose own breaker is gone, so a killed break never dead-ends the stage", () => {
    writeLock(reapedPid())
    writeFileSync(`${lockPath()}.break`, `${JSON.stringify({ pid: reapedPid(), started_at: "2026-07-04T09:00:00Z" }, null, 2)}\n`)

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held).not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
    expect(readdirSync(runtimeDir)).toEqual([])
  })

  it("sweeps an abandoned break's residue when it takes the lock, and leaves a live breaker's — or its own — alone", () => {
    const breaker = 4242
    const untouched = [
      SKILLS_LOCK_FILE,
      `${SKILLS_LOCK_FILE}.break`,
      `${SKILLS_LOCK_FILE}.break.new.${breaker}`,
      `${SKILLS_LOCK_FILE}.break.taken.${breaker}`,
      `${SKILLS_LOCK_FILE}.stale.${breaker}`,
      `${SKILLS_LOCK_FILE}.stale.${process.pid}`,
    ].sort()
    writeLock(breaker, `${SKILLS_LOCK_FILE}.stale.${breaker}`)
    writeLock(breaker, `${SKILLS_LOCK_FILE}.break.taken.${breaker}`)
    writeLock(breaker, `${SKILLS_LOCK_FILE}.break.new.${breaker}`)
    writeLock(breaker, `${SKILLS_LOCK_FILE}.break`)
    writeLock(process.pid, `${SKILLS_LOCK_FILE}.stale.${process.pid}`)

    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE, (pid) => pid === breaker)
    expect(held, "a free path is claimed whatever a live breaker is doing beside it").not.toBeNull()
    expect(readdirSync(runtimeDir).sort(), "and that breaker's aside-name and marker are its own to finish with").toEqual(untouched)

    expect(
      claimStageLock(runtimeDir, SKILLS_LOCK_FILE, () => true),
      "a refused caller is a reader"
    ).toBeNull()
    expect(readdirSync(runtimeDir).sort(), "so it sweeps nothing at all").toEqual(untouched)
    held!.release()

    const next = claimStageLock(runtimeDir, SKILLS_LOCK_FILE, () => false)
    expect(next).not.toBeNull()
    expect(
      readdirSync(runtimeDir).sort(),
      "every per-process name a killed break can leave — the aside, the marker's publish temp, its takeover name — is swept once its breaker is gone, and never this process's own"
    ).toEqual([SKILLS_LOCK_FILE, `${SKILLS_LOCK_FILE}.stale.${process.pid}`])
    next!.release()
  })

  it("treats an unreadable lock as residue rather than refusing forever", () => {
    writeFileSync(lockPath(), "{ half a lock")
    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "a crash mid-write must not dead-end the stage").not.toBeNull()
    expect(recordedPid(lockPath())).toBe(process.pid)
    held!.release()
  })
})

describe("stageLockHolder — the clients' read-only probe", () => {
  it("reports a live holder, ignores a dead one, and never writes", () => {
    const dead = reapedPid()
    const abs = writeLock(dead)
    const before = readFileSync(abs, "utf8")
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBeNull()
    expect(readFileSync(abs, "utf8"), "the probe is read-only — reclaiming is the stage's move").toBe(before)

    writeLock(process.pid)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBe(process.pid)
  })

  it("takes the caller's own liveness source, and reads EPERM as alive", () => {
    writeLock(4242)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE, () => true)).toBe(4242)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE, () => false)).toBeNull()
    // pid 1 is alive and owned by root: signalling it raises EPERM, which is a holder, not a corpse.
    writeLock(1)
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBe(1)
  })

  it("reads a recorded pid that is no process at all as no holder — 0, negative and fractional included", () => {
    for (const pid of [0, -1, 1.5]) {
      writeLock(pid)
      expect(
        stageLockHolder(runtimeDir, SKILLS_LOCK_FILE),
        `pid ${pid} names no process, and signalling it would answer for a group`
      ).toBeNull()
    }
    const held = claimStageLock(runtimeDir, SKILLS_LOCK_FILE)
    expect(held, "such a lock is residue, broken like any other").not.toBeNull()
    held!.release()
  })

  it("is null on a missing or unreadable lock", () => {
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBeNull()
    writeFileSync(lockPath(), "{ half a lock")
    expect(stageLockHolder(runtimeDir, SKILLS_LOCK_FILE)).toBeNull()
  })
})
