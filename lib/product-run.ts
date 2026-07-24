// Dependency-free: the SectionRun client component imports this directly, and lib/control.ts (server) imports it too — keep it free of node/@ imports so both reach it.

export type ProductRunPhase = "not_established" | "stopped" | "running" | "exited"

export type ProductRunUrlSource = "log" | "command"

export interface ProductRunView {
  phase: ProductRunPhase
  command: string | null
  url: string | null
  url_source: ProductRunUrlSource | null
  log_file: string | null
  log_tail: string | null
  started_at: string | null
}

// Loopback / bind-all hosts only — we surface a URL the owner can click on their own machine, never an arbitrary host printed in the log.
const LOOPBACK_URL_RE =
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi

function normalizeLoopbackUrl(url: string): string {
  return url
    .replace("://0.0.0.0", "://localhost")
    .replace("://[::]", "://localhost")
    .replace(/[.,;:)\]]+$/, "")
}

export function detectUrlFromLog(logText: string): string | null {
  const matches = logText.match(LOOPBACK_URL_RE)
  if (!matches || matches.length === 0) return null
  return normalizeLoopbackUrl(matches[matches.length - 1])
}

function inRange(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535
}

export function detectPortFromCommand(command: string): number | null {
  const patterns = [
    /(?:^|\s)PORT=(\d{2,5})(?=\s|$)/,
    /(?:^|\s)--port[=\s]+(\d{2,5})(?=\s|$)/,
    /(?:^|\s)-p[=\s]+(\d{2,5})(?=\s|$)/,
  ]
  for (const re of patterns) {
    const match = command.match(re)
    if (match) {
      const port = Number(match[1])
      if (inRange(port)) return port
    }
  }
  return null
}

// Log sniff is authoritative (the server printed its real URL); the command-string port is a best-effort guess; otherwise honest "see log".
export function deriveProductRunUrl(
  logText: string | null,
  command: string | null
): { url: string | null; source: ProductRunUrlSource | null } {
  const fromLog = logText ? detectUrlFromLog(logText) : null
  if (fromLog) return { url: fromLog, source: "log" }
  const port = command ? detectPortFromCommand(command) : null
  if (port !== null) return { url: `http://localhost:${port}`, source: "command" }
  return { url: null, source: null }
}

export function normalizeRunCommandValue(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null
}
