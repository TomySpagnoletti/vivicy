import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { detectSpecKind } from "@/lib/spec-kind"

let repo: string

function git(...args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" })
}

function gitInit(): void {
  git("init", "-q")
  git("config", "user.email", "t@vivicy.local")
  git("config", "user.name", "T")
}

function commitFile(rel: string, body = "x\n"): void {
  const abs = path.join(repo, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, body)
  git("add", "--", rel)
  git("commit", "-q", "-m", `add ${rel}`)
}

beforeEach(() => {
  repo = mkdtempSync(path.join(tmpdir(), "spec-kind-"))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
})

describe("detectSpecKind — git witness", () => {
  it("a scaffolded-only repo is a PROJECT spec (no product code)", () => {
    gitInit()
    commitFile("AGENTS.md", "# agents\n")
    commitFile("CLAUDE.md", "@AGENTS.md\n")
    commitFile("README.md", "# readme\n")
    commitFile("vivicy.json", '{"gateCommand":"npm test"}\n')
    commitFile(".gitignore", "node_modules\n")
    commitFile(".vivicy/canonical/.gitkeep", "")
    commitFile(".vivicy/development/spikes/.gitkeep", "")
    expect(detectSpecKind(repo)).toBe("project")
  })

  it("one tracked source file flips it to a FEATURE spec", () => {
    gitInit()
    commitFile("AGENTS.md")
    commitFile("src/index.ts", "export const a = 1\n")
    expect(detectSpecKind(repo)).toBe("feature")
  })

  it("canonical docs under .vivicy never count as code", () => {
    gitInit()
    commitFile(".vivicy/canonical/01-product.md", "# spec\n")
    expect(detectSpecKind(repo)).toBe("project")
  })

  it("UNTRACKED code does not count (tracked files are the witness)", () => {
    gitInit()
    commitFile("README.md")
    writeFileSync(path.join(repo, "scratch.ts"), "// not yet part of the product\n")
    expect(detectSpecKind(repo)).toBe("project")
  })

  it("the skills stage committing its own footprint never flips a greenfield repo to a feature spec", () => {
    gitInit()
    commitFile("AGENTS.md", "# agents\n")
    commitFile("vivicy.json", '{"gateCommand":null}\n')
    expect(detectSpecKind(repo), "precondition: greenfield").toBe("project")

    commitFile(".agents/skills/xlsx/SKILL.md", "---\nname: xlsx\n---\n")
    commitFile(".agents/skills/xlsx/scripts/recalc.py", "print(1)\n")
    commitFile(".claude/skills/xlsx", "../../.agents/skills/xlsx")
    commitFile(".codex/skills/xlsx", "../../.agents/skills/xlsx")
    commitFile("skills-lock.json", '{"version":1,"skills":{}}\n')
    expect(detectSpecKind(repo), "installed skills are Vivicy's own output, never the owner's product code").toBe("project")

    commitFile("src/index.ts", "export const a = 1\n")
    expect(detectSpecKind(repo), "and real product code still flips it").toBe("feature")
  })
})

describe("detectSpecKind — filesystem fallback (no git)", () => {
  it("empty/scaffold-only dir is a PROJECT spec", () => {
    writeFileSync(path.join(repo, "README.md"), "# r\n")
    writeFileSync(path.join(repo, "vivicy.json"), "{}\n")
    mkdirSync(path.join(repo, ".vivicy", "canonical"), { recursive: true })
    expect(detectSpecKind(repo)).toBe("project")
  })

  it("a source file makes it a FEATURE spec; node_modules and dot-dirs are ignored", () => {
    mkdirSync(path.join(repo, "node_modules", "x"), { recursive: true })
    writeFileSync(path.join(repo, "node_modules", "x", "index.js"), "x\n")
    mkdirSync(path.join(repo, ".cache"), { recursive: true })
    writeFileSync(path.join(repo, ".cache", "blob.bin"), "x\n")
    expect(detectSpecKind(repo)).toBe("project")

    mkdirSync(path.join(repo, "app"), { recursive: true })
    writeFileSync(path.join(repo, "app", "main.py"), "print(1)\n")
    expect(detectSpecKind(repo)).toBe("feature")
  })
})
