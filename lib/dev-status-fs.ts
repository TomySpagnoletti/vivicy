// Reimplements factory/dev-status.ts's deterministic status (minus live-process checks) for the E2E fake-spawner's dry path — keep both in sync.
import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"

import type { DevStatus, QuotaBlock } from "@/lib/control"

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T
  } catch {
    return fallback
  }
}

interface IssueIndex {
  issues?: Array<{ id: string; graph_refs?: string[] }>
}
interface Ledger {
  graph_item_states?: Array<{
    graph_ref: string
    issue_states?: Record<string, string>
  }>
  active_items?: Array<Record<string, unknown>>
}

export function readDevStatusFromDisk(root: string): DevStatus {
  const dev = path.join(root, ".vivicy", "development")
  const index = readJson<IssueIndex>(path.join(dev, "issue-index.json"), { issues: [] })
  const issues = Array.isArray(index.issues) ? index.issues : []
  const ledger = readJson<Ledger>(path.join(dev, "progress-ledger.json"), {
    graph_item_states: [],
    active_items: [],
  })

  const doneDir = path.join(dev, "issues", "done")
  const doneFiles = existsSync(doneDir)
    ? readdirSync(doneDir).filter((f) => f.endsWith(".md"))
    : []

  const verifiedByRef = new Map<string, Set<string>>()
  for (const state of ledger.graph_item_states ?? []) {
    const verified = Object.entries(state.issue_states ?? {})
      .filter(([, s]) => s === "verified")
      .map(([id]) => id)
    verifiedByRef.set(state.graph_ref, new Set(verified))
  }
  const issueDone = (issue: { id: string; graph_refs?: string[] }): boolean => {
    if (doneFiles.includes(`${issue.id}.md`)) return true
    const refs = Array.isArray(issue.graph_refs) ? issue.graph_refs : []
    return refs.length > 0 && refs.every((ref) => verifiedByRef.get(ref)?.has(issue.id))
  }
  const doneIds = issues.filter(issueDone).map((i) => i.id)

  const gatesDir = path.join(dev, "gates")
  const gateRecords = existsSync(gatesDir)
    ? readdirSync(gatesDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => readJson<{ status?: string }>(path.join(gatesDir, f), {}))
    : []
  const gatesPass = gateRecords.filter((g) => g.status === "pass").length
  const gatesFail = gateRecords.filter((g) => g.status === "fail").length

  // Absent quota data must render as unknown, never fabricated — mirrors dev-status.ts.
  const quota = readJson<QuotaBlock>(path.join(dev, "reports", "quota-state.json"), {
    updated_at: null,
    agents: {},
  })

  let verdict: string
  if (issues.length > 0 && doneIds.length === issues.length) verdict = "DONE"
  else if (gatesFail > 0 && doneIds.length < issues.length) verdict = "STOPPED (last gate failed)"
  else if (doneIds.length > 0) verdict = "STOPPED (resume to continue)"
  else verdict = "NOT STARTED"

  return {
    verdict,
    issues_total: issues.length,
    issues_done: doneIds.length,
    done: doneIds,
    remaining: issues.filter((i) => !doneIds.includes(i.id)).map((i) => i.id),
    active: ledger.active_items ?? [],
    process_alive: false,
    idle_seconds: null,
    gates: { pass: gatesPass, fail: gatesFail },
    quota: quota && typeof quota === "object" && quota.agents ? quota : { updated_at: null, agents: {} },
  }
}
