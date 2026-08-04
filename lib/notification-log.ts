// Must stay a LEAF — the notification log's on-disk contract, loaded by the Next app, by plain node from factory/, and as a type by a client component: no Next alias, no relative value import, no node: import.

import type { NotificationLevel, NotificationParamValue } from "./notification-events.ts"

export const NOTIFICATIONS_FILE = "notifications.jsonl"

// Cross-process wire contract (newline-delimited JSON): id is the unique key, ts may collide across writers and is display-only, and `dismissed` is the fold's answer — never a field any writer puts on disk.
export interface Notification {
  id: string
  ts: string
  level: NotificationLevel
  stage: string
  event: string
  message: string
  params?: Record<string, NotificationParamValue>
  dismissed?: true
}

const ROW_FIELDS = ["id", "ts", "level", "stage", "event", "message"] as const

// APPEND-ONLY for every writer: a whole-file rewrite from a pre-read snapshot drops whatever a detached child appended in between.
export function dismissalLine(ids: readonly string[]): string {
  return `${JSON.stringify({ dismiss: [...ids] })}\n`
}

export function notificationLine(row: Notification): string {
  return `${JSON.stringify(row)}\n`
}

function asRow(value: Record<string, unknown>): Notification | null {
  for (const field of ROW_FIELDS) {
    if (typeof value[field] !== "string") return null
  }
  const row: Notification = {
    id: value.id as string,
    ts: value.ts as string,
    level: value.level as NotificationLevel,
    stage: value.stage as string,
    event: value.event as string,
    message: value.message as string,
  }
  const params = value.params
  if (params !== null && typeof params === "object" && !Array.isArray(params)) {
    row.params = params as Record<string, NotificationParamValue>
  }
  return row
}

function dismissedIds(value: Record<string, unknown>): string[] | null {
  if (!Array.isArray(value.dismiss)) return null
  return value.dismiss.filter((id): id is string => typeof id === "string")
}

// Two passes, so a tombstone is read whatever its position: a killed writer leaves a torn line, never a reordered log.
export function foldNotificationLog(text: string): Notification[] {
  const rows: Notification[] = []
  const dismissed = new Set<string>()
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const ids = dismissedIds(record)
    if (ids !== null) {
      for (const id of ids) dismissed.add(id)
      continue
    }
    const row = asRow(record)
    if (row !== null) rows.push(row)
  }
  return rows.map((row) => (dismissed.has(row.id) ? { ...row, dismissed: true as const } : row))
}
