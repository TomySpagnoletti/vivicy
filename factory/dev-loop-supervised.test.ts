import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { hashBundle } from "./skill-pin.ts"
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
    assert.doesNotMatch(
      supervisor.stdout ?? "",
      /verifying the pinned project skills/,
      "a project that pins nothing spawns no verification child at all"
    )
    const dirty = porcelain(root, gitHome)
    assert.equal(dirty, "", `the supervisor left committed territory dirty, so its own child's clean-tree gate refuses the run:\n${dirty}`)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// The wiring, end to end and with no leg in sight: every start verifies the bundles vivicy.json pins, restores what drifted, and reaches the dev loop anyway. The cache is deliberately absent, so the restore comes from the repository's own history — the cold-clone shape.
test("every supervisor start verifies the pinned skills and restores a drifted bundle before launching the loop", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vivicy-supervised-skills-"))
  try {
    const root = join(scratch, "target")
    const runtimeDir = join(scratch, "runtime")
    const gitHome = join(scratch, "git-home")
    const bundle = join(root, ".agents/skills/spreadsheets")
    mkdirSync(join(root, ".vivicy/development/issues/done"), { recursive: true })
    mkdirSync(join(bundle, "scripts"), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(gitHome, { recursive: true })
    writeFileSync(join(root, ".gitignore"), ".vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n")
    writeFileSync(join(root, ".vivicy/development/issue-index.json"), '{ "issues": [] }\n')
    writeFileSync(join(bundle, "SKILL.md"), "---\nname: spreadsheets\n---\n")
    const pinnedScript = "print('recalc')\n"
    writeFileSync(join(bundle, "scripts/recalc.py"), pinnedScript)
    const pin = hashBundle(bundle)
    assert.ok(pin)
    writeFileSync(
      join(root, "vivicy.json"),
      `${JSON.stringify({ gateCommand: "true", skills: [{ id: "acme/pack@spreadsheets", ...pin }] }, null, 2)}\n`
    )

    git(root, ["init", "-q"], gitHome)
    git(root, ["config", "user.email", "t@local"], gitHome)
    git(root, ["config", "user.name", "t"], gitHome)
    git(root, ["config", "commit.gpgsign", "false"], gitHome)
    git(root, ["add", "-A"], gitHome)
    git(root, ["commit", "-qm", "initial"], gitHome)
    assert.equal(porcelain(root, gitHome), "", "precondition: the owner's tree is clean")

    writeFileSync(join(bundle, "scripts/recalc.py"), "print('tampered')\n")

    const supervisor = spawnSync(process.execPath, [join(FACTORY_DIR, "dev-loop-supervised.ts")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: gitHome,
        XDG_CONFIG_HOME: gitHome,
        VIVICY_TARGET_ROOT: root,
        VIVICY_RUNTIME_DIR: runtimeDir,
        DEV_LOOP_STALL_LIMIT: "1",
      },
    })

    assert.match(
      supervisor.stdout ?? "",
      /verifying the pinned project skills/,
      `the maintenance pass must run at the start:\n${supervisor.stdout}\n${supervisor.stderr}`
    )
    assert.match(supervisor.stdout ?? "", /launch #1 of \S+dev-loop\.ts/, "and the loop still launches after it")
    assert.equal(readFileSync(join(bundle, "scripts/recalc.py"), "utf8"), pinnedScript, "the drifted bundle is back to the pinned bytes")
    assert.equal(porcelain(root, gitHome), "", "and the restore is absorbed, so the child's clean-tree gate still passes")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// The zero-human law at the seam: a pinned bundle no rung can reproduce leaves the supervisor announcing it and launching the loop anyway — degraded, never a dead stop. The re-fetch rung is shimmed off the network by a fake `npx` on PATH.
test("a pinned bundle the supervisor cannot restore is a loud line, never a stop", () => {
  const scratch = mkdtempSync(join(tmpdir(), "vivicy-supervised-unhealable-"))
  try {
    const root = join(scratch, "target")
    const runtimeDir = join(scratch, "runtime")
    const gitHome = join(scratch, "git-home")
    const shim = join(scratch, "bin")
    const bundle = join(root, ".agents/skills/spreadsheets")
    mkdirSync(join(root, ".vivicy/development/issues/done"), { recursive: true })
    mkdirSync(join(bundle, "scripts"), { recursive: true })
    mkdirSync(runtimeDir, { recursive: true })
    mkdirSync(gitHome, { recursive: true })
    mkdirSync(shim, { recursive: true })
    writeFileSync(join(shim, "npx"), "#!/bin/sh\necho 'error: 404 no such skill' >&2\nexit 1\n")
    chmodSync(join(shim, "npx"), 0o755)
    writeFileSync(join(root, ".gitignore"), ".vivicy-runtime/\n.vivicy-worktrees/\n.vivicy/development/transcripts/\n")
    writeFileSync(join(root, ".vivicy/development/issue-index.json"), '{ "issues": [] }\n')
    writeFileSync(join(bundle, "SKILL.md"), "---\nname: spreadsheets\n---\n")
    writeFileSync(join(bundle, "scripts/recalc.py"), "print('recalc')\n")
    const pin = hashBundle(bundle)
    assert.ok(pin)
    writeFileSync(
      join(root, "vivicy.json"),
      `${JSON.stringify({ gateCommand: "true", skills: [{ id: "acme/pack@spreadsheets", ...pin }] }, null, 2)}\n`
    )

    git(root, ["init", "-q"], gitHome)
    git(root, ["config", "user.email", "t@local"], gitHome)
    git(root, ["config", "user.name", "t"], gitHome)
    git(root, ["config", "commit.gpgsign", "false"], gitHome)
    git(root, ["add", "-A"], gitHome)
    git(root, ["commit", "-qm", "initial"], gitHome)
    // Nothing left to restore FROM: the bundle is gone from the working tree and from history, and the cache never existed.
    rmSync(bundle, { recursive: true, force: true })
    git(root, ["rm", "-r", "-q", "--cached", ".agents/skills/spreadsheets"], gitHome)
    git(root, ["commit", "-qm", "someone: drop the bundle"], gitHome)
    assert.equal(porcelain(root, gitHome), "", "precondition: the owner's tree is clean")

    const supervisor = spawnSync(process.execPath, [join(FACTORY_DIR, "dev-loop-supervised.ts")], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${shim}:${process.env.PATH ?? ""}`,
        HOME: gitHome,
        XDG_CONFIG_HOME: gitHome,
        VIVICY_TARGET_ROOT: root,
        VIVICY_RUNTIME_DIR: runtimeDir,
        DEV_LOOP_STALL_LIMIT: "1",
      },
    })

    assert.match(supervisor.stdout ?? "", /verifying the pinned project skills/)
    assert.match(
      supervisor.stdout ?? "",
      /a pinned skill bundle could not be restored \(non-fatal, retried on next start\); the dev loop proceeds without it/,
      `the loud line is what the owner sees:\n${supervisor.stdout}\n${supervisor.stderr}`
    )
    assert.match(supervisor.stdout ?? "", /launch #1 of \S+dev-loop\.ts/, "and the build still runs — degraded, never a dead stop")
    assert.equal(porcelain(root, gitHome), "", "the failed pass still leaves the tree the child needs")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
