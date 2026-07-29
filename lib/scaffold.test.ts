import { spawnSync } from "node:child_process"
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  extractManagedBlock,
  GITIGNORE_MARKERS,
  MANAGED_GOVERNANCE_FILES,
  METHOD_MARKERS,
} from "@/lib/managed-block"
import { readNotifications } from "@/lib/notifications"
import { getCurrentProject, setCurrentProject } from "@/lib/project"
import {
  detectGateCommand,
  getTemplatesRoot,
  renormalizeManagedFiles,
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

  it("treats a POPULATED directory as existing_project", () => {
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
    // The secret family is excluded in EVERY shape and re-included NOWHERE — a `!` line below the block would survive only until the first marker repair re-appends the block underneath it, silently flipping the placeholder to ignored forever. `.vivicy-tmp.*` rides the same block because an atomic-write temp a crash abandoned is Vivicy's own uncommittable artifact.
    const blockEnd = ignoreLines.indexOf(GITIGNORE_MARKERS.end)
    for (const line of [".env", ".env.*", ".envrc", ".vivicy-tmp.*"]) {
      expect(ignoreLines.filter((l) => l === line), `greenfield must carry ${line} exactly once`).toHaveLength(1)
      expect(ignoreLines.indexOf(line), `${line} is block content`).toBeLessThan(blockEnd)
    }
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
    expect(git(target, ["check-ignore", "-q", ".envrc"]).status, "direnv's secret-bearing file migrates with them").toBe(0)
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
    const home = path.join(target, ".vivicy", "development", "proofs", "ISSUE-0008", "cli-run")
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
    expect(tracked).toContain(".vivicy/development/proofs/ISSUE-0008/cli-run/recipe.txt")
    expect(tracked.filter((p) => p.startsWith(".vivicy/development/proofs/"))).toEqual([
      ".vivicy/development/proofs/ISSUE-0008/cli-run/recipe.txt",
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
      ".vivicy/development/proofs/ISSUE-0008/cli-run/recipe.txt",
    ])
    expect(spawnSync("git", ["status", "--porcelain"], { cwd: target, encoding: "utf8" }).stdout.trim()).toBe("")
  })
})

describe("the secret-file ignore posture, exercised through real git (both writers)", () => {
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
    expectIgnored(target, [".env", ".env.local", ".env.sample", ".envrc"], true)
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
    expectIgnored(target, [".env", ".env.local", ".env.example", ".env.sample", ".envrc"], true)
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

const MANAGED = [".gitignore", "AGENTS.md", "CLAUDE.md"]
const ownerHead = "# My guide\n\nHouse rules the owner wrote above the managed block.\n\n"
const ownerTail = "\n## My own appendix\n\nOwner prose after the managed block, kept verbatim.\n"
const staleMethodBlock = `${METHOD_MARKERS.begin}\n## Working under Vivicy\n\nA thinner method contract from the governance pass that laid this repo down.\n${METHOD_MARKERS.end}`
const ownerIgnoreHead = "node_modules/\nmy-own-ignore/\n"
const staleIgnoreBlock = `${GITIGNORE_MARKERS.begin}\n.vivicy-runtime/\n.vivicy-worktrees/\n${GITIGNORE_MARKERS.end}\n`

function canonicalClaude(): string {
  return readFileSync(path.join(getTemplatesRoot(), "CLAUDE.md"), "utf8")
}

function governedRoot(name: string, files: Record<string, string> = {}): string {
  const target = path.join(workDir, name)
  mkdirSync(path.join(target, ".vivicy"), { recursive: true })
  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(target, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, contents)
  }
  // Mirrors the production seam: the root is persisted first, so the renormalization's notifications land in ITS namespace.
  setCurrentProject(target)
  return target
}

function staleGovernedRoot(name: string): string {
  return governedRoot(name, {
    "AGENTS.md": `${ownerHead}${staleMethodBlock}${ownerTail}`,
    "CLAUDE.md": canonicalClaude(),
    ".gitignore": `${ownerIgnoreHead}${staleIgnoreBlock}`,
  })
}

function writtenRel(target: string, result: { written: string[] }): string[] {
  return result.written.map((abs) => path.relative(target, abs))
}

describe("renormalizeManagedFiles — the project-open seam (same engine, never blocks the open)", () => {
  it("delivers the current block definition to a repo governed before it existed, owner bytes outside byte-identical", () => {
    const target = staleGovernedRoot("open-stale")

    const result = renormalizeManagedFiles(target)

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents.startsWith(ownerHead), "owner bytes before the block stay byte-identical").toBe(true)
    expect(agents.endsWith(ownerTail), "owner bytes after the block stay byte-identical").toBe(true)
    expect(agents, "the block the repo was governed with is replaced, not kept").not.toContain("A thinner method contract")
    expect(agents).toContain("A test must discriminate")
    expect(agents).toContain("smallest verified increments")
    expect(count(agents, METHOD_MARKERS.begin), "still exactly one managed block").toBe(1)

    const gitignore = readFileSync(path.join(target, ".gitignore"), "utf8")
    expect(gitignore.startsWith(ownerIgnoreHead), "owner bytes before the block stay byte-identical").toBe(true)
    expect(gitignore.split("\n"), "the env excludes reach a repo governed before they existed").toContain(".env.*")
    expect(gitignore.split("\n")).toContain(".vivicy/development/transcripts/")
    expect(count(gitignore, GITIGNORE_MARKERS.begin)).toBe(1)

    expect(result.failures).toEqual([])
    expect(writtenRel(target, result), "only the two stale files — the healthy CLAUDE.md is left alone").toEqual([
      ".gitignore",
      "AGENTS.md",
    ])

    const notifications = readNotifications()
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ level: "info", stage: "project", event: "managed_files_updated" })
    expect(notifications[0].message).toContain("AGENTS.md")
    expect(notifications[0].message).toContain(".gitignore")
    expect(notifications[0].message, "a file that was not rewritten is never announced").not.toContain("CLAUDE.md")
    expect(
      notifications[0].message,
      "the pending refresh is the run's to absorb, not a dirty tree the owner has to explain"
    ).toContain("the next run absorbs them into a commit of its own")
  })

  it("is a byte-stable no-op on a healthy project: nothing rewritten, no mtime touched, nothing announced", () => {
    const target = path.join(workDir, "open-healthy")
    scaffoldProject({ targetDir: target, projectName: "Open Healthy" })
    // An explicit past stamp, not the write clock: it makes the no-write claim independent of timestamp resolution.
    const stamp = new Date(Date.now() - 86_400_000)
    const before = MANAGED.map((rel) => {
      const abs = path.join(target, rel)
      utimesSync(abs, stamp, stamp)
      return { rel, bytes: readFileSync(abs, "utf8"), mtimeMs: statSync(abs).mtimeMs }
    })

    const result = renormalizeManagedFiles(target)

    expect(result).toEqual({ written: [], failures: [] })
    for (const { rel, bytes, mtimeMs } of before) {
      const abs = path.join(target, rel)
      expect(readFileSync(abs, "utf8"), `${rel} was rewritten`).toBe(bytes)
      expect(statSync(abs).mtimeMs, `${rel}'s mtime was touched`).toBe(mtimeMs)
    }
    expect(readNotifications(), "silent when zero files change").toEqual([])
  })

  it("recreates a managed file the owner deleted, and re-runs NOTHING else the greenfield scaffold owns", () => {
    const target = governedRoot("acme-open")

    const result = renormalizeManagedFiles(target)

    expect(result.failures).toEqual([])
    expect(writtenRel(target, result)).toEqual(MANAGED)

    const agents = readFileSync(path.join(target, "AGENTS.md"), "utf8")
    expect(agents, "a missing file gets the FULL template, named after the project directory").toContain(
      "acme-open Development Operating Guide"
    )
    expect(agents).not.toContain("{{PROJECT_NAME}}")
    expect(count(agents, METHOD_MARKERS.begin)).toBe(1)
    expect(readFileSync(path.join(target, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md")
    expect(readFileSync(path.join(target, ".gitignore"), "utf8").split("\n")).toContain(".env.*")

    for (const rel of ["README.md", "vivicy.json", ".env.example", ".vivicy/canonical"]) {
      expect(
        existsSync(path.join(target, rel)),
        `${rel} is a greenfield-only artifact — opening a project never re-runs it`
      ).toBe(false)
    }
  })

  it("never blocks the open when a managed file is unwritable: the failure is surfaced internally, the rest still land", () => {
    const target = staleGovernedRoot("open-readonly")
    const agentsPath = path.join(target, "AGENTS.md")
    const sealed = readFileSync(agentsPath, "utf8")
    chmodSync(agentsPath, 0o444)

    let result
    try {
      result = renormalizeManagedFiles(target)
    } finally {
      chmodSync(agentsPath, 0o644)
    }

    expect(readFileSync(agentsPath, "utf8"), "an unwritable file keeps its bytes").toBe(sealed)
    expect(writtenRel(target, result), "the writable files still reach the current definition").toEqual([".gitignore"])
    expect(readNotifications()[0].message, "the announcement agrees in number with what it lists").toContain(
      "updated 1 managed file on open: .gitignore — uncommitted in your working tree for now; the next run absorbs it into a commit of its own"
    )
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].file, "failures carry absolute paths, exactly like written").toBe(agentsPath)
    expect(result.failures[0].reason, "the reason names the real fs error").toMatch(/^(EACCES|EPERM): /)
    expect(
      result.failures[0].reason,
      "and drops the absolute path the message already names by its relative file"
    ).not.toContain(agentsPath)

    const notifications = readNotifications()
    expect(notifications.map((n) => n.event)).toEqual(["managed_files_updated", "managed_files_failed"])
    expect(notifications[1]).toMatchObject({ level: "warning", stage: "project" })
    expect(notifications[1].message).toContain("AGENTS.md")
    expect(notifications[1].message, "the owner learns the open succeeded anyway, and what to do").toContain(
      "the project opened anyway"
    )
    expect(notifications[1].message).toContain("reopen the project")
    expect(
      notifications[1].message,
      "the announcement is relative throughout — it belongs to a project whose root the owner picked"
    ).not.toContain(target)
  })

  it("degrades to a surfaced failure, never a throw, when Vivicy's own templates are unreachable", () => {
    const target = staleGovernedRoot("open-no-templates")
    process.env.VIVICY_FACTORY_ROOT = path.join(workDir, "absent-factory")

    const result = renormalizeManagedFiles(target)

    expect(
      result.failures.map((f) => path.relative(target, f.file)),
      "the template-backed files fail, each named"
    ).toEqual(["AGENTS.md", "CLAUDE.md"])
    expect(writtenRel(target, result), ".gitignore is a code constant and still reaches the current definition").toEqual([
      ".gitignore",
    ])
    expect(
      result.failures[0].reason,
      "a failure on VIVICY's own template keeps the path — otherwise it would read as the owner's AGENTS.md being gone"
    ).toContain(path.join("absent-factory", "templates", "AGENTS.md"))
    expect(readNotifications().map((n) => n.event)).toEqual(["managed_files_updated", "managed_files_failed"])
  })

  it("does nothing at all on an ungoverned root — the seam renormalizes only what Vivicy governs", () => {
    const target = path.join(workDir, "not-governed")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "README.md"), "the owner's own readme\n")
    setCurrentProject(target)

    expect(renormalizeManagedFiles(target)).toEqual({ written: [], failures: [] })
    expect(readdirSync(target), "no managed file is invented in a folder Vivicy does not govern").toEqual(["README.md"])
    expect(readNotifications()).toEqual([])
  })

  it("mutates no git state: the refreshed bytes sit in the working tree, nothing staged, HEAD unmoved", () => {
    const target = staleGovernedRoot("open-git")
    git(target, ["init", "-q", "."])
    git(target, ["config", "user.email", "owner@example.com"])
    git(target, ["config", "user.name", "Owner"])
    git(target, ["add", "-A"])
    git(target, ["commit", "-qm", "the owner's own commit"])
    const head = git(target, ["rev-parse", "HEAD"]).stdout.trim()

    renormalizeManagedFiles(target)

    expect(git(target, ["rev-parse", "HEAD"]).stdout.trim(), "no commit at open").toBe(head)
    expect(git(target, ["diff", "--cached", "--name-only"]).stdout.trim(), "nothing staged at open").toBe("")
    expect(
      git(target, ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).sort(),
      "exactly the two refreshed files, unstaged — the governed loop's own checkpoints pick them up later"
    ).toEqual([" M .gitignore", " M AGENTS.md"])
  })
})

// One seam serves both call sites: every case here drives the open seam, and the two that can also refuse governance drive `scaffoldProject` too.
describe("writeManaged — the owner's bytes, their file, and one atomic swap", () => {
  const TEMP_PREFIX = ".vivicy-tmp."
  // What a lossy decode leaves behind: read as UTF-8, a latin-1 é becomes U+FFFD (EF BF BD) and the owner's line is mutilated for good.
  const REPLACEMENT_CHAR = Buffer.from([0xef, 0xbf, 0xbd])
  const utf16le = (text: string) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")])
  const REFUSAL =
    "not UTF-8 — it is saved as UTF-16LE, and Vivicy replaces a managed file byte for byte rather than re-encode yours; re-save it as UTF-8"

  function temps(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.startsWith(TEMP_PREFIX))
  }

  it("a latin-1 .gitignore keeps its accented owner lines byte-for-byte through a REAL block update, and still ignores what they hid", () => {
    const target = governedRoot("open-latin1")
    git(target, ["init", "-q", "."])
    const abs = path.join(target, ".gitignore")
    const ownerBytes = Buffer.from("# règles privées, à ne pas toucher\nsecrets/config.json\n", "latin1")
    writeFileSync(abs, Buffer.concat([ownerBytes, Buffer.from(staleIgnoreBlock, "latin1")]))

    const result = renormalizeManagedFiles(target)

    const after = readFileSync(abs)
    expect(writtenRel(target, result), "the block really was rewritten — the no-op path would prove nothing").toContain(".gitignore")
    expect(after.subarray(0, ownerBytes.length), "the owner's own bytes, neither decoded nor rewritten").toEqual(ownerBytes)
    expect(after.includes(REPLACEMENT_CHAR), "nothing was decoded to UTF-8 and re-encoded").toBe(false)
    expect(after.toString("latin1").split("\n"), "and the current block landed").toContain(".envrc")
    expect(git(target, ["check-ignore", "-q", "secrets/config.json"]).status, "their rule still hides their secret").toBe(0)
  })

  it("a UTF-8 BOM is the owner's byte and still starts the file after a real update", () => {
    const target = governedRoot("open-bom")
    const abs = path.join(target, "AGENTS.md")
    writeFileSync(abs, Buffer.from(`﻿${ownerHead}${staleMethodBlock}${ownerTail}`, "utf8"))

    renormalizeManagedFiles(target)

    const after = readFileSync(abs)
    expect(after.subarray(0, 3), "the byte-order mark is owner content, not something to normalize away").toEqual(
      Buffer.from([0xef, 0xbb, 0xbf])
    )
    expect(after.toString("utf8").startsWith(`﻿${ownerHead}`)).toBe(true)
    expect(after.toString("utf8").endsWith(ownerTail)).toBe(true)
    expect(after.toString("utf8")).toContain("A test must discriminate")
  })

  it("a UTF-16 managed file is refused untouched — the open still succeeds and the owner is told which file and what to do", () => {
    const target = staleGovernedRoot("open-utf16")
    const abs = path.join(target, ".gitignore")
    const ownerBytes = utf16le("node_modules/\nmy-own-ignore/\n")
    writeFileSync(abs, ownerBytes)

    const result = renormalizeManagedFiles(target)

    expect(readFileSync(abs), "a file Vivicy cannot splice byte-safely is never written at all").toEqual(ownerBytes)
    expect(result.failures.map((f) => path.relative(target, f.file))).toEqual([".gitignore"])
    expect(result.failures[0].reason).toBe(REFUSAL)
    expect(writtenRel(target, result), "the files it CAN manage still reach the current definition").toEqual(["AGENTS.md"])
    const notifications = readNotifications()
    expect(notifications.map((n) => n.event)).toEqual(["managed_files_updated", "managed_files_failed"])
    expect(notifications[1].message, "one sentence the owner can act on, the file named once").toContain(
      `.gitignore (${REFUSAL})`
    )
  })

  // A UTF-32LE file opens on the UTF-16LE mark followed by two zero bytes, so the shorter pattern would send the owner to convert from an encoding their file is not in.
  it("names the encoding it actually found: a UTF-32LE file is not reported as UTF-16LE", () => {
    const target = staleGovernedRoot("open-utf32")
    const abs = path.join(target, ".gitignore")
    const ownerBytes = Buffer.concat([Buffer.from([0xff, 0xfe, 0x00, 0x00]), Buffer.from("node_modules/\n", "utf-8")])
    writeFileSync(abs, ownerBytes)

    const result = renormalizeManagedFiles(target)

    expect(result.failures[0].reason).toContain("it is saved as UTF-32LE")
    expect(readFileSync(abs)).toEqual(ownerBytes)
  })

  it("governance start refuses the same file with a typed error naming it, having written none of its bytes", () => {
    const target = path.join(workDir, "govern-utf16")
    mkdirSync(target, { recursive: true })
    writeFileSync(path.join(target, "main.py"), "print('hi')\n")
    const ownerBytes = utf16le("node_modules/\n")
    writeFileSync(path.join(target, ".gitignore"), ownerBytes)

    expect(() => scaffoldProject({ targetDir: target, projectName: "Utf16 Repo" })).toThrow(
      expect.objectContaining({ code: "unsupported_encoding", message: `.gitignore is ${REFUSAL}` })
    )
    expect(readFileSync(path.join(target, ".gitignore"))).toEqual(ownerBytes)
  })

  it("the bytes a reader already holds are never truncated: the file is swapped in whole by one rename", () => {
    const target = staleGovernedRoot("open-atomic")
    const abs = path.join(target, ".gitignore")
    const before = readFileSync(abs)
    const inode = statSync(abs).ino
    const held = openSync(abs, "r")
    try {
      const result = renormalizeManagedFiles(target)

      expect(writtenRel(target, result)).toContain(".gitignore")
      expect(
        readFileSync(held),
        "everything a crash could interrupt happens on a copy — the file that existed is never opened for writing"
      ).toEqual(before)
    } finally {
      closeSync(held)
    }
    expect(statSync(abs).ino, "what the owner sees is a new inode, published by one atomic syscall").not.toBe(inode)
    expect(temps(target), "and no temp outlives a write that completed").toEqual([])
    expect(readFileSync(abs, "utf8").split("\n")).toContain(".envrc")
  })

  it("a symlinked managed file stays a symlink: the bytes land on the file it points at, at its own mode", () => {
    const target = governedRoot("open-symlinked")
    const shared = path.join(target, "shared", "gitignore")
    mkdirSync(path.dirname(shared), { recursive: true })
    writeFileSync(shared, `${ownerIgnoreHead}${staleIgnoreBlock}`)
    chmodSync(shared, 0o600)
    symlinkSync(path.join("shared", "gitignore"), path.join(target, ".gitignore"))

    const result = renormalizeManagedFiles(target)

    expect(writtenRel(target, result)).toContain(".gitignore")
    expect(
      lstatSync(path.join(target, ".gitignore")).isSymbolicLink(),
      "a rename onto the link itself would silently detach the owner's convention into a regular file"
    ).toBe(true)
    expect(readFileSync(shared, "utf8").split("\n"), "the block reaches the file the link points at").toContain(".envrc")
    expect(readFileSync(shared, "utf8").startsWith(ownerIgnoreHead)).toBe(true)
    expect(statSync(shared).mode & 0o7777, "and the resolved file keeps its own mode").toBe(0o600)
    expect(temps(path.dirname(shared)), "the temp is written beside the RESOLVED file, so the rename never crosses a filesystem").toEqual([])
  })

  // Adjudicated: a link the owner points OUT of the governed root takes its temp with it. Keeping the temp inside the root would make the rename cross filesystems — trading atomicity, the property this whole seam exists for, for an ignore rule Vivicy has no standing to install in someone else's directory. The exposure is one crash window, in a directory the owner chose, under a name that is unmistakably Vivicy's.
  it("a link pointing OUT of the governed root takes its temp with it, rather than trade the atomic rename away", () => {
    const target = governedRoot("open-symlinked-out")
    const elsewhere = path.join(workDir, "dotfiles")
    mkdirSync(elsewhere, { recursive: true })
    const shared = path.join(elsewhere, "gitignore")
    writeFileSync(shared, `${ownerIgnoreHead}${staleIgnoreBlock}`)
    symlinkSync(shared, path.join(target, ".gitignore"))
    mkdirSync(path.join(elsewhere, `${TEMP_PREFIX}${process.pid}.gitignore`))

    const result = renormalizeManagedFiles(target)

    expect(
      result.failures.map((f) => path.relative(target, f.file)),
      "the write failed on a temp path OUTSIDE the root — which is where it must be, beside the file it replaces"
    ).toEqual([".gitignore"])
    expect(readFileSync(shared, "utf8"), "and the owner's file across the link is untouched").toBe(
      `${ownerIgnoreHead}${staleIgnoreBlock}`
    )
    expect(temps(target), "no temp is ever left in the governed root for a file that does not live there").toEqual([])
  })

  // 0600 is the mode a fresh temp would WIDEN to the umask default; 0664 is the one the umask itself would narrow while creating that temp, so the exact bits have to be set after the write, not asked for during it.
  for (const mode of [0o600, 0o664]) {
    it(`keeps the owner's ${mode.toString(8)} file mode instead of the one a fresh file would land on`, () => {
      const target = staleGovernedRoot(`open-mode-${mode.toString(8)}`)
      const abs = path.join(target, ".gitignore")
      chmodSync(abs, mode)

      renormalizeManagedFiles(target)

      expect(statSync(abs).mode & 0o7777).toBe(mode)
      expect(readFileSync(abs, "utf8").split("\n"), "and the write really happened").toContain(".envrc")
    })
  }

  it("a temp path it cannot use fails that file loudly and leaves the owner's bytes — and the blocking entry — alone", () => {
    const target = staleGovernedRoot("open-temp-blocked")
    const abs = path.join(target, ".gitignore")
    const before = readFileSync(abs)
    // The exact name the write builds; a directory sitting there is the one way to fail it from the outside, which is also what binds this pin to that name.
    const blocked = path.join(target, `${TEMP_PREFIX}${process.pid}..gitignore`)
    mkdirSync(blocked)

    const result = renormalizeManagedFiles(target)

    expect(readFileSync(abs), "a write that could not complete never touched the original").toEqual(before)
    expect(result.failures.map((f) => path.relative(target, f.file))).toEqual([".gitignore"])
    expect(result.failures[0].reason, "the obstruction is what it reports").toMatch(/^Path is a directory: rm returned EISDIR/)
    expect(result.failures[0].reason, "and where it sits, since removing it is the owner's only move here").toContain(blocked)
    expect(writtenRel(target, result), "the other managed files still land").toEqual(["AGENTS.md"])
    expect(existsSync(blocked), "cleanup removes the temp it wrote, never an entry it found").toBe(true)
  })

  it("a temp a killed run left behind is removed, never opened: a symlink at that path cannot capture the write", () => {
    const target = staleGovernedRoot("open-temp-stale-link")
    const outside = path.join(workDir, "the-owners-other-file.txt")
    writeFileSync(outside, "not Vivicy's to write\n")
    const abs = path.join(target, ".gitignore")
    symlinkSync(outside, path.join(target, `${TEMP_PREFIX}${process.pid}..gitignore`))

    const result = renormalizeManagedFiles(target)

    expect(readFileSync(outside, "utf8"), "an opened symlink would have sent the block out of the repo").toBe(
      "not Vivicy's to write\n"
    )
    expect(lstatSync(abs).isSymbolicLink(), "and then the rename would have moved that link onto the managed file").toBe(false)
    expect(writtenRel(target, result)).toContain(".gitignore")
    expect(readFileSync(abs, "utf8").split("\n")).toContain(".envrc")
    expect(temps(target), "the stale entry is gone with the write's own temp").toEqual([])
  })

  it("...and a stale temp's mode never leaks into a file recreated from nothing", () => {
    const target = governedRoot("open-temp-stale-mode")
    const stale = path.join(target, `${TEMP_PREFIX}${process.pid}..gitignore`)
    writeFileSync(stale, "half of a managed file\n")
    chmodSync(stale, 0o600)

    renormalizeManagedFiles(target)

    expect(
      statSync(path.join(target, ".gitignore")).mode & 0o7777,
      "a file with no predecessor takes the process default, never a dead temp's bits"
    ).not.toBe(0o600)
  })

  it("a read-only directory refuses the write instead of replacing the file, and never shows Vivicy's internal name", () => {
    const target = staleGovernedRoot("open-readonly-dir")
    const before = MANAGED.map((rel) => readFileSync(path.join(target, rel)))
    chmodSync(target, 0o555)

    let result
    try {
      result = renormalizeManagedFiles(target)
    } finally {
      chmodSync(target, 0o755)
    }

    expect(result.written, "a directory the owner sealed is not written through").toEqual([])
    MANAGED.forEach((rel, i) => expect(readFileSync(path.join(target, rel)), `${rel} was rewritten`).toEqual(before[i]))
    expect(
      result.failures.map((f) => path.relative(target, f.file)),
      "each file that had something to write, and only those — the canonical CLAUDE.md never opens"
    ).toEqual([".gitignore", "AGENTS.md"])
    for (const { reason } of result.failures) {
      expect(reason, "the fs error, whole").toMatch(/^EACCES: /)
      expect(reason, "and never the temp path, which names nothing the owner has").not.toContain(TEMP_PREFIX)
    }
  })

  // The consequence cannot be observed after the fact — both orders end with the same three files — so it is pinned where it is decided.
  it("writes .gitignore FIRST, so no other managed file's temp can exist before the rules that keep it out of a commit", () => {
    expect(MANAGED_GOVERNANCE_FILES[0]).toBe(".gitignore")
    expect(new Set(MANAGED_GOVERNANCE_FILES), "and the set itself is unchanged").toEqual(new Set(MANAGED))
  })
})

describe("a crash-abandoned atomic-write temp is never committable (both writers)", () => {
  // The shape a SIGKILL between the temp write and the rename leaves behind, at the exact names the write builds — every managed file, since `.gitignore` is written FIRST precisely so the others' temps are already covered.
  function abandonTemps(target: string): string[] {
    return MANAGED_GOVERNANCE_FILES.map((rel) => {
      const temp = `.vivicy-tmp.${process.pid}.${rel}`
      writeFileSync(path.join(target, temp), "half of a managed file\n")
      return temp
    })
  }

  function commitAll(target: string): string[] {
    git(target, ["config", "user.email", "t@example.com"])
    git(target, ["config", "user.name", "t"])
    git(target, ["add", "-A"])
    git(target, ["commit", "-qm", "after the crash"])
    return git(target, ["ls-files"]).stdout.split("\n").filter(Boolean)
  }

  it("greenfield: the block Vivicy wrote covers its own temps, so git add -A cannot pick them up", () => {
    const target = path.join(workDir, "greenfield-temp")
    scaffoldProject({ targetDir: target, projectName: "Greenfield Temp" })
    const temps = abandonTemps(target)

    for (const rel of temps) expect(git(target, ["check-ignore", "-q", rel]).status, `${rel} must be ignored`).toBe(0)
    const tracked = commitAll(target)
    for (const rel of temps) expect(tracked).not.toContain(rel)
    expect(git(target, ["status", "--porcelain"]).stdout.trim(), "nor do they dirty the tree the run gates on").toBe("")
  })

  it("brownfield: the appended block delivers the same posture in a repo that already had its own .gitignore", () => {
    const target = path.join(workDir, "brownfield-temp")
    mkdirSync(target, { recursive: true })
    git(target, ["init", "-q", "."])
    writeFileSync(path.join(target, ".gitignore"), "node_modules/\n")
    writeFileSync(path.join(target, "main.py"), "print('hi')\n")
    scaffoldProject({ targetDir: target, projectName: "Brownfield Temp" })
    const temps = abandonTemps(target)

    for (const rel of temps) expect(git(target, ["check-ignore", "-q", rel]).status, `${rel} must be ignored`).toBe(0)
    const tracked = commitAll(target)
    for (const rel of temps) expect(tracked).not.toContain(rel)
    expect(git(target, ["status", "--porcelain"]).stdout.trim()).toBe("")
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
