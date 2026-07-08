import path from "node:path"

import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter"

// Aggregates the per-test "browser-issues" attachments produced by the fixture in
// e2e/browser-issues.ts, dedupes them across the whole run with occurrence counts,
// prints a readable summary, and fails the suite when any error-level issue is not
// covered by the allowlist below.

type BrowserIssueLevel = "warning" | "error"
type BrowserIssueKind = "console" | "pageerror" | "requestfailed" | "http"

type BrowserIssue = {
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

type IssueOccurrence = {
  projectName?: string
  testTitle: string
  file: string
  line: number
  retry: number
}

type AggregatedIssue = {
  issue: BrowserIssue
  count: number
  occurrences: IssueOccurrence[]
}

const ISSUE_ATTACHMENT_NAME = "browser-issues"
const MAX_OCCURRENCES_PER_ISSUE = 5
const MAX_STACK_LINES = 6

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isBrowserIssue(value: unknown): value is BrowserIssue {
  if (!isRecord(value)) return false
  return typeof value.kind === "string" && typeof value.level === "string" && typeof value.text === "string"
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

function severity(issue: BrowserIssue): number {
  return issue.level === "error" ? 2 : 1
}

function formatWhere(issue: BrowserIssue): string {
  if (issue.kind !== "console") return ""

  const location = issue.location
  if (location?.url) {
    const linePart = location.line ? `:${location.line}` : ""
    const columnPart = location.column ? `:${location.column}` : ""
    return ` @ ${location.url}${linePart}${columnPart}`
  }
  return ""
}

function formatDetails(issue: BrowserIssue): string {
  if (issue.kind === "http" || issue.kind === "requestfailed") {
    const method = issue.method ? `${issue.method} ` : ""
    return `${method}${issue.url ?? ""}`.trim()
  }
  return ""
}

function formatIssueLine(issue: BrowserIssue): string {
  const details = formatDetails(issue)
  const detailsSuffix = details ? ` (${details})` : ""
  return `[${issue.level}] [${issue.kind}] ${issue.text}${detailsSuffix}${formatWhere(issue)}`
}

function formatOccurrence(occurrence: IssueOccurrence): string {
  const project = occurrence.projectName ? `[${occurrence.projectName}] ` : ""
  const retry = occurrence.retry ? ` (retry #${occurrence.retry})` : ""
  const file = path.relative(process.cwd(), occurrence.file)
  return `${project}${occurrence.testTitle} (${file}:${occurrence.line})${retry}`
}

// Known-safe noise for this stack (Next 16 dev servers across chromium/firefox/webkit):
// mid-navigation cancellations of Next static chunk / RSC fetches that each browser
// reports in its own dialect. Everything else — and every error-level issue — blocks.
function isAllowedIssue(issue: BrowserIssue) {
  if (issue.kind === "console" && issue.level === "warning") {
    return /Loading failed for the <script> with source .*\/_next\/static\/chunks\//i.test(issue.text)
  }

  if (issue.kind === "console" && issue.level === "error") {
    const isNextChunk = /\/_next\/static\/chunks\//i.test(issue.location?.url ?? "")
    const isFirefoxNetworkCancel =
      issue.text === "Error" &&
      /"name":"TypeError"[\s\S]*"message":"NetworkError when attempting to fetch resource\."/i.test(issue.body ?? "")
    const isWebKitNetworkCancel =
      issue.text === "TypeError: Load failed" && /"name":"TypeError"[\s\S]*"message":"Load failed"/i.test(issue.body ?? "")

    return isNextChunk && (isFirefoxNetworkCancel || isWebKitNetworkCancel)
  }

  if (issue.kind === "requestfailed") {
    return /ERR_ABORTED|NS_BINDING_ABORTED|NS_BASE_STREAM_CLOSED|cancelled|canceled/i.test(issue.text)
  }

  if (issue.kind === "pageerror") {
    return /Fetch API cannot load[\s\S]*[?&]_rsc=[\s\S]*due to access control checks/i.test(issue.text)
  }

  return false
}

function isBlockingIssue(issue: BrowserIssue) {
  return issue.level === "error" && !isAllowedIssue(issue)
}

class BrowserIssuesReporter implements Reporter {
  private readonly issuesByKey = new Map<string, AggregatedIssue>()

  onTestEnd(test: TestCase, result: TestResult): void {
    const attachment = result.attachments.find((a) => a.name === ISSUE_ATTACHMENT_NAME)
    if (!attachment?.body) return

    let parsed: unknown
    try {
      parsed = JSON.parse(attachment.body.toString("utf-8"))
    } catch {
      return
    }
    if (!Array.isArray(parsed)) return

    const projectName = test.parent.project()?.name
    const titles = test.titlePath().filter(Boolean)
    const testTitle = projectName && titles[0] === projectName ? titles.slice(1).join(" › ") : titles.join(" › ")

    for (const entry of parsed) {
      if (!isBrowserIssue(entry)) continue

      const key = makeIssueKey(entry)
      const occurrence: IssueOccurrence = {
        projectName,
        testTitle,
        file: test.location.file,
        line: test.location.line,
        retry: result.retry,
      }

      const aggregated = this.issuesByKey.get(key)
      if (aggregated) {
        aggregated.count += 1
        const alreadyRecorded = aggregated.occurrences.some(
          (o) =>
            o.projectName === occurrence.projectName &&
            o.testTitle === occurrence.testTitle &&
            o.file === occurrence.file &&
            o.line === occurrence.line &&
            o.retry === occurrence.retry
        )
        if (!alreadyRecorded) aggregated.occurrences.push(occurrence)
        continue
      }

      this.issuesByKey.set(key, { issue: entry, count: 1, occurrences: [occurrence] })
    }
  }

  async onEnd(): Promise<{ status?: FullResult["status"] } | undefined> {
    if (this.issuesByKey.size === 0) return

    const aggregated = [...this.issuesByKey.values()].sort((a, b) => {
      const sev = severity(b.issue) - severity(a.issue)
      if (sev !== 0) return sev
      const countDiff = b.count - a.count
      if (countDiff !== 0) return countDiff
      return a.issue.text.localeCompare(b.issue.text)
    })

    const reportable = aggregated.filter((entry) => !isAllowedIssue(entry.issue))
    if (reportable.length === 0) return

    const title = `Browser warnings/errors (deduplicated): ${reportable.length} unique issue(s)`
    console.log(`\n========== ${title} ==========\n`)
    for (const entry of reportable) {
      console.log(`- (${entry.count}x) ${formatIssueLine(entry.issue)}`)

      if (entry.issue.stack) {
        for (const line of entry.issue.stack.split("\n").slice(0, MAX_STACK_LINES)) console.log(`    ${line}`)
      }

      if (entry.issue.body) {
        console.log("    Body (truncated):")
        for (const line of entry.issue.body.split("\n").slice(0, MAX_STACK_LINES)) console.log(`    ${line}`)
      }

      for (const occurrence of entry.occurrences.slice(0, MAX_OCCURRENCES_PER_ISSUE)) {
        console.log(`    - ${formatOccurrence(occurrence)}`)
      }
      const remaining = entry.occurrences.length - MAX_OCCURRENCES_PER_ISSUE
      if (remaining > 0) console.log(`    - … +${remaining} more`)
    }

    const blocking = reportable.filter((entry) => isBlockingIssue(entry.issue))
    if (blocking.length > 0) {
      console.log(`\nBrowser issue gate failed: ${blocking.length} unexpected error-level issue(s).`)
      return { status: "failed" }
    }
  }

  printsToStdio(): boolean {
    return true
  }
}

export default BrowserIssuesReporter
