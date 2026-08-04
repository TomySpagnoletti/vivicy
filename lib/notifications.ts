import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import type { NotificationInput, NotificationLevel, NotificationParamValue } from "@/lib/notification-events"
import { ensureProjectRuntimeDir, getProjectRuntimeDir } from "@/lib/project-runtime"
import { getTargetRoot } from "@/lib/target"

const NOTIFICATIONS_FILE = "notifications.jsonl"

export type { NotificationLevel }

// Cross-process wire contract with factory/cli.ts (newline-delimited JSON): id is the unique key, ts may collide across writers and is display-only.
export interface Notification {
  id: string
  ts: string
  level: NotificationLevel
  stage: string
  event: string
  message: string
  params?: Record<string, NotificationParamValue>
  dismissed?: boolean
}

// The log lives with the project it is about: no project selected means no log to read or append to.
export function getNotificationsPath(): string | null {
  const targetRoot = getTargetRoot()
  return targetRoot === null ? null : path.join(getProjectRuntimeDir(targetRoot), NOTIFICATIONS_FILE)
}

export function readNotifications(): Notification[] {
  const file = getNotificationsPath()
  if (file === null || !existsSync(file)) return []
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
export function appendNotification(input: NotificationInput): Notification | null {
  const file = getNotificationsPath()
  if (file === null) return null
  const notification: Notification = { id: nextId(), ts: new Date().toISOString(), ...input }
  ensureProjectRuntimeDir(path.dirname(file))
  appendFileSync(file, `${JSON.stringify(notification)}\n`)
  return notification
}

export function dismissNotifications(refs?: string[]): number {
  const file = getNotificationsPath()
  if (file === null || !existsSync(file)) return 0
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
