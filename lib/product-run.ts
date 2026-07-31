// Keep free of node/@ imports: the SectionRun client component and lib/control.ts both import this directly.

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

// Loopback/bind-all hosts only: never surface an arbitrary host read out of the log.
const LOOPBACK_URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi

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
  const patterns = [/(?:^|\s)PORT=(\d{2,5})(?=\s|$)/, /(?:^|\s)--port[=\s]+(\d{2,5})(?=\s|$)/, /(?:^|\s)-p[=\s]+(\d{2,5})(?=\s|$)/]
  for (const re of patterns) {
    const match = command.match(re)
    if (match) {
      const port = Number(match[1])
      if (inRange(port)) return port
    }
  }
  return null
}

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

// Under-fire is the safe direction: only add a token that unambiguously boots a browser-facing HTTP server.
const WEB_SERVE_COMMAND_RE =
  /(?:\b(?:next|vite|nuxt|astro|remix|gatsby|parcel|storybook|webpack(?:-dev-server)?|http-server|live-server|serve|ng|vue-cli-service|react-scripts|svelte-kit|flask|runserver|rails|puma|rackup|uvicorn|gunicorn|hypercorn|daphne|streamlit)\b|php\s+-S)/i

const NODE_WEB_SCRIPT_RE = /\b(?:npm|pnpm|yarn|bun)\b[^&|;]*\b(?:run\s+)?(?:dev|start|serve)\b/i

export function commandServesHttp(command: string | null | undefined): boolean {
  if (typeof command !== "string" || command.trim().length === 0) return false
  return detectPortFromCommand(command) !== null || WEB_SERVE_COMMAND_RE.test(command) || NODE_WEB_SCRIPT_RE.test(command)
}
