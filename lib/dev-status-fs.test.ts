import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { readDevStatusFromDisk } from "@/lib/dev-status-fs"

let root: string

interface IssueIndexShape {
  issues: Array<{ id: string; graph_refs?: string[] }>
}
interface LedgerShape {
  graph_item_states?: Array<{ graph_ref: string; issue_states?: Record<string, string> }>
  active_items?: Array<Record<string, unknown>>
}

function devDir(): string {
  return path.join(root, ".vivicy", "development")
}

function writeIndex(index: IssueIndexShape): void {
  const dev = devDir()
  mkdirSync(dev, { recursive: true })
  writeFileSync(path.join(dev, "issue-index.json"), JSON.stringify(index))
}

function writeLedger(ledger: LedgerShape): void {
  const dev = devDir()
  mkdirSync(dev, { recursive: true })
  writeFileSync(path.join(dev, "progress-ledger.json"), JSON.stringify(ledger))
}

function writeDoneFiles(ids: string[]): void {
  const doneDir = path.join(devDir(), "issues", "done")
  mkdirSync(doneDir, { recursive: true })
  for (const id of ids) writeFileSync(path.join(doneDir, `${id}.md`), `# ${id}\n`)
}

function writeGate(name: string, status: string): void {
  const gatesDir = path.join(devDir(), "gates")
  mkdirSync(gatesDir, { recursive: true })
  writeFileSync(path.join(gatesDir, `${name}.json`), JSON.stringify({ status }))
}

function writeQuota(body: unknown): void {
  const reportsDir = path.join(devDir(), "reports")
  mkdirSync(reportsDir, { recursive: true })
  writeFileSync(path.join(reportsDir, "quota-state.json"), JSON.stringify(body))
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "vivicy-dev-status-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readDevStatusFromDisk — verdict ordering", () => {
  it("(1) DONE when every issue is done via a done/ file", () => {
    writeIndex({ issues: [{ id: "ISS-1" }, { id: "ISS-2" }] })
    writeDoneFiles(["ISS-1", "ISS-2"])

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("DONE")
    expect(status.issues_total).toBe(2)
    expect(status.issues_done).toBe(2)
    expect(status.done).toEqual(["ISS-1", "ISS-2"])
    expect(status.remaining).toEqual([])
  })

  it("(2) STOPPED (last gate failed) when some are done AND a gate is failing", () => {
    writeIndex({ issues: [{ id: "ISS-1" }, { id: "ISS-2" }, { id: "ISS-3" }] })
    writeDoneFiles(["ISS-1"])
    writeGate("gate-pass", "pass")
    writeGate("gate-fail", "fail")

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("STOPPED (last gate failed)")
    expect(status.issues_done).toBe(1)
    expect(status.gates).toEqual({ pass: 1, fail: 1 })
    expect(status.remaining).toEqual(["ISS-2", "ISS-3"])
  })

  it("(3) STOPPED (resume to continue) when some are done and no gate is failing", () => {
    writeIndex({ issues: [{ id: "ISS-1" }, { id: "ISS-2" }] })
    writeDoneFiles(["ISS-1"])
    writeGate("gate-pass", "pass")

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("STOPPED (resume to continue)")
    expect(status.issues_done).toBe(1)
    expect(status.gates).toEqual({ pass: 1, fail: 0 })
  })

  it("(4) NOT STARTED when nothing is done", () => {
    writeIndex({ issues: [{ id: "ISS-1" }, { id: "ISS-2" }] })

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("NOT STARTED")
    expect(status.issues_done).toBe(0)
    expect(status.done).toEqual([])
    expect(status.remaining).toEqual(["ISS-1", "ISS-2"])
  })

  it("NOT STARTED even with a failing gate when no issue is done (ordering: DONE>fail>resume, but fail needs doneIds<total which holds, yet the resume branch is skipped)", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    writeGate("gate-fail", "fail")

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("STOPPED (last gate failed)")
    expect(status.issues_done).toBe(0)
    expect(status.gates).toEqual({ pass: 0, fail: 1 })
  })

  it("DONE takes precedence over a failing gate when all issues are complete", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    writeDoneFiles(["ISS-1"])
    writeGate("gate-fail", "fail")

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("DONE")
    expect(status.gates).toEqual({ pass: 0, fail: 1 })
  })

  it("NOT STARTED when there are zero issues (DONE requires issues.length>0)", () => {
    writeIndex({ issues: [] })

    const status = readDevStatusFromDisk(root)
    expect(status.verdict).toBe("NOT STARTED")
    expect(status.issues_total).toBe(0)
    expect(status.issues_done).toBe(0)
  })
})

describe("readDevStatusFromDisk — per-issue done rule", () => {
  it("(5) counts an issue done when EVERY graph_ref is verified in the ledger (no done/ file)", () => {
    writeIndex({
      issues: [
        { id: "ISS-1", graph_refs: ["ref-a", "ref-b"] },
        { id: "ISS-2", graph_refs: ["ref-c"] },
      ],
    })
    writeLedger({
      graph_item_states: [
        { graph_ref: "ref-a", issue_states: { "ISS-1": "verified" } },
        { graph_ref: "ref-b", issue_states: { "ISS-1": "verified" } },
        { graph_ref: "ref-c", issue_states: { "ISS-2": "in_progress" } },
      ],
    })

    const status = readDevStatusFromDisk(root)
    expect(status.done).toEqual(["ISS-1"])
    expect(status.remaining).toEqual(["ISS-2"])
    expect(status.issues_done).toBe(1)
    expect(status.verdict).toBe("STOPPED (resume to continue)")
  })

  it("does NOT count an issue done when only SOME of its graph_refs are verified", () => {
    writeIndex({ issues: [{ id: "ISS-1", graph_refs: ["ref-a", "ref-b"] }] })
    writeLedger({
      graph_item_states: [
        { graph_ref: "ref-a", issue_states: { "ISS-1": "verified" } },
      ],
    })

    const status = readDevStatusFromDisk(root)
    expect(status.done).toEqual([])
    expect(status.verdict).toBe("NOT STARTED")
  })

  it("does NOT count an issue with an empty graph_refs list as done via the ledger (refs.length>0 guard)", () => {
    writeIndex({ issues: [{ id: "ISS-1", graph_refs: [] }] })
    writeLedger({ graph_item_states: [] })

    const status = readDevStatusFromDisk(root)
    expect(status.done).toEqual([])
    expect(status.verdict).toBe("NOT STARTED")
  })

  it("a done/ file wins even when the ledger shows the issue unverified", () => {
    writeIndex({ issues: [{ id: "ISS-1", graph_refs: ["ref-a"] }] })
    writeDoneFiles(["ISS-1"])
    writeLedger({
      graph_item_states: [{ graph_ref: "ref-a", issue_states: { "ISS-1": "in_progress" } }],
    })

    const status = readDevStatusFromDisk(root)
    expect(status.done).toEqual(["ISS-1"])
    expect(status.verdict).toBe("DONE")
  })

  it("ignores non-.md entries in the done/ dir", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    const doneDir = path.join(devDir(), "issues", "done")
    mkdirSync(doneDir, { recursive: true })
    writeFileSync(path.join(doneDir, "ISS-1.txt"), "not a done marker")

    const status = readDevStatusFromDisk(root)
    expect(status.done).toEqual([])
    expect(status.verdict).toBe("NOT STARTED")
  })

  it("surfaces active_items verbatim from the ledger", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    writeLedger({ active_items: [{ id: "ISS-1", actor: "claude" }] })

    const status = readDevStatusFromDisk(root)
    expect(status.active).toEqual([{ id: "ISS-1", actor: "claude" }])
  })
})

describe("readDevStatusFromDisk — gates counting", () => {
  it("counts pass/fail across multiple gate files and ignores other statuses", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    writeDoneFiles(["ISS-1"])
    writeGate("g1", "pass")
    writeGate("g2", "pass")
    writeGate("g3", "fail")
    writeGate("g4", "skipped")

    const status = readDevStatusFromDisk(root)
    expect(status.gates).toEqual({ pass: 2, fail: 1 })
  })

  it("reports zero gates when the gates dir is absent", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    const status = readDevStatusFromDisk(root)
    expect(status.gates).toEqual({ pass: 0, fail: 0 })
  })
})

describe("readDevStatusFromDisk — quota fallback", () => {
  it("(6) yields an empty agents map when quota-state.json is missing (no fabricated numbers)", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    const status = readDevStatusFromDisk(root)
    expect(status.quota).toEqual({ updated_at: null, agents: {} })
  })

  it("returns the real quota block when present", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    const block = {
      updated_at: "2026-06-25T00:00:00.000Z",
      agents: {
        claude: { model: "claude-opus-4-8", status: "available", reset_at: null, last_message: null },
      },
    }
    writeQuota(block)
    const status = readDevStatusFromDisk(root)
    expect(status.quota).toEqual(block)
  })

  it("falls back to an empty agents map when the quota file is malformed JSON", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    const reportsDir = path.join(devDir(), "reports")
    mkdirSync(reportsDir, { recursive: true })
    writeFileSync(path.join(reportsDir, "quota-state.json"), "{ broken")
    const status = readDevStatusFromDisk(root)
    expect(status.quota).toEqual({ updated_at: null, agents: {} })
  })

  it("repairs a quota object missing its agents map to the empty-agents fallback", () => {
    writeIndex({ issues: [{ id: "ISS-1" }] })
    writeQuota({ updated_at: "2026-06-25T00:00:00.000Z" })
    const status = readDevStatusFromDisk(root)
    expect(status.quota).toEqual({ updated_at: null, agents: {} })
  })
})

describe("readDevStatusFromDisk — missing/empty inputs", () => {
  it("returns a fully NOT STARTED snapshot when the development tree is entirely absent", () => {
    const status = readDevStatusFromDisk(root)
    expect(status).toMatchObject({
      verdict: "NOT STARTED",
      issues_total: 0,
      issues_done: 0,
      done: [],
      remaining: [],
      active: [],
      process_alive: false,
      idle_seconds: null,
      gates: { pass: 0, fail: 0 },
      quota: { updated_at: null, agents: {} },
    })
  })
})
