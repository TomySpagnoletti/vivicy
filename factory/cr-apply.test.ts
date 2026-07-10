import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { applyChangeRequest } from "./cr-apply.ts";
import type { ApplyChangeRequestArgs } from "./cr-apply.ts";
import { readChangeRequest, runChangeControlCheck } from "./change-control.ts";
import { readSpikes, transitivelyVerifiedGates } from "./spike-check.ts";

let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vivicy-cr-apply-test-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

const write = (rel: string, content: string) => {
  const abs = resolve(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
};
const read = (rel: string) => readFileSync(resolve(temp, rel), "utf8");

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

function seedCanonical() {
  write(".vivicy/canonical/01-x.md", "# X\n\nThe product must do the original thing.\n");
}

function seedSpike(filename: string, { status = "failed", reqId = "REQ-ARCH-001" }: { status?: string; reqId?: string } = {}) {
  const slug = filename.replace(/\.md$/, "");
  write(`.vivicy/development/spikes/${filename}`, [
    `# S - ${slug}`,
    "",
    "## Traceability",
    "",
    "```text",
    `requirement_ids: ${reqId}`,
    `gate_id: gate:phase0:s${slug}`,
    `status: ${status}`,
    "```",
    "",
    "## Question",
    "",
    "Does the provider behave as assumed?",
    "",
    "## Must Verify",
    "",
    "- [Live test required: ...] the assumption",
    "",
    "## Evidence Required",
    "",
    "```text",
    "environment: (recorded)",
    "```",
    "",
  ].join("\n"));
  return { file: `.vivicy/development/spikes/${filename}`, gate_id: `gate:phase0:s${slug}` };
}

function seedApprovedCr(id = "CR-0001", { affectedGates = [] }: { affectedGates?: string[] } = {}) {
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
    `affected_verification_gates: [${affectedGates.join(", ")}]`,
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

function fakeApplier({ edit }: { edit?: () => void } = {}) {
  const calls: Array<{ cr: unknown; attempt: number; feedback: string | null }> = [];
  const spawnApplier: NonNullable<ApplyChangeRequestArgs["spawnApplier"]> = async (ctx) => {
    calls.push({ cr: ctx.cr.fm?.id, attempt: ctx.attempt, feedback: ctx.feedback });
    (edit ?? defaultEdit)();
    return { result: { status: 0 } };
  };
  return { spawnApplier, calls };
}
function defaultEdit() {
}

function fakeFreeze({ onFreeze }: { onFreeze?: () => void } = {}) {
  const calls: Array<{ version: string; previousVersion: string; approvedBy: string; approvalRef: string }> = [];
  const runFreeze: NonNullable<ApplyChangeRequestArgs["runFreeze"]> = async ({ repoRoot, version, previousVersion, approvedBy, approvalRef }) => {
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

function fakeExtraction({ status = "green", reopened }: { status?: string; reopened?: string[] } = {}) {
  const calls: Array<{ repoRoot: string }> = [];
  const runExtraction: NonNullable<ApplyChangeRequestArgs["runExtraction"]> = async ({ repoRoot }) => {
    calls.push({ repoRoot });
    return { status, summary: `extraction ${status}`, ...(reopened ? { reopened } : {}) };
  };
  return { runExtraction, calls };
}

function reportSink() {
  const reports: Array<Record<string, unknown>> = [];
  return { recordReport: (r: Record<string, unknown>) => reports.push(structuredClone(r)), reports, phases: () => reports.map((r) => r.phase) };
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

    assert.equal(result.status, "green");
    assert.equal(result.cr, "CR-0001");
    assert.equal(result.baseline!.baselineId, "baseline-v1.0.1", "patch bump 1.0.0 -> 1.0.1");

    assert.equal(applyCalls.length, 1);
    assert.equal(applyCalls[0].feedback, null, "the first apply carries no repair feedback");

    assert.equal(freezeCalls.length, 1);
    assert.deepEqual(freezeCalls[0], { version: "1.0.1", previousVersion: "1.0.0", approvedBy: "owner:ui", approvalRef: "CR-0001" });

    assert.equal(extractCalls.length, 1, "extraction spawn invoked exactly once");
    assert.equal(extractCalls[0].repoRoot, temp);

    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr!.fm!.status, "docs_applied");
    assert.equal(cr!.fm!.resulting_baseline_id, "baseline-v1.0.1");
    assert.equal(cr!.fm!.resulting_manifest_hash, "manifest-1.0.1");
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0, "the stamped CR passes change-control");

    const phases = sink.phases();
    for (const expected of ["apply", "verify", "freeze", "stamped", "extract", "green"]) {
      assert.ok(phases.includes(expected), `report recorded phase "${expected}" (saw ${phases.join(", ")})`);
    }
    assert.equal(sink.reports.at(-1)!.status, "green");

    assert.match(result.summary, /reopened 1 impacted issue/);
  });

  it("commits the applied canonical edit BEFORE freezing (else doc-baseline refuses a dirty tree)", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

    const order: string[] = [];
    const { spawnApplier } = fakeApplier();
    const { runExtraction } = fakeExtraction();
    const runFreeze: NonNullable<ApplyChangeRequestArgs["runFreeze"]> = async ({ version }) => {
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
    assert.equal(readChangeRequest(temp, "CR-0001")!.fm!.status, "accepted_current_build");
  });
});

describe("applyChangeRequest — retires the disproven spike(s) the CR folds (failed -> deferred)", () => {
  it("flips a failed spike named on affected_verification_gates to deferred BEFORE re-extraction, and leaves unnamed spikes untouched", async () => {
    seedPreviousBaseline();
    seedCanonical();
    const target = seedSpike("s01-argon2id-node-crypto.md", { status: "failed" });
    const bystander = seedSpike("s02-other.md", { status: "failed", reqId: "REQ-ARCH-002" });
    seedApprovedCr("CR-0001", { affectedGates: [target.gate_id] });

    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    let statusAtExtraction: string | null = null;
    let bystanderAtExtraction: string | null = null;
    const runExtraction: NonNullable<ApplyChangeRequestArgs["runExtraction"]> = async ({ repoRoot }) => {
      statusAtExtraction = readSpikes(repoRoot).find((s) => s.gate_id === target.gate_id)?.status ?? null;
      bystanderAtExtraction = readSpikes(repoRoot).find((s) => s.gate_id === bystander.gate_id)?.status ?? null;
      return { status: "green", summary: "extraction green" };
    };
    const commits: string[] = [];
    const sink = reportSink();

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport,
      commitApplied: ({ id }) => { commits.push(id); return { committed: true }; },
      now: () => "2026-07-02T00:00:00.000Z",
    });

    assert.equal(result.status, "green");
    assert.equal(statusAtExtraction, "deferred", "the disproven spike is deferred before re-extraction spawns");
    assert.equal(readSpikes(temp).find((s) => s.gate_id === target.gate_id)?.status, "deferred");
    assert.equal(bystanderAtExtraction, "failed", "a spike not named on the CR is not retired");
    assert.equal(readSpikes(temp).find((s) => s.gate_id === bystander.gate_id)?.status, "failed");
    const retireReport = sink.reports.find((r) => r.phase === "retire_spikes");
    assert.ok(retireReport, "a retire_spikes phase was recorded");
    assert.deepEqual(retireReport.retired, [target.gate_id]);
    assert.equal(commits.length, 2, "the fold commit and the retirement commit both ran");
  });

  it("a deferred spike does NOT count as unverified-blocking in the G13 path (transitivelyVerifiedGates)", async () => {
    seedPreviousBaseline();
    seedCanonical();
    const target = seedSpike("s01-argon2id-node-crypto.md", { status: "failed" });
    seedApprovedCr("CR-0001", { affectedGates: [target.gate_id] });

    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();

    const blockingBefore = readSpikes(temp)
      .filter((s) => s.status !== "deferred" && !transitivelyVerifiedGates(temp).has(s.gate_id))
      .map((s) => s.gate_id);
    assert.deepEqual(blockingBefore, [target.gate_id], "the failed spike blocks G13 before the fold");

    await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction,
      commitApplied: () => ({ committed: true }), recordReport: () => {},
    });

    assert.equal(readSpikes(temp).find((s) => s.gate_id === target.gate_id)?.status, "deferred");
    const blockingAfter = readSpikes(temp)
      .filter((s) => s.status !== "deferred" && !transitivelyVerifiedGates(temp).has(s.gate_id))
      .map((s) => s.gate_id);
    assert.deepEqual(blockingAfter, [], "the retired (deferred) spike is non-blocking in G13");
  });

  it("leaves a spike alone when the CR names its gate but the spike is NOT failed (no verified/pending downgrade)", async () => {
    seedPreviousBaseline();
    seedCanonical();
    const verified = seedSpike("s01-provider-auth.md", { status: "verified" });
    seedApprovedCr("CR-0001", { affectedGates: [verified.gate_id] });

    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();
    const sink = reportSink();

    const result = await applyChangeRequest({
      repoRoot: temp, id: "CR-0001",
      spawnApplier, runFreeze, runExtraction, recordReport: sink.recordReport,
      commitApplied: () => ({ committed: true }),
    });

    assert.equal(result.status, "green");
    assert.equal(readSpikes(temp).find((s) => s.gate_id === verified.gate_id)?.status, "verified", "a verified spike named on the CR is not downgraded");
    assert.ok(!sink.reports.some((r) => r.phase === "retire_spikes"), "no retire_spikes phase when nothing failed is named");
  });
});

describe("applyChangeRequest — a red reference-check blocks honestly", () => {
  it("leaves the CR accepted_current_build (NOT docs_applied) and reports blocked at verify", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();

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
    assert.equal(applyCalls.length, 2, "the apply leg retried once on the red gate");
    assert.ok(applyCalls[1].feedback, "the retry carried the reference-check failure feedback");
    assert.match(applyCalls[1].feedback, /reference-check FAILED/i);
    assert.equal(freezeCalls.length, 0, "no freeze on a blocked apply");
    assert.equal(extractCalls.length, 0, "no extraction on a blocked apply");
    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr!.fm!.status, "accepted_current_build", "the CR is not advanced to docs_applied on a block");
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
    const cr = readChangeRequest(temp, "CR-0001");
    assert.equal(cr!.fm!.status, "docs_applied");
    assert.match(result.summary, /re-extraction did not reach green/);
  });
});

describe("applyChangeRequest — refuses a CR that is not approved into the build", () => {
  it("blocks on an idea CR without touching it", async () => {
    seedPreviousBaseline();
    seedCanonical();
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

describe("applyChangeRequest — default report recorder writes apply-<id>.json", () => {
  it("persists the terminal report to the reports dir when no sink is injected", async () => {
    seedPreviousBaseline();
    seedCanonical();
    seedApprovedCr();
    const { spawnApplier } = fakeApplier();
    const { runFreeze } = fakeFreeze();
    const { runExtraction } = fakeExtraction();

    const result = await applyChangeRequest({ repoRoot: temp, id: "CR-0001", spawnApplier, runFreeze, runExtraction, commitApplied: () => ({ committed: true }) });

    assert.equal(result.status, "green");
    const reportRel = ".vivicy/development/reports/apply-CR-0001.json";
    assert.ok(existsSync(resolve(temp, reportRel)), "the cr-apply report file exists");
    const report = JSON.parse(read(reportRel));
    assert.equal(report.status, "green");
    assert.equal(report.cr, "CR-0001");
  });
});
