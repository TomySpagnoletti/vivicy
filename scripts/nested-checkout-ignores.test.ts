import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { ESLint } from "eslint"
import { afterAll, describe, expect, it } from "vitest"
import { resolveConfig } from "vitest/node"

import { computeBehaviorFingerprint, REPO_ROOT } from "./test-matrix"

const NESTED_CHECKOUTS = [
  { root: ".claude", phantom: ".claude/worktrees/f000" },
  { root: ".vivicy-worktrees", phantom: ".vivicy-worktrees/ISSUE-0001" },
]
const LINTED_SOURCE_FILE = "lib/map-data.ts"
const roots: string[] = []

function syntheticRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "vivicy-nested-checkout-"))
  roots.push(root)
  return root
}

function seed(root: string, rel: string, body: string): void {
  mkdirSync(path.join(root, path.dirname(rel)), { recursive: true })
  writeFileSync(path.join(root, rel), body)
}

const HERMETIC_GIT_HOME = syntheticRoot()

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe("nested checkouts are invisible to the repo's file-discovering tools", () => {
  it("eslint.config.mjs ignores lintable files inside a nested checkout, and still lints the real tree", async () => {
    const eslint = new ESLint({ cwd: REPO_ROOT })
    for (const { phantom } of NESTED_CHECKOUTS) {
      const file = `${phantom}/${LINTED_SOURCE_FILE}`
      expect(await eslint.isPathIgnored(file), `${file} must not reach the lint gate`).toBe(true)
    }
    expect(await eslint.isPathIgnored(LINTED_SOURCE_FILE)).toBe(false)
  })

  it("vitest.config.ts resolves to a repo-wide test glob that excludes both nested checkouts", async () => {
    const { vitestConfig } = await resolveConfig({ root: REPO_ROOT, config: path.join(REPO_ROOT, "vitest.config.ts") })
    expect(vitestConfig.include, "discovery reaches every directory, so only the exclude keeps phantom copies out").toContain("**/*.test.ts")
    for (const { root } of NESTED_CHECKOUTS) {
      expect(vitestConfig.exclude, `**/${root}/** must stay in the resolved exclude`).toContain(`**/${root}/**`)
    }
  })

  it("the matrix behavior fingerprint is blind to a nested checkout of the whole tree", () => {
    const root = syntheticRoot()
    seed(root, "lib/thing.ts", "export const thing = 1\n")
    const clean = computeBehaviorFingerprint(root)
    for (const { phantom } of NESTED_CHECKOUTS) {
      seed(root, `${phantom}/lib/thing.ts`, "export const thing = 2\n")
      seed(root, `lib/${phantom}/lib/thing.ts`, "export const thing = 3\n")
    }
    expect(computeBehaviorFingerprint(root)).toBe(clean)
    seed(root, "lib/other.ts", "export const other = 4\n")
    expect(computeBehaviorFingerprint(root)).not.toBe(clean)
  })
})

// The machine must not decide the answer: HOME and XDG_CONFIG_HOME are redirected too, because git reads its DEFAULT per-user excludes file ($XDG_CONFIG_HOME/git/ignore, else $HOME/.config/git/ignore) whether or not core.excludesFile is set — neutralizing the CONFIG files alone leaves a machine whose per-user ignore lists node_modules answering for this repo's rules.
function git(cwd: string, args: string[]): { status: number; stdout: string } {
  const r = spawnSync("git", ["-c", "user.email=t@vivicy.local", "-c", "user.name=Test", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: HERMETIC_GIT_HOME,
      XDG_CONFIG_HOME: HERMETIC_GIT_HOME,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
  })
  return { status: r.status ?? 1, stdout: r.stdout ?? "" }
}

describe("the repo's own .gitignore covers node_modules in every form git can see", () => {
  it("ignores the symlink a nested checkout links to the main install, not only a real directory", () => {
    const root = syntheticRoot()
    git(root, ["init"])
    copyFileSync(path.join(REPO_ROOT, ".gitignore"), path.join(root, ".gitignore"))
    seed(root, "lib/thing.ts", "export const thing = 1\n")
    seed(root, "install/eslint/index.js", "module.exports = {}\n")
    symlinkSync(path.join(root, "install"), path.join(root, "node_modules"))
    seed(root, "packages/app/node_modules/dep/index.js", "module.exports = {}\n")

    expect(git(root, ["check-ignore", "-q", "node_modules"]).status, "the symlink form at the repo root").toBe(0)
    expect(git(root, ["check-ignore", "-q", "packages/app/node_modules"]).status, "the directory form at any depth").toBe(0)

    git(root, ["add", "-A"])
    git(root, ["commit", "-m", "seed"])
    expect(git(root, ["ls-files"]).stdout.split("\n").filter(Boolean)).toEqual([".gitignore", "install/eslint/index.js", "lib/thing.ts"])
    expect(git(root, ["status", "--porcelain"]).stdout.trim(), "nothing of either form is left for a later add -A").toBe("")
  })

  // Why `.prettierignore` may keep the trailing slash the git carriers dropped — an upstream default the repo now depends on, so it is pinned rather than assumed.
  it("prettier never descends a symlinked directory, so its ignore rules are never consulted for one", () => {
    const base = syntheticRoot()
    const project = path.join(base, "project")
    seed(project, "real/messy.js", "const  x=1\n")
    seed(base, "store/messy.js", "const  y=2\n")
    symlinkSync(path.join(base, "store"), path.join(project, "linked"))

    const r = spawnSync(path.join(REPO_ROOT, "node_modules", ".bin", "prettier"), ["--list-different", "**/*.js"], {
      cwd: project,
      encoding: "utf8",
    })
    const listed = (r.stdout ?? "").split("\n").filter(Boolean)
    expect(listed, "control: the globber does reach a badly-formatted file at a real path").toContain("real/messy.js")
    expect(listed.filter((p) => p.startsWith("linked")), "and never one reachable only through a symlinked directory").toEqual([])
  })
})
