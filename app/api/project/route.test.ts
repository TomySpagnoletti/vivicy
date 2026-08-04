import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { GET } from "./route"

let workDir: string
let prevTarget: string | undefined

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-binding-")))
  prevTarget = process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_TARGET_ROOT
})

afterEach(() => {
  if (prevTarget === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevTarget
  rmSync(workDir, { recursive: true, force: true })
})

describe("GET /api/project", () => {
  it("reports an unbound process — that server is the launcher, not a project", async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, binding: { kind: "unbound" } })
  })

  it("reports the spawn-time binding and whether the folder is governed", async () => {
    process.env.VIVICY_TARGET_ROOT = workDir

    expect((await (await GET()).json()).binding).toEqual({
      kind: "bound",
      project: { root: workDir, name: path.basename(workDir), governed: false },
    })

    mkdirSync(path.join(workDir, ".vivicy"), { recursive: true })
    expect((await (await GET()).json()).binding).toEqual({
      kind: "bound",
      project: { root: workDir, name: path.basename(workDir), governed: true },
    })
  })

  it("reports a vanished binding as missing (200) rather than pretending to be the launcher", async () => {
    const gone = path.join(workDir, "gone")
    process.env.VIVICY_TARGET_ROOT = gone

    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, binding: { kind: "missing", root: gone } })
  })
})
