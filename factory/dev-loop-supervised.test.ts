import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { FACTORY_DIR } from "./target-root.ts"

// The single git seam of this file: HOME and XDG_CONFIG_HOME are redirected on top of the config vars, because git reads its DEFAULT per-user excludes ($XDG_CONFIG_HOME/git/ignore, else $HOME/.config/git/ignore) whether or not core.excludesFile is set — and a per-user rule can only ADD ignores, which would silently turn this file's "tree clean" assertion green over a supervisor that dirtied it.
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

// An empty porcelain is this file's whole verdict, and a git that never ran prints exactly that — so the observer's own exit status is asserted before its silence is read as cleanliness.
function porcelain(root: string, home: string): string {
  const r = git(root, ["status", "--porcelain"], home)
  assert.equal(r.status, 0, `git status could not observe the tree, so its empty output means nothing: ${r.stderr.trim()}`)
  return r.stdout.trim()
}

test("the supervisor spawns its child WITHOUT dirtying committed territory, so the run it launches is never refused for Vivicy's own bytes", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vivicy-supervised-"))
  try {
    const root = join(scratch, "target")
    const runtimeDir = join(scratch, "runtime")
    const gitHome = join(scratch, "git-home")
    mkdirSync(join(root, ".vivicy/development/issues/done"), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(gitHome, { recursive: true })
    writeFileSync(join(root, ".gitignore"), ".vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n")
    writeFileSync(join(root, ".vivicy/development/issue-index.json"), '{ "issues": [] }\n')
    writeFileSync(join(root, "vivicy.json"), '{ "gateCommand": "true" }\n')

    git(root, ["init", "-q"], gitHome)
    git(root, ["config", "user.email", "t@local"], gitHome)
    git(root, ["config", "user.name", "t"], gitHome)
    git(root, ["config", "commit.gpgsign", "false"], gitHome)
    git(root, ["add", "-A"], gitHome)
    git(root, ["commit", "-qm", "initial"], gitHome)
    assert.equal(porcelain(root, gitHome), "", "precondition: the owner's tree is clean")

    // Bounded to a single child launch: one relaunch, then the unchanged done count terminates the loop.
    const supervisor = spawnSync(process.execPath, [join(FACTORY_DIR, "dev-loop-supervised.ts")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, VIVICY_TARGET_ROOT: root, VIVICY_RUNTIME_DIR: runtimeDir, DEV_LOOP_STALL_LIMIT: "1" },
    })

    assert.match(
      supervisor.stdout ?? "",
      /launch #1 of \S+dev-loop\.ts/,
      `the supervisor must actually reach the spawn — otherwise this case proves nothing about its pre-spawn footprint:\n${supervisor.stdout}\n${supervisor.stderr}`
    )
    const dirty = porcelain(root, gitHome)
    assert.equal(dirty, "", `the supervisor left committed territory dirty, so its own child's clean-tree gate refuses the run:\n${dirty}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
