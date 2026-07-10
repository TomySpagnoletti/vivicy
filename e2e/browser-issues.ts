import { expect, test as base } from "@playwright/test"
import type { BrowserContext, ConsoleMessage, Page, Request, Response, TestInfo } from "@playwright/test"

export type BrowserIssueLevel = "warning" | "error"
export type BrowserIssueKind = "console" | "pageerror" | "requestfailed" | "http"

export type BrowserIssue = {
  kind: BrowserIssueKind
  level: BrowserIssueLevel
  text: string
  url?: string
  location?: { url?: string; line?: number; column?: number }
  method?: string
  status?: number
  statusText?: string
  resourceType?: string
  body?: string
  stack?: string
}

// Consumed by the browser-issues Playwright reporter, which aggregates it across the run and applies the allowlist — keep the name in sync.
export const ISSUE_ATTACHMENT_NAME = "browser-issues"

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function getBaseURL(testInfo: TestInfo): string | undefined {
  const baseURL = (testInfo.project.use as { baseURL?: unknown }).baseURL
  return typeof baseURL === "string" && baseURL.length > 0 ? baseURL : undefined
}

function isSameOrigin(url: string, baseURL: string | undefined): boolean {
  if (!baseURL) return true
  try {
    return new URL(url).origin === new URL(baseURL).origin
  } catch {
    return true
  }
}

function normalizeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl)
    url.searchParams.delete("_rsc")
    return url.toString()
  } catch {
    return rawUrl
  }
}

function isNavigationAbort(errorText: string) {
  return /ERR_ABORTED|NS_BINDING_ABORTED|NS_ERROR_ABORT|NS_BASE_STREAM_CLOSED|cancelled|canceled/i.test(errorText)
}

// WebKit fires pageerror for mid-navigation RSC fetch aborts that Next's router already recovers from — not a real failure.
function isKnownWebKitRscAbort(error: Error) {
  return /Fetch API cannot load[\s\S]*[?&]_rsc=[\s\S]*due to access control checks/i.test(error.message)
}

function makeIssueKey(issue: BrowserIssue): string {
  const location = issue.location ?? {}
  return [
    issue.kind,
    issue.level,
    issue.text,
    issue.url ?? "",
    location.url ?? "",
    String(location.line ?? ""),
    String(location.column ?? ""),
    issue.method ?? "",
    String(issue.status ?? ""),
    issue.statusText ?? "",
    issue.resourceType ?? "",
  ].join("|")
}

async function getConsoleMessageBody(msg: ConsoleMessage): Promise<string | undefined> {
  const args = msg.args().slice(0, 3)
  if (args.length === 0) return undefined

  const summaries = await Promise.all(
    args.map((arg) =>
      arg
        .evaluate((value) => {
          if (value instanceof Error) {
            return { kind: "error", name: value.name, message: value.message, stack: value.stack || "" }
          }
          return { kind: typeof value, value: String(value) }
        })
        .catch((error: unknown) => ({
          kind: "unserializable",
          message: error instanceof Error ? error.message : String(error),
        }))
    )
  )

  return JSON.stringify(summaries)
}

function addIssue(issues: BrowserIssue[], seen: Set<string>, issue: BrowserIssue): void {
  const key = makeIssueKey(issue)
  if (seen.has(key)) return
  seen.add(key)
  issues.push(issue)
}

async function trackResponse(
  response: Response,
  baseURL: string | undefined,
  issues: BrowserIssue[],
  seen: Set<string>
): Promise<void> {
  const status = response.status()
  if (status < 400) return

  const rawUrl = response.url()
  if (!isSameOrigin(rawUrl, baseURL)) return

  const url = normalizeUrl(rawUrl)
  const request = response.request()
  let body: string | undefined
  if (status >= 500) {
    try {
      const text = await response.text()
      body = text.slice(0, 2000)
    } catch {
      body = undefined
    }
  }
  addIssue(issues, seen, {
    kind: "http",
    level: status >= 500 ? "error" : "warning",
    text: `HTTP ${status} ${response.statusText()}`.trim(),
    url,
    method: request.method(),
    status,
    statusText: response.statusText(),
    resourceType: request.resourceType(),
    body,
  })
}

function attachListeners(
  page: Page,
  baseURL: string | undefined,
  issues: BrowserIssue[],
  seen: Set<string>,
  pendingIssueDetails: Promise<void>[]
): () => void {
  const onConsole = (msg: ConsoleMessage) => {
    const type = msg.type()
    if (type !== "warning" && type !== "error" && type !== "assert") return

    const location = msg.location()
    const issue: BrowserIssue = {
      kind: "console",
      level: type === "warning" ? "warning" : "error",
      text: msg.text(),
      location: {
        url: location.url || undefined,
        line: toNumber(location.lineNumber),
        column: toNumber(location.columnNumber),
      },
    }
    pendingIssueDetails.push(
      getConsoleMessageBody(msg).then((body) => {
        if (body) issue.body = body
      })
    )
    addIssue(issues, seen, issue)
  }

  const onPageError = (error: Error) => {
    if (isKnownWebKitRscAbort(error)) return

    addIssue(issues, seen, {
      kind: "pageerror",
      level: "error",
      text: `${error.name}: ${error.message}`.trim(),
      stack: error.stack,
    })
  }

  const onRequestFailed = (request: Request) => {
    const failure = request.failure()
    const errorText = failure?.errorText ?? ""
    const isAbortError = isNavigationAbort(errorText)
    if (isAbortError && isSameOrigin(request.url(), baseURL)) return

    addIssue(issues, seen, {
      kind: "requestfailed",
      level: isAbortError ? "warning" : "error",
      text: errorText ? `Request failed: ${errorText}` : "Request failed",
      url: normalizeUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
    })
  }

  const onResponse = (response: Response) => {
    void trackResponse(response, baseURL, issues, seen)
  }

  page.on("console", onConsole)
  page.on("pageerror", onPageError)
  page.on("requestfailed", onRequestFailed)
  page.on("response", onResponse)

  return () => {
    page.off("console", onConsole)
    page.off("pageerror", onPageError)
    page.off("requestfailed", onRequestFailed)
    page.off("response", onResponse)
  }
}

function attachContextListeners(
  context: BrowserContext,
  baseURL: string | undefined,
  issues: BrowserIssue[],
  seen: Set<string>,
  pendingIssueDetails: Promise<void>[]
): () => void {
  const subscriptions = new Map<Page, () => void>()

  const subscribe = (page: Page) => {
    if (subscriptions.has(page)) return
    subscriptions.set(page, attachListeners(page, baseURL, issues, seen, pendingIssueDetails))
  }

  for (const page of context.pages()) subscribe(page)

  context.on("page", subscribe)

  return () => {
    context.off("page", subscribe)
    for (const unsubscribe of subscriptions.values()) unsubscribe()
    subscriptions.clear()
  }
}

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    const issues: BrowserIssue[] = []
    const seen = new Set<string>()
    const pendingIssueDetails: Promise<void>[] = []
    const baseURL = getBaseURL(testInfo)

    const detachFromContext = attachContextListeners(page.context(), baseURL, issues, seen, pendingIssueDetails)

    await use(page)

    detachFromContext()
    await Promise.allSettled(pendingIssueDetails)

    if (issues.length === 0) return

    await testInfo.attach(ISSUE_ATTACHMENT_NAME, {
      body: Buffer.from(JSON.stringify(issues, null, 2), "utf-8"),
      contentType: "application/json",
    })
  },
})

export { expect }
export type { ConsoleMessage, Page } from "@playwright/test"
