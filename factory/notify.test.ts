import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { notify } from "./notify.ts";

test("notify is a strict no-op without a runtime dir", () => {
  const prev = process.env.VIVICY_RUNTIME_DIR;
  delete process.env.VIVICY_RUNTIME_DIR;
  try {
    assert.equal(notify({ level: "info", stage: "S9", event: "gate_passed", message: "x" }), false);
  } finally {
    if (prev !== undefined) process.env.VIVICY_RUNTIME_DIR = prev;
  }
});

test("notify appends the contract shape with unique ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "vivicy-notify-"));
  try {
    assert.equal(notify({ level: "success", stage: "S9", event: "gate_passed", message: "ISS-0001: gate green" }, { runtimeDir: dir }), true);
    assert.equal(notify({ level: "error", stage: "S10", event: "post_merge_gate_failed", message: "ISS-0002: reverted" }, { runtimeDir: dir, now: () => Date.now() }), true);
    const lines = readFileSync(join(dir, "notifications.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    for (const row of lines) {
      assert.ok(row.id && row.ts && row.level && row.stage && row.event && row.message);
    }
    assert.notEqual(lines[0].id, lines[1].id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("notify never throws on an unwritable dir", () => {
  assert.equal(notify({ level: "info", stage: "S9", event: "x", message: "x" }, { runtimeDir: "/dev/null/nope" }), false);
});
