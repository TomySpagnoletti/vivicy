import assert from "node:assert/strict"
import test from "node:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"

import {
  ACCEPTANCE_REPORT_REL,
  ACCEPTANCE_VERDICT_REL,
  acceptanceStageNeeded,
  doneSetHash,
  issueTotals,
  runAcceptance,
} from "./acceptance.ts"
import type { SpawnAcceptanceLeg } from "./acceptance.ts"
import { readChangeRequests } from "./change-control.ts"

function makeRepo({ total = 2, done = total, baseline = true }: { total?: number; done?: number; baseline?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "vivicy-acceptance-"))
  const write = (rel: string, content: string): void => {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  const id = (i: number): string => `ISSUE-${String(i + 1).padStart(4, "0")}`
  write(".vivicy/development/issue-index.json", JSON.stringify({ issues: Array.from({ length: total }, (_, i) => ({ id: id(i) })) }))
  for (let i = 0; i < done; i += 1) write(`.vivicy/development/issues/done/${id(i)}.md`, `# ${id(i)}\n`)
  if (baseline) {
    write(
      ".vivicy/baselines/baseline-v1.0.0.json",
      JSON.stringify({ schema_version: 1, baseline_id: "baseline-v1.0.0", version: "1.0.0", status: "frozen", files: [] })
    )
  }
  return root
}

function verdictLeg(verdict: unknown, spy?: { calls: number }): SpawnAcceptanceLeg {
  return async ({ repoRoot, verdictRel }) => {
    if (spy) spy.calls += 1
    const abs = join(repoRoot, verdictRel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, JSON.stringify(verdict))
  }
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true })
}

function crCount(root: string): number {
  const dir = join(root, ".vivicy/change-requests")
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^CR-\d{4}-.*\.md$/.test(f)).length : 0
}

test("doneSetHash is stable and changes only when the done set changes", () => {
  const root = makeRepo({ total: 2 })
  try {
    const h1 = doneSetHash(root)
    assert.equal(doneSetHash(root), h1)
    writeFileSync(join(root, ".vivicy/development/issues/done/ISSUE-0003.md"), "# extra\n")
    assert.notEqual(doneSetHash(root), h1)
  } finally {
    cleanup(root)
  }
})

test("issueTotals reads the index length and the done/ count", () => {
  const root = makeRepo({ total: 3, done: 2 })
  try {
    assert.deepEqual(issueTotals(root), { done: 2, total: 3 })
  } finally {
    cleanup(root)
  }
})

test("acceptanceStageNeeded gates on applicability, settlement, baseline, and done-set", () => {
  const baseline = { manifestPath: ".vivicy/baselines/baseline-v1.0.0.json", baselineId: "baseline-v1.0.0" }
  const at = { done: 2, total: 2, doneSetHash: "abc" }
  assert.equal(acceptanceStageNeeded(baseline, null, { done: 1, total: 2, doneSetHash: "abc" }), false, "not all issues done")
  assert.equal(acceptanceStageNeeded(baseline, null, { done: 0, total: 0, doneSetHash: "abc" }), false, "no issues at all")
  assert.equal(acceptanceStageNeeded(null, null, at), false, "no frozen baseline")
  assert.equal(acceptanceStageNeeded(baseline, null, at), true, "no report yet")
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "green", baseline_id: "baseline-v1.0.0", done_set_hash: "abc" }, at),
    false,
    "settled green"
  )
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "findings", baseline_id: "baseline-v1.0.0", done_set_hash: "abc" }, at),
    false,
    "settled findings"
  )
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "checking", baseline_id: "baseline-v1.0.0", done_set_hash: "abc" }, at),
    true,
    "still running is not settled"
  )
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "failed", baseline_id: "baseline-v1.0.0", done_set_hash: "abc" }, at),
    true,
    "failed re-runs"
  )
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "green", baseline_id: "baseline-v0.9.0", done_set_hash: "abc" }, at),
    true,
    "baseline changed"
  )
  assert.equal(
    acceptanceStageNeeded(baseline, { phase: "green", baseline_id: "baseline-v1.0.0", done_set_hash: "zzz" }, at),
    true,
    "done-set changed"
  )
})

test("a clean verdict flips the acceptance report green and drafts no change requests", async () => {
  const root = makeRepo({ total: 2 })
  try {
    const report = await runAcceptance({
      repoRoot: root,
      spawnLeg: verdictLeg({
        accepted: true,
        scenarios: [
          { id: "happy", verification: "executed", result: "pass" },
          { id: "offline", verification: "read_only", result: "unverifiable_without_run_story" },
        ],
        findings: [],
      }),
    })
    assert.equal(report.phase, "green")
    assert.deepEqual(report.drafted_crs, [])
    assert.equal(report.read_only_scenarios, 1, "the read-only-verified scenario is recorded as the run-story seam")
    assert.equal(report.baseline_id, "baseline-v1.0.0")
    assert.equal(crCount(root), 0)
    const onDisk = JSON.parse(readFileSync(join(root, ACCEPTANCE_REPORT_REL), "utf8"))
    assert.equal(onDisk.phase, "green")
  } finally {
    cleanup(root)
  }
})

test("findings route to draft change requests, phase is findings, and Done is withheld", async () => {
  const root = makeRepo({ total: 2 })
  try {
    const report = await runAcceptance({
      repoRoot: root,
      spawnLeg: verdictLeg({
        accepted: false,
        scenarios: [{ id: "checkout", verification: "executed", result: "fail" }],
        findings: [
          {
            obligation: ".vivicy/canonical/04-checkout.md:20 (REQ-0012)",
            gap: "cart total excludes tax across the ISSUE-0007/ISSUE-0011 seam",
            title: "Checkout total must be tax-inclusive end to end",
            classification: "minor_product_change",
            verification: "executed",
          },
        ],
      }),
    })
    assert.equal(report.phase, "findings", "findings phase, never green")
    assert.notEqual(report.phase, "green", "Done is withheld")
    assert.equal(report.drafted_crs?.length, 1)
    assert.equal(report.findings?.[0]?.cr_id, report.drafted_crs?.[0])
    assert.equal(crCount(root), 1, "exactly one CR drafted via the existing change-control machinery")
    const cr = readChangeRequests(root)[0]
    assert.equal(cr.fm!.status, "idea")
    assert.match(readFileSync(join(root, ".vivicy/change-requests", cr.file), "utf8"), /tax-inclusive/)
  } finally {
    cleanup(root)
  }
})

test("an invalid proposed classification is coerced to minor_product_change (P5 — orchestrator enforces)", async () => {
  const root = makeRepo({ total: 1 })
  try {
    const report = await runAcceptance({
      repoRoot: root,
      spawnLeg: verdictLeg({
        accepted: false,
        findings: [{ gap: "a real whole-product gap", title: "Fix the seam", classification: "totally-bogus" }],
      }),
    })
    assert.equal(report.phase, "findings")
    assert.equal(readChangeRequests(root)[0].fm!.classification, "minor_product_change")
  } finally {
    cleanup(root)
  }
})

test("findings present override an accepted:true flag (the findings are ground truth)", async () => {
  const root = makeRepo({ total: 1 })
  try {
    const report = await runAcceptance({
      repoRoot: root,
      spawnLeg: verdictLeg({ accepted: true, findings: [{ gap: "contradiction the leg still flagged", title: "Resolve it" }] }),
    })
    assert.equal(report.phase, "findings")
    assert.equal(report.drafted_crs?.length, 1)
  } finally {
    cleanup(root)
  }
})

test("done < total is a loud failure, never a silent accept", async () => {
  const root = makeRepo({ total: 3, done: 2 })
  const spy = { calls: 0 }
  try {
    const report = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }, spy) })
    assert.equal(report.phase, "failed")
    assert.equal(spy.calls, 0, "the leg never runs when the product is not fully assembled")
    assert.match(report.summary ?? "", /done 2\/3/)
  } finally {
    cleanup(root)
  }
})

test("no frozen baseline is a loud failure", async () => {
  const root = makeRepo({ total: 2, baseline: false })
  try {
    const report = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }) })
    assert.equal(report.phase, "failed")
    assert.match(report.summary ?? "", /frozen baseline/)
  } finally {
    cleanup(root)
  }
})

test("a timed-out leg is a typed refusal (failed), never a green Done", async () => {
  const root = makeRepo({ total: 2 })
  try {
    const timeoutLeg: SpawnAcceptanceLeg = async () => ({ result: { timedOut: true, timeoutReason: "no output for 12m" } })
    const report = await runAcceptance({ repoRoot: root, spawnLeg: timeoutLeg })
    assert.equal(report.phase, "failed")
    assert.notEqual(report.phase, "green")
    assert.match(report.summary ?? "", /timed out/)
  } finally {
    cleanup(root)
  }
})

test("a missing or malformed verdict is a failure, not a green Done", async () => {
  const root = makeRepo({ total: 2 })
  try {
    const noWrite: SpawnAcceptanceLeg = async () => undefined
    const report = await runAcceptance({ repoRoot: root, spawnLeg: noWrite })
    assert.equal(report.phase, "failed")
    assert.match(report.summary ?? "", /no valid verdict/)
  } finally {
    cleanup(root)
  }
})

test("not-accepted with no actionable findings is unusable → failed", async () => {
  const root = makeRepo({ total: 2 })
  try {
    const report = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: false, findings: [] }) })
    assert.equal(report.phase, "failed")
    assert.match(report.summary ?? "", /no actionable findings/)
  } finally {
    cleanup(root)
  }
})

test("a routing failure (CR draft throws) fails loudly and does not report green", async () => {
  const root = makeRepo({ total: 1 })
  try {
    const report = await runAcceptance({
      repoRoot: root,
      spawnLeg: verdictLeg({ accepted: false, findings: [{ gap: "a gap", title: "T" }] }),
      createCr: () => {
        throw new Error("change-control rejected the draft")
      },
    })
    assert.equal(report.phase, "failed")
    assert.match(report.summary ?? "", /could not route/)
  } finally {
    cleanup(root)
  }
})

test("a settled report is not re-run unless forced (idempotent, no duplicate CRs)", async () => {
  const root = makeRepo({ total: 2 })
  const spy = { calls: 0 }
  try {
    const first = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }, spy) })
    assert.equal(first.phase, "green")
    assert.equal(spy.calls, 1)
    const second = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }, spy) })
    assert.equal(second.phase, "green")
    assert.equal(spy.calls, 1, "settled green is not re-run")
    const forced = await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }, spy), force: true })
    assert.equal(forced.phase, "green")
    assert.equal(spy.calls, 2, "force re-runs the leg (the retry-dev path)")
  } finally {
    cleanup(root)
  }
})

test("the leg writes its verdict to the reserved report path, not the committed report", async () => {
  const root = makeRepo({ total: 1 })
  try {
    await runAcceptance({ repoRoot: root, spawnLeg: verdictLeg({ accepted: true }) })
    assert.notEqual(
      ACCEPTANCE_VERDICT_REL,
      ACCEPTANCE_REPORT_REL,
      "the leg's proposal and the orchestrator's enforced report are distinct files"
    )
  } finally {
    cleanup(root)
  }
})

test("the acceptance summary agrees in number with what it counted", async () => {
  const one = makeRepo({ total: 1 })
  try {
    const green = await runAcceptance({
      repoRoot: one,
      spawnLeg: verdictLeg({ accepted: true, scenarios: [{ id: "happy", verification: "executed", result: "pass" }], findings: [] }),
    })
    assert.match(green.summary!, /\(1 scenario checked, 0 read-only-verified/)
  } finally {
    cleanup(one)
  }

  const many = makeRepo({ total: 2 })
  try {
    const green = await runAcceptance({
      repoRoot: many,
      spawnLeg: verdictLeg({
        accepted: true,
        scenarios: [
          { id: "happy", verification: "executed", result: "pass" },
          { id: "offline", verification: "read_only", result: "pending" },
        ],
        findings: [],
      }),
    })
    assert.match(green.summary!, /\(2 scenarios checked, 1 read-only-verified/)
  } finally {
    cleanup(many)
  }

  const gaps = makeRepo({ total: 2 })
  try {
    const single = await runAcceptance({
      repoRoot: gaps,
      spawnLeg: verdictLeg({ accepted: false, findings: [{ gap: "tax excluded", title: "Tax", classification: "minor_product_change" }] }),
    })
    assert.match(single.summary!, /^1 whole-product gap found; drafted /)

    const pair = await runAcceptance({
      repoRoot: gaps,
      force: true,
      spawnLeg: verdictLeg({
        accepted: false,
        findings: [
          { gap: "tax excluded", title: "Tax", classification: "minor_product_change" },
          { gap: "no receipt", title: "Receipt", classification: "minor_product_change" },
        ],
      }),
    })
    assert.match(pair.summary!, /^2 whole-product gaps found; drafted /)
  } finally {
    cleanup(gaps)
  }
})
