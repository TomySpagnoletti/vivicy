import assert from "node:assert/strict"
import test from "node:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { cleanupTree } from "./cleanup-tree.ts"
import { sleepSync } from "./sleep-sync.ts"

const FACTORY_DIR = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(FACTORY_DIR, "..")
const MODULE_URL = pathToFileURL(join(FACTORY_DIR, "cleanup-tree.ts")).href

// The writer must be its OWN process: a write from inside this process could never race a synchronous removal. Names and directories cycle over a BOUNDED set (unbounded ones grow the tree by ~100k files per second of race) but the set is wide on purpose: a remover only loses the race if entries reappear between its walk and its rmdir, so the tree must take long enough to walk that the writer cannot possibly stay idle across it.
const WRITER_SOURCE = `const { mkdirSync, writeFileSync } = require("node:fs");
const dir = process.argv[1];
const until = Number(process.argv[2]);
let i = 0;
while (Date.now() < until) {
  const deep = dir + "/late/" + (i % 200) + "/deep";
  try {
    mkdirSync(deep, { recursive: true });
    writeFileSync(deep + "/" + (i % 25) + ".tmp", "late write");
  } catch {}
  i += 1;
}
`

// Hosts one obstruction per mode, lets cleanupTree fail against it, then clears it and exits: the announcements and the exit drain only exist in another process's stderr, since they are written with writeSync(2) that no in-process stub can intercept.
const HOST_SOURCE = `const { spawn } = require("node:child_process");
const { chmodSync, existsSync, mkdirSync, writeFileSync } = require("node:fs");
const [mode, target, moduleUrl, writerSource] = process.argv.slice(1);
const bounded = { attempts: 2, backoffStepMs: 5 };
(async () => {
  const { cleanupTree } = await import(moduleUrl);
  let removed;
  if (mode === "racing") {
    const writer = spawn(process.execPath, ["-e", writerSource, target, String(Date.now() + 60000)], { stdio: "ignore" });
    const deadline = Date.now() + 5000;
    while (!existsSync(target + "/late") && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    removed = cleanupTree(target, bounded);
    writer.kill("SIGKILL");
    await new Promise((r) => writer.once("exit", r));
  } else if (mode === "undeletable-subdir") {
    mkdirSync(target + "/blocked/inner", { recursive: true });
    writeFileSync(target + "/blocked/inner/f.txt", "x");
    chmodSync(target + "/blocked", 0o500);
    removed = cleanupTree(target, bounded);
    chmodSync(target + "/blocked", 0o700);
  } else if (mode === "denied") {
    mkdirSync(target + "/child/inner", { recursive: true });
    writeFileSync(target + "/child/inner/f.txt", "x");
    chmodSync(target, 0o500);
    removed = cleanupTree(target + "/child", bounded);
    chmodSync(target, 0o700);
  } else {
    removed = cleanupTree(42);
  }
  if (removed !== false) {
    process.stderr.write("host: cleanupTree unexpectedly reported success in mode " + mode + "\\n");
    process.exitCode = 3;
  }
})();
`

function seededTree(prefix: string): string {
  const root = mkdtempSync(resolve(tmpdir(), prefix))
  for (let i = 0; i < 40; i += 1) {
    const deep = join(root, "seed", String(i % 5), "deep")
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, `${i}.txt`), "seed")
  }
  return root
}

function startRacingWriter(dir: string, lifetimeMs: number): ChildProcess {
  const writer = spawn(process.execPath, ["-e", WRITER_SOURCE, dir, String(Date.now() + lifetimeMs)], { stdio: "ignore" })
  const deadline = Date.now() + 5000
  while (!existsSync(join(dir, "late")) && Date.now() < deadline) sleepSync(2)
  assert.ok(existsSync(join(dir, "late")), "the racing writer is writing into the tree")
  return writer
}

function reap(writer: ChildProcess): Promise<void> {
  if (writer.exitCode !== null || writer.signalCode !== null) return Promise.resolve()
  writer.kill("SIGKILL")
  return new Promise((done) => writer.once("exit", () => done()))
}

function collect(child: ChildProcess): Promise<{ status: number | null; stderr: string }> {
  let stderr = ""
  child.stderr?.setEncoding("utf8")
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk
  })
  return new Promise((done) => child.once("close", (status) => done({ status, stderr })))
}

function runHost(mode: string, target: string): Promise<{ status: number | null; stderr: string }> {
  return collect(
    spawn(process.execPath, ["-e", HOST_SOURCE, mode, target, MODULE_URL, WRITER_SOURCE], {
      stdio: ["ignore", "ignore", "pipe"],
    })
  )
}

test("removes a populated tree and reports success", () => {
  const root = seededTree("cleanup-tree-test-plain-")
  try {
    assert.equal(cleanupTree(root), true)
    assert.ok(!existsSync(root), "the tree is gone")
  } finally {
    cleanupTree(root)
  }
})

test("an absent path and an already-removed tree are both successes (replaying the cleanup is safe)", () => {
  const root = seededTree("cleanup-tree-test-idempotent-")
  try {
    assert.equal(cleanupTree(root), true)
    assert.equal(cleanupTree(root), true, "removing the same tree again still reports success")
    assert.equal(cleanupTree(join(root, "never-existed")), true, "a path that never existed is a no-op success")
  } finally {
    cleanupTree(root)
  }
})

test("a single-shot removal loses the race a bounded retry wins: ENOTEMPTY while the writer runs, converged once it stops", async () => {
  const root = seededTree("cleanup-tree-test-race-")
  const writer = startRacingWriter(root, 500)
  try {
    assert.throws(
      () => rmSync(root, { recursive: true, force: true }),
      { code: "ENOTEMPTY" },
      "the un-hardened one-shot removal fails on the late writes"
    )

    assert.equal(cleanupTree(root), true, "the bounded retry converges once the writer stops")
    assert.ok(!existsSync(root), "nothing is left of the tree")
  } finally {
    await reap(writer)
    cleanupTree(root)
  }
})

test("a writer that outlives every attempt leaves the tree standing and never throws", async () => {
  const root = seededTree("cleanup-tree-test-stuck-")
  const writer = startRacingWriter(root, 60_000)
  try {
    assert.equal(cleanupTree(root, { attempts: 2, backoffStepMs: 5 }), false, "the caller is told the tree survived")
    assert.ok(existsSync(root), "the tree is kept, not half-reported as gone")
  } finally {
    await reap(writer)
    cleanupTree(root)
  }
})

test("a tree a writer keeps racing is announced with its path and removed at exit, once the writer is reaped", async () => {
  const root = seededTree("cleanup-tree-test-drain-")
  try {
    const { status, stderr } = await runHost("racing", root)

    assert.equal(status, 0, `host process failed: ${stderr}`)
    assert.match(stderr, /survived 2 removal attempts \(ENOTEMPTY — entries keep reappearing or resist removal/, stderr)
    assert.match(stderr, /up to 3 more attempts at exit/, "the promise states the exact number of exit attempts")
    assert.ok(stderr.includes(root), `the announcement names the tree: ${stderr}`)
    assert.match(stderr, new RegExp(`removed at exit: ${root}`), stderr)
    assert.ok(!existsSync(root), "the exit drain removed the tree once the writer was reaped")
  } finally {
    cleanupTree(root)
  }
})

test("an obstruction that is no writer at all (a subdirectory whose permissions deny removal) reports the same ENOTEMPTY with both causes named, and converges at exit once it clears", async () => {
  const root = seededTree("cleanup-tree-test-subdir-")
  try {
    const { status, stderr } = await runHost("undeletable-subdir", root)

    assert.equal(status, 0, `host process failed: ${stderr}`)
    assert.match(
      stderr,
      /\(ENOTEMPTY — entries keep reappearing or resist removal — a live writer, or a subdirectory that denies removal\)/,
      stderr
    )
    assert.match(stderr, new RegExp(`removed at exit: ${root}`), "clearing the permission lets the exit drain converge")
    assert.ok(!existsSync(root), "the tree is gone after the drain")
  } finally {
    cleanupTree(root)
  }
})

test("a target whose parent denies removal reports the permissions reason, never a racing writer", async () => {
  const root = seededTree("cleanup-tree-test-denied-")
  try {
    const { status, stderr } = await runHost("denied", root)

    assert.equal(status, 0, `host process failed: ${stderr}`)
    assert.match(stderr, /\(EACCES — the filesystem or its permissions deny removal\)/, stderr)
    assert.ok(!/a live writer/.test(stderr), `no writer is claimed for a permission failure: ${stderr}`)
  } finally {
    cleanupTree(root)
  }
})

test("a failure nothing can retry (a path that is not a string) is announced once, promises no exit retry, and still never throws", async () => {
  assert.equal(cleanupTree(42 as unknown as string), false, "a type violation degrades to false, never a throw")

  const root = seededTree("cleanup-tree-test-invalid-")
  try {
    const { status, stderr } = await runHost("non-retryable", root)

    assert.equal(status, 0, `host process failed: ${stderr}`)
    assert.match(stderr, /was not removed after 1 removal attempt \(ERR_INVALID_ARG_TYPE\); nothing further will retry it/, stderr)
    assert.ok(!/at exit/.test(stderr), `no exit-retry promise for a non-transient failure: ${stderr}`)
    assert.ok(!/a live writer/.test(stderr), `no racing-writer claim for a non-transient failure: ${stderr}`)
  } finally {
    cleanupTree(root)
  }
})

// The artifact wrapper (npm test / npm run e2e) removes trees the just-exited webServer and its children may still be flushing into; the real script bytes run against a temp repo root, so the exit-code contract is proven rather than asserted. The obstruction here is a permission-blocked subdirectory rather than a live writer — the wrapper's contract does not depend on WHY a tree resists, and this way the case is deterministic instead of racing.
test("the artifact wrapper preserves the wrapped command's exit code when an artifact tree cannot be removed, and keeps cleaning past it", async () => {
  const repo = mkdtempSync(resolve(tmpdir(), "cleanup-tree-test-wrapper-"))
  const blocked = join(repo, "test-results", "blocked")
  try {
    for (const dir of ["scripts", "factory", "lib"]) mkdirSync(join(repo, dir), { recursive: true })
    copyFileSync(join(REPO_ROOT, "scripts", "clean-artifacts.ts"), join(repo, "scripts", "clean-artifacts.ts"))
    copyFileSync(join(REPO_ROOT, "lib", "count-form.ts"), join(repo, "lib", "count-form.ts"))
    for (const file of ["cleanup-tree.ts", "sleep-sync.ts"]) copyFileSync(join(FACTORY_DIR, file), join(repo, "factory", file))
    writeFileSync(
      join(repo, "tsconfig.json"),
      `${JSON.stringify({ include: ["**/*.ts", ".next-e2e-stale-chromium-desktop/types/**/*.ts"] }, null, 2)}\n`
    )
    const artifacts = join(repo, "test-results")
    mkdirSync(join(artifacts, "deep"), { recursive: true })
    writeFileSync(join(artifacts, "deep", "trace.zip"), "trace")
    mkdirSync(join(blocked, "inner"), { recursive: true })
    writeFileSync(join(blocked, "inner", "held.txt"), "held")
    chmodSync(blocked, 0o500)

    const { status, stderr } = await collect(
      spawn(process.execPath, [join(repo, "scripts", "clean-artifacts.ts"), "--", process.execPath, "-e", "process.exit(7)"], {
        cwd: repo,
        stdio: ["ignore", "ignore", "pipe"],
      })
    )

    assert.equal(status, 7, `the wrapped command's exit code must survive an unremovable artifact tree; stderr: ${stderr}`)
    assert.ok(!/^\s+at /m.test(stderr), `the wrapper must not crash: ${stderr}`)
    assert.match(stderr, /\[cleanup\].*test-results.*ENOTEMPTY/, stderr)
    assert.match(stderr, /LEAKED .*test-results.*delete it by hand/, "a tree that truly survives is named as leaked")
    assert.ok(existsSync(artifacts), "the announced leftover is left in place, never silently reported gone")
    assert.deepEqual(
      (JSON.parse(readFileSync(join(repo, "tsconfig.json"), "utf8")) as { include: string[] }).include,
      ["**/*.ts"],
      "the rest of the cleanup still ran: the stale dist include was pruned"
    )
  } finally {
    if (existsSync(blocked)) chmodSync(blocked, 0o700)
    cleanupTree(repo)
  }
})
