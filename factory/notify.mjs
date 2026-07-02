// Best-effort notification emission from factory orchestrators to the app's
// notification log (.vivicy-runtime/notifications.jsonl — the read contract
// lives in lib/notifications.ts and factory/cli.mjs `notifications`).
//
// Contract: emission happens ONLY when VIVICY_RUNTIME_DIR is set — the control
// plane and the CLI pass it explicitly to every spawn. A detached orchestrator
// must never guess a runtime dir, and a failed append must never fail the run:
// notifications are observability, not state (the ledger and status files stay
// the sources of truth).

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

let counter = 0;

/** Writer-stamped unique id: pid separates processes, ms separates process lifetimes, counter separates same-ms calls. */
function stampId(nowMs) {
  counter += 1;
  return `${process.pid.toString(36)}-${nowMs.toString(36)}-${counter.toString(36)}`;
}

/**
 * Append one notification line. `level` ∈ info|success|warning|error, `stage`
 * is the pipeline stage key (e.g. "S6", "S9"), `event` a machine keyword,
 * `message` one technical line. Returns true when a line was written.
 */
export function notify({ level = "info", stage, event, message }, options = {}) {
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
