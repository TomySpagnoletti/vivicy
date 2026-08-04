import { appendFileSync } from "node:fs"
import { join } from "node:path"

import type { NotificationInput } from "../lib/notification-events.ts"
import { ensureProjectRuntimeDir } from "../lib/project-runtime.ts"

let counter = 0

function stampId(nowMs: number): string {
  counter += 1
  return `${process.pid.toString(36)}-${nowMs.toString(36)}-${counter.toString(36)}`
}

interface NotifyOptions {
  runtimeDir?: string
  now?: () => number
}

export function notify(payload: NotificationInput, options: NotifyOptions = {}): boolean {
  const runtimeDir = options.runtimeDir ?? process.env.VIVICY_RUNTIME_DIR
  if (!runtimeDir) return false
  try {
    ensureProjectRuntimeDir(runtimeDir)
    const nowMs = options.now ? options.now() : Date.now()
    const line = JSON.stringify({ id: stampId(nowMs), ts: new Date(nowMs).toISOString(), ...payload })
    appendFileSync(join(runtimeDir, "notifications.jsonl"), `${line}\n`, "utf8")
    return true
  } catch {
    return false
  }
}
