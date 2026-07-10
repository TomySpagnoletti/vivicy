// Best-effort JSONL append to .vivicy-runtime/notifications.jsonl (read by lib/notifications.ts and factory/cli.ts); only fires when VIVICY_RUNTIME_DIR is set (never guessed), and a failed append must never fail the run — observability, not state.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

function stampId(nowMs: number): string {
  counter += 1;
  return `${process.pid.toString(36)}-${nowMs.toString(36)}-${counter.toString(36)}`;
}

type NotificationLevel = "info" | "success" | "warning" | "error";

interface NotifyPayload {
  level?: NotificationLevel;
  stage?: string;
  event?: string;
  message?: string;
}

interface NotifyOptions {
  runtimeDir?: string;
  now?: () => number;
}

export function notify({ level = "info", stage, event, message }: NotifyPayload, options: NotifyOptions = {}): boolean {
  const runtimeDir = options.runtimeDir ?? process.env.VIVICY_RUNTIME_DIR;
  if (!runtimeDir || !stage || !event) return false;
  try {
    if (!existsSync(runtimeDir)) mkdirSync(runtimeDir, { recursive: true });
    const nowMs = options.now ? options.now() : Date.now();
    const line = JSON.stringify({
      id: stampId(nowMs),
      ts: new Date(nowMs).toISOString(),
      level,
      stage,
      event,
      message: String(message ?? event),
    });
    appendFileSync(join(runtimeDir, "notifications.jsonl"), `${line}\n`, "utf8");
    return true;
  } catch {
    return false;
  }
}
