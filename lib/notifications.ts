/**
 * Read/write the Vivicy notification log — the app-side half of the G14
 * notifications verb, sharing its contract with the `vivicy notifications` CLI.
 *
 * Server-only. The log is newline-delimited JSON, PER PROJECT since W8, at
 * <runtime>/projects/<key>/notifications.jsonl (root-level legacy fallback when no
 * project is selected), one object per line:
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

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { getTargetRoot } from "@/lib/target"

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

/**
 * Absolute path to the notification log (created on demand by the writer). Since W8
 * the log is PER PROJECT — `<runtime>/projects/<key>/notifications.jsonl` — so one
 * governed project never shows another's notifications. With no project selected the
 * legacy root log is the honest fallback (pre-project events, e.g. onboarding).
 *
 * Lazy one-time migration: the first per-project access moves a still-present legacy
 * root log into the current project's namespace (the pre-W8 log was one mixed global
 * stream; attributing it to the first project touched loses nothing that was not
 * already mixed) and appends a loud migration marker — never a silent move.
 */
export function getNotificationsPath(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return path.join(getRuntimeDir(), NOTIFICATIONS_FILE)
  const projectFile = path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), NOTIFICATIONS_FILE)
  migrateLegacyLog(projectFile)
  return projectFile
}

/** Fold the legacy root log into the project namespace, once, loudly, best-effort.
 *  A project log that already exists (a factory spawn can write it first) gets the
 *  legacy lines PREPENDED — the pre-W8 history is older by construction; without the
 *  merge it would stay invisible forever. */
function migrateLegacyLog(projectFile: string): void {
  const legacyFile = path.join(getRuntimeDir(), NOTIFICATIONS_FILE)
  if (!existsSync(legacyFile)) return
  try {
    mkdirSync(path.dirname(projectFile), { recursive: true })
    if (!existsSync(projectFile)) {
      renameSync(legacyFile, projectFile)
    } else {
      const merged = readFileSync(legacyFile, "utf8") + readFileSync(projectFile, "utf8")
      writeFileSync(projectFile, merged)
      rmSync(legacyFile, { force: true })
    }
    const marker: Notification = {
      id: nextId(),
      ts: new Date().toISOString(),
      level: "info",
      stage: "runtime",
      event: "notifications_migrated",
      message: "notification log migrated to this project's runtime namespace (W8 per-project isolation)",
    }
    appendFileSync(projectFile, `${JSON.stringify(marker)}\n`)
  } catch {
    // Best-effort: a failed migration leaves the legacy log in place; the project
    // log simply starts fresh on the next append.
  }
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
  const file = getNotificationsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(notification)}\n`)
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
