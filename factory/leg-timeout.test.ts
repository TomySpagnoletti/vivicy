// Per-leg timeout tests — fakes only, NO real Claude/Codex CLI.
//
// These guard the resilience fix for the live 5-hour hang: a `codex exec` leg
// stalled internally and the orchestrator awaited it forever because there was no
// per-leg timeout. The leg now runs under a hard wall-clock cap AND a stall/idle
// timeout, enforced by killing the leg's WHOLE process group. Every case here
// uses a fake `node -e` leg so the suite never touches a live agent.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  DEFAULT_LEG_CAP_MS,
  DEFAULT_LEG_IDLE_MS,
  resolveLegTimeout,
  spawnLegAsync,
  spawnLegSync,
} from "./leg-timeout.ts";

// A fake leg = `node -e <code>`. No network, no agent, deterministic timing.
const node = process.execPath;
const legArgs = (code: string) => ["-e", code];

test("resolveLegTimeout: defaults, env override, and explicit options precedence", () => {
  // Defaults when nothing is set.
  const prev = { cap: process.env.VIVICY_LEG_TIMEOUT_MS, idle: process.env.VIVICY_LEG_IDLE_MS };
  delete process.env.VIVICY_LEG_TIMEOUT_MS;
  delete process.env.VIVICY_LEG_IDLE_MS;
  try {
    assert.deepEqual(
      { capMs: resolveLegTimeout().capMs, idleMs: resolveLegTimeout().idleMs },
      { capMs: DEFAULT_LEG_CAP_MS, idleMs: DEFAULT_LEG_IDLE_MS },
    );
    // The generous defaults leave room for legit xhigh-effort work (15-30 min).
    assert.ok(DEFAULT_LEG_CAP_MS >= 30 * 60 * 1000, "hard cap must not be set too low for hard issues");

    // Env override is honored.
    process.env.VIVICY_LEG_TIMEOUT_MS = "123456";
    process.env.VIVICY_LEG_IDLE_MS = "7890";
    assert.equal(resolveLegTimeout().capMs, 123456);
    assert.equal(resolveLegTimeout().idleMs, 7890);

    // Explicit options win over env.
    assert.equal(resolveLegTimeout({ capMs: 5 }).capMs, 5);

    // Garbage env falls back to the default (never NaN/negative).
    process.env.VIVICY_LEG_TIMEOUT_MS = "not-a-number";
    assert.equal(resolveLegTimeout().capMs, DEFAULT_LEG_CAP_MS);
  } finally {
    if (prev.cap === undefined) delete process.env.VIVICY_LEG_TIMEOUT_MS;
    else process.env.VIVICY_LEG_TIMEOUT_MS = prev.cap;
    if (prev.idle === undefined) delete process.env.VIVICY_LEG_IDLE_MS;
    else process.env.VIVICY_LEG_IDLE_MS = prev.idle;
  }
});

test("a leg that finishes just under the cap succeeds normally (no false kill)", () => {
  const res = spawnLegSync(node, legArgs("process.stdout.write('done'); process.exit(0)"), {
    timeout: { capMs: 5000, idleMs: 5000, graceMs: 300 },
  });
  assert.equal(res.status, 0);
  assert.notEqual(res.timedOut, true, "a quick leg must NOT be flagged as timed out");
  assert.match(res.stdout, /done/);
});

test("a non-zero exit under the cap is a normal failure, NOT a timeout", () => {
  const res = spawnLegSync(node, legArgs("process.stderr.write('boom'); process.exit(2)"), {
    timeout: { capMs: 5000, idleMs: 5000, graceMs: 300 },
  });
  assert.equal(res.status, 2, "the real non-zero exit code is preserved");
  assert.notEqual(res.timedOut, true, "an ordinary red exit is not a timeout");
  assert.match(res.stderr, /boom/);
});

test("a leg that sleeps past the hard cap is killed and returns a timeout failure", () => {
  const t0 = Date.now();
  // Emits steadily so the IDLE watchdog never fires — only the hard cap can stop
  // it, proving the cap path specifically.
  const res = spawnLegSync(node, legArgs("setInterval(()=>process.stdout.write('.'),50)"), {
    timeout: { capMs: 700, idleMs: 10_000, graceMs: 300 },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.timedOut, true, "the leg must be reported as timed out");
  assert.match(res.timeoutReason!, /hard cap/);
  assert.notEqual(res.status, 0, "a timed-out leg never reports success");
  assert.ok(elapsed < 5000, `the cap fired promptly (elapsed ${elapsed}ms), it did NOT hang`);
});

test("a leg that goes idle (no output) past the idle timeout is killed", () => {
  const t0 = Date.now();
  // Silent forever: never emits, never exits. Only the IDLE watchdog can stop it.
  const res = spawnLegSync(node, legArgs("setTimeout(()=>{}, 600000)"), {
    timeout: { capMs: 60_000, idleMs: 600, graceMs: 300 },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.timedOut, true);
  assert.match(res.timeoutReason!, /idle/);
  assert.ok(elapsed < 5000, `the idle watchdog fired promptly (elapsed ${elapsed}ms), it did NOT hang`);
});

test("a killed leg leaves NO orphaned child process (whole tree is reaped)", async () => {
  const dir = mkdtempSync(resolve(tmpdir(), "vivicy-orphan-"));
  const marker = resolve(dir, "grand.pid");
  writeFileSync(marker, "");
  try {
    // The fake leg spawns a long-lived GRANDCHILD, records its pid, and pipes the
    // grandchild's steady output up so the leg never goes idle — the leg can only
    // be stopped by the hard cap, and the kill must reach the grandchild's group.
    const legCode = `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const grand = spawn(process.execPath, ['-e', "setInterval(()=>process.stdout.write('g'),50)"], { stdio: ['ignore','pipe','ignore'] });
      fs.writeFileSync(${JSON.stringify(marker)}, String(grand.pid));
      grand.stdout.on('data', (c) => process.stdout.write(c));
      setInterval(() => {}, 1000);
    `;
    const res = spawnLegSync(node, legArgs(legCode), { timeout: { capMs: 800, idleMs: 10_000, graceMs: 300 } });
    assert.equal(res.timedOut, true, "the leg should have been killed by the cap");

    const grandPid = Number(readFileSync(marker, "utf8").trim());
    assert.ok(Number.isInteger(grandPid) && grandPid > 0, "the grandchild recorded its pid");

    // After the SIGKILL grace, the grandchild must be gone. process.kill(pid, 0)
    // throws ESRCH when the process no longer exists.
    await new Promise((r) => setTimeout(r, 700));
    let alive = true;
    try {
      process.kill(grandPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, false, "the grandchild must be reaped — no orphaned process tree");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("async leg: normal finish under the cap is not killed", async () => {
  const res = await spawnLegAsync(node, legArgs("process.stdout.write('async'); process.exit(0)"), {
    timeout: { capMs: 5000, idleMs: 5000, graceMs: 300 },
  });
  assert.equal(res.status, 0);
  assert.notEqual(res.timedOut, true);
  assert.match(res.stdout, /async/);
});

test("async leg: a stalled leg is killed and returns a timeout failure (never hangs)", async () => {
  const t0 = Date.now();
  const res = await spawnLegAsync(node, legArgs("setTimeout(()=>{}, 600000)"), {
    timeout: { capMs: 700, idleMs: 600, graceMs: 300 },
  });
  const elapsed = Date.now() - t0;
  assert.equal(res.timedOut, true);
  assert.ok(/idle|hard cap/.test(res.timeoutReason!));
  assert.ok(elapsed < 5000, `async timeout fired promptly (elapsed ${elapsed}ms)`);
});
