import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getCurrentProject } from "@/lib/project"
import {
  ScaffoldError,
  scaffoldProject,
  slugify,
  validateProjectName,
  validateTargetDir,
} from "@/lib/scaffold"

let workDir: string
let prevCwd: string
let prevRuntime: string | undefined
let prevFactoryRoot: string | undefined

beforeEach(() => {
  // Isolate the runtime store (current-project.json) per test, and pin the
  // factory root to the real repo's factory/ so templates resolve regardless of
  // the temp cwd. The scaffolder copies factory/templates/** from there.
  workDir = mkdtempSync(path.join(tmpdir(), "vivicy-scaffold-"))
  prevCwd = process.cwd()
  prevRuntime = process.env.VIVICY_RUNTIME_DIR
  prevFactoryRoot = process.env.VIVICY_FACTORY_ROOT
  process.env.VIVICY_FACTORY_ROOT = path.resolve(prevCwd, "factory")
  process.env.VIVICY_RUNTIME_DIR = path.join(workDir, ".runtime")
  process.chdir(workDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  if (prevRuntime === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntime
  if (prevFactoryRoot === undefined) delete process.env.VIVICY_FACTORY_ROOT
  else process.env.VIVICY_FACTORY_ROOT = prevFactoryRoot
  rmSync(workDir, { recursive: true, force: true })
})

describe("validateProjectName", () => {
  it("accepts a normal name and trims it", () => {
    expect(validateProjectName("  My Project ")).toBe("My Project")
  })

  it("rejects empty, too-long, or weird names", () => {
    expect(() => validateProjectName("")).toThrow(ScaffoldError)
    expect(() => validateProjectName("   ")).toThrow(ScaffoldError)
    expect(() => validateProjectName("x".repeat(65))).toThrow(ScaffoldError)
    expect(() => validateProjectName("/etc/passwd")).toThrow(ScaffoldError)
    expect(() => validateProjectName("a\nb")).toThrow(ScaffoldError)
  })
})

describe("validateTargetDir", () => {
  it("accepts a non-existent absolute path", () => {
    const target = path.join(workDir, "new-project")
    expect(validateTargetDir(target)).toBe(target)
  })

  it("accepts an existing empty directory (ignoring .git/.DS_Store)", () => {
    const target = path.join(workDir, "empty")
    writeFileSync(path.join(workDir, "empty.keep"), "") // unrelated
    mkdirSync(path.join(target, ".git"), { recursive: true })
    writeFileSync(path.join(target, ".DS_Store"), "")
    expect(validateTargetDir(target)).toBe(target)
  })

  it("rejects a relative path", () => {
    expect(() => validateTargetDir("relative/path")).toThrow(
      expect.objectContaining({ code: "not_absolute" })
    )
  })

  it("rejects a non-empty directory", () => {
    const target = path.join(workDir, "populated")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "existing.txt"), "hi")
    expect(() => validateTargetDir(target)).toThrow(
      expect.objectContaining({ code: "not_empty" })
    )
  })

  it("rejects a path that is a file, not a directory", () => {
    const target = path.join(workDir, "afile")
    writeFileSync(target, "x")
    expect(() => validateTargetDir(target)).toThrow(
      expect.objectContaining({ code: "not_a_directory" })
    )
  })
})

describe("slugify", () => {
  it("produces a filesystem-safe npm slug", () => {
    expect(slugify("My Cool Project")).toBe("my-cool-project")
    expect(slugify("  A..B__C  ")).toBe("a-b-c")
    expect(slugify("***")).toBe("project")
  })
})

describe("scaffoldProject", () => {
  it("writes the expected skeleton with the name substituted and sets the current project", () => {
    const target = path.join(workDir, "acme-app")
    const result = scaffoldProject({ targetDir: target, projectName: "Acme App" })

    // Governance + entrypoint templates.
    const expectedFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "package.json",
      ".gitignore",
      "test/scaffold.test.js",
      "docs/canonical/README.md",
      "docs/governance/01-source-of-truth.md",
      "docs/governance/05-development-traceability-method.md",
      "docs/governance/06-product-change-control.md",
      "docs/governance/07-development-launch-prompt.md",
      "docs/governance/08-doc-baseline-lock.md",
      "spec/development/ISSUE-TEMPLATE.md",
    ]
    for (const rel of expectedFiles) {
      expect(existsSync(path.join(target, rel)), `missing ${rel}`).toBe(true)
    }

    // Empty skeleton dirs are kept alive with .gitkeep.
    for (const dir of [
      "docs/baselines",
      "docs/architecture-map",
      "spec/development/issues",
      "spec/development/prompts",
      "spec/development/reports",
      "spec/requirements",
    ]) {
      expect(existsSync(path.join(target, dir, ".gitkeep")), `missing ${dir}/.gitkeep`).toBe(true)
    }

    // Name substitution: AGENTS.md carries the real name, never the raw token.
    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents).toContain("Acme App Development Operating Guide")
    expect(agents).not.toContain("{{PROJECT_NAME}}")

    // No Naight-product terms leaked into the generic governance output.
    const method = readFileSync(
      path.join(target, "docs/governance/05-development-traceability-method.md"),
      "utf8"
    )
    expect(method).not.toMatch(/\bNaight\b/i)
    expect(method).not.toMatch(/\btenant\b/i)

    // package.json is a valid manifest with a green node --test gate + slug name.
    const pkg = JSON.parse(readFileSync(path.join(target, "package.json"), "utf8"))
    expect(pkg.name).toBe("acme-app")
    expect(pkg.scripts.test).toBe("node --test")

    // The result describes the project and it is now the current target.
    expect(result.project.root).toBe(target)
    expect(result.project.name).toBe("acme-app")
    expect(result.project.hasDocs).toBe(true)
    expect(getCurrentProject()?.root).toBe(target)

    // The reported written list is non-trivial and absolute.
    expect(result.written.length).toBeGreaterThan(expectedFiles.length)
    expect(result.written.every((p) => path.isAbsolute(p))).toBe(true)
  })

  it("refuses to scaffold into a non-empty directory", () => {
    const target = path.join(workDir, "occupied")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "keepme.txt"), "do not clobber")
    expect(() => scaffoldProject({ targetDir: target, projectName: "Whatever" })).toThrow(
      expect.objectContaining({ code: "not_empty" })
    )
    // The pre-existing file is untouched and no current project was set.
    expect(readFileSync(path.join(target, "keepme.txt"), "utf8")).toBe("do not clobber")
    expect(getCurrentProject()).toBeNull()
  })

  it("rejects an invalid project name before writing anything", () => {
    const target = path.join(workDir, "named-badly")
    expect(() => scaffoldProject({ targetDir: target, projectName: "" })).toThrow(
      expect.objectContaining({ code: "invalid_name" })
    )
    expect(existsSync(target)).toBe(false)
  })
})
