import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ARCHITECTURE_DATA_RELATIVE_PATH,
  getArchitectureDataPath,
  getTargetRoot,
  isTargetResolved,
} from "@/lib/target"

let tmp: string
const prevEnv = process.env.VIVICY_TARGET_ROOT
const prevRuntime = process.env.VIVICY_RUNTIME_DIR

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "vivicy-target-"))
  // Point VIVICY_RUNTIME_DIR at an empty temp dir so readCurrentProjectRoot() returns null — otherwise tests could pick up the developer's real persisted project selection.
  process.env.VIVICY_RUNTIME_DIR = path.join(tmp, "runtime")
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevEnv
  if (prevRuntime === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntime
})

describe("getTargetRoot", () => {
  it("resolves VIVICY_TARGET_ROOT when set (verbatim spelling — env servers are single-spelling)", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(getTargetRoot()).toBe(path.resolve(tmp))
  })

  it("returns a persisted (canonical-by-construction) root verbatim, winning over the env", () => {
    const real = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-target-persisted-")))
    try {
      mkdirSync(process.env.VIVICY_RUNTIME_DIR!, { recursive: true })
      writeFileSync(
        path.join(process.env.VIVICY_RUNTIME_DIR!, "current-project.json"),
        JSON.stringify({ root: real })
      )
      process.env.VIVICY_TARGET_ROOT = tmp
      expect(getTargetRoot()).toBe(real)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it("is null when neither a persisted project nor VIVICY_TARGET_ROOT is set", () => {
    delete process.env.VIVICY_TARGET_ROOT
    expect(getTargetRoot()).toBeNull()
  })
})

describe("getArchitectureDataPath", () => {
  it("joins the target root with the committed map relative path", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(getArchitectureDataPath()).toBe(
      path.join(path.resolve(tmp), ARCHITECTURE_DATA_RELATIVE_PATH)
    )
  })

  it("is null when no target is set", () => {
    delete process.env.VIVICY_TARGET_ROOT
    expect(getArchitectureDataPath()).toBeNull()
  })
})

describe("isTargetResolved", () => {
  it("is false when the target root does not exist", () => {
    process.env.VIVICY_TARGET_ROOT = path.join(tmp, "does-not-exist")
    expect(isTargetResolved()).toBe(false)
  })

  it("is false when the root exists but has no docs/ directory", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(isTargetResolved()).toBe(false)
  })

  it("is true when the root exists and holds a .vivicy/canonical/ directory", () => {
    mkdirSync(path.join(tmp, ".vivicy", "canonical"), { recursive: true })
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(isTargetResolved()).toBe(true)
  })

  it("is false when .vivicy/canonical is a file, not a directory", () => {
    mkdirSync(path.join(tmp, ".vivicy"), { recursive: true })
    const docsAsFile = path.join(tmp, ".vivicy", "canonical")
    writeFileSync(docsAsFile, "not a dir")
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(isTargetResolved()).toBe(false)
  })
})
