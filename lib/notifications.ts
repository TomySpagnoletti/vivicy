import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { getTargetRoot } from "@/lib/target"

const NOTIFICATIONS_FILE = "notifications.jsonl"

// factory/notify.ts declares the same union for the factory-side writer — edit together.
export type NotificationLevel = "info" | "success" | "warning" | "error"

// Cross-process wire contract with factory/cli.ts (newline-delimited JSON): id is the unique key, ts may collide across writers and is display-only.
export interface Notification {
  id: string
  ts: string
  level: NotificationLevel
  stage: string
  event: string
  message: string
  dismissed?: boolean
}

export interface NotificationInput {
  level: NotificationLevel
  stage: string
  event: string
  message: string
}

export function getNotificationsPath(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return path.join(getRuntimeDir(), NOTIFICATIONS_FILE)
  return path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), NOTIFICATIONS_FILE)
}

export function readNotifications(): Notification[] {
  const file = getNotificationsPath()
  if (!existsSync(file)) return []
  const out: Notification[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as Notification)
    } catch {}
  }
  return out
}

let seq = 0

function nextId(): string {
  seq += 1
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${seq.toString(36)}`
}

// One appendFileSync per line, never an open+write pair: only the single call is atomic against concurrent appenders.
export function appendNotification(input: NotificationInput): Notification {
  const notification: Notification = { id: nextId(), ts: new Date().toISOString(), ...input }
  const file = getNotificationsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(notification)}\n`)
  return notification
}

export function dismissNotifications(refs?: string[]): number {
  const file = getNotificationsPath()
  if (!existsSync(file)) return 0
  const target = refs ? new Set(refs) : null
  let changed = 0
  const rows = readNotifications().map((row) => {
    if (row.dismissed) return row
    if (target && !target.has(row.id)) return row
    changed += 1
    return { ...row, dismissed: true }
  })
  if (changed > 0) {
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""))
  }
  return changed
}
