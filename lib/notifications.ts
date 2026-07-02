/**
 * Read the Vivicy notification log — the app-side half of the G14 notifications
 * verb, sharing its READ contract with the `vivicy notifications` CLI.
 *
 * Server-only. The log is newline-delimited JSON at
 * getRuntimeDir()/notifications.jsonl, one object per line:
 *   { ts, level, stage, event, message, dismissed? }
 * A missing or empty file is an empty list (never an error); a malformed/partial
 * line is skipped so a concurrent write never breaks a read. G9 lands the WRITER
 * after G14 and appends lines in exactly this shape — the reader here and the CLI
 * are the contract it follows; both clients read the SAME file (CLI+API parity).
 */

import { existsSync, readFileSync } from "node:fs"
import path from "node:path"

import { getRuntimeDir } from "@/lib/runtime-dir"

const NOTIFICATIONS_FILE = "notifications.jsonl"

/** One notification line as surfaced to the UI/CLI. Fields are optional because
 *  a partial line is tolerated; the writer (G9) populates the full shape. */
export interface Notification {
  ts?: string
  level?: string
  stage?: string
  event?: string
  message?: string
  dismissed?: boolean
}

/** Absolute path to the notification log (created on demand by G9's writer). */
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
