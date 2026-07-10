import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getRuntimeDir } from "@/lib/runtime-dir"

const RUNTIME_DIR_NAME = ".vivicy-runtime"

let tmp: string
let prevEnv: string | undefined
let prevCwd: string

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "vivicy-runtime-dir-"))
  prevEnv = process.env.VIVICY_RUNTIME_DIR
  prevCwd = process.cwd()
})

afterEach(() => {
  if (prevEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevEnv
  process.chdir(prevCwd)
  rmSync(tmp, { recursive: true, force: true })
})

describe("getRuntimeDir", () => {
  it("defaults to <cwd>/.vivicy-runtime when the env var is unset", () => {
    delete process.env.VIVICY_RUNTIME_DIR
    process.chdir(tmp)
    // process.cwd() may resolve symlinks (e.g. /var -> /private/var on macOS) — compare against the live cwd, not the raw mkdtemp path.
    expect(getRuntimeDir()).toBe(path.join(process.cwd(), RUNTIME_DIR_NAME))
  })

  it("ignores a blank/whitespace-only override and falls back to the default", () => {
    process.chdir(tmp)
    process.env.VIVICY_RUNTIME_DIR = "   "
    expect(getRuntimeDir()).toBe(path.join(process.cwd(), RUNTIME_DIR_NAME))
    process.env.VIVICY_RUNTIME_DIR = ""
    expect(getRuntimeDir()).toBe(path.join(process.cwd(), RUNTIME_DIR_NAME))
  })

  it("honors an absolute override verbatim (already resolved)", () => {
    const abs = path.join(tmp, "custom-runtime")
    process.env.VIVICY_RUNTIME_DIR = abs
    expect(getRuntimeDir()).toBe(abs)
    expect(path.isAbsolute(getRuntimeDir())).toBe(true)
  })

  it("resolves a relative override against cwd (path.resolve)", () => {
    process.chdir(tmp)
    process.env.VIVICY_RUNTIME_DIR = "rel-runtime"
    expect(getRuntimeDir()).toBe(path.resolve(process.cwd(), "rel-runtime"))
    expect(path.isAbsolute(getRuntimeDir())).toBe(true)
  })

  it("normalizes '.' and '..' segments in the override via path.resolve", () => {
    process.chdir(tmp)
    process.env.VIVICY_RUNTIME_DIR = "./a/../b"
    expect(getRuntimeDir()).toBe(path.resolve(process.cwd(), "b"))
  })
})
