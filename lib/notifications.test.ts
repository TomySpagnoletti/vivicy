import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  appendNotification,
  dismissNotifications,
  getNotificationsPath,
  readNotifications,
} from "@/lib/notifications"

let runtimeDir: string
let prevRuntimeEnv: string | undefined

beforeEach(() => {
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-notif-"))
  prevRuntimeEnv = process.env.VIVICY_RUNTIME_DIR
  process.env.VIVICY_RUNTIME_DIR = runtimeDir
})

afterEach(() => {
  rmSync(runtimeDir, { recursive: true, force: true })
  if (prevRuntimeEnv === undefined) delete process.env.VIVICY_RUNTIME_DIR
  else process.env.VIVICY_RUNTIME_DIR = prevRuntimeEnv
})

describe("readNotifications (shared read contract)", () => {
  it("returns [] when the log is missing", () => {
    expect(readNotifications()).toEqual([])
  })

  it("returns [] when the log is empty", () => {
    writeFileSync(getNotificationsPath(), "")
    expect(readNotifications()).toEqual([])
  })

  it("reads well-formed lines oldest-first and skips malformed/blank ones", () => {
    writeFileSync(
      getNotificationsPath(),
      [
        JSON.stringify({ ts: "2026-07-02T10:00:00Z", level: "info", stage: "extract", event: "green", message: "done" }),
        "",
        "not json — a partial write",
        JSON.stringify({ ts: "2026-07-02T10:05:00Z", level: "warn", stage: "dev", event: "stall", message: "idle", dismissed: false }),
      ].join("\n")
    )

    const rows = readNotifications()
    expect(rows).toHaveLength(2)
    expect(rows[0].event).toBe("green")
    expect(rows[1]).toEqual({
      ts: "2026-07-02T10:05:00Z",
      level: "warn",
      stage: "dev",
      event: "stall",
      message: "idle",
      dismissed: false,
    })
  })
})

describe("appendNotification (writer)", () => {
  it("creates the runtime dir and log on the first call, stamping id + ts", () => {
    const before = Date.now()
    const written = appendNotification({
      level: "info",
      stage: "extract",
      event: "started",
      message: "extraction started",
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
      level: "info",
      stage: "extract",
      event: "started",
      message: "extraction started",
    })
  })

  it("appends without disturbing prior lines (one line per call, oldest first)", () => {
    appendNotification({ level: "info", stage: "extract", event: "started", message: "a" })
    appendNotification({ level: "info", stage: "extract", event: "green", message: "b" })
    appendNotification({ level: "error", stage: "dev", event: "stopped", message: "c" })

    const rows = readNotifications()
    expect(rows.map((r) => r.message)).toEqual(["a", "b", "c"])
    const raw = readFileSync(getNotificationsPath(), "utf8")
    expect(raw.endsWith("\n")).toBe(true)
    expect(raw.split("\n").filter((l) => l.trim().length > 0)).toHaveLength(3)
  })

  it("same-instant appends get distinct ids — ts may collide, identity never does", () => {
    const first = appendNotification({ level: "info", stage: "extract", event: "started", message: "a" })
    const second = appendNotification({ level: "error", stage: "extract", event: "failed", message: "b" })

    expect(first.id).not.toBe(second.id)
  })
})

describe("dismissNotifications (dismissal mechanism: rewrite dismissed in place, keyed on id)", () => {
  it("flips dismissed:true on the referenced id and leaves the rest untouched", () => {
    const first = appendNotification({ level: "info", stage: "extract", event: "started", message: "a" })
    const second = appendNotification({ level: "info", stage: "extract", event: "green", message: "b" })

    const changed = dismissNotifications([first.id as string])
    expect(changed).toBe(1)

    const rows = readNotifications()
    expect(rows.find((r) => r.id === first.id)?.dismissed).toBe(true)
    expect(rows.find((r) => r.id === second.id)?.dismissed).toBeUndefined()
  })

  it("dismisses exactly one of two rows sharing the same ts (the cross-process same-ms case)", () => {
    writeFileSync(
      getNotificationsPath(),
      [
        JSON.stringify({ id: "aaa-1", ts: "2026-07-03T10:00:00.000Z", level: "info", stage: "extract", event: "started", message: "twin A" }),
        JSON.stringify({ id: "bbb-2", ts: "2026-07-03T10:00:00.000Z", level: "info", stage: "dev", event: "started", message: "twin B" }),
      ].join("\n") + "\n"
    )

    expect(dismissNotifications(["bbb-2"])).toBe(1)

    const rows = readNotifications()
    expect(rows.find((r) => r.id === "aaa-1")?.dismissed).toBeUndefined()
    expect(rows.find((r) => r.id === "bbb-2")?.dismissed).toBe(true)
  })

  it("falls back to ts matching for a legacy line that predates the id field", () => {
    writeFileSync(
      getNotificationsPath(),
      `${JSON.stringify({ ts: "2026-07-02T10:00:00Z", level: "info", stage: "extract", event: "green", message: "legacy" })}\n`
    )

    expect(dismissNotifications(["2026-07-02T10:00:00Z"])).toBe(1)
    expect(readNotifications()[0].dismissed).toBe(true)
  })

  it("clears all when no refs are given (the sidebar 'clear all')", () => {
    appendNotification({ level: "info", stage: "extract", event: "started", message: "a" })
    appendNotification({ level: "info", stage: "extract", event: "green", message: "b" })

    const changed = dismissNotifications()
    expect(changed).toBe(2)
    expect(readNotifications().every((r) => r.dismissed === true)).toBe(true)
  })

  it("is a no-op on an unknown id or an already-dismissed one (idempotent)", () => {
    const first = appendNotification({ level: "info", stage: "extract", event: "started", message: "a" })
    dismissNotifications([first.id as string])

    expect(dismissNotifications([first.id as string])).toBe(0)
    expect(dismissNotifications(["not-a-real-id"])).toBe(0)
    expect(readNotifications()).toHaveLength(1)
  })

  it("is a no-op when the log does not exist yet", () => {
    expect(dismissNotifications(["anything"])).toBe(0)
    expect(readNotifications()).toEqual([])
  })

  it("round-trips through readNotifications exactly like a fresh append (writer/reader agree)", () => {
    const written = appendNotification({
      level: "warn",
      stage: "dev",
      event: "stall",
      message: "idle 90s",
    })
    dismissNotifications([written.id as string])

    const [row] = readNotifications()
    expect(row).toEqual({ ...written, dismissed: true })
  })
})
