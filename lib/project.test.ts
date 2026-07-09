import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  describeProject,
  getCurrentProject,
  getCurrentProjectPath,
  ProjectError,
  readCurrentProjectRoot,
  setCurrentProject,
} from "@/lib/project"

// The store writes under <cwd>/.vivicy-runtime, so each test runs in its own
// temp cwd to avoid touching the real runtime dir.
let tmpCwd: string
let projectDir: string
let prevCwd: string

beforeEach(() => {
  tmpCwd = mkdtempSync(path.join(tmpdir(), "vivicy-project-cwd-"))
  // Canonical (realpath) spelling: describeProject canonicalizes its result, so
  // tests compare against the one true spelling (macOS tmpdir is symlinked).
  projectDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-project-target-")))
  prevCwd = process.cwd()
  process.chdir(tmpCwd)
})

afterEach(() => {
  process.chdir(prevCwd)
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

  it("describes a valid directory and flags hasCanonicalSpec=false without docs/", () => {
    const described = describeProject(projectDir)
    expect(described.root).toBe(projectDir)
    expect(described.name).toBe(path.basename(projectDir))
    expect(described.hasCanonicalSpec).toBe(false)
  })

  it("flags hasCanonicalSpec=true when the directory holds a .vivicy/canonical/ directory", () => {
    mkdirSync(path.join(projectDir, ".vivicy", "canonical"), { recursive: true })
    expect(describeProject(projectDir).hasCanonicalSpec).toBe(true)
  })

  it("trims surrounding whitespace before validating", () => {
    expect(describeProject(`  ${projectDir}  `).root).toBe(projectDir)
  })

  it("canonicalizes a symlink-spelled root to ONE spelling (the W8 runtime key hashes it)", () => {
    const alias = path.join(tmpCwd, "alias-root")
    symlinkSync(projectDir, alias)
    const described = describeProject(alias)
    expect(described.root).toBe(projectDir)
    expect(described.name).toBe(path.basename(projectDir))
  })
})

describe("setCurrentProject / readCurrentProjectRoot / getCurrentProject", () => {
  it("persists a valid project and reads it back", () => {
    const described = setCurrentProject(projectDir)
    expect(described.root).toBe(projectDir)
    expect(existsSync(getCurrentProjectPath())).toBe(true)
    expect(readCurrentProjectRoot()).toBe(projectDir)
    expect(getCurrentProject()?.root).toBe(projectDir)
  })

  it("only writes the root key (never the raw request body) to disk", () => {
    setCurrentProject(projectDir)
    const onDisk = JSON.parse(readFileSync(getCurrentProjectPath(), "utf8"))
    expect(Object.keys(onDisk)).toEqual(["root"])
    expect(onDisk.root).toBe(projectDir)
  })

  it("does not persist when validation fails", () => {
    expect(() => setCurrentProject("relative")).toThrow(ProjectError)
    expect(existsSync(getCurrentProjectPath())).toBe(false)
  })

  it("returns null when nothing is persisted", () => {
    expect(readCurrentProjectRoot()).toBe(null)
    expect(getCurrentProject()).toBe(null)
  })

  it("returns null from getCurrentProject when the persisted path went stale", () => {
    setCurrentProject(projectDir)
    rmSync(projectDir, { recursive: true, force: true })
    // The raw root is still recorded, but it no longer resolves to a directory.
    expect(readCurrentProjectRoot()).toBe(projectDir)
    expect(getCurrentProject()).toBe(null)
  })

  it("returns null from readCurrentProjectRoot when the file is corrupt", () => {
    mkdirSync(path.dirname(getCurrentProjectPath()), { recursive: true })
    writeFileSync(getCurrentProjectPath(), "{ not json")
    expect(readCurrentProjectRoot()).toBe(null)
  })
})
