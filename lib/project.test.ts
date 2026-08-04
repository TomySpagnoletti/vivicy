import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { describeProject, isGovernedRoot, ProjectError, readProjectBinding } from "@/lib/project"

let tmpCwd: string
let projectDir: string
let prevCwd: string
let prevTarget: string | undefined

beforeEach(() => {
  tmpCwd = mkdtempSync(path.join(tmpdir(), "vivicy-project-cwd-"))
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-project-target-")))
  prevCwd = process.cwd()
  prevTarget = process.env.VIVICY_TARGET_ROOT
  delete process.env.VIVICY_TARGET_ROOT
  process.chdir(tmpCwd)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevTarget === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevTarget
  rmSync(tmpCwd, { recursive: true, force: true })
  rmSync(projectDir, { recursive: true, force: true })
})

describe("describeProject (validation)", () => {
  it("rejects a relative path with not_absolute", () => {
    try {
      describeProject("relative/path")
      expect.unreachable("should have thrown")
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectError)
      expect((error as ProjectError).code).toBe("not_absolute")
    }
  })

  it("rejects a non-existent absolute path with not_found", () => {
    try {
      describeProject(path.join(projectDir, "does-not-exist"))
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as ProjectError).code).toBe("not_found")
    }
  })

  it("rejects a file (not a directory) with not_a_directory", () => {
    const file = path.join(projectDir, "a-file")
    writeFileSync(file, "x")
    try {
      describeProject(file)
      expect.unreachable("should have thrown")
    } catch (error) {
      expect((error as ProjectError).code).toBe("not_a_directory")
    }
  })

  it("describes a valid directory and flags governed=false without a .vivicy directory", () => {
    const described = describeProject(projectDir)
    expect(described.root).toBe(projectDir)
    expect(described.name).toBe(path.basename(projectDir))
    expect(described.governed).toBe(false)
    expect(isGovernedRoot(projectDir)).toBe(false)
  })

  it("flags governed=true when the directory holds a .vivicy/ directory", () => {
    mkdirSync(path.join(projectDir, ".vivicy"), { recursive: true })
    expect(describeProject(projectDir).governed).toBe(true)
  })

  it("trims surrounding whitespace before validating", () => {
    expect(describeProject(`  ${projectDir}  `).root).toBe(projectDir)
  })

  it("canonicalizes a symlink-spelled root to ONE spelling (the registry keys a project by it)", () => {
    const alias = path.join(tmpCwd, "alias-root")
    symlinkSync(projectDir, alias)
    const described = describeProject(alias)
    expect(described.root).toBe(projectDir)
    expect(described.name).toBe(path.basename(projectDir))
  })
})

describe("readProjectBinding", () => {
  it("is unbound with no VIVICY_TARGET_ROOT — that process is the launcher", () => {
    expect(readProjectBinding()).toEqual({ kind: "unbound" })
  })

  it("is unbound for a blank binding rather than resolving the cwd", () => {
    process.env.VIVICY_TARGET_ROOT = "   "
    expect(readProjectBinding()).toEqual({ kind: "unbound" })
  })

  it("binds to the spawn-time root and reports whether it is governed", () => {
    process.env.VIVICY_TARGET_ROOT = projectDir
    expect(readProjectBinding()).toEqual({
      kind: "bound",
      project: { root: projectDir, name: path.basename(projectDir), governed: false },
    })
    mkdirSync(path.join(projectDir, ".vivicy"), { recursive: true })
    expect(readProjectBinding()).toEqual({
      kind: "bound",
      project: { root: projectDir, name: path.basename(projectDir), governed: true },
    })
  })

  it("reports a bound root that vanished as missing, never as unbound", () => {
    process.env.VIVICY_TARGET_ROOT = projectDir
    rmSync(projectDir, { recursive: true, force: true })
    expect(readProjectBinding()).toEqual({ kind: "missing", root: projectDir })
  })
})
