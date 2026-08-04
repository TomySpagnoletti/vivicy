import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { appendNotification, dismissNotifications, getNotificationsPath, readNotifications } from "@/lib/notifications"

let targetRoot: string
let appCwd: string
let prevRuntimeEnv: string | undefined
let prevTargetEnv: string | undefined
let prevCwd: string

// The log path must come from the TARGET, so the harness leaves VIVICY_RUNTIME_DIR unset and only isolates the cwd the app-side store still reads.
beforeEach(() => {
  targetRoot = mkdtempSync(path.join(tmpdir(), "vivicy-notif-target-"))
  appCwd = mkdtempSync(path.join(tmpdir(), "vivicy-notif-cwd-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  prevTargetEnv = process.env.VIVICY_TARGET_ROOT
  prevCwd = process.cwd()
  delete process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_TARGET_ROOT = targetRoot
  process.chdir(appCwd)
})

afterEach(() => {
  process.chdir(prevCwd)
  for (const dir of [targetRoot, appCwd]) rmSync(dir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
  if (prevTargetEnv === undefined) delete process.env.VIVICY_TARGET_ROOT
  else process.env.VIVICY_TARGET_ROOT = prevTargetEnv
})

function logPath(): string {
  const file = getNotificationsPath()
  if (file === null) throw new Error("no notifications path")
  mkdirSync(path.dirname(file), { recursive: true })
  return file
}

function write(input: Parameters<typeof appendNotification>[0]) {
  const written = appendNotification(input)
  if (written === null) throw new Error("notification was not written")
  return written
}

describe("the log lives with the project", () => {
  it("writes under the target's own runtime dir, and makes that dir ignore itself", () => {
    write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    expect(getNotificationsPath()).toBe(path.join(targetRoot, ".vivicy", "runtime", "notifications.jsonl"))
    expect(readFileSync(path.join(targetRoot, ".vivicy", "runtime", ".gitignore"), "utf8")).toBe("*\n")
    expect(readdirSync(appCwd)).toEqual([])
  })

  it("has no log at all when no project is selected: reads are empty and the append is a no-op", () => {
    delete process.env.VIVICY_TARGET_ROOT
    expect(getNotificationsPath()).toBeNull()
    expect(readNotifications()).toEqual([])
    expect(appendNotification({ level: "error", stage: "extract", event: "blocked", message: "a" })).toBeNull()
    expect(dismissNotifications()).toBe(0)
  })
})

describe("readNotifications (shared read contract)", () => {
  it("returns [] when the log is missing", () => {
    expect(readNotifications()).toEqual([])
  })

  it("returns [] when the log is empty", () => {
    writeFileSync(logPath(), "")
    expect(readNotifications()).toEqual([])
  })

  it("reads well-formed lines oldest-first and skips malformed/blank ones", () => {
    writeFileSync(
      logPath(),
      [
        JSON.stringify({
          id: "aaa-1",
          ts: "2026-07-02T10:00:00Z",
          level: "error",
          stage: "extract",
          event: "blocked",
          message: "still red",
        }),
        "",
        "not json — a partial write",
        JSON.stringify({
          id: "bbb-2",
          ts: "2026-07-02T10:05:00Z",
          level: "warning",
          stage: "S9",
          event: "gate_failed",
          message: "idle",
          dismissed: false,
        }),
      ].join("\n")
    )

    const rows = readNotifications()
    expect(rows).toHaveLength(2)
    expect(rows[0].event).toBe("blocked")
    expect(rows[1]).toEqual({
      id: "bbb-2",
      ts: "2026-07-02T10:05:00Z",
      level: "warning",
      stage: "S9",
      event: "gate_failed",
      message: "idle",
      dismissed: false,
    })
  })
})

describe("appendNotification (writer)", () => {
  it("creates the runtime dir and log on the first call, stamping id + ts", () => {
    const before = Date.now()
    const written = write({
      level: "error",
      stage: "extract",
      event: "blocked",
      message: "extraction blocked after bounded retries",
    })
    const after = Date.now()

    expect(written.id).toBeDefined()
    expect(written.ts).toBeDefined()
    expect(Date.parse(written.ts as string)).toBeGreaterThanOrEqual(before)
    expect(Date.parse(written.ts as string)).toBeLessThanOrEqual(after)

    const rows = readNotifications()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      id: written.id,
      ts: written.ts,
      level: "error",
      stage: "extract",
      event: "blocked",
      message: "extraction blocked after bounded retries",
    })
  })

  it("appends without disturbing prior lines (one line per call, oldest first)", () => {
    write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    write({ level: "error", stage: "extract", event: "failed", message: "b" })
    write({ level: "error", stage: "S9", event: "issue_blocked", message: "c", params: { id: "ISSUE-0003" } })

    const rows = readNotifications()
    expect(rows.map((r) => r.message)).toEqual(["a", "b", "c"])
    const raw = readFileSync(logPath(), "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(3)
  })

  it("same-instant appends get distinct ids — ts may collide, identity never does", () => {
    const first = write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    const second = write({ level: "error", stage: "extract", event: "failed", message: "b" })

    expect(first.id).not.toBe(second.id)
  })
})

describe("dismissNotifications (dismissal mechanism: rewrite dismissed in place, keyed on id)", () => {
  it("flips dismissed:true on the referenced id and leaves the rest untouched", () => {
    const first = write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    const second = write({ level: "error", stage: "extract", event: "failed", message: "b" })

    const changed = dismissNotifications([first.id])
    expect(changed).toBe(1)

    const rows = readNotifications()
    expect(rows.find((r) => r.id === first.id)?.dismissed).toBe(true)
    expect(rows.find((r) => r.id === second.id)?.dismissed).toBeUndefined()
  })

  it("dismisses exactly one of two rows sharing the same ts (the cross-process same-ms case)", () => {
    writeFileSync(
      logPath(),
      [
        JSON.stringify({
          id: "aaa-1",
          ts: "2026-07-03T10:00:00.000Z",
          level: "error",
          stage: "extract",
          event: "blocked",
          message: "twin A",
        }),
        JSON.stringify({
          id: "bbb-2",
          ts: "2026-07-03T10:00:00.000Z",
          level: "warning",
          stage: "S9",
          event: "gate_failed",
          message: "twin B",
        }),
      ].join("\n") + "\n"
    )

    expect(dismissNotifications(["bbb-2"])).toBe(1)

    const rows = readNotifications()
    expect(rows.find((r) => r.id === "aaa-1")?.dismissed).toBeUndefined()
    expect(rows.find((r) => r.id === "bbb-2")?.dismissed).toBe(true)
  })

  it("clears all when no refs are given (the sidebar 'clear all')", () => {
    write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    write({ level: "error", stage: "extract", event: "failed", message: "b" })

    const changed = dismissNotifications()
    expect(changed).toBe(2)
    expect(readNotifications().every((r) => r.dismissed === true)).toBe(true)
  })

  it("is a no-op on an unknown id or an already-dismissed one (idempotent)", () => {
    const first = write({ level: "error", stage: "extract", event: "blocked", message: "a" })
    dismissNotifications([first.id])

    expect(dismissNotifications([first.id])).toBe(0)
    expect(dismissNotifications(["not-a-real-id"])).toBe(0)
    expect(readNotifications()).toHaveLength(1)
  })

  it("is a no-op when the log does not exist yet", () => {
    expect(dismissNotifications(["anything"])).toBe(0)
    expect(readNotifications()).toEqual([])
  })

  it("round-trips through readNotifications exactly like a fresh append (writer/reader agree)", () => {
    const written = write({
      level: "warning",
      stage: "S9",
      event: "gate_failed",
      message: "ISSUE-0007: gate red",
      params: { id: "ISSUE-0007" },
    })
    dismissNotifications([written.id])

    const [row] = readNotifications()
    expect(row).toEqual({ ...written, dismissed: true })
  })
})
