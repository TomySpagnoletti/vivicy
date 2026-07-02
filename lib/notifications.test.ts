import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { getNotificationsPath, readNotifications } from "@/lib/notifications"

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

describe("readNotifications (G14 read contract)", () => {
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
