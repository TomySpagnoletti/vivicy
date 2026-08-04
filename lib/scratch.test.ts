import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { openScratchDir, scratchName, sweepAbandonedScratch } from "@/lib/scratch"

const PREFIX = "vivicy-scratch-probe-"

let root: string
let prevTmpdir: string | undefined

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "vivicy-scratch-root-"))
  prevTmpdir = process.env.TMPDIR
  process.env.TMPDIR = root
})

afterEach(() => {
  if (prevTmpdir === undefined) delete process.env.TMPDIR
  else process.env.TMPDIR = prevTmpdir
  rmSync(root, { recursive: true, force: true })
})

function plant(name: string): string {
  const dir = path.join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "held.txt"), "a killed process left this")
  return dir
}

const nobodyAlive = () => false
const everybodyAlive = () => true

describe("openScratchDir (scratch lives in the OS temp dir, never in a governed repo)", () => {
  it("creates a per-process unique dir under the temp root, named with its owner", () => {
    const first = openScratchDir(PREFIX)
    const second = openScratchDir(PREFIX)

    expect(path.dirname(first)).toBe(root)
    expect(first).not.toBe(second)
    for (const dir of [first, second]) {
      expect(path.basename(dir).startsWith(`${PREFIX}${process.pid}-`)).toBe(true)
      expect(existsSync(dir)).toBe(true)
    }
  })

  it("sweeps abandoned siblings as it plants — the only sweeper a hard kill leaves", () => {
    const orphan = plant(`${PREFIX}4242-AbCdEf`)

    const mine = openScratchDir(PREFIX, nobodyAlive)

    expect(existsSync(orphan)).toBe(false)
    expect(existsSync(mine)).toBe(true)
  })

  it("never touches a live owner's scratch, its own dir, or another prefix's", () => {
    const live = plant(`${PREFIX}4242-AbCdEf`)
    const mine = plant(`${PREFIX}${process.pid}-GhIjKl`)
    const foreign = plant("vivicy-other-stage-4242-MnOpQr")

    const planted = openScratchDir(PREFIX, everybodyAlive)

    for (const dir of [live, mine, foreign, planted]) expect(existsSync(dir)).toBe(true)
  })
})

describe("sweepAbandonedScratch (pid in the name is the whole identity)", () => {
  it("takes an entry whose name carries no pid at all", () => {
    const nameless = plant(`${PREFIX}not-a-pid`)

    sweepAbandonedScratch(root, PREFIX, everybodyAlive)

    expect(existsSync(nameless)).toBe(false)
  })

  it("takes a file as readily as a directory — the in-place publish temp is one", () => {
    const dead = path.join(root, scratchName(PREFIX).replace(`${process.pid}-`, "4242-"))
    writeFileSync(dead, "half a published file")

    sweepAbandonedScratch(root, PREFIX, nobodyAlive)

    expect(existsSync(dead)).toBe(false)
  })

  it("is a silent no-op on a directory that does not exist", () => {
    expect(() => sweepAbandonedScratch(path.join(root, "never-created"), PREFIX)).not.toThrow()
    expect(readdirSync(root)).toEqual([])
  })
})

describe("scratchName (a temp published by rename must stay beside its target)", () => {
  it("carries this process and never repeats", () => {
    const first = scratchName(PREFIX)
    const second = scratchName(PREFIX)

    expect(first).not.toBe(second)
    for (const name of [first, second]) expect(name.startsWith(`${PREFIX}${process.pid}-`)).toBe(true)
  })
})
