import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  ARCHITECTURE_DATA_RELATIVE_PATH,
  canonicalHasSpecDoc,
  getArchitectureDataPath,
  getTargetRoot,
  isTargetResolved,
} from "@/lib/target"

let tmp: string
const prevEnv = process.env.VIVICY_TARGET_ROOT

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "vivicy-target-"))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
  if (prevEnv === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevEnv
})

describe("getTargetRoot", () => {
  it("resolves the spawn-time binding, normalizing a dotted spelling once", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(getTargetRoot()).toBe(path.resolve(tmp))
    process.env.VIVICY_TARGET_ROOT = path.join(tmp, "a", "..")
    expect(getTargetRoot()).toBe(path.resolve(tmp))
  })

  it("is null when VIVICY_TARGET_ROOT is unset or blank — that process governs no project", () => {
    delete process.env.VIVICY_TARGET_ROOT
    expect(getTargetRoot()).toBeNull()
    process.env.VIVICY_TARGET_ROOT = "   "
    expect(getTargetRoot()).toBeNull()
  })
})

describe("getArchitectureDataPath", () => {
  it("joins the target root with the committed map relative path", () => {
    process.env.VIVICY_TARGET_ROOT = tmp
    expect(getArchitectureDataPath()).toBe(path.join(path.resolve(tmp), ARCHITECTURE_DATA_RELATIVE_PATH))
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

describe("canonicalHasSpecDoc", () => {
  const canonicalDir = () => path.join(tmp, ".vivicy", "canonical")

  it("is true when a non-README .md spec doc exists, even nested in a subdirectory", () => {
    mkdirSync(path.join(canonicalDir(), "areas"), { recursive: true })
    writeFileSync(path.join(canonicalDir(), "areas", "01-core.md"), "# Core\n")
    expect(canonicalHasSpecDoc(tmp)).toBe(true)
  })

  it("is false when the canonical holds only the scaffold seed (.gitkeep + README.md)", () => {
    mkdirSync(canonicalDir(), { recursive: true })
    writeFileSync(path.join(canonicalDir(), ".gitkeep"), "")
    writeFileSync(path.join(canonicalDir(), "README.md"), "# placeholder\n")
    expect(canonicalHasSpecDoc(tmp)).toBe(false)
  })

  it("is false without throwing when the canonical directory cannot be read (readdir error is swallowed, never propagated — the predicate is total so its /api/map caller never 500s)", () => {
    mkdirSync(path.join(tmp, ".vivicy"), { recursive: true })
    writeFileSync(canonicalDir(), "not a dir")
    expect(() => canonicalHasSpecDoc(tmp)).not.toThrow()
    expect(canonicalHasSpecDoc(tmp)).toBe(false)
  })
})
