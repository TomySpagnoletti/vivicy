import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getCurrentProject } from "@/lib/project"
import {
  detectGateCommand,
  resolveTargetDir,
  ScaffoldError,
  scaffoldProject,
  slugify,
  validateProjectName,
} from "@/lib/scaffold"

let workDir: string
let prevCwd: string
let prevRuntime: string | undefined
let prevFactoryRoot: string | undefined

beforeEach(() => {
  // Isolate the runtime store (current-project.json) per test, and pin the
  // factory root to the real repo's factory/ so templates resolve regardless of
  // the temp cwd. The scaffolder reads factory/templates/** from there.
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

describe("resolveTargetDir", () => {
  it("reports a non-existent absolute path as from_scratch", () => {
    const target = path.join(workDir, "new-project")
    expect(resolveTargetDir(target)).toEqual({ target, mode: "from_scratch" })
  })

  it("treats an empty directory (ignoring .git/.DS_Store) as from_scratch", () => {
    const target = path.join(workDir, "empty")
    mkdirSync(path.join(target, ".git"), { recursive: true })
    writeFileSync(path.join(target, ".DS_Store"), "")
    expect(resolveTargetDir(target)).toEqual({ target, mode: "from_scratch" })
  })

  it("treats a POPULATED directory as existing_project (no longer refused)", () => {
    const target = path.join(workDir, "populated")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "existing.txt"), "hi")
    expect(resolveTargetDir(target)).toEqual({ target, mode: "existing_project" })
  })

  it("rejects a relative path", () => {
    expect(() => resolveTargetDir("relative/path")).toThrow(
      expect.objectContaining({ code: "not_absolute" })
    )
  })

  it("rejects a path that is a file, not a directory", () => {
    const target = path.join(workDir, "afile")
    writeFileSync(target, "x")
    expect(() => resolveTargetDir(target)).toThrow(
      expect.objectContaining({ code: "not_a_directory" })
    )
  })
})

describe("detectGateCommand", () => {
  it("prefills `npm test` from a package.json with a test script", () => {
    const dir = path.join(workDir, "node-proj")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }))
    expect(detectGateCommand(dir)).toBe("npm test")
  })

  it("prefills `make test` from a Makefile with a test target", () => {
    const dir = path.join(workDir, "make-proj")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "Makefile"), "build:\n\tgo build ./...\ntest:\n\tgo test ./...\n")
    expect(detectGateCommand(dir)).toBe("make test")
  })

  it("returns null when nothing is confidently detectable (no language assumed)", () => {
    const dir = path.join(workDir, "go-proj")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "main.go"), "package main\n")
    expect(detectGateCommand(dir)).toBeNull()
  })
})

describe("slugify", () => {
  it("produces a filesystem-safe slug", () => {
    expect(slugify("My Cool Project")).toBe("my-cool-project")
    expect(slugify("  A..B__C  ")).toBe("a-b-c")
    expect(slugify("***")).toBe("project")
  })
})

describe("scaffoldProject — from scratch (lean, language-agnostic)", () => {
  it("writes the LEAN skeleton with the name substituted and sets the current project", () => {
    const target = path.join(workDir, "acme-app")
    const result = scaffoldProject({ targetDir: target, projectName: "Acme App" })

    expect(result.mode).toBe("from_scratch")

    // The lean target carries ONLY what it needs.
    const expectedFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "vivicy.json",
      ".gitignore",
      "docs/canonical/README.md",
      "spec/development/ISSUE-TEMPLATE.md",
    ]
    for (const rel of expectedFiles) {
      expect(existsSync(path.join(target, rel)), `missing ${rel}`).toBe(true)
    }

    // LEAN: no heavy governance method docs are copied into the target.
    expect(existsSync(path.join(target, "docs/governance")), "target must not carry docs/governance").toBe(
      false
    )

    // LANGUAGE-AGNOSTIC: no Node package.json and no node:test placeholder baked in.
    expect(existsSync(path.join(target, "package.json")), "no Node package.json in a lean scaffold").toBe(
      false
    )
    expect(existsSync(path.join(target, "test/scaffold.test.js")), "no node:test placeholder").toBe(false)

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
    // The lean AGENTS.md has no dangling governance-doc links.
    expect(agents).not.toContain("docs/governance/")

    // vivicy.json is a valid config with a non-empty gateCommand the owner edits.
    const vivicy = JSON.parse(readFileSync(path.join(target, "vivicy.json"), "utf8"))
    expect(typeof vivicy.gateCommand).toBe("string")
    expect(vivicy.gateCommand.length).toBeGreaterThan(0)

    // The .gitignore is the COMPLETE never-commit set, and ONLY that set.
    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")
    for (const ignored of [
      "node_modules/",
      ".DS_Store",
      ".vivicy-runtime/",
      ".vivicy-worktrees/",
      "spec/development/transcripts/",
      "spec/development/gates/.integration.lock",
    ]) {
      expect(gitignore, `expected .gitignore to ignore ${ignored}`).toContain(ignored)
    }
    for (const committed of ["architecture-data.json", "source-map.json", "coverage-report"]) {
      expect(gitignore, `expected .gitignore NOT to ignore ${committed}`).not.toContain(committed)
    }

    // The result describes the project and it is now the current target.
    expect(result.project.root).toBe(target)
    expect(result.project.name).toBe("acme-app")
    expect(result.project.hasDocs).toBe(true)
    expect(getCurrentProject()?.root).toBe(target)

    // The reported written list is non-trivial and absolute.
    expect(result.written.length).toBeGreaterThan(expectedFiles.length)
    expect(result.written.every((p) => path.isAbsolute(p))).toBe(true)
  })

  it("rejects an invalid project name before writing anything", () => {
    const target = path.join(workDir, "named-badly")
    expect(() => scaffoldProject({ targetDir: target, projectName: "" })).toThrow(
      expect.objectContaining({ code: "invalid_name" })
    )
    expect(existsSync(target)).toBe(false)
  })
})

describe("scaffoldProject — existing project (add Vivicy, never clobber)", () => {
  it("creates ONLY the missing files and leaves every existing file byte-unchanged", () => {
    const target = path.join(workDir, "my-repo")
    mkdirSync(target, { recursive: true })

    // A real repo with its own files Vivicy must never touch.
    const preexisting: Record<string, string> = {
      "AGENTS.md": "# My own agents guide\nDo not overwrite me.\n",
      "README.md": "# my-repo\nMy original readme.\n",
      ".gitignore": "node_modules/\nmy-own-ignore/\n",
      "src/main.py": "print('hello')\n",
      "package.json": JSON.stringify({ name: "my-repo", scripts: { test: "pytest -q" } }, null, 2),
    }
    for (const [rel, contents] of Object.entries(preexisting)) {
      const abs = path.join(target, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, contents)
    }

    const result = scaffoldProject({ targetDir: target, projectName: "My Repo" })
    expect(result.mode).toBe("existing_project")

    // Every pre-existing file is byte-for-byte unchanged (clobbers nothing).
    for (const [rel, contents] of Object.entries(preexisting)) {
      expect(readFileSync(path.join(target, rel), "utf8"), `clobbered ${rel}`).toBe(contents)
    }

    // The MISSING Vivicy files are created.
    for (const rel of [
      "CLAUDE.md",
      "vivicy.json",
      "docs/canonical/README.md",
      "spec/development/ISSUE-TEMPLATE.md",
      "docs/baselines/.gitkeep",
      "spec/development/issues/.gitkeep",
    ]) {
      expect(existsSync(path.join(target, rel)), `missing ${rel}`).toBe(true)
    }

    // None of the pre-existing files appear in the written list (we skipped them).
    const writtenRel = new Set(result.written.map((p) => path.relative(target, p)))
    for (const rel of Object.keys(preexisting)) {
      expect(writtenRel.has(rel), `should not have rewritten ${rel}`).toBe(false)
    }

    // Still lean: no governance docs, no extra Node placeholder test.
    expect(existsSync(path.join(target, "docs/governance"))).toBe(false)
    expect(existsSync(path.join(target, "test/scaffold.test.js"))).toBe(false)

    // The gate command is DETECTED from the existing repo's own test wiring.
    const vivicy = JSON.parse(readFileSync(path.join(target, "vivicy.json"), "utf8"))
    expect(vivicy.gateCommand).toBe("npm test")
  })
})
