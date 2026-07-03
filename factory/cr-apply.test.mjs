// Unit tests for the CR APPLICATION chain (S11 / G7): the docs_applied automation for an
// APPROVED Change Request.
//
// The agent APPLY leg is ALWAYS faked (no real CLI is launched): the fake spawnApplier
// edits .vivicy/canonical/** as the real applier would. The orchestration is REAL — it
// reads the CR, runs the reference gate, freezes (faked, but writes a real manifest the
// change-control checker verifies), stamps the CR docs_applied via the REAL
// stampChangeRequestApplied (so change-control must accept the stamped file), then spawns
// extraction (faked). The report phases and the honest-block behaviour are asserted.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applyChangeRequest } from "./cr-apply.mjs";
import { readChangeRequest, runChangeControlCheck } from "./change-control.mjs";

let temp;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vivicy-cr-apply-test-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

const write = (rel, content) => {
  const abs = resolve(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
const read = (rel) => readFileSync(resolve(temp, rel), "utf8");

// A previous frozen manifest (the pre-change baseline the CR chains from). Only the fields
// the checker + cr-apply read need to be real; the checker verifies a manifest exists whose
// manifest_hash matches the CR's resulting_manifest_hash (for the NEW one, below).
function seedPreviousBaseline() {
  write(".vivicy/baselines/baseline-v1.0.0.json", JSON.stringify({
    schema_version: 1,
    baseline_id: "baseline-v1.0.0",
    version: "1.0.0",
    status: "frozen",
    document_set_hash: "prevdoc",
    manifest_hash: "prevmanifest",
    files: [{ path: ".vivicy/canonical/01-x.md", bytes: 1, sha256: "z" }],
  }, null, 2));
}

// A canonical doc so reference-check has an entry doc and the applier has something to edit.
function seedCanonical() {
  write(".vivicy/canonical/01-x.md", "# X\n\nThe product must do the original thing.\n");
}

// An approved CR (accepted_current_build) with the decided + previous_baseline_* fields the
// registry requires from that status onward, so it passes change-control before we apply it.
function seedApprovedCr(id = "CR-0001") {
  const fm = [
    "---",
    `id: ${id}`,
    "title: Change the thing",
    "status: accepted_current_build",
    "classification: minor_product_change",
    "created_at: 2026-07-01",
    "updated_at: 2026-07-01",
    "source: agent",
    "owner_decision: approved",
    "owner_decision_by: owner:ui",
    "owner_decision_at: 2026-07-01",
    "owner_decision_evidence: approved in the UI",
    "previous_baseline_id: baseline-v1.0.0",
    "previous_baseline_version: 1.0.0",
    "previous_baseline_manifest_path: .vivicy/baselines/baseline-v1.0.0.json",
    "previous_document_set_hash: prevdoc",
    "previous_manifest_hash: prevmanifest",
    "target_baseline_bump: null",
    "resulting_baseline_id: null",
    "resulting_baseline_version: null",
    "resulting_baseline_manifest_path: null",
    "resulting_document_set_hash: null",
    "resulting_manifest_hash: null",
    "affected_docs: []",
    "affected_issues: []",
    "affected_requirements: []",
    "affected_verification_gates: []",
    "issue_generation_required: false",
    "catalog_delta_required: false",
    "matrix_rows_pending: false",
    "supersedes: []",
    "superseded_by: null",
    "---",
    "",
    `# ${id} - Change the thing`,
    "",
    "## Idea",
    "",
    "Change the product to do the new thing.",
    "",
  ].join("\n");
  write(`.vivicy/change-requests/${id}-change-the-thing.md`, fm);
}

// A fake APPLY leg: folds an edit into the canonical (as the real applier would) and records
// every call so ordering/retries can be asserted.
function fakeApplier({ edit } = {}) {
  const calls = [];
  const spawnApplier = async (ctx) => {
    calls.push({ cr: ctx.cr.fm?.id, attempt: ctx.attempt, feedback: ctx.feedback });
    (edit ?? defaultEdit)();
    return { result: { status: 0 } };
  };
  return { spawnApplier, calls };
}
function defaultEdit() {
  // No-op file touch that keeps reference-check green (no broken links).
}

// A fake FREEZE that writes a REAL new manifest (so change-control's resulting-manifest-exists
// rule passes when the CR is stamped) and returns the identity cr-apply records.
function fakeFreeze({ onFreeze } = {}) {
  const calls = [];
  const runFreeze = async ({ repoRoot, version, previousVersion, approvedBy, approvalRef }) => {
    calls.push({ version, previousVersion, approvedBy, approvalRef });
    const baselineId = `baseline-v${version}`;
    const manifestHash = `manifest-${version}`;
    write(`.vivicy/baselines/${baselineId}.json`, JSON.stringify({
      schema_version: 1, baseline_id: baselineId, version, status: "frozen",
      document_set_hash: `doc-${version}`, manifest_hash: manifestHash,
      files: [{ path: ".vivicy/canonical/01-x.md", bytes: 1, sha256: "z2" }],
    }, null, 2));
    if (onFreeze) onFreeze();
    return { manifestPath: `.vivicy/baselines/${baselineId}.json`, baselineId, version, documentSetHash: `doc-${version}`, manifestHash };
  };
  return { runFreeze, calls };
}

// A fake EXTRACTION spawn (green by default). Records that it was invoked.
function fakeExtraction({ status = "green", reopened } = {}) {
  const calls = [];
  const runExtraction = async ({ repoRoot }) => {
    calls.push({ repoRoot });
    return { status, summary: `extraction ${status}`, ...(reopened ? { reopened } : {}) };
  };
  return { runExtraction, calls };
}

// Capture every recorded report snapshot (the running phase log + the terminal).
function reportSink() {
  const reports = [];
  return { recordReport: (r) => reports.push(structuredClone(r)), reports, phases: () => reports.map((r) => r.phase) };
}

describe("applyChangeRequest — happy path (green)", () => {
  it("folds the canonical, freezes a patch bump, stamps docs_applied, spawns extraction, records phases", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

    const { spawnApplier, calls: applyCalls } = fakeApplier();
    const { runFreeze, calls: freezeCalls } = fakeFreeze();
    const { runExtraction, calls: extractCalls } = fakeExtraction({ reopened: ["ISS-1"] });
    const sink = reportSink();

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport,
      commitApplied: () => ({ committed: true }),
      now: () => "2026-07-02T00:00:00.000Z",
    });

    // Terminal green.
    assert.equal(result.status, "green");
    assert.equal(result.cr, "CR-0001");
    assert.equal(result.baseline.baselineId, "baseline-v1.0.1", "patch bump 1.0.0 -> 1.0.1");

    // The APPLY leg ran once (green gate, no retry).
    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].feedback, null, "the first apply carries no repair feedback");

    // FREEZE used a patch bump from the CR's previous version, with the CR id as approval_ref
    // and the CR's owner as approved_by.
    assert.equal(freezeCalls.length, 1);
    assert.deepEqual(freezeCalls[0], { version: "1.0.1", previousVersion: "1.0.0", approvedBy: "owner:ui", approvalRef: "CR-0001" });

    // EXTRACTION was spawned (re-drive is intrinsic to it; the chain does not re-drive here).
    assert.equal(extractCalls.length, 1, "extraction spawn invoked exactly once");
    assert.equal(extractCalls[0].repoRoot, temp);

    // The CR is stamped docs_applied with the resulting baseline identity, and STILL passes
    // change-control (the stamped frontmatter is well-formed against the new manifest on disk).
    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr.fm.status, "docs_applied");
    assert.equal(cr.fm.resulting_baseline_id, "baseline-v1.0.1");
    assert.equal(cr.fm.resulting_manifest_hash, "manifest-1.0.1");
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0, "the stamped CR passes change-control");

    // The report progressed through the chain phases and ended green.
    const phases = sink.phases();
    for (const expected of ["apply", "verify", "freeze", "stamped", "extract", "green"]) {
      assert.ok(phases.includes(expected), `report recorded phase "${expected}" (saw ${phases.join(", ")})`);
    }
    assert.equal(sink.reports.at(-1).status, "green");

    // The report file was written to disk by the default recorder path only when used; here
    // we injected a sink, so assert the terminal object rather than the file.
    assert.match(result.summary, /re-drive reopened 1 impacted issue/);
  });

  it("commits the applied canonical edit BEFORE freezing (else doc-baseline refuses a dirty tree)", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

    // Shared order log: the commit MUST land before the freeze, or the real freeze
    // fails with "working tree clean: false" (the torture-run bug this locks).
    const order = [];
    const { spawnApplier } = fakeApplier();
    const { runExtraction } = fakeExtraction();
    const runFreeze = async ({ version }) => {
      order.push("freeze");
      const baselineId = `baseline-v${version}`;
      write(`.vivicy/baselines/${baselineId}.json`, JSON.stringify({
        schema_version: 1, baseline_id: baselineId, version, status: "frozen",
        document_set_hash: `doc-${version}`, manifest_hash: `manifest-${version}`,
        files: [{ path: ".vivicy/canonical/01-x.md", bytes: 1, sha256: "z2" }],
      }, null, 2));
      return { manifestPath: `.vivicy/baselines/${baselineId}.json`, baselineId, version, documentSetHash: `doc-${version}`, manifestHash: `manifest-${version}` };
    };

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction,
      commitApplied: () => { order.push("commit"); return { committed: true }; },
      recordReport: () => {},
    });

    assert.equal(result.status, "green");
    assert.deepEqual(order, ["commit", "freeze"], "commit must run before freeze");
  });

  it("blocks honestly when the applied edit cannot be committed", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();
    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction,
      commitApplied: () => ({ committed: false }),
      recordReport: () => {},
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.phase, "commit");
    // The CR stays accepted_current_build — NOT docs_applied — since the freeze never ran.
    assert.equal(readChangeRequest(temp, "CR-0001").fm.status, "accepted_current_build");
  });
});

describe("applyChangeRequest — a red reference-check blocks honestly", () => {
  it("leaves the CR accepted_current_build (NOT docs_applied) and reports blocked at verify", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

    // The applier "edit" breaks a canonical doc link, so reference-check stays red on BOTH
    // the initial attempt and the bounded retry.
    const { spawnApplier, calls: applyCalls } = fakeApplier({
      edit: () => write(".vivicy/canonical/01-x.md", "# X\n\nSee [gone](./02-missing.md).\n"),
    });
    const { runFreeze, calls: freezeCalls } = fakeFreeze();
    const { runExtraction, calls: extractCalls } = fakeExtraction();
    const sink = reportSink();

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.phase, "verify");
    // Bounded retry: the applier ran twice, the second attempt carrying the failure feedback.
    assert.equal(applyCalls.length, 2, "the apply leg retried once on the red gate");
    assert.ok(applyCalls[1].feedback, "the retry carried the reference-check failure feedback");
    assert.match(applyCalls[1].feedback, /reference-check FAILED/i);
    // The chain stopped BEFORE freeze/extraction — nothing downstream ran.
    assert.equal(freezeCalls.length, 0, "no freeze on a blocked apply");
    assert.equal(extractCalls.length, 0, "no extraction on a blocked apply");
    // The CR was NOT stamped — it stays accepted_current_build so a re-run resumes cleanly.
    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr.fm.status, "accepted_current_build", "the CR is not advanced to docs_applied on a block");
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0, "the untouched CR still passes change-control");
  });
});

describe("applyChangeRequest — blocked when extraction does not reach green", () => {
  it("stamps docs_applied (canonical is folded + re-frozen) but reports blocked at extract", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction, calls: extractCalls } = fakeExtraction({ status: "extraction_blocked" });
    const sink = reportSink();

    const result = await applyChangeRequest({ repoRoot: temp, id: "CR-0001", spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport, commitApplied: () => ({ committed: true }) });

    assert.equal(result.status, "blocked");
    assert.equal(result.phase, "extract");
    assert.equal(extractCalls.length, 1, "extraction was attempted");
    // The fold + freeze already happened, so the CR IS docs_applied (the baseline exists); the
    // block is honestly reported for the extraction, not a rollback of the freeze.
    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr.fm.status, "docs_applied");
    assert.match(result.summary, /re-extraction did not reach green/);
  });
});

describe("applyChangeRequest — refuses a CR that is not approved into the build", () => {
  it("blocks on an idea CR without touching it", async () => {
    seedPreviousBaseline();
    seedCanonical();
    // An idea CR (not accepted_current_build).
    write(".vivicy/change-requests/CR-0001-not-approved.md", [
      "---",
      "id: CR-0001",
      "title: not approved yet",
      "status: idea",
      "classification: minor_product_change",
      "created_at: 2026-07-01",
      "updated_at: 2026-07-01",
      "source: agent",
      "owner_decision: pending",
      "owner_decision_by: null",
      "owner_decision_at: null",
      "owner_decision_evidence: null",
      "previous_baseline_id: null",
      "previous_baseline_version: null",
      "previous_baseline_manifest_path: null",
      "previous_document_set_hash: null",
      "previous_manifest_hash: null",
      "supersedes: []",
      "superseded_by: null",
      "---",
      "",
      "# CR-0001 - not approved yet",
      "",
    ].join("\n"));

    const { spawnApplier, calls: applyCalls } = fakeApplier();
    const { runFreeze, calls: freezeCalls } = fakeFreeze();
    const { runExtraction } = fakeExtraction();
    const sink = reportSink();

    const result = await applyChangeRequest({ repoRoot: temp, id: "CR-0001", spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport, commitApplied: () => ({ committed: true }) });

    assert.equal(result.status, "blocked");
    assert.equal(result.phase, "resolve");
    assert.equal(applyCalls.length, 0, "no apply leg runs for an unapproved CR");
    assert.equal(freezeCalls.length, 0);
    assert.match(result.summary, /only runs on accepted_current_build/);
  });

  it("blocks on an unknown CR id", async () => {
    seedPreviousBaseline();
    seedCanonical();
    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();
    const result = await applyChangeRequest({ repoRoot: temp, id: "CR-9999", spawnApplier, runFreeze, runExtraction, recordReport: () => {} });
    assert.equal(result.status, "blocked");
    assert.match(result.summary, /no CR with id CR-9999/);
  });
});

describe("applyChangeRequest — default report recorder writes cr-apply-<id>.json", () => {
  it("persists the terminal report to the reports dir when no sink is injected", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();
    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();

    const result = await applyChangeRequest({ repoRoot: temp, id: "CR-0001", spawnApplier, runFreeze, runExtraction, commitApplied: () => ({ committed: true }) });

    assert.equal(result.status, "green");
    const reportRel = ".vivicy/development/reports/cr-apply-CR-0001.json";
    assert.ok(existsSync(resolve(temp, reportRel)), "the cr-apply report file exists");
    const report = JSON.parse(read(reportRel));
    assert.equal(report.status, "green");
    assert.equal(report.cr, "CR-0001");
  });
});
