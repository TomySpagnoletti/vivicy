import assert from "node:assert/strict"
import test from "node:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { notify } from "./notify.ts"

test("notify is a strict no-op without a runtime dir", () => {
  const prev = process.env.VIVICY_RUNTIME_DIR
  delete process.env.VIVICY_RUNTIME_DIR
  try {
    assert.equal(notify({ level: "warning", stage: "S9", event: "gate_failed", message: "x", params: { id: "ISSUE-0001" } }), false)
  } finally {
    if (prev !== undefined) process.env.VIVICY_RUNTIME_DIR = prev
  }
})

test("notify appends the contract shape with unique ids, carrying the params the catalogue interpolates", () => {
  const dir = mkdtempSync(join(tmpdir(), "vivicy-notify-"))
  try {
    assert.equal(
      notify(
        { level: "warning", stage: "S9", event: "gate_failed", message: "ISSUE-0001: gate red", params: { id: "ISSUE-0001" } },
        { runtimeDir: dir }
      ),
      true
    )
    assert.equal(
      notify(
        { level: "error", stage: "S12", event: "run_blocked", message: "build halted — 1 issue blocked" },
        { runtimeDir: dir, now: () => Date.now() }
      ),
      true
    )
    const lines = readFileSync(join(dir, "notifications.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    for (const row of lines) {
      assert.ok(row.id && row.ts && row.level && row.stage && row.event && row.message)
    }
    assert.deepEqual(lines[0].params, { id: "ISSUE-0001" })
    assert.equal("params" in lines[1], false, "an untranslated event carries no params key at all")
    assert.notEqual(lines[0].id, lines[1].id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("notify never throws on an unwritable dir", () => {
  assert.equal(notify({ level: "info", stage: "SP", event: "language_unresolved", message: "x" }, { runtimeDir: "/dev/null/nope" }), false)
})
