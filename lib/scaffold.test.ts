import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { extractManagedBlock, GITIGNORE_MARKERS, METHOD_MARKERS } from "@/lib/managed-block"
import { getCurrentProject } from "@/lib/project"
import {
  detectGateCommand,
  getTemplatesRoot,
  resolveTargetDir,
  ScaffoldError,
  scaffoldProject,
  validateProjectName,
} from "@/lib/scaffold"

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1
}

let workDir: string
let prevCwd: string
let prevRuntime: string | undefined
let prevFactoryRoot: string | undefined

beforeEach(() => {
  // realpathSync is required: macOS symlinks tmpdir, and describeProject canonicalizes roots, so a raw mkdtempSync path would fail root-equality assertions below.
  workDir = realpathSync(mkdtempSync(path.join(tmpdir(), "vivicy-scaffold-")))
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

describe("scaffoldProject — from scratch (lean, language-agnostic)", () => {
  it("writes the LEAN skeleton with the name substituted and sets the current project", () => {
    const target = path.join(workDir, "acme-app")
    const result = scaffoldProject({ targetDir: target, projectName: "Acme App" })

    expect(result.mode).toBe("from_scratch")

    const expectedFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      "README.md",
      "vivicy.json",
      ".gitignore",
      ".env.example",
    ]
    for (const rel of expectedFiles) {
      expect(existsSync(path.join(target, rel)), `missing ${rel}`).toBe(true)
    }

    expect(existsSync(path.join(target, "docs/governance")), "target must not carry docs/governance").toBe(
      false
    )

    expect(existsSync(path.join(target, "package.json")), "no Node package.json in a lean scaffold").toBe(
      false
    )
    expect(existsSync(path.join(target, "test/scaffold.test.js")), "no node:test placeholder").toBe(false)

    for (const dir of [
      ".vivicy/canonical",
      ".vivicy/baselines",
      ".vivicy/architecture-map",
      ".vivicy/development/issues",
      ".vivicy/development/spikes",
      ".vivicy/development/reports",
      ".vivicy/requirements",
      ".vivicy/change-requests",
    ]) {
      expect(existsSync(path.join(target, dir, ".gitkeep")), `missing ${dir}/.gitkeep`).toBe(true)
    }

    for (const rel of [
      ".vivicy/canonical/README.md",
      ".vivicy/development/ISSUE-TEMPLATE.md",
      ".vivicy/development/SPIKE-TEMPLATE.md",
      ".vivicy/change-requests/CR-TEMPLATE.md",
      ".vivicy/change-requests/README.md",
    ]) {
      expect(existsSync(path.join(target, rel)), `${rel} must NOT be scaffolded into the lean target`).toBe(false)
    }

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents).toContain("Acme App Development Operating Guide")
    expect(agents).not.toContain("{{PROJECT_NAME}}")
    expect(agents).not.toContain("docs/governance/")

    const vivicy = JSON.parse(readFileSync(path.join(target, "vivicy.json"), "utf8"))
    expect("gateCommand" in vivicy).toBe(true)
    expect(vivicy.gateCommand).toBeNull()
    expect("runCommand" in vivicy, "scaffold writes the runCommand field beside gateCommand").toBe(true)
    expect(vivicy.runCommand, "runCommand starts as the not-yet-established sentinel").toBeNull()

    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")
    for (const ignored of [
      "node_modules/",
      ".DS_Store",
      ".vivicy-runtime/",
      ".vivicy-worktrees/",
      ".vivicy/development/transcripts/",
      ".vivicy/development/gates/.integration.lock",
    ]) {
      expect(gitignore, `expected .gitignore to ignore ${ignored}`).toContain(ignored)
    }
    // Line-exact: the re-inclusion lines contain the exclude pattern as a substring, so `toContain` alone would pass with the exclude gone.
    const ignoreLines = gitignore.split("\n")
    for (const line of [
      ".vivicy/development/proofs/**",
      "!.vivicy/development/proofs/**/",
      "!.vivicy/development/proofs/**/recipe.txt",
    ]) {
      expect(ignoreLines, `expected .gitignore to carry the exact line ${line}`).toContain(line)
    }
    // The env family is excluded in EVERY shape and re-included NOWHERE — a `!` line below the block would survive only until the first marker repair re-appends the block underneath it, silently flipping the placeholder to ignored forever.
    for (const line of [".env", ".env.*"]) {
      expect(ignoreLines.filter((l) => l === line), `greenfield must carry ${line} exactly once`).toHaveLength(1)
    }
    const blockEnd = ignoreLines.indexOf(GITIGNORE_MARKERS.end)
    expect(ignoreLines.indexOf(".env.*"), "the excludes are block content").toBeLessThan(blockEnd)
    expect(
      ignoreLines.filter((l) => l.startsWith("!.env")),
      "no env re-include anywhere — greenfield ships a real .env.example and TRACKS it instead"
    ).toEqual([])
    for (const committed of ["architecture-data.json", "source-map.json", "coverage-report"]) {
      expect(gitignore, `expected .gitignore NOT to ignore ${committed}`).not.toContain(committed)
    }
    expect(gitignore, "greenfield keeps the generalist comfort rules alongside the managed essentials").toContain("# macOS")
    expect(count(gitignore, GITIGNORE_MARKERS.begin), "greenfield carries exactly one managed block, so re-governance is a fixpoint").toBe(1)
    expect(gitignore).toContain("__pycache__/")
    expect(count(agents, METHOD_MARKERS.begin), "greenfield AGENTS.md embeds exactly one managed contract block").toBe(1)
    expect(agents).toContain("## Working under Vivicy")
    expect(agents).toContain("## The `.vivicy/` layout")

    expect(result.project.root).toBe(target)
    expect(result.project.name).toBe("acme-app")
    expect(result.project.hasCanonicalSpec).toBe(true)
    expect(getCurrentProject()?.root).toBe(target)

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

describe("scaffoldProject — existing project (shared files get a managed block, owner files untouched)", () => {
  const ownerAgents = "# My own agents guide\nDo not overwrite me.\n"
  const ownerReadme = "# my-repo\nMy original readme.\n"
  const ownerGitignore = "node_modules/\nmy-own-ignore/\n"
  const ownerMain = "print('hello')\n"

  function seedBrownfield(): string {
    const target = path.join(workDir, "my-repo")
    mkdirSync(target, { recursive: true })
    const files: Record<string, string> = {
      "AGENTS.md": ownerAgents,
      "README.md": ownerReadme,
      ".gitignore": ownerGitignore,
      "src/main.py": ownerMain,
      "package.json": JSON.stringify({ name: "my-repo", scripts: { test: "pytest -q" } }, null, 2),
    }
    for (const [rel, contents] of Object.entries(files)) {
      const abs = path.join(target, rel)
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, contents)
    }
    return target
  }

  it("appends an editable block to AGENTS.md and .gitignore, leaves README and code byte-unchanged, creates CLAUDE.md/vivicy.json", () => {
    const target = seedBrownfield()
    const result = scaffoldProject({ targetDir: target, projectName: "My Repo" })
    expect(result.mode).toBe("existing_project")

    expect(readFileSync(path.join(target, "README.md"), "utf8"), "README is an owner file — never touched").toBe(ownerReadme)
    expect(readFileSync(path.join(target, "src/main.py"), "utf8")).toBe(ownerMain)
    expect(readFileSync(path.join(target, "package.json"), "utf8")).toBe(
      JSON.stringify({ name: "my-repo", scripts: { test: "pytest -q" } }, null, 2)
    )

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents.startsWith(ownerAgents), "owner AGENTS.md text stays byte-intact at the head").toBe(true)
    expect(count(agents, METHOD_MARKERS.begin)).toBe(1)
    expect(agents).toContain("## Working under Vivicy")
    expect(agents).toContain(".vivicy/development/transcripts/")
    expect(agents.endsWith(`${METHOD_MARKERS.end}\n`)).toBe(true)

    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")
    expect(gitignore.startsWith(ownerGitignore), "owner .gitignore text stays byte-intact at the head").toBe(true)
    expect(count(gitignore, GITIGNORE_MARKERS.begin)).toBe(1)
    expect(gitignore).toContain(".vivicy-runtime/")
    expect(gitignore).toContain(".vivicy/development/transcripts/")
    expect(gitignore.endsWith(`${GITIGNORE_MARKERS.end}\n`)).toBe(true)
    expect(gitignore, "the brownfield block is the essentials only, not the generalist comfort rules").not.toContain("__pycache__/")

    for (const rel of ["CLAUDE.md", "vivicy.json", ".vivicy/canonical/.gitkeep", ".vivicy/development/issues/.gitkeep"]) {
      expect(existsSync(path.join(target, rel)), `missing ${rel}`).toBe(true)
    }

    const writtenRel = new Set(result.written.map((p) => path.relative(target, p)))
    expect(writtenRel.has("AGENTS.md"), "AGENTS.md was edited in place").toBe(true)
    expect(writtenRel.has(".gitignore"), ".gitignore was edited in place").toBe(true)
    expect(writtenRel.has("README.md"), "README stays writeIfMissing — not rewritten").toBe(false)
    expect(writtenRel.has("src/main.py")).toBe(false)
    expect(writtenRel.has("package.json")).toBe(false)

    const vivicy = JSON.parse(readFileSync(path.join(target, "vivicy.json"), "utf8"))
    expect(vivicy.gateCommand).toBe("npm test")
    expect(vivicy.runCommand, "runCommand is never brownfield-detected — established from the canonical run-and-ship area or the stack-setup issue").toBeNull()
  })

  it("is idempotent: a second scaffold pass leaves every shared file byte-identical (block already canonical)", () => {
    const target = seedBrownfield()
    scaffoldProject({ targetDir: target, projectName: "My Repo" })
    const after1 = Object.fromEntries(
      ["AGENTS.md", "CLAUDE.md", ".gitignore", "README.md"].map((rel) => [rel, readFileSync(path.join(target, rel), "utf8")])
    )
    const result2 = scaffoldProject({ targetDir: target, projectName: "My Repo" })
    for (const rel of Object.keys(after1)) {
      expect(readFileSync(path.join(target, rel), "utf8"), `second pass changed ${rel}`).toBe(after1[rel])
    }
    const writtenRel = new Set(result2.written.map((p) => path.relative(target, p)))
    expect(writtenRel.has("AGENTS.md"), "canonical block already present — no rewrite").toBe(false)
    expect(writtenRel.has(".gitignore")).toBe(false)
  })

  it("restores an owner-mangled managed block while keeping their surrounding edits", () => {
    const target = seedBrownfield()
    scaffoldProject({ targetDir: target, projectName: "My Repo" })
    const gitignorePath = path.join(target, ".gitignore")
    const governed = readFileSync(gitignorePath, "utf8")
    const begin = governed.indexOf(GITIGNORE_MARKERS.begin)
    const end = governed.indexOf(GITIGNORE_MARKERS.end) + GITIGNORE_MARKERS.end.length
    const mangled = `${governed.slice(0, begin)}${GITIGNORE_MARKERS.begin}\ndist/\n${GITIGNORE_MARKERS.end}${governed.slice(end)}\n# owner note\n`
    writeFileSync(gitignorePath, mangled)

    scaffoldProject({ targetDir: target, projectName: "My Repo" })
    const restored = readFileSync(gitignorePath, "utf8")
    expect(restored).toContain(".vivicy-runtime/")
    expect(restored, "the essentials the owner deleted are restored").toContain(".vivicy/development/transcripts/")
    for (const line of [".vivicy/development/proofs/**", "!.vivicy/development/proofs/**/recipe.txt"]) {
      expect(restored.split("\n"), `restored block must carry the exact line ${line}`).toContain(line)
    }
    expect(restored.startsWith(ownerGitignore), "owner's own head stays intact").toBe(true)
    expect(restored.endsWith("# owner note\n"), "owner's edit after the block stays intact").toBe(true)
    expect(count(restored, GITIGNORE_MARKERS.begin)).toBe(1)
  })

  it("re-normalizes an already-governed .gitignore whose essential block predates the env rules, owner bytes outside byte-identical", () => {
    const target = path.join(workDir, "governed-pre-env")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    const ownerHead = "node_modules/\nmy-own-ignore/\n\n"
    const ownerTail = "\n# my own tail rule\nbuild-cache/\n"
    const staleBlock = `${GITIGNORE_MARKERS.begin}\n.vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n${GITIGNORE_MARKERS.end}`
    writeFileSync(path.join(target, ".gitignore"), `${ownerHead}${staleBlock}${ownerTail}`)

    scaffoldProject({ targetDir: target, projectName: "Governed Pre Env" })
    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")

    expect(gitignore.startsWith(ownerHead), "owner bytes before the block stay byte-identical").toBe(true)
    expect(gitignore.endsWith(ownerTail), "owner bytes after the block stay byte-identical").toBe(true)
    expect(count(gitignore, GITIGNORE_MARKERS.begin), "still exactly one managed block").toBe(1)
    expect(git(target, ["check-ignore", "-q", ".env"]).status, "the migrated block ignores real env files").toBe(0)
    expect(
      gitignore.split("\n"),
      "the brownfield block carries excludes only — a re-include appended at EOF would override the owner's rules above it"
    ).not.toContain("!.env.example")
  })

  it("re-normalizes an already-governed AGENTS.md carrying an OLDER method block to the current canonical, owner bytes outside byte-identical", () => {
    const target = path.join(workDir, "already-governed")
    mkdirSync(target, { recursive: true })
    const ownerHead = "# My guide\n\nHouse rules the owner wrote, above the managed block.\n\n"
    const ownerTail = "\n## My own appendix\n\nOwner prose after the managed block, kept verbatim.\n"
    const staleBlock = `${METHOD_MARKERS.begin}\n## Working under Vivicy\n\nAn older, thinner version of the method contract from a previous governance pass.\n\n- One stale bullet that the current canonical no longer carries.\n${METHOD_MARKERS.end}`
    writeFileSync(path.join(target, "AGENTS.md"), `${ownerHead}${staleBlock}${ownerTail}`)

    scaffoldProject({ targetDir: target, projectName: "Already Governed" })
    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")

    expect(agents.startsWith(ownerHead), "owner bytes before the block stay byte-identical").toBe(true)
    expect(agents.endsWith(ownerTail), "owner bytes after the block stay byte-identical").toBe(true)
    expect(agents, "the stale block content is replaced, not kept").not.toContain("An older, thinner version")
    expect(agents).not.toContain("One stale bullet")
    expect(agents, "re-normalized to the current tier-1 machinery defense").toContain("immutable evidence")
    expect(agents, "re-normalized to the current tier-2 discipline").toContain("A test must discriminate")
    expect(agents, "re-normalized to the current atomic-increments law").toContain("smallest verified increments")
    expect(count(agents, METHOD_MARKERS.begin), "still exactly one managed block").toBe(1)
  })

  it("self-repairs an owner-damaged marker state instead of blocking governance, and a further pass is a zero diff", () => {
    const target = seedBrownfield()
    const agentsPath = path.join(target, "AGENTS.md")
    writeFileSync(agentsPath, `# mine\n${METHOD_MARKERS.begin}\nhalf a block, no end marker\n`)

    const result = scaffoldProject({ targetDir: target, projectName: "My Repo" })
    const repaired = readFileSync(agentsPath, "utf8")

    expect(repaired.startsWith("# mine\nhalf a block, no end marker\n"), "owner lines are never deleted — only Vivicy's own marker lines are").toBe(true)
    expect(count(repaired, METHOD_MARKERS.begin), "exactly one well-formed block").toBe(1)
    expect(count(repaired, METHOD_MARKERS.end)).toBe(1)
    expect(repaired.endsWith(`${METHOD_MARKERS.end}\n`)).toBe(true)
    expect(repaired).toContain("## Working under Vivicy")
    expect(new Set(result.written.map((p) => path.relative(target, p))).has("AGENTS.md"), "the repair rides `written` like any other renormalization").toBe(true)

    const result2 = scaffoldProject({ targetDir: target, projectName: "My Repo" })
    expect(readFileSync(agentsPath, "utf8"), "the repair is a fixpoint").toBe(repaired)
    expect(new Set(result2.written.map((p) => path.relative(target, p))).has("AGENTS.md")).toBe(false)
  })
})

describe("the proof-artifact ignore posture, exercised through real git (both writers)", () => {
  function plantProof(target: string): void {
    const home = path.join(target, ".vivicy", "development", "proofs", "ISS-0008", "cli-run")
    mkdirSync(path.join(home, "screens"), { recursive: true })
    writeFileSync(path.join(home, "recipe.txt"), "node src/cli.js report 2026-01\n")
    writeFileSync(path.join(home, "observed.log"), "total 1234\n")
    writeFileSync(path.join(home, "screens", "desktop.png"), "png-bytes")
  }

  function trackedAfterAddAll(target: string): string[] {
    const git = (args: string[]) => spawnSync("git", args, { cwd: target, encoding: "utf8" })
    if (git(["rev-parse", "--is-inside-work-tree"]).status !== 0) git(["init", "-q", "."])
    git(["config", "user.email", "t@example.com"])
    git(["config", "user.name", "t"])
    git(["add", "-A"])
    git(["commit", "-qm", "proof posture"])
    return (git(["ls-files"]).stdout ?? "").split("\n").filter(Boolean)
  }

  // A string assertion cannot prove a .gitignore: git's own re-inclusion rules decide, and a trailing-slash directory pattern would make the recipe unrecoverable.
  it("greenfield: git tracks each proof's recipe.txt and NOT one artifact beside it", () => {
    const target = path.join(workDir, "greenfield-proofs")
    scaffoldProject({ targetDir: target, projectName: "Greenfield Proofs" })
    plantProof(target)
    const tracked = trackedAfterAddAll(target)
    expect(tracked).toContain(".vivicy/development/proofs/ISS-0008/cli-run/recipe.txt")
    expect(tracked.filter((p) => p.startsWith(".vivicy/development/proofs/"))).toEqual([
      ".vivicy/development/proofs/ISS-0008/cli-run/recipe.txt",
    ])
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).stdout.trim()).toBe("")
  })

  it("brownfield: the appended managed block yields the same posture in a repo that already had its own .gitignore", () => {
    const target = path.join(workDir, "brownfield-proofs")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, ".gitignore"), "node_modules/\nmy-own-ignore/\n")
    writeFileSync(path.join(target, "main.py"), "print('hi')\n")
    scaffoldProject({ targetDir: target, projectName: "Brownfield Proofs" })
    plantProof(target)
    const tracked = trackedAfterAddAll(target)
    expect(tracked.filter((p) => p.startsWith(".vivicy/development/proofs/"))).toEqual([
      ".vivicy/development/proofs/ISS-0008/cli-run/recipe.txt",
    ])
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).stdout.trim()).toBe("")
  })
})

describe("the .env ignore posture, exercised through real git (both writers)", () => {
  // A string pin on the constant would pass with the patterns ordered wrong; git's own last-match-wins rules are the only oracle. Exit 0 = ignored, 1 = not ignored (128 would be a broken invocation, which either assertion catches) — and git never reports a TRACKED path as ignored, so `--no-index` is what asks the rules alone.
  function expectIgnored(target: string, rels: string[], ignored: boolean): void {
    for (const rel of rels) {
      expect(
        git(target, ["check-ignore", "-q", rel]).status,
        `${rel} must be ${ignored ? "ignored" : "committable"}`
      ).toBe(ignored ? 0 : 1)
    }
  }

  function trackedFiles(target: string): string[] {
    return git(target, ["ls-files"]).stdout.split("\n").filter(Boolean)
  }

  it("greenfield: the whole family is ignored, yet the placeholder template reaches history because scaffold TRACKS it", () => {
    const target = path.join(workDir, "greenfield-env")
    scaffoldProject({ targetDir: target, projectName: "Greenfield Env" })
    expectIgnored(target, [".env", ".env.local", ".env.sample"], true)
    expect(
      git(target, ["check-ignore", "-q", "--no-index", ".env.example"]).status,
      "the rules themselves ignore it — no re-include exists anywhere to be inverted"
    ).toBe(0)
    expect(
      git(target, ["check-ignore", "-q", ".env.example"]).status,
      "git never ignores a path that is in the index, which is exactly why tracking is the structural fix"
    ).toBe(1)

    const example = readFileSync(path.join(target, ".env.example"), "utf8")
    expect(example, "the placeholder tells the owner what to do with it").toContain("cp .env.example .env")
    expect(example.split("\n").filter((l) => l.trim() && !l.startsWith("#")), "every placeholder line is commented — never a live value").toEqual([])
    expect(trackedFiles(target), "an ignored file only reaches history force-added, and a tracked file no ignore rule can undo").toContain(".env.example")
  })

  it("brownfield: the appended block excludes the whole family, re-includes NOTHING, and drops no uninvited file into the owner's tree", () => {
    const target = path.join(workDir, "brownfield-env")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    writeFileSync(path.join(target, ".gitignore"), "node_modules/\nmy-own-ignore/\n")
    writeFileSync(path.join(target, "main.py"), "print('hi')\n")
    scaffoldProject({ targetDir: target, projectName: "Brownfield Env" })
    expectIgnored(target, [".env", ".env.local", ".env.example", ".env.sample"], true)
    expect(existsSync(path.join(target, ".env.example")), "the placeholder is greenfield-only — an owner's existing tree receives no file it did not ask for").toBe(false)
  })

  // The inversion this kills: with the placeholder delivered by a `!` re-include below the block, either damage shape re-appends the block at EOF UNDER that line and flips it to ignored, permanently. A tracked file cannot be flipped.
  const DAMAGE: Array<{ name: string; damage: (gitignore: string) => string }> = [
    {
      name: "the owner deletes the managed block whole",
      damage: (gi) =>
        gi.slice(0, gi.indexOf(GITIGNORE_MARKERS.begin)) +
        gi.slice(gi.indexOf(GITIGNORE_MARKERS.end) + GITIGNORE_MARKERS.end.length).replace(/^\n+/, ""),
    },
    {
      name: "the owner drops the block's end marker",
      damage: (gi) => gi.replace(`${GITIGNORE_MARKERS.end}\n`, ""),
    },
  ]
  for (const [index, { name, damage }] of DAMAGE.entries()) {
    it(`greenfield repair: ${name}, and re-governance leaves .env.example tracked with its content intact`, () => {
      const target = path.join(workDir, `greenfield-repair-${index}`)
      scaffoldProject({ targetDir: target, projectName: "Greenfield Repair" })
      const examplePath = path.join(target, ".env.example")
      const example = readFileSync(examplePath, "utf8")

      const gitignorePath = path.join(target, ".gitignore")
      writeFileSync(gitignorePath, damage(readFileSync(gitignorePath, "utf8")))
      scaffoldProject({ targetDir: target, projectName: "Greenfield Repair" })

      expect(count(readFileSync(gitignorePath, "utf8"), GITIGNORE_MARKERS.begin), "exactly one block after repair").toBe(1)
      expect(readFileSync(examplePath, "utf8"), "the placeholder is an owner file — never rewritten").toBe(example)
      git(target, ["add", "-A"])
      git(target, ["commit", "-qm", "after repair"])
      expect(trackedFiles(target), "the repaired block sits at EOF, and a tracked file is immune to it").toContain(".env.example")
      expect(git(target, ["show", "HEAD:.env.example"]).stdout, "and it is the placeholder's real bytes in history").toBe(example)
    })
  }

  it("greenfield in a repo the owner already init'd FOR this project: the placeholder is staged into their index, so their own first commit carries it", () => {
    const target = path.join(workDir, "pre-inited")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    git(target, ["config", "user.email", "owner@example.com"])
    git(target, ["config", "user.name", "Owner"])

    const result = scaffoldProject({ targetDir: target, projectName: "Pre Inited" })
    expect(result.git, "Vivicy still never inits or commits in a repo it did not create").toEqual({ initialized: false, committed: false })
    expect(git(target, ["config", "user.email"]).stdout.trim(), "and never touches their identity").toBe("owner@example.com")
    expect(trackedFiles(target), "staged, or the block's own .env.* would hide the placeholder from git forever").toContain(".env.example")

    git(target, ["add", "-A"])
    git(target, ["commit", "-qm", "owner's first commit"])
    expect(git(target, ["show", "HEAD:.env.example"]).stdout, "the owner's own first commit carries its real bytes").toBe(
      readFileSync(path.join(target, ".env.example"), "utf8")
    )
  })

  it("greenfield reached through a SYMLINKED path: the owner's own repo is recognised by PHYSICAL path identity, so the placeholder is still staged", () => {
    const physical = path.join(workDir, "physical")
    mkdirSync(path.join(physical, "app"), { recursive: true })
    symlinkSync(physical, path.join(workDir, "link"), "dir")
    const target = path.join(workDir, "link", "app")
    git(target, ["init", "-q", "."])

    scaffoldProject({ targetDir: target, projectName: "Symlinked App" })

    // `resolveTargetDir` only normalizes the owner's input while git always answers `--show-toplevel` with the physical path (darwin's /tmp → /private/tmp, /var → /private/var, or any symlinked project dir), so comparing the raw strings would read the owner's OWN repo as a foreign parent and silently withhold the placeholder.
    expect(git(target, ["rev-parse", "--show-toplevel"]).stdout.trim(), "the two spellings of this repo really do differ").not.toBe(target)
    expect(trackedFiles(target), "physical path identity keeps this on branch (b)").toContain(".env.example")
  })

  it("greenfield nested under a FOREIGN parent repo: no placeholder is written at all, because Vivicy may not stage into an index it does not own", () => {
    const parent = path.join(workDir, "parent-repo")
    mkdirSync(parent, { recursive: true })
    git(parent, ["init", "-q", "."])
    git(parent, ["config", "user.email", "owner@example.com"])
    git(parent, ["config", "user.name", "Owner"])
    writeFileSync(path.join(parent, "README.md"), "parent\n")
    git(parent, ["add", "-A"])
    git(parent, ["commit", "-qm", "parent"])

    const target = path.join(parent, "apps", "nested")
    const result = scaffoldProject({ targetDir: target, projectName: "Nested App" })

    expect(result.mode).toBe("from_scratch")
    expect(result.git).toEqual({ initialized: false, committed: false })
    expect(
      existsSync(path.join(target, ".env.example")),
      "a placeholder that cannot be tracked would be invisible to git forever and its own text would be false — so it is never written"
    ).toBe(false)
    // `status --porcelain` is the wrong oracle here: the scaffold legitimately leaves untracked files in the parent's work tree. The index is what must be untouched.
    expect(trackedFiles(parent), "the parent's index is not Vivicy's to write").toEqual(["README.md"])
    expect(git(parent, ["diff", "--cached", "--name-only"]).stdout.trim(), "nothing staged in the parent").toBe("")
  })

  it("brownfield: an owner rule the block would otherwise override survives — a repo that deliberately ignores its .env.example keeps it ignored", () => {
    const target = path.join(workDir, "brownfield-env-allowlist")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    writeFileSync(path.join(target, ".gitignore"), "*\n!src/\n!.gitignore\n")
    writeFileSync(path.join(target, "main.py"), "print('hi')\n")
    scaffoldProject({ targetDir: target, projectName: "Brownfield Allowlist" })
    expectIgnored(target, [".env", ".env.example", ".env.sample"], true)
  })

  it("a half-deleted marker above the owner's own secret rule never costs them that rule: repair keeps it and git still ignores the secret", () => {
    const target = path.join(workDir, "damaged-above-secret")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    writeFileSync(
      path.join(target, ".gitignore"),
      `node_modules/\n${GITIGNORE_MARKERS.begin}\nsecrets/config.json\n${GITIGNORE_MARKERS.begin}\n.vivicy-runtime/\n${GITIGNORE_MARKERS.end}\n`
    )
    mkdirSync(path.join(target, "secrets"), { recursive: true })
    writeFileSync(path.join(target, "secrets", "config.json"), '{"token":"real"}\n')

    scaffoldProject({ targetDir: target, projectName: "Damaged Above Secret" })

    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")
    expect(gitignore.split("\n"), "the owner's rule between the two markers is never swallowed").toContain("secrets/config.json")
    expect(count(gitignore, GITIGNORE_MARKERS.begin), "exactly one block after repair").toBe(1)
    expectIgnored(target, ["secrets/config.json"], true)
    git(target, ["config", "user.email", "t@example.com"])
    git(target, ["config", "user.name", "t"])
    git(target, ["add", "-A"])
    git(target, ["commit", "-qm", "post-repair"])
    expect(
      git(target, ["ls-files"]).stdout.split("\n").filter(Boolean),
      "the loop's git add -A must not stage the owner's secret"
    ).not.toContain("secrets/config.json")
  })
})

describe("the vivicy:method block (single-sourced from the template)", () => {
  it("extractManagedBlock yields the enriched tier-1 machinery defense and tier-2 discipline, with no code-culture (tier-3) content inside the markers", () => {
    const template = readFileSync(path.join(getTemplatesRoot(), "AGENTS.md"), "utf8")
    const block = extractManagedBlock(template, METHOD_MARKERS)

    expect(block).toContain(".vivicy/uploads/")
    expect(block).toContain("immutable evidence")
    expect(block, "vivicy.json is machine-owned, never hand-edited").toMatch(/machine-owned config, never hand-edited/i)
    expect(block, "the machine-owned contract names both gateCommand and runCommand").toMatch(/gateCommand/)
    expect(block, "runCommand's machine-established law rides inside the single-sourced managed block").toMatch(/runCommand/)
    expect(block).toMatch(/never weaken the gate to pass it/i)
    expect(block).toMatch(/reach green only honestly/i)
    expect(block).toContain("A test must discriminate")
    expect(block).toMatch(/refactor, don't accrete/i)
    expect(block, "the atomic-increments law rides in the managed block as a tier-2 discipline").toMatch(/smallest verified increments/i)
    expect(block, "the increments law forbids landing an oversized change as one sprawling diff").toMatch(/one sprawling diff/i)
    expect(block).toMatch(/diagnose before rewriting/i)
    expect(block, "no silent side-channel around a spec conflict").toMatch(/side-channel hack/i)

    expect(block, "existing corpus rule preserved").toContain(".vivicy/development/transcripts/")
    expect(block, "the a-posteriori proof artifacts are never-committed evidence too").toContain(".vivicy/development/proofs/")
    expect(block, "but each proof's recipe IS committed, or nothing is replayable").toMatch(/`recipe\.txt` IS committed/)
    expect(block, "a proof is an observation, never a fabrication").toMatch(/never fabricate one/i)
    expect(block, "existing language law preserved").toMatch(/established language/i)

    expect(block, "tier-3 zero-comments culture stays OUT of the block").not.toMatch(/zero comments/i)
    expect(block, "tier-3 time-marker culture stays OUT of the block").not.toMatch(/moment in time/i)
    expect(block).not.toMatch(/version marker/i)
  })
})

function git(cwd: string, args: string[]) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function isCleanTree(cwd: string): boolean {
  return git(cwd, ["status", "--porcelain"]).stdout.trim() === ""
}

describe("scaffoldProject — from-scratch git lifecycle (mechanical, no human git)", () => {
  it("git init + commits the skeleton so the target is a clean, committed repo", { timeout: 20_000 }, () => {
    const target = path.join(workDir, "fresh-repo")
    const result = scaffoldProject({ targetDir: target, projectName: "Fresh Repo" })

    expect(result.mode).toBe("from_scratch")
    expect(result.git).toEqual({ initialized: true, committed: true })

    expect(git(target, ["rev-parse", "--is-inside-work-tree"]).status).toBe(0)
    expect(git(target, ["rev-parse", "HEAD"]).status).toBe(0)

    expect(isCleanTree(target), git(target, ["status", "--porcelain"]).stdout).toBe(true)

    const tracked = new Set(
      git(target, ["ls-files"]).stdout.split("\n").map((s) => s.trim()).filter(Boolean)
    )
    expect(tracked.has("vivicy.json")).toBe(true)
    expect(tracked.has(".vivicy/canonical/.gitkeep")).toBe(true)
    expect(tracked.has(".gitignore")).toBe(true)
    for (const t of tracked) {
      expect(t.startsWith(".vivicy-runtime/"), `runtime must not be committed: ${t}`).toBe(false)
    }
  })

  it("commits with a LOCAL identity even on a repo whose only identity would be absent", { timeout: 20_000 }, () => {
    const target = path.join(workDir, "no-identity-repo")
    const emptyHome = path.join(workDir, "empty-home")
    mkdirSync(emptyHome, { recursive: true })
    const prevHome = process.env.HOME
    const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL
    const prevGitConfigSystem = process.env.GIT_CONFIG_SYSTEM
    process.env.HOME = emptyHome
    process.env.GIT_CONFIG_GLOBAL = path.join(emptyHome, ".gitconfig-absent")
    process.env.GIT_CONFIG_SYSTEM = path.join(emptyHome, ".gitconfig-system-absent")
    try {
      const result = scaffoldProject({ targetDir: target, projectName: "No Identity" })
      expect(result.git).toEqual({ initialized: true, committed: true })
      expect(git(target, ["rev-parse", "HEAD"]).status).toBe(0)
      expect(isCleanTree(target)).toBe(true)
      expect(git(target, ["config", "user.email"]).stdout.trim()).toBe("vivicy@local")
    } finally {
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
      if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL
      else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal
      if (prevGitConfigSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM
      else process.env.GIT_CONFIG_SYSTEM = prevGitConfigSystem
    }
  })

  it("does NOT re-init or add a second root commit when the from-scratch target is already a repo", { timeout: 20_000 }, () => {
    const target = path.join(workDir, "preinit")
    mkdirSync(target, { recursive: true })
    git(target, ["init"])
    git(target, ["config", "user.email", "owner@example.com"])
    git(target, ["config", "user.name", "Owner"])

    const result = scaffoldProject({ targetDir: target, projectName: "Preinit" })
    expect(result.mode).toBe("from_scratch")
    expect(result.git).toEqual({ initialized: false, committed: false })
    expect(git(target, ["config", "user.email"]).stdout.trim()).toBe("owner@example.com")
  })
})

describe("scaffoldProject — existing-project mode never touches the owner's git", () => {
  it("does not init a repo and does not commit when adding Vivicy to a populated dir", () => {
    const target = path.join(workDir, "existing-no-git")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "existing.txt"), "hi")

    const result = scaffoldProject({ targetDir: target, projectName: "Existing" })
    expect(result.mode).toBe("existing_project")
    expect(result.git).toEqual({ initialized: false, committed: false })
    expect(git(target, ["rev-parse", "--is-inside-work-tree"]).status).not.toBe(0)
  })

  it("leaves an EXISTING repo's history and HEAD completely untouched (no new root commit)", () => {
    const target = path.join(workDir, "existing-with-git")
    mkdirSync(target, { recursive: true })
    git(target, ["init"])
    git(target, ["config", "user.email", "owner@example.com"])
    git(target, ["config", "user.name", "Owner"])
    writeFileSync(path.join(target, "src.txt"), "original\n")
    git(target, ["add", "-A"])
    git(target, ["commit", "-m", "owner's original commit"])
    const headBefore = git(target, ["rev-parse", "HEAD"]).stdout.trim()
    const countBefore = git(target, ["rev-list", "--count", "HEAD"]).stdout.trim()

    const result = scaffoldProject({ targetDir: target, projectName: "Existing With Git" })
    expect(result.mode).toBe("existing_project")
    expect(result.git).toEqual({ initialized: false, committed: false })

    expect(git(target, ["rev-parse", "HEAD"]).stdout.trim()).toBe(headBefore)
    expect(git(target, ["rev-list", "--count", "HEAD"]).stdout.trim()).toBe(countBefore)
    expect(existsSync(path.join(target, "vivicy.json"))).toBe(true)
    expect(isCleanTree(target)).toBe(false)
  })
})
