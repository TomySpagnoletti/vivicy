import { appendFileSync, existsSync, readFileSync } from "node:fs"
import path from "node:path"

import type { NotificationInput, NotificationLevel } from "@/lib/notification-events"
import { dismissalLine, foldNotificationLog, NOTIFICATIONS_FILE, notificationLine, type Notification } from "@/lib/notification-log"
import { ensureProjectRuntimeDir, getProjectRuntimeDir } from "@/lib/project-runtime"
import { getTargetRoot } from "@/lib/target"

export type { Notification, NotificationLevel }

// The log lives with the project it is about: no project selected means no log to read or append to.
export function getNotificationsPath(): string | null {
  const targetRoot = getTargetRoot()
  return targetRoot === null ? null : path.join(getProjectRuntimeDir(targetRoot), NOTIFICATIONS_FILE)
}

export function readNotifications(): Notification[] {
  const file = getNotificationsPath()
  if (file === null || !existsSync(file)) return []
  return foldNotificationLog(readFileSync(file, "utf8"))
}

let seq = 0

function nextId(): string {
  seq += 1
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${seq.toString(36)}`
}

// One appendFileSync per record, never an open+write pair: only the single call is atomic against concurrent appenders.
export function appendNotification(input: NotificationInput): Notification | null {
  const file = getNotificationsPath()
  if (file === null) return null
  const notification: Notification = { id: nextId(), ts: new Date().toISOString(), ...input }
  ensureProjectRuntimeDir(path.dirname(file))
  appendFileSync(file, notificationLine(notification))
  return notification
}

export function dismissNotifications(refs?: string[]): number {
  const file = getNotificationsPath()
  if (file === null || !existsSync(file)) return 0
  const target = refs ? new Set(refs) : null
  const ids = readNotifications()
    .filter((row) => row.dismissed !== true && (target === null || target.has(row.id)))
    .map((row) => row.id)
  if (ids.length === 0) return 0
  appendFileSync(file, dismissalLine(ids))
  return ids.length
}
