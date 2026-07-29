import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  inspectDeclaredProofs,
  isProofSlug,
  parseDeclaredProofs,
  proofArtifactHomeRel,
  proofClass,
  PROOF_CLASSES,
  PROOF_CLASS_IDS,
  readIssueBodyFromDisk,
  readProofsByIssue,
} from "@/lib/proofs"

function issueFile(proofsBlock: string, { fence = true }: { fence?: boolean } = {}): string {
  return [
    "# ISSUE-0004 - Report a month",
    "",
    "## Verification",
    "",
    "Unit tests to full branch coverage.",
    "",
    "## Proofs",
    "",
    ...(fence ? ["```text", proofsBlock, "```"] : [proofsBlock]),
    "",
  ].join("\n")
}

const RUN_LOG_PROOF = ["- id: cli-report", "  class: run_log", "  evidences:", "    - .vivicy/canonical/06-cli.md:13-16"].join("\n")

const GATE_PROOF = ["- id: totals", "  class: gate_evidence", "  evidences:", "    - .vivicy/canonical/02-model.md:31"].join("\n")

describe("the proof-class taxonomy", () => {
  it("is a closed, proportional set: one class per honest observation shape", () => {
    expect(PROOF_CLASS_IDS).toEqual(["ui_flow", "http_transcript", "run_log", "gate_evidence"])
    expect(new Set(PROOF_CLASS_IDS).size).toBe(PROOF_CLASSES.length)
    for (const entry of PROOF_CLASSES) {
      expect(entry.obligation.length, `${entry.id} must say which obligation it fits`).toBeGreaterThan(20)
      expect(entry.production.length, `${entry.id} must say how it is produced`).toBeGreaterThan(20)
    }
    expect(proofClass("gate_evidence")?.production).toMatch(/never add a ritual artifact/)
    expect(proofClass("nope")).toBeNull()
  })
})

describe("parseDeclaredProofs", () => {
  it("reads the declared proofs of the issue file's Proofs block", () => {
    const parsed = parseDeclaredProofs(
      issueFile(
        [
          "- id: monthly-report-cli",
          "  class: run_log",
          "  evidences:",
          "    - .vivicy/canonical/04-reporting.md:21",
          "    - .vivicy/canonical/04-reporting.md:23-25",
          "- id: totals",
          "  class: gate_evidence",
          "  evidences:",
          "    - .vivicy/canonical/02-ledger-model.md:31",
        ].join("\n")
      )
    )
    expect(parsed.problems).toEqual([])
    expect(parsed.proofs).toEqual([
      {
        id: "monthly-report-cli",
        class: "run_log",
        evidences: [".vivicy/canonical/04-reporting.md:21", ".vivicy/canonical/04-reporting.md:23-25"],
      },
      { id: "totals", class: "gate_evidence", evidences: [".vivicy/canonical/02-ledger-model.md:31"] },
    ])
  })

  it("reads a CRLF-authored issue file identically — the boundary is normalized once, never left to chance", () => {
    const crlf = parseDeclaredProofs(issueFile(RUN_LOG_PROOF).replace(/\n/g, "\r\n"))
    expect(crlf.problems).toEqual([])
    expect(crlf.proofs).toEqual([{ id: "cli-report", class: "run_log", evidences: [".vivicy/canonical/06-cli.md:13-16"] }])
  })

  it("declares nothing silently only when NO Proofs section is reachable (absent, or quoted inside a closed fence)", () => {
    expect(parseDeclaredProofs("# ISSUE-0001\n\n## Verification\n\nunit tests\n")).toEqual({
      proofs: [],
      problems: [],
    })
    expect(parseDeclaredProofs(null)).toEqual({ proofs: [], problems: [] })
    expect(parseDeclaredProofs(undefined)).toEqual({ proofs: [], problems: [] })
  })

  it("REFUSES a section the machine cannot read instead of silently declaring nothing", () => {
    const asProse = parseDeclaredProofs(
      issueFile("- a run log of the CLI proving the report command\n- screenshots of the dashboard", { fence: false })
    )
    expect(asProse.proofs).toEqual([])
    expect(asProse.problems[0]).toMatch(/carries no closed, non-empty `text` block/)

    const empty = parseDeclaredProofs(issueFile(""))
    expect(empty.proofs).toEqual([])
    expect(empty.problems[0]).toMatch(/carries no closed, non-empty `text` block/)

    const unterminated = parseDeclaredProofs("# ISSUE\n\n## Proofs\n\n```text\n- id: shot\n")
    expect(unterminated.problems[0]).toMatch(/carries no closed, non-empty `text` block/)
  })

  it("never reaches past its own section: a fence-less Proofs section cannot swallow the next section's block", () => {
    const parsed = parseDeclaredProofs(
      [
        "# ISSUE-0008 - CLI",
        "",
        "## Proofs",
        "",
        "See the CLI run log.",
        "",
        "## Traceability",
        "",
        "```text",
        "issue_id: ISSUE-0008",
        "graph_refs:",
        "  - node:cli",
        "```",
        "",
      ].join("\n")
    )
    expect(parsed.proofs).toEqual([])
    expect(parsed.problems).toEqual([expect.stringMatching(/carries no closed, non-empty `text` block/)])
  })

  it("reports declaration content that sits OUTSIDE the one block — a half-read declaration must never look honest", () => {
    const afterFence = parseDeclaredProofs(
      [
        "# ISSUE-0008 - CLI",
        "",
        "## Proofs",
        "",
        "```text",
        RUN_LOG_PROOF,
        "```",
        "",
        "- id: forgotten-second-proof",
        "  class: ui_flow",
        "  evidences:",
        "    - .vivicy/canonical/06-cli.md:20",
        "",
      ].join("\n")
    )
    expect(
      afterFence.proofs.map((p) => p.id),
      "the block itself still parses"
    ).toEqual(["cli-report"])
    expect(afterFence.problems[0]).toMatch(/declaration content outside its one `text` block/)

    const secondBlock = parseDeclaredProofs(
      ["# ISSUE", "", "## Proofs", "", "```text", RUN_LOG_PROOF, "```", "", "```text", "- id: second", "```", ""].join("\n")
    )
    expect(secondBlock.problems[0]).toMatch(/declaration content outside its one `text` block/)

    const spacedInfoString = parseDeclaredProofs(["# ISSUE", "", "## Proofs", "", "``` text", RUN_LOG_PROOF, "```", ""].join("\n"))
    expect(spacedInfoString.problems, "a space before the info string is still a fence (CommonMark)").toEqual([])
    expect(spacedInfoString.proofs.map((p) => p.id)).toEqual(["cli-report"])
  })

  it("recognizes every CommonMark heading shape, and REFUSES a section an unterminated fence swallowed", () => {
    const indented = parseDeclaredProofs(["# ISSUE", "", "   ## Proofs", "", "```text", RUN_LOG_PROOF, "```", ""].join("\n"))
    expect(indented.problems, "up to three leading spaces is still an ATX heading").toEqual([])
    expect(indented.proofs.map((p) => p.id)).toEqual(["cli-report"])

    const closedAtx = parseDeclaredProofs(["# ISSUE", "", "## Proofs ##", "", "```text", RUN_LOG_PROOF, "```", ""].join("\n"))
    expect(closedAtx.problems, "a closing run of #s is still an ATX heading").toEqual([])
    expect(closedAtx.proofs.map((p) => p.id)).toEqual(["cli-report"])

    const swallowed = parseDeclaredProofs(
      ["# ISSUE", "", "## Verification", "", "```text", "an unterminated fence", "", "## Proofs", "", RUN_LOG_PROOF, ""].join("\n")
    )
    expect(swallowed.proofs).toEqual([])
    expect(swallowed.problems[0], "a section hidden by an earlier unterminated fence is a defect, never silence").toMatch(
      /inside an unterminated code fence/
    )

    const nextSectionIndented = parseDeclaredProofs(
      ["# ISSUE", "", "## Proofs", "", "  ### Notes", "", "```text", RUN_LOG_PROOF, "```", ""].join("\n")
    )
    expect(nextSectionIndented.problems[0], "the section ends at the next heading of ANY level, so a later block is never adopted").toMatch(
      /carries no closed, non-empty `text` block/
    )
  })

  it("ignores a Proofs heading quoted inside another fenced block", () => {
    expect(
      parseDeclaredProofs(
        ["# ISSUE-0008 - CLI", "", "## Verification", "", "```text", "## Proofs", "- id: not-a-declaration", "```", ""].join("\n")
      )
    ).toEqual({ proofs: [], problems: [] })
  })

  it("reports every malformed declaration instead of silently declaring nothing", () => {
    const unknownClass = parseDeclaredProofs(issueFile("- id: shot\n  class: vibes\n  evidences:\n    - .vivicy/canonical/01-a.md:3"))
    expect(unknownClass.proofs).toEqual([])
    expect(unknownClass.problems[0]).toMatch(/unknown class "vibes"/)

    const noClass = parseDeclaredProofs(issueFile("- id: shot\n  evidences:\n    - .vivicy/canonical/01-a.md:3"))
    expect(noClass.problems[0]).toMatch(/declares no class/)

    const noEvidence = parseDeclaredProofs(issueFile("- id: shot\n  class: run_log"))
    expect(noEvidence.problems[0]).toMatch(/cites no canonical line/)

    const badRef = parseDeclaredProofs(issueFile("- id: shot\n  class: run_log\n  evidences:\n    - src/index.js:3"))
    expect(badRef.problems[0]).toMatch(/not a \.vivicy\/canonical/)

    const dotDotRef = parseDeclaredProofs(
      issueFile("- id: shot\n  class: run_log\n  evidences:\n    - .vivicy/canonical/../../etc/passwd.md:1")
    )
    expect(dotDotRef.proofs).toEqual([])
    expect(dotDotRef.problems[0]).toMatch(/not a \.vivicy\/canonical/)

    const duplicate = parseDeclaredProofs(
      issueFile(
        [
          "- id: shot",
          "  class: run_log",
          "  evidences:",
          "    - .vivicy/canonical/01-a.md:3",
          "- id: shot",
          "  class: run_log",
          "  evidences:",
          "    - .vivicy/canonical/01-a.md:4",
        ].join("\n")
      )
    )
    expect(duplicate.proofs).toHaveLength(1)
    expect(duplicate.problems[0]).toMatch(/duplicate proof id/)

    const stray = parseDeclaredProofs(issueFile("class: run_log"))
    expect(stray.problems[0]).toMatch(/before the first "- id:/)

    const garbage = parseDeclaredProofs(issueFile("- id: shot\n  class: run_log\n  recipe: npm run dev"))
    expect(garbage.problems.some((p) => /unparseable proofs line "recipe: npm run dev"/.test(p))).toBe(true)
  })

  it("refuses a proof id that could escape the proofs directory or blow the path length", () => {
    expect(isProofSlug("cli-run")).toBe(true)
    expect(isProofSlug("v1.2_shot-a")).toBe(true)
    for (const hostile of ["../escape", "a/b", "..", ".hidden", "-lead", "", "a..b", "x".repeat(65)]) {
      expect(isProofSlug(hostile), `${hostile} must not be a proof slug`).toBe(false)
    }
    const escaped = parseDeclaredProofs(
      issueFile("- id: ../../etc/passwd\n  class: run_log\n  evidences:\n    - .vivicy/canonical/01-a.md:3")
    )
    expect(escaped.proofs).toEqual([])
    expect(escaped.problems[0]).toMatch(/is not a safe slug/)
  })
})

describe("proofArtifactHomeRel", () => {
  it("derives the per-proof home, and points a gate_evidence proof at the gate record itself", () => {
    expect(proofArtifactHomeRel({ id: "cli-run", class: "run_log", evidences: [] }, "ISSUE-0008")).toBe(
      ".vivicy/development/proofs/ISSUE-0008/cli-run"
    )
    expect(proofArtifactHomeRel({ id: "totals", class: "gate_evidence", evidences: [] }, "ISSUE-0003")).toBe(
      ".vivicy/development/gates/ISSUE-0003-gate.json"
    )
    expect(
      proofArtifactHomeRel({ id: "cli-run", class: "run_log", evidences: [] }, "ISSUE-0008", {
        proofsDir: "scratch/proofs",
        gatesDir: "scratch/gates",
      })
    ).toBe("scratch/proofs/ISSUE-0008/cli-run")
  })
})

let root: string

function write(rel: string, contents: string): void {
  const abs = path.join(root, ...rel.split("/"))
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, contents)
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "vivicy-proofs-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("inspectDeclaredProofs", () => {
  it("reports a proof as produced only once BOTH its artifact and its replayable recipe are on disk", () => {
    const inspect = () => inspectDeclaredProofs({ targetRoot: root, issueId: "ISSUE-0008", body: issueFile(RUN_LOG_PROOF) })

    expect(inspect().statuses[0]).toMatchObject({
      id: "cli-report",
      class: "run_log",
      path: ".vivicy/development/proofs/ISSUE-0008/cli-report",
      produced: false,
      recipe: false,
      artifacts: [],
    })

    write(".vivicy/development/proofs/ISSUE-0008/cli-report/report.log", "total 1234\n")
    expect(inspect().statuses[0], "an artifact with no recipe is not replayable, so not a proof").toMatchObject({
      produced: false,
      recipe: false,
      artifacts: ["report.log"],
    })

    write(".vivicy/development/proofs/ISSUE-0008/cli-report/recipe.txt", "node src/cli.js report 2026-01\n")
    expect(inspect().statuses[0]).toMatchObject({
      produced: true,
      recipe: true,
      artifacts: ["recipe.txt", "report.log"],
    })
  })

  it("counts a nested capture, ignores an empty placeholder, and refuses a symlinked stand-in", () => {
    write(".vivicy/development/proofs/ISSUE-0008/cli-report/recipe.txt", "node src/cli.js report 2026-01\n")
    write(".vivicy/development/proofs/ISSUE-0008/cli-report/empty.log", "")
    const inspect = () => inspectDeclaredProofs({ targetRoot: root, issueId: "ISSUE-0008", body: issueFile(RUN_LOG_PROOF) }).statuses[0]
    expect(inspect()).toMatchObject({ produced: false, artifacts: ["recipe.txt"] })

    write("elsewhere/other-run.log", "someone else's output\n")
    symlinkSync(
      path.join(root, "elsewhere/other-run.log"),
      path.join(root, ".vivicy/development/proofs/ISSUE-0008/cli-report/observed.log")
    )
    expect(inspect(), "a symlink to another file is not an observation this run produced").toMatchObject({
      produced: false,
      artifacts: ["recipe.txt"],
    })

    write(".vivicy/development/proofs/ISSUE-0008/cli-report/screens/desktop.png", "png-bytes")
    expect(inspect()).toMatchObject({ produced: true, artifacts: ["recipe.txt", "screens/desktop.png"] })
  })

  it("takes a gate_evidence proof from the green gate record itself — no ritual artifact", () => {
    const inspect = () => inspectDeclaredProofs({ targetRoot: root, issueId: "ISSUE-0003", body: issueFile(GATE_PROOF) }).statuses[0]

    expect(inspect()).toMatchObject({
      path: ".vivicy/development/gates/ISSUE-0003-gate.json",
      produced: false,
      artifacts: [],
    })

    write(
      ".vivicy/development/gates/ISSUE-0003-gate.json",
      JSON.stringify({ gate_id: "gate:test:totals", status: "fail", exit_code: 1, command: "npm test" })
    )
    expect(inspect(), "a red gate observes nothing worth calling a proof").toMatchObject({ produced: false })

    write(
      ".vivicy/development/gates/ISSUE-0003-gate.json",
      JSON.stringify({ gate_id: "gate:test:totals", status: "pass", exit_code: 0, command: "npm test" })
    )
    expect(inspect()).toMatchObject({ produced: true, recipe: true, artifacts: ["ISSUE-0003-gate.json"] })

    write(
      ".vivicy/development/gates/ISSUE-0003-gate.json",
      JSON.stringify({ gate_id: "gate:test:totals", status: "pass", exit_code: 0, command: null })
    )
    expect(inspect(), "a gate record with no command carries no replayable recipe").toMatchObject({
      produced: false,
      recipe: false,
    })
  })

  it("resolves against the caller's gate/proof directories and surfaces declaration problems", () => {
    write("scratch/gates/ISSUE-0003-gate.json", JSON.stringify({ status: "pass", command: "go test ./..." }))
    const scoped = inspectDeclaredProofs({
      targetRoot: root,
      issueId: "ISSUE-0003",
      body: issueFile(GATE_PROOF),
      dirs: { proofsDir: "scratch/proofs", gatesDir: "scratch/gates" },
    })
    expect(scoped.statuses[0]).toMatchObject({ path: "scratch/gates/ISSUE-0003-gate.json", produced: true })

    const malformed = inspectDeclaredProofs({
      targetRoot: root,
      issueId: "ISSUE-0008",
      body: issueFile("- id: cli-report\n  class: vibes"),
    })
    expect(malformed.statuses).toEqual([])
    expect(malformed.problems[0]).toMatch(/unknown class "vibes"/)
  })
})

describe("readIssueBodyFromDisk", () => {
  it("finds the issue file whether it is still open or already in done/, and refuses an unsafe id", () => {
    write(".vivicy/development/issues/ISSUE-0008.md", "# ISSUE-0008 open\n")
    write(".vivicy/development/issues/done/ISSUE-0003.md", "# ISSUE-0003 done\n")
    expect(readIssueBodyFromDisk(root, "ISSUE-0008")).toMatch(/open/)
    expect(readIssueBodyFromDisk(root, "ISSUE-0003")).toMatch(/done/)
    expect(readIssueBodyFromDisk(root, "ISSUE-9999")).toBeNull()
    // Plant the file exactly where the unguarded join would land (.vivicy/development/issues/../../etc/passwd.md), so the guard is what refuses it — not a missing file.
    write(".vivicy/etc/passwd.md", "root:x:0:0\n")
    expect(
      readIssueBodyFromDisk(root, "../../etc/passwd"),
      "an id is never trusted into a path, even when the traversal target exists"
    ).toBeNull()
    write(".vivicy/development/issues/ISSUE-0009.md", "")
    expect(readIssueBodyFromDisk(root, "ISSUE-0009"), "an empty issue file is not a readable declaration").toBeNull()
  })
})

describe("readProofsByIssue", () => {
  it("reads both open and done issues, keyed by issue id, skipping issues that declare none", () => {
    write(".vivicy/development/issues/ISSUE-0008.md", issueFile(RUN_LOG_PROOF))
    write(".vivicy/development/issues/done/ISSUE-0003.md", issueFile(GATE_PROOF))
    write(".vivicy/development/issues/ISSUE-0002.md", "# ISSUE-0002\n\n## Verification\n\nunit tests\n")
    write(".vivicy/development/gates/ISSUE-0003-gate.json", JSON.stringify({ status: "pass", command: "npm test" }))

    const byIssue = readProofsByIssue(root)
    expect(byIssue.map((entry) => entry.issue_id)).toEqual(["ISSUE-0003", "ISSUE-0008"])
    expect(byIssue[0].proofs[0]).toMatchObject({ id: "totals", produced: true })
    expect(byIssue[1].proofs[0]).toMatchObject({ id: "cli-report", produced: false })
  })

  it("is empty and never throws on a target with no issues on disk", () => {
    expect(readProofsByIssue(root)).toEqual([])
    expect(readProofsByIssue(path.join(root, "nope"))).toEqual([])
  })
})
