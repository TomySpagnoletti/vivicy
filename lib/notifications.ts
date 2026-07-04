/**
 * Read/write the Vivicy notification log — the app-side half of the G14
 * notifications verb, sharing its contract with the `vivicy notifications` CLI.
 *
 * Server-only. The log is newline-delimited JSON at
 * getRuntimeDir()/notifications.jsonl, one object per line:
 *   { ts, level, stage, event, message, dismissed?, id? }
 * A missing or empty file is an empty list (never an error); a malformed/partial
 * line is skipped so a concurrent write never breaks a read.
 *
 * Identity: `id` (stamped by the writer: pid + wall-clock ms + a per-process
 * counter, base36) is the unique key dismissal targets. `ts` is display-only
 * wall clock — several processes can append to this one file over a run's life
 * (the Next server, the G14 CLI), so same-millisecond `ts` values across
 * writers are realistic and `ts` must never be treated as unique. Lines
 * written before the `id` field existed stay dismissable via a `ts` fallback
 * match ({@link dismissNotifications}).
 *
 * Dismissal mechanism (G9): the log stays append-only for NEW notifications
 * (appendNotification only ever adds a line), but dismissing one flips its
 * existing `dismissed` field in place via a full rewrite of the file. This is
 * the simplest option consistent with the ALREADY-FIXED reader contract above
 * (both this reader and the CLI's `cmdNotifications` treat `dismissed` as a
 * boolean on the notification object itself — see factory/cli.ts and
 * lib/notifications.test.ts, both written before this writer landed) — a
 * sidecar dismissed-set or an appended `{event:"dismissed"}` marker line would
 * require both readers to learn a second shape for no benefit. The log is
 * expected to stay small (local runs, periodically clearable), so a rewrite on
 * dismiss is cheap.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getRuntimeDir } from "@/lib/runtime-dir"

const NOTIFICATIONS_FILE = "notifications.jsonl"

/** One notification line as surfaced to the UI/CLI. Fields are optional because
 *  a partial line is tolerated; the writer populates the full shape. */
export interface Notification {
  /** Unique identity (see module doc). Absent only on pre-`id` legacy lines. */
  id?: string
  ts?: string
  level?: string
  stage?: string
  event?: string
  message?: string
  dismissed?: boolean
}

/** Input to {@link appendNotification}: everything but `id`/`ts`, which the
 *  writer stamps itself so identity is never caller-supplied and every call
 *  site reports the moment it actually happened. */
export interface NotificationInput {
  level: string
  stage: string
  event: string
  message: string
}

/** Absolute path to the notification log (created on demand by the writer). */
export function getNotificationsPath(): string {
  return path.join(getRuntimeDir(), NOTIFICATIONS_FILE)
}

/** Read all notifications, oldest first. Missing/empty file => []; malformed lines
 *  are skipped. Never throws. */
export function readNotifications(): Notification[] {
  const file = getNotificationsPath()
  if (!existsSync(file)) return []
  const out: Notification[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      out.push(JSON.parse(trimmed) as Notification)
    } catch {
      // Skip a partial/corrupt line rather than failing the whole read.
    }
  }
  return out
}

/**
 * Unique across every realistic writer combination: the pid separates
 * concurrent processes, the millisecond separates process lifetimes (pid reuse
 * within the same millisecond is impossible), and the counter separates
 * same-millisecond calls within one process.
 */
let seq = 0

function nextId(): string {
  seq += 1
  return `${process.pid.toString(36)}-${Date.now().toString(36)}-${seq.toString(36)}`
}

/**
 * Append one notification line (P9: every meaningful pipeline transition calls
 * this once). `id` and `ts` are stamped here, never by the caller: `id` is the
 * unique identity ({@link nextId}), `ts` the honest wall-clock display time. A
 * single `appendFileSync` call is atomic for one line on every OS Vivicy
 * targets (POSIX `O_APPEND` write, Windows analogous), which is the
 * concurrency-safety this needs — multiple callers appending never interleave
 * or corrupt each other's line.
 */
export function appendNotification(input: NotificationInput): Notification {
  const notification: Notification = { id: nextId(), ts: new Date().toISOString(), ...input }
  mkdirSync(getRuntimeDir(), { recursive: true })
  appendFileSync(getNotificationsPath(), `${JSON.stringify(notification)}\n`)
  return notification
}

/**
 * Flip `dismissed: true` on every notification matching `refs` (or, when `refs`
 * is omitted, on all of them — the sidebar's "clear all"). A row matches on its
 * `id`; a legacy row without an `id` matches on its `ts` instead (best effort —
 * pre-`id` lines carried no unique key). Rewrites the whole file in place. A
 * missing log is a no-op (nothing to dismiss). Returns the count actually flipped.
 */
export function dismissNotifications(refs?: string[]): number {
  const file = getNotificationsPath()
  if (!existsSync(file)) return 0
  const target = refs ? new Set(refs) : null
  let changed = 0
  const rows = readNotifications().map((row) => {
    if (row.dismissed) return row
    if (target) {
      const key = row.id ?? row.ts
      if (!(key && target.has(key))) return row
    }
    changed += 1
    return { ...row, dismissed: true }
  })
  if (changed > 0) {
    writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""))
  }
  return changed
}
