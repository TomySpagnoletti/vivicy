import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, describe, expect, it } from "vitest"

import { commitDirty, dirtyPaths } from "@/lib/pathspec-commit"

const scratches: string[] = []

// HOME and XDG_CONFIG_HOME redirected on top of the config vars: git reads its per-user excludes whatever core.excludesFile says, and one inherited ignore rule turns every "was not committed" assertion here green over a tree it never looked at.
function git(root: string, args: string[], home: string) {
  const r = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: home,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
}

function repo(): { root: string; home: string } {
  const scratch = mkdtempSync(path.join(tmpdir(), "vivicy-pathspec-"))
  scratches.push(scratch)
  const root = path.join(scratch, "target")
  const home = path.join(scratch, "git-home")
  mkdirSync(root, { recursive: true })
  mkdirSync(home, { recursive: true })
  git(root, ["init", "-q"], home)
  git(root, ["config", "user.email", "t@local"], home)
  git(root, ["config", "user.name", "t"], home)
  git(root, ["config", "commit.gpgsign", "false"], home)
  return { root, home }
}

function write(root: string, rel: string, contents: string): void {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

function committedPaths(root: string, home: string): string[] {
  return git(root, ["show", "--pretty=", "--name-only", "HEAD"], home)
    .stdout.split("\n")
    .filter((line) => line.length > 0)
    .sort()
}

afterEach(() => {
  for (const scratch of scratches.splice(0)) rmSync(scratch, { recursive: true, force: true })
})

describe("commitDirty — the factory's one staging seam", () => {
  it("carries the declared territory and nothing else: an ecosystem install and an owner's draft never ride", () => {
    const { root, home } = repo()
    write(root, "src/app.ts", "export const a = 1\n")
    git(root, ["add", "--", "src"], home)
    git(root, ["commit", "-qm", "initial"], home)

    write(root, "src/app.ts", "export const a = 2\n")
    write(root, "src/next.ts", "export const b = 1\n")
    write(root, "node_modules/left-pad/index.js", "module.exports = 1\n")
    write(root, "NOTES-FOR-ME.md", "my draft\n")

    const result = commitDirty(root, { pathspecs: ["src"], message: "slice" })

    expect(result.committed).toBe(true)
    expect(result.paths.sort()).toEqual(["src/app.ts", "src/next.ts"])
    expect(committedPaths(root, home)).toEqual(["src/app.ts", "src/next.ts"])
    expect(git(root, ["status", "--porcelain", "-uall"], home).stdout).toContain("node_modules/left-pad/index.js")
    expect(git(root, ["status", "--porcelain", "-uall"], home).stdout).toContain("NOTES-FOR-ME.md")
  })

  it("stages a deletion and a rename the tree already recorded, instead of aborting the whole commit on them", () => {
    const { root, home } = repo()
    write(root, "src/keep.ts", "1\n")
    write(root, "src/unstaged-delete.ts", "2\n")
    write(root, "src/staged-delete.ts", "3\n")
    write(root, "src/moved.ts", "4\n")
    git(root, ["add", "--", "src"], home)
    git(root, ["commit", "-qm", "initial"], home)

    rmSync(path.join(root, "src/unstaged-delete.ts"))
    git(root, ["rm", "-q", "--", "src/staged-delete.ts"], home)
    git(root, ["mv", "src/moved.ts", "src/moved-elsewhere.ts"], home)
    write(root, "src/keep.ts", "1 changed\n")

    const result = commitDirty(root, { pathspecs: ["src"], message: "slice" })

    expect(result.failure).toBeNull()
    expect(result.committed).toBe(true)
    expect(committedPaths(root, home)).toEqual(["src/keep.ts", "src/moved-elsewhere.ts", "src/staged-delete.ts", "src/unstaged-delete.ts"])
    expect(git(root, ["show", "--pretty=", "--name-status", "HEAD"], home).stdout).toContain("src/moved.ts\tsrc/moved-elsewhere.ts")
    expect(git(root, ["status", "--porcelain", "-uall"], home).stdout.trim()).toBe("")
  })

  it("leaves excluded dirt behind and never rides the index: what was staged outside the territory stays staged", () => {
    const { root, home } = repo()
    write(root, "src/app.ts", "1\n")
    write(root, "docs/guide.md", "owner\n")
    git(root, ["add", "--", "src", "docs"], home)
    git(root, ["commit", "-qm", "initial"], home)

    write(root, "src/app.ts", "2\n")
    write(root, "src/theirs.ts", "already dirty when the stage started\n")
    write(root, "docs/guide.md", "owner, mid-edit\n")
    git(root, ["add", "--", "docs/guide.md"], home)

    const result = commitDirty(root, {
      pathspecs: ["src"],
      exclude: new Set(["src/theirs.ts"]),
      message: "slice",
    })

    expect(result.paths).toEqual(["src/app.ts"])
    expect(result.excluded).toEqual(["src/theirs.ts"])
    expect(committedPaths(root, home)).toEqual(["src/app.ts"])
    expect(git(root, ["diff", "--cached", "--name-only"], home).stdout.trim()).toBe("docs/guide.md")
  })

  it("reports an empty set rather than a failure when the territory is clean, and writes no commit", () => {
    const { root, home } = repo()
    write(root, "src/app.ts", "1\n")
    git(root, ["add", "--", "src"], home)
    git(root, ["commit", "-qm", "initial"], home)
    write(root, "elsewhere.md", "untouched by this stage\n")

    const result = commitDirty(root, { pathspecs: ["src"], message: "slice" })

    expect(result).toEqual({ paths: [], excluded: [], committed: false, empty: true, failure: null })
    expect(git(root, ["rev-list", "--count", "HEAD"], home).stdout.trim()).toBe("1")
    expect(dirtyPaths(root, ["."])).toEqual(["elsewhere.md"])
  })

  it("asks git nothing when the declared territory is empty", () => {
    const { root } = repo()
    write(root, "src/app.ts", "1\n")

    expect(dirtyPaths(root, [])).toEqual([])
    expect(commitDirty(root, { pathspecs: [], message: "slice" }).empty).toBe(true)
  })
})
