import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import { changedBehaviorFilesSince, computeBehaviorFingerprint, MATRIX_FILE, readStamp, REPO_ROOT } from "./test-matrix"

const CASE_RE = /^- \[([a-z0-9-]+(?:\.[a-z0-9-]+)*)\.([A-Za-z0-9-]+)\]/
const TABLE_ROW_RE = /^\| ([a-z0-9.-]+) \| (\d+) \| (\d+) \| (\d+) \|$/
const TOTAL_ROW_RE = /^\| \*\*TOTAL\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \|$/

function areaOfId(idPrefix: string): string {
  return idPrefix.replace(/\./g, "-")
}

function parseMatrix() {
  const text = readFileSync(path.join(REPO_ROOT, MATRIX_FILE), "utf8")
  const lines = text.split("\n")
  const table = new Map<string, { cases: number; gaps: number; covered: number }>()
  let total: { cases: number; gaps: number; covered: number } | null = null
  const counted = new Map<string, { cases: number; gaps: number }>()
  const ids = new Map<string, number>()

  for (const line of lines) {
    const row = line.match(TABLE_ROW_RE)
    if (row) table.set(row[1], { cases: Number(row[2]), gaps: Number(row[3]), covered: Number(row[4]) })
    const totalRow = line.match(TOTAL_ROW_RE)
    if (totalRow) total = { cases: Number(totalRow[1]), gaps: Number(totalRow[2]), covered: Number(totalRow[3]) }
    const bullet = line.match(CASE_RE)
    if (bullet) {
      const area = areaOfId(bullet[1])
      const id = `${bullet[1]}.${bullet[2]}`
      ids.set(id, (ids.get(id) ?? 0) + 1)
      const bucket = counted.get(area) ?? { cases: 0, gaps: 0 }
      bucket.cases += 1
      if (line.includes("GAP")) bucket.gaps += 1
      counted.set(area, bucket)
    }
  }
  return { table, total, counted, ids }
}

describe("TEST-MATRIX reconciliation guard", () => {
  it("the behavior fingerprint is stamped and matches the current source tree (code changed => reconcile the matrix, then `npm run matrix:stamp`)", () => {
    const stamp = readStamp()
    expect(stamp, "no `Reconciled fingerprint:` line in test/TEST-MATRIX.md — run `npm run matrix:stamp` after reconciling").toBeTruthy()
    const current = computeBehaviorFingerprint()
    if (stamp!.fingerprint !== current) {
      const changed = changedBehaviorFilesSince(stamp!.commit)
      expect.fail(`behavior sources changed since the last matrix reconciliation (stamped @ ${stamp!.commit.slice(0, 12)}). Reconcile test/TEST-MATRIX.md for these files, then run \`npm run matrix:stamp\`:\n${changed.map((f) => `  - ${f}`).join("\n") || "  (delta unavailable — no git baseline; check your working tree)"}`)
    }
  })

  it("case ids are globally unique", () => {
    const { ids } = parseMatrix()
    const dupes = [...ids.entries()].filter(([, n]) => n > 1).map(([id]) => id)
    expect(dupes, `duplicate case ids: ${dupes.join(", ")}`).toEqual([])
  })

  it("the status table matches the actual per-area bullet and GAP counts", () => {
    const { table, total, counted } = parseMatrix()
    expect(table.size).toBeGreaterThan(0)
    expect(total).not.toBeNull()
    const mismatches: string[] = []
    for (const [area, row] of table) {
      const actual = counted.get(area) ?? { cases: 0, gaps: 0 }
      if (actual.cases !== row.cases) mismatches.push(`${area}: table says ${row.cases} cases, found ${actual.cases}`)
      if (actual.gaps !== row.gaps) mismatches.push(`${area}: table says ${row.gaps} gaps, found ${actual.gaps}`)
      if (row.covered !== row.cases - row.gaps) mismatches.push(`${area}: covered ${row.covered} != cases ${row.cases} - gaps ${row.gaps}`)
    }
    for (const area of counted.keys()) {
      if (!table.has(area)) mismatches.push(`${area}: cases exist but area missing from the status table`)
    }
    const sum = [...table.values()].reduce((acc, r) => ({ cases: acc.cases + r.cases, gaps: acc.gaps + r.gaps, covered: acc.covered + r.covered }), { cases: 0, gaps: 0, covered: 0 })
    if (total && (total.cases !== sum.cases || total.gaps !== sum.gaps || total.covered !== sum.covered)) {
      mismatches.push(`TOTAL row (${total.cases}/${total.gaps}/${total.covered}) != column sums (${sum.cases}/${sum.gaps}/${sum.covered})`)
    }
    expect(mismatches, mismatches.join("\n")).toEqual([])
  })
})
