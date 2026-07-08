import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { pruneGitkeeps, SKELETON_DIRS } from "@/lib/skeleton"

describe("pruneGitkeeps", () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "vivicy-skeleton-"))
    for (const rel of SKELETON_DIRS) {
      const dir = path.join(root, rel)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, ".gitkeep"), "")
    }
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it("removes .gitkeep only from dirs that gained real content", () => {
    writeFileSync(path.join(root, ".vivicy/canonical/product.md"), "# spec\n")
    writeFileSync(path.join(root, ".vivicy/development/reports/extraction-status.json"), "{}\n")

    const pruned = pruneGitkeeps(root)

    expect(pruned.sort()).toEqual([
      ".vivicy/canonical/.gitkeep",
      ".vivicy/development/reports/.gitkeep",
    ])
    expect(existsSync(path.join(root, ".vivicy/canonical/.gitkeep"))).toBe(false)
    expect(existsSync(path.join(root, ".vivicy/development/reports/.gitkeep"))).toBe(false)
    expect(existsSync(path.join(root, ".vivicy/baselines/.gitkeep"))).toBe(true)
    expect(existsSync(path.join(root, ".vivicy/change-requests/.gitkeep"))).toBe(true)
  })

  it("does not count .DS_Store as content", () => {
    writeFileSync(path.join(root, ".vivicy/baselines/.DS_Store"), "")
    expect(pruneGitkeeps(root)).toEqual([])
    expect(existsSync(path.join(root, ".vivicy/baselines/.gitkeep"))).toBe(true)
  })

  it("is idempotent and tolerates missing dirs and missing .gitkeep", () => {
    writeFileSync(path.join(root, ".vivicy/canonical/product.md"), "# spec\n")
    rmSync(path.join(root, ".vivicy/requirements"), { recursive: true, force: true })

    expect(pruneGitkeeps(root)).toEqual([".vivicy/canonical/.gitkeep"])
    expect(pruneGitkeeps(root)).toEqual([])
  })
})
