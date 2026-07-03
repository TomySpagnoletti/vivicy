// Unit tests for the spike PROVER (S3 / G3), the substance-verification stage.
//
// BOTH agent legs are ALWAYS faked here — no real CLI is launched:
//   - the PROVER leg (spawnProver) records the six evidence fields into the spike
//     file and writes the machine verdict spike-proof-<stem>.json, and
//   - the independent SPIKE-VERIFIER leg (spawnSpikeVerifier) writes its agree verdict
//     spike-proof-<stem>-verdict.json.
// The orchestrator's DECISION logic is real: it reads both JSONs, flips the spike's
// traceability status IN the file (single source of truth, no folder move), and — on a
// disproven or unresolved proof — drafts a Change Request whose frontmatter is proven to
// pass the REAL change-control gate. change-control + spike-check run for real.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { flipSpikeStatus, runSpikeProving } from "./spike-prover.mjs";
import { readSpikes, runSpikeCheck } from "./spike-check.mjs";
import { runChangeControlCheck } from "./change-control.mjs";
import { progressEventTypes, progressRoles } from "./progress-ledger.mjs";

let temp;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "vivicy-proof-test-"));
});

afterEach(() => {
  rmSync(temp, { recursive: true, force: true });
});

const SPIKES_DIR = ".vivicy/development/spikes";
const REPORTS_DIR = ".vivicy/development/reports";

/**
 * Write a well-formed `pending` spike whose gate-id slug equals its filename stem.
 * `gated_by`/`blocks` model the inter-spike graph; the evidence section carries only the
 * environment placeholder (completion fields are enforced only at `verified`, so a
 * pending spike passes spike-check with one field).
 */
function writeSpike(filename, { status = "pending", reqId = "REQ-ARCH-001", gated_by, blocks } = {}) {
  const slug = filename.replace(/\.md$/, "");
  const content = [
    `# S - ${slug}`,
    "",
    "Document status: Phase 0 spike.",
    "",
    "## Traceability",
    "",
    "```text",
    `requirement_ids: ${reqId}`,
    `gate_id: gate:phase0:s${slug}`,
    `status: ${status}`,
    ...(gated_by ? [`gated_by: ${gated_by}`] : []),
    ...(blocks ? [`blocks: ${blocks}`] : []),
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
    "environment: (to be filled by the prover)",
    "```",
    "",
  ].join("\n");
  const p = resolve(temp, SPIKES_DIR, filename);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return { file: `${SPIKES_DIR}/${filename}`, path: p, gate_id: `gate:phase0:s${slug}` };
}

function spikeStem(file) {
  return (file.split("/").pop() ?? file).replace(/\.md$/, "");
}
function proofRel(file) {
  return `${REPORTS_DIR}/spike-proof-${spikeStem(file)}.json`;
}
function verdictRel(file) {
  return `${REPORTS_DIR}/spike-proof-${spikeStem(file)}-verdict.json`;
}
function writeJson(rel, value) {
  const abs = resolve(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}
function readStatus(file) {
  return readSpikes(temp).find((s) => s.file === file)?.status ?? null;
}

/**
 * A fake PROVER: for the spike it is handed, it fills the six evidence fields into the
 * spike file (as the real prover would) and writes the machine verdict per a lookup
 * keyed by gate_id (default `verified`). Records every call so ordering can be asserted.
 */
function fakeProver(verdictByGate = {}, { onAttempt } = {}) {
  const calls = [];
  const spawnProver = async (ctx) => {
    calls.push({ gate_id: ctx.spike.gate_id, attempt: ctx.attempt, disagreement: ctx.disagreement });
    // Fill full evidence into the spike file so a `verified` flip yields a spike-check-clean
    // corpus. The leg receives the spike as readSpikes() indexes it (a repo-relative `file`),
    // so resolve the absolute path here — the real prover likewise edits the file in-repo.
    fillEvidence(resolve(temp, ctx.spike.file));
    const decided = onAttempt ? onAttempt(ctx) : null;
    const verdict = decided ?? verdictByGate[ctx.spike.gate_id] ?? "verified";
    if (verdict !== "__NO_REPORT__") {
      writeJson(proofRel(ctx.spike.file), { verdict, reason: `attempt ${ctx.attempt}: ${verdict}` });
    }
    return { transcriptRel: `${SPIKES_DIR}/../transcripts/x/proof-${ctx.attempt}.jsonl`, result: { status: 0 } };
  };
  return { spawnProver, calls };
}

/**
 * A fake SPIKE-VERIFIER: writes an agree verdict per a lookup keyed by gate_id (default
 * agree:true), or a scripted per-attempt decision. Records every call.
 */
function fakeSpikeVerifier(agreeByGate = {}, { onAttempt } = {}) {
  const calls = [];
  const spawnSpikeVerifier = async (ctx) => {
    calls.push({ gate_id: ctx.spike.gate_id, attempt: ctx.attempt });
    const decided = onAttempt ? onAttempt(ctx) : null;
    const agree = decided ?? agreeByGate[ctx.spike.gate_id] ?? true;
    if (agree !== "__NO_REPORT__") {
      writeJson(verdictRel(ctx.spike.file), { agree, problems: agree ? [] : ["evidence does not support the verdict"] });
    }
    return { transcriptRel: `${SPIKES_DIR}/../transcripts/x/verify-${ctx.attempt}.jsonl`, result: { status: 0 } };
  };
  return { spawnSpikeVerifier, calls };
}

// Replace the spike file's Evidence Required section with all six filled fields, so a
// spike flipped to `verified` passes spike-check's completion-fields rule.
function fillEvidence(path) {
  const text = readFileSync(path, "utf8");
  const filled = text.replace(
    /## Evidence Required[\s\S]*$/,
    [
      "## Evidence Required",
      "",
      "```text",
      "environment: 2026-07-02, node 22, provider-sdk 1.2.3",
      "commands or API calls: node probe.mjs",
      "observed output: 200 OK, token issued",
      "decision: the provider behaves as assumed",
      "documentation updates: none",
      "unresolved risks: none",
      "```",
      "",
    ].join("\n"),
  );
  writeFileSync(path, filled);
}

describe("runSpikeProving — agree + verified", () => {
  it("flips the spike's traceability status to verified IN the file (no folder move)", async () => {
    const s = writeSpike("01-provider-auth.md");
    assert.equal(readStatus(s.file), "pending");

    const { spawnProver } = fakeProver({ [s.gate_id]: "verified" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [s.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.deepEqual(
      result.proved.map((p) => [p.gate_id, p.verdict]),
      [[s.gate_id, "verified"]],
    );
    assert.equal(result.failed.length, 0);
    // The status is flipped in-place; the file still lives in spikes/ (no /_verified move).
    assert.equal(readStatus(s.file), "verified");
    assert.ok(existsSync(s.path), "the spike file stays in place");
    // The verified spike, with the prover's evidence, is a spike-check-clean corpus.
    assert.equal(runSpikeCheck({ repoRoot: temp }).exitCode, 0, "verified spike passes spike-check");
    // No change request is drafted on a successful proof.
    assert.equal(result.changeRequests.length, 0);
    assert.ok(!existsSync(resolve(temp, ".vivicy/change-requests")), "no CR dir created on success");
  });

  it("emits spike_proof_started/completed through the injected recordEvent sink", async () => {
    const s = writeSpike("01-provider-auth.md");
    const events = [];
    const { spawnProver } = fakeProver({ [s.gate_id]: "verified" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [s.gate_id]: true });

    await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier, recordEvent: (e) => events.push(e), now: () => "2026-07-02T00:00:00.000Z" });

    const types = events.map((e) => e.event_type);
    assert.deepEqual(types, ["spike_proof_started", "spike_proof_completed"]);
    // The emitted roles are the ledger-vocabulary form (underscores), matching progressRoles.
    assert.equal(events[0].role, "spike_prover");
    assert.equal(events[1].role, "spike_verifier");
    assert.ok(progressRoles.includes(events[0].role), "spike_proof_started role is a declared progress role");
    assert.ok(progressRoles.includes(events[1].role), "spike_proof_completed role is a declared progress role");
    assert.ok(
      progressEventTypes.includes(events[0].event_type) && progressEventTypes.includes(events[1].event_type),
      "both emitted event types are declared in progressEventTypes",
    );
    assert.equal(events[1].verdict, "verified");
    assert.equal(events[1].gate_id, s.gate_id);
  });

  it("does not throw when recordEvent is null (the extraction path passes null)", async () => {
    const s = writeSpike("01-provider-auth.md");
    const { spawnProver } = fakeProver({ [s.gate_id]: "verified" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [s.gate_id]: true });
    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier, recordEvent: null });
    assert.equal(result.proved.length, 1);
  });
});

describe("runSpikeProving — agree + failed drafts a Change Request", () => {
  it("flips the spike to failed and writes a CR whose frontmatter passes change-control", async () => {
    const s = writeSpike("01-provider-auth.md");
    const { spawnProver } = fakeProver({ [s.gate_id]: "failed" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [s.gate_id]: true }); // agrees it failed

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(result.proved.length, 0);
    assert.deepEqual(
      result.failed.map((f) => f.gate_id),
      [s.gate_id],
    );
    assert.equal(readStatus(s.file), "failed", "a disproven spike is marked failed in-place");
    // Exactly one CR was drafted, capturing both reports as evidence.
    assert.equal(result.changeRequests.length, 1);
    const crAbs = resolve(temp, result.changeRequests[0].file);
    assert.ok(existsSync(crAbs), "the CR file exists");
    const crText = readFileSync(crAbs, "utf8");
    assert.match(crText, /status: idea/);
    assert.match(crText, /source: agent/);
    assert.match(crText, /classification: major_product_change/);
    assert.match(crText, new RegExp(proofRel(s.file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "CR cites the prover report");
    assert.match(crText, new RegExp(verdictRel(s.file).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "CR cites the verifier report");
    // The disproven spike's own gate rides on affected_verification_gates — the link cr-apply
    // follows to retire this now-moot spike (failed -> deferred) once the CR is folded.
    assert.match(crText, new RegExp(`affected_verification_gates: \\[${s.gate_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`), "the CR records the spike gate_id on affected_verification_gates");
    // The drafted CR passes the REAL change-control gate (valid enums, sequential id, decision scaffold).
    const cc = runChangeControlCheck({ repoRoot: temp });
    assert.equal(cc.exitCode, 0, `change-control must accept the drafted CR:\n${cc.errors.join("\n")}`);
  });

  it("numbers a second drafted CR sequentially (CR-0002) so change-control stays gap-free", async () => {
    const a = writeSpike("01-a.md");
    const b = writeSpike("02-b.md", { reqId: "REQ-ARCH-002" });
    const { spawnProver } = fakeProver({ [a.gate_id]: "failed", [b.gate_id]: "failed" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [a.gate_id]: true, [b.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(result.changeRequests.length, 2);
    const ids = result.changeRequests.map((c) => c.id).sort();
    assert.deepEqual(ids, ["CR-0001", "CR-0002"], "the two CRs are numbered sequentially");
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0, "two sequential CRs pass change-control");
  });
});

describe("runSpikeProving — disagreement retries once then drafts a CR", () => {
  it("retries the pair once feeding the disagreement back, then flips failed + CR on persistent disagreement", async () => {
    const s = writeSpike("01-provider-auth.md");
    // Prover always claims verified; verifier always disagrees -> never resolves.
    const { spawnProver, calls: proofCalls } = fakeProver({ [s.gate_id]: "verified" });
    const { spawnSpikeVerifier, calls: verifyCalls } = fakeSpikeVerifier({ [s.gate_id]: false });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    // The whole pair ran exactly twice (initial + one bounded retry).
    assert.equal(proofCalls.length, 2, "prover ran twice (bounded retry)");
    assert.equal(verifyCalls.length, 2, "verifier ran twice");
    // The retry carried the disagreement back to the prover.
    assert.equal(proofCalls[0].disagreement, null, "the first attempt has no disagreement feedback");
    assert.ok(proofCalls[1].disagreement, "the retry attempt carries the disagreement feedback");
    assert.match(proofCalls[1].disagreement, /agree=false/);
    // Persistent disagreement is treated as a failed proof: status failed + a CR.
    assert.equal(readStatus(s.file), "failed");
    assert.deepEqual(result.failed.map((f) => f.gate_id), [s.gate_id]);
    assert.equal(result.changeRequests.length, 1);
    const crText = readFileSync(resolve(temp, result.changeRequests[0].file), "utf8");
    assert.match(crText, /did not agree/i, "the CR explains the unresolved disagreement");
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0);
  });

  it("a disagreement RESOLVED on the retry flips verified with no CR", async () => {
    const s = writeSpike("01-provider-auth.md");
    const { spawnProver, calls: proofCalls } = fakeProver({ [s.gate_id]: "verified" });
    // Verifier disagrees on attempt 1, agrees on attempt 2.
    const { spawnSpikeVerifier } = fakeSpikeVerifier({}, { onAttempt: (ctx) => ctx.attempt === 1 ? false : true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(proofCalls.length, 2, "the retry ran once, then resolved");
    assert.equal(readStatus(s.file), "verified");
    assert.deepEqual(result.proved.map((p) => p.gate_id), [s.gate_id]);
    assert.equal(result.changeRequests.length, 0, "a resolved disagreement drafts no CR");
  });
});

describe("runSpikeProving — topological ordering of the gated_by graph", () => {
  it("proves a gate BEFORE the spike it gates (a spike waits for its gated_by within the run)", async () => {
    // 01-a is gated_by 02-b: 02-b must be proved FIRST, then 01-a.
    const a = writeSpike("01-a.md", { gated_by: "gate:phase0:s02-b" });
    const b = writeSpike("02-b.md", { reqId: "REQ-ARCH-002", blocks: "gate:phase0:s01-a" });

    const { spawnProver, calls: proofCalls } = fakeProver({ [a.gate_id]: "verified", [b.gate_id]: "verified" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [a.gate_id]: true, [b.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    // Both verified, and b (the gate) was proved before a (the dependent).
    const order = proofCalls.map((c) => c.gate_id);
    assert.deepEqual(order, [b.gate_id, a.gate_id], "the gate is proved before its dependent");
    assert.equal(readStatus(a.file), "verified");
    assert.equal(readStatus(b.file), "verified");
    // The verified chain (a verified only because b is) is spike-check clean.
    assert.equal(runSpikeCheck({ repoRoot: temp }).exitCode, 0, "the verified chain passes the status-chain rule");
    assert.equal(result.proved.length, 2);
  });

  it("skips a spike whose gate FAILED this run (never proves on an unproven foundation)", async () => {
    const a = writeSpike("01-a.md", { gated_by: "gate:phase0:s02-b" });
    const b = writeSpike("02-b.md", { reqId: "REQ-ARCH-002", blocks: "gate:phase0:s01-a" });
    // b fails; a must then be SKIPPED (its gate is not verified), not proved.
    const { spawnProver, calls: proofCalls } = fakeProver({ [a.gate_id]: "verified", [b.gate_id]: "failed" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [a.gate_id]: true, [b.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    // Only b ran through the prover; a was skipped before spawning any leg.
    assert.deepEqual(proofCalls.map((c) => c.gate_id), [b.gate_id], "the dependent's legs never ran");
    assert.deepEqual(result.failed.map((f) => f.gate_id), [b.gate_id]);
    assert.deepEqual(result.skipped.map((s2) => s2.gate_id), [a.gate_id], "the dependent is skipped");
    assert.match(result.skipped[0].reason, /gate:phase0:s02-b is failed/);
    assert.equal(readStatus(a.file), "pending", "the skipped spike keeps its pending status");
  });

  it("skips a spike gated by an already-failed spike ON DISK (not proved this run)", async () => {
    // 02-b was already failed in a prior run; 01-a depends on it and stays pending.
    const a = writeSpike("01-a.md", { gated_by: "gate:phase0:s02-b" });
    writeSpike("02-b.md", { reqId: "REQ-ARCH-002", status: "failed", blocks: "gate:phase0:s01-a" });
    const { spawnProver, calls: proofCalls } = fakeProver({ [a.gate_id]: "verified" });
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [a.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(proofCalls.length, 0, "no leg runs — the only pending spike is gated by a failed one");
    assert.deepEqual(result.skipped.map((s2) => s2.gate_id), [a.gate_id]);
    assert.equal(readStatus(a.file), "pending");
  });

  it("leaves an already-verified spike alone (only pending spikes are proof candidates)", async () => {
    const s = writeSpike("01-provider-auth.md", { status: "verified" });
    const { spawnProver, calls: proofCalls } = fakeProver();
    const { spawnSpikeVerifier } = fakeSpikeVerifier();
    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });
    assert.equal(proofCalls.length, 0, "a verified spike is not re-proved");
    assert.equal(result.proved.length, 0);
    assert.equal(result.failed.length, 0);
    assert.equal(readStatus(s.file), "verified");
  });
});

describe("runSpikeProving — honest failure on a dead/timed-out leg", () => {
  it("a TIMED-OUT prover leg (writes no report) is an honest failed proof + CR, never a silent green", async () => {
    const s = writeSpike("01-provider-auth.md");
    // The prover "leg" mimics a leg-timeout kill: it writes NO verdict JSON and carries a timeout result.
    const spawnProver = async () => ({
      result: { status: 124, timedOut: true, timeoutReason: "leg timed out after 45 min (hard cap)" },
      output: "",
    });
    // The verifier can't agree with a proof that does not exist -> reads as no report either.
    const spawnSpikeVerifier = async () => ({ result: { status: 124, timedOut: true, timeoutReason: "leg timed out" }, output: "" });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(result.proved.length, 0, "a timed-out proof is never verified");
    assert.deepEqual(result.failed.map((f) => f.gate_id), [s.gate_id]);
    assert.equal(readStatus(s.file), "failed", "the dead-leg proof honestly fails");
    // A CR is drafted so a human sees the block; it passes change-control.
    assert.equal(result.changeRequests.length, 1);
    assert.equal(runChangeControlCheck({ repoRoot: temp }).exitCode, 0);
  });

  it("a prover that says verified but writes NO report is not trusted (no report -> failed)", async () => {
    const s = writeSpike("01-provider-auth.md");
    // Prover fills evidence and returns a clean exit but writes NO verdict JSON at all.
    const spawnProver = async (ctx) => {
      fillEvidence(resolve(temp, ctx.spike.file));
      return { result: { status: 0 }, output: "" }; // NO writeJson of the verdict
    };
    const { spawnSpikeVerifier } = fakeSpikeVerifier({ [s.gate_id]: true });

    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });

    assert.equal(result.proved.length, 0, "a missing proof report is never a green");
    assert.equal(readStatus(s.file), "failed");
    assert.equal(result.changeRequests.length, 1);
  });
});

describe("runSpikeProving — nothing to do", () => {
  it("returns empty results and spawns no leg when there are no spikes", async () => {
    const { spawnProver, calls: proofCalls } = fakeProver();
    const { spawnSpikeVerifier, calls: verifyCalls } = fakeSpikeVerifier();
    const result = await runSpikeProving({ repoRoot: temp, spawnProver, spawnSpikeVerifier });
    assert.deepEqual(result, { proved: [], failed: [], skipped: [], changeRequests: [] });
    assert.equal(proofCalls.length, 0);
    assert.equal(verifyCalls.length, 0);
  });
});

describe("flipSpikeStatus — surgical, byte-preserving status edit", () => {
  it("changes ONLY the status: line and leaves every other line byte-identical", () => {
    const s = writeSpike("01-provider-auth.md", { status: "pending" });
    const before = readFileSync(s.path, "utf8").split("\n");
    flipSpikeStatus(temp, { file: s.file }, "verified");
    const after = readFileSync(s.path, "utf8").split("\n");
    assert.equal(before.length, after.length, "no line added or removed");
    for (let i = 0; i < before.length; i += 1) {
      if (/^\s*status:/.test(before[i])) {
        assert.equal(after[i], "status: verified", "the status line is flipped");
      } else {
        assert.equal(after[i], before[i], `line ${i} is untouched`);
      }
    }
  });

  it("preserves CRLF line endings on a Windows-authored spike (no CRLF->LF rewrite)", () => {
    // Author a spike with CRLF endings, as a Windows editor would.
    const crlf = writeSpike("01-crlf.md", { status: "pending" });
    writeFileSync(crlf.path, readFileSync(crlf.path, "utf8").replace(/\n/g, "\r\n"));

    flipSpikeStatus(temp, { file: crlf.file }, "verified");

    const out = readFileSync(crlf.path, "utf8");
    assert.ok(out.includes("\r\n"), "CRLF endings are preserved");
    assert.ok(!/[^\r]\n/.test(out), "no bare LF was introduced (every LF stays paired with CR)");
    assert.match(out, /status: verified\r\n/, "the status line is flipped and still CRLF-terminated");
  });

  it("throws (never silently no-ops) when there is no status line to flip", () => {
    const p = resolve(temp, SPIKES_DIR, "01-broken.md");
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "# S\n\n## Traceability\n\n```text\ngate_id: gate:phase0:s01-broken\n```\n");
    assert.throws(() => flipSpikeStatus(temp, { file: `${SPIKES_DIR}/01-broken.md` }, "verified"), /no "status:" line/);
  });
});
