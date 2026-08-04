import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { ensureProjectRuntimeDir, getProjectRuntimeDir, PROJECT_RUNTIME_SEGMENTS } from "@/lib/project-runtime"

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "vivicy-project-runtime-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe("getProjectRuntimeDir", () => {
  it("homes the state inside the target project", () => {
    expect(getProjectRuntimeDir("/tmp/demo", {})).toBe(path.join("/tmp/demo", ".vivicy", "runtime"))
  })

  it("gives two targets sharing a basename two distinct homes, with no key to derive", () => {
    expect(getProjectRuntimeDir("/a/app", {})).not.toBe(getProjectRuntimeDir("/b/app", {}))
  })

  it("resolves a relative target against cwd", () => {
    expect(getProjectRuntimeDir("foo", {})).toBe(path.join(path.resolve("foo"), ...PROJECT_RUNTIME_SEGMENTS))
  })

  it("honors VIVICY_RUNTIME_DIR as an override, resolved absolute", () => {
    expect(getProjectRuntimeDir("/tmp/demo", { VIVICY_RUNTIME_DIR: "/elsewhere/rt" })).toBe("/elsewhere/rt")
    expect(getProjectRuntimeDir("/tmp/demo", { VIVICY_RUNTIME_DIR: "./a/../b" })).toBe(path.resolve("b"))
  })

  it("ignores a blank override and falls back to the target-side default", () => {
    expect(getProjectRuntimeDir("/tmp/demo", { VIVICY_RUNTIME_DIR: "   " })).toBe(path.join("/tmp/demo", ".vivicy", "runtime"))
    expect(getProjectRuntimeDir("/tmp/demo", { VIVICY_RUNTIME_DIR: "" })).toBe(path.join("/tmp/demo", ".vivicy", "runtime"))
  })

  it("reads process.env when no env is handed in", () => {
    const prev = process.env.VIVICY_RUNTIME_DIR
    process.env.VIVICY_RUNTIME_DIR = path.join(tmp, "override")
    try {
      expect(getProjectRuntimeDir("/tmp/demo")).toBe(path.join(tmp, "override"))
    } finally {
      if (prev === undefined) delete process.env.VIVICY_RUNTIME_DIR
      else process.env.VIVICY_RUNTIME_DIR = prev
    }
  })
})

describe("ensureProjectRuntimeDir", () => {
  it("creates the dir and makes it ignore itself", () => {
    const dir = getProjectRuntimeDir(tmp, {})
    expect(ensureProjectRuntimeDir(dir)).toBe(dir)
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("*\n")
  })

  it("leaves a healthy marker untouched and disturbs nothing beside it", () => {
    const dir = ensureProjectRuntimeDir(getProjectRuntimeDir(tmp, {}))
    writeFileSync(path.join(dir, "run-state.json"), "{}")
    const before = statSync(path.join(dir, ".gitignore"))
    ensureProjectRuntimeDir(dir)
    ensureProjectRuntimeDir(dir)
    const after = statSync(path.join(dir, ".gitignore"))
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("*\n")
    expect(after.ino, "a healthy dir is a zero-write no-op, never a republish").toBe(before.ino)
    expect(existsSync(path.join(dir, "run-state.json"))).toBe(true)
  })

  // The exact residue an exclusive-create publish leaves when it is killed between its open and its write.
  it("repairs an EMPTY marker instead of leaving the dir permanently visible to git", () => {
    const dir = ensureProjectRuntimeDir(getProjectRuntimeDir(tmp, {}))
    writeFileSync(path.join(dir, ".gitignore"), "")
    ensureProjectRuntimeDir(dir)
    expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("*\n")
  })

  it("repairs a marker holding anything but its own bytes (a torn write, a truncation, a hand edit)", () => {
    const dir = ensureProjectRuntimeDir(getProjectRuntimeDir(tmp, {}))
    for (const broken of ["*", "\n", "# not the marker\n"]) {
      writeFileSync(path.join(dir, ".gitignore"), broken)
      ensureProjectRuntimeDir(dir)
      expect(readFileSync(path.join(dir, ".gitignore"), "utf8")).toBe("*\n")
    }
  })

  it("publishes through a temp it always removes, so a repair leaves the dir holding the marker alone", () => {
    const dir = getProjectRuntimeDir(tmp, {})
    ensureProjectRuntimeDir(dir)
    writeFileSync(path.join(dir, ".gitignore"), "")
    ensureProjectRuntimeDir(dir)
    expect(readdirSync(dir)).toEqual([".gitignore"])
  })

  it("still yields the dir when the marker itself cannot be written", () => {
    const dir = path.join(tmp, "runtime-blocked-marker")
    mkdirSync(path.join(dir, ".gitignore"), { recursive: true })
    expect(() => ensureProjectRuntimeDir(dir)).not.toThrow()
    expect(existsSync(dir)).toBe(true)
  })
})
