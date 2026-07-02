import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  // Isolate from any persisted current-project selection on this machine:
  // point the runtime dir at an empty location so readCurrentProjectRoot()
  // returns null and target resolution is driven purely by
  // VIVICY_TARGET_ROOT / cwd here, not the developer's real picked project.
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
  it("resolves VIVICY_TARGET_ROOT when set", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(getTargetRoot()).toBe(path.resolve(tmp))
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
    // A .vivicy/canonical that is not a directory is not a usable canonical-spec home.
    mkdirSync(path.join(tmp, ".vivicy"), { recursive: true })
    const docsAsFile = path.join(tmp, ".vivicy", "canonical")
    writeFileSync(docsAsFile, "not a dir")
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(isTargetResolved()).toBe(false)
  })
})
