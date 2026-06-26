// MUST be the first import: it binds VIVICY_TARGET_ROOT to a dedicated temp root
// as a side effect, before any later import pulls in a factory module that reads
// resolveTargetRoot() at load time. See test-target-root.mjs for why ordering matters.
import { testTargetRoot as repoRoot } from "./test-target-root.mjs";
import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { applyProgressEvent, createEmptyProgressLedger, recordProgressEvent } from "./progress-ledger.mjs";

// Self-contained artifact identity, faithful to the real frozen-baseline shape.
// The manifest is the pinned source of truth; the issue-index and progress-ledger
// placeholders pin to it, exactly like the committed artifacts do.
const MANIFEST_REL = "docs/baselines/test-baseline.json";
const MANIFEST = {
  schema_version: 1,
  status: "frozen",
  baseline_id: "baseline-test-v1.0.0",
  version: "1.0.0",
  manifest_hash: "test-manifest-hash",
  document_set_hash: "test-document-set-hash",
  files: [],
};

// The verification grammar matches the committed artifacts (see the bundled
// rehearsal fixture's issue-index.json). The gate-evidence refs the tests write
// under spec/development/gates/ satisfy it, so there is no hand-copied second regex.
const VERIFICATION_EVIDENCE_REF_GRAMMAR = "^spec/development/(gates|reports)/.+";

// A minimal placeholder issue-index (no issues yet), pinned to the manifest and
// carrying the grammar — the shape recordProgressEvent and the artifact-readiness
// tests read. It is rewritten by the function-call tests as needed.
const placeholderIssueIndex = {
  schema_version: 1,
  status: "pending_llm_semantic_issue_generation",
  baseline_id: MANIFEST.baseline_id,
  baseline_version: MANIFEST.version,
  manifest_path: MANIFEST_REL,
  manifest_hash: MANIFEST.manifest_hash,
  document_set_hash: MANIFEST.document_set_hash,
  source_corpus: ["docs/canonical/**/*.md"],
  issues: [],
  coverage_summary: {
    total_doc_lines: 0,
    classified_doc_lines: 0,
    requirement_linked_doc_lines: 0,
    issue_linked_doc_lines: 0,
  },
  verification_evidence_ref_grammar: VERIFICATION_EVIDENCE_REF_GRAMMAR,
};

const placeholderProgressLedger = {
  schema_version: 1,
  revision: 0,
  baseline_id: MANIFEST.baseline_id,
  baseline_version: MANIFEST.version,
  manifest_hash: MANIFEST.manifest_hash,
  document_set_hash: MANIFEST.document_set_hash,
  updated_at: null,
  graph_item_states: [],
  active_items: [],
};

// The architecture map declares the gate-ref grammar; the artifact-readiness test
// cross-checks that the issue-index grammar equals the map's, so write both.
const ARCHITECTURE_MAP =
  `schema_version: 1\nverification_gate_ref_grammar: "${VERIFICATION_EVIDENCE_REF_GRAMMAR}"\n`;

function writeJson(rel, value) {
  const abs = resolve(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
}

// The artifact-readiness tests read the same committed paths the real factory uses,
// now self-contained under the temp target root.
function writeRealArtifacts() {
  writeJson(MANIFEST_REL, MANIFEST);
  writeJson("spec/development/issue-index.json", placeholderIssueIndex);
  writeJson("spec/development/progress-ledger.json", placeholderProgressLedger);
  const mapAbs = resolve(repoRoot, "docs/architecture-map/architecture-map.yml");
  mkdirSync(dirname(mapAbs), { recursive: true });
  writeFileSync(mapAbs, ARCHITECTURE_MAP);
  // A short README so a "missing line" evidence ref (README.md:999999) reaches the
  // line-range check instead of failing on a missing file first.
  writeFileSync(resolve(repoRoot, "README.md"), "# Test target\n");
}

// Stand-in for the "real" artifacts the host used to provide: in the standalone
// factory they are the self-contained temp fixtures written above.
const realIssueIndex = placeholderIssueIndex;
const realManifest = MANIFEST;

const issueIndex = {
  verification_evidence_ref_grammar: VERIFICATION_EVIDENCE_REF_GRAMMAR,
  issues: [
    {
      graph_refs: ["node:manager_service", "node:mission_intake"],
      id: "ISS-MANAGER-0001",
    },
  ],
};

// Evidence refs must be repo-relative and point to an existing file, so the
// fixture gate-evidence files live inside the repo and are removed in after().
const gateEvidenceRel = "spec/development/gates/_test-iss-manager-0001-gate.json";
const gateEvidenceAbs = resolve(repoRoot, gateEvidenceRel);
const gateEvidenceDir = dirname(gateEvidenceAbs);

const wrongGateEvidenceRel = "spec/development/gates/_test-other-issue-gate.json";
const wrongGateEvidenceAbs = resolve(repoRoot, wrongGateEvidenceRel);
const failedGateEvidenceRel = "spec/development/gates/_test-iss-manager-0001-gate-failed.json";
const failedGateEvidenceAbs = resolve(repoRoot, failedGateEvidenceRel);

function gateRunRecord(overrides = {}) {
  // Canonical gate-run record shape from the governance method.
  return {
    gate_id: "gate:test:iss-manager-0001",
    issue_id: "ISS-MANAGER-0001",
    command: "npm run progress:test",
    exit_code: 0,
    status: "pass",
    finished_at: "2026-06-08T12:09:00.000Z",
    baseline_id: "baseline-v0.2.0",
    ...overrides,
  };
}

before(() => {
  writeRealArtifacts();
  mkdirSync(gateEvidenceDir, { recursive: true });
  writeFileSync(gateEvidenceAbs, `${JSON.stringify(gateRunRecord(), null, 2)}\n`);
  writeFileSync(wrongGateEvidenceAbs, `${JSON.stringify(gateRunRecord({ gate_id: "gate:test:some-other-issue" }), null, 2)}\n`);
  writeFileSync(failedGateEvidenceAbs, `${JSON.stringify(gateRunRecord({ exit_code: 1, status: "fail" }), null, 2)}\n`);
});

after(() => {
  // The whole temp target root is removed, taking every scratch fixture with it.
  rmSync(repoRoot, { recursive: true, force: true });
});

test("records in-progress heartbeat for linked graph refs", () => {
  const ledger = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:00:00.000Z",
      worktree: "worktrees/manager",
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });

  assert.equal(ledger.active_items.length, 1);
  assert.equal(ledger.active_items[0].state, "working");
  assert.equal(ledger.graph_item_states[0].status, "in_progress");
});

test("carries the actor role on the active item", () => {
  const ledger = applyProgressEvent({
    event: {
      actor: "codex",
      role: "reviewer",
      event_type: "review_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-review",
      timestamp: "2026-06-08T12:05:00.000Z",
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });

  assert.equal(ledger.active_items[0].role, "reviewer");
  assert.equal(ledger.active_items[0].state, "reviewing");
  assert.equal(ledger.graph_item_states[0].status, "reviewing");
});

test("completing an issue clears active items from both legs (implementer + reviewer)", () => {
  // Reviewer leg (codex actor) opens a "reviewing" active item.
  const afterReview = applyProgressEvent({
    event: {
      actor: "codex",
      role: "reviewer",
      event_type: "review_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-review",
      timestamp: "2026-06-08T12:05:00.000Z",
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });
  assert.equal(afterReview.active_items.length, 1);

  // The gate passes, emitted by the implementer actor (a DIFFERENT actor). The
  // reviewer's active item must still be cleared, or it would dangle forever and
  // hold the shared node's conservative aggregate below verified.
  const afterGate = applyProgressEvent({
    event: {
      actor: "claude",
      role: "implementer",
      event_type: "gate_passed",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-impl",
      evidence_refs: [gateEvidenceRel],
      timestamp: "2026-06-08T12:10:00.000Z",
    },
    issueIndex,
    ledger: afterReview,
  });
  assert.equal(
    afterGate.active_items.filter((item) => item.issue_id === "ISS-MANAGER-0001").length,
    0,
    "no active item lingers for a completed issue, including the reviewer leg's",
  );
  assert.equal(afterGate.graph_item_states[0].status, "verified");
});

test("rejects an unknown actor role", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "claude",
          role: "architect",
          event_type: "issue_started",
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-bad-role",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /Unsupported role/,
  );
});

test("accumulates transcript_refs on the graph item state and active item", () => {
  const ref = "spec/development/transcripts/ISS-MANAGER-0001/claude-implementer-x.jsonl";
  const ledger = applyProgressEvent({
    event: {
      actor: "claude",
      role: "implementer",
      event_type: "issue_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-t",
      transcript_refs: [ref],
      timestamp: "2026-06-08T12:00:00.000Z",
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });

  assert.deepEqual(ledger.graph_item_states[0].transcript_refs, [ref]);
  assert.deepEqual(ledger.active_items[0].transcript_refs, [ref]);
});

// Progress is 100% MECHANICAL: the orchestrator (dev-loop's emit()) is the sole
// writer, through recordProgressEvent — there is no agent self-report seam (no MCP
// tool, no progress-emit CLI, no Stop-hook backfill). This proves the orchestrator
// path records a reviewer-leg event with the right role + reviewing state, exactly
// as dev-loop emits when it sequences the review leg.
test("the orchestrator write path records a review event with role + reviewing state", () => {
  const scratchDir = mkdtempSync(resolve(repoRoot, "_tmp-progress-orchestrator-test-"));
  try {
    const issueIndexRel = relative(repoRoot, resolve(scratchDir, "issue-index.json"));
    const ledgerRel = relative(repoRoot, resolve(scratchDir, "progress-ledger.json"));
    writeFileSync(resolve(repoRoot, issueIndexRel), `${JSON.stringify(issueIndex, null, 2)}\n`);

    recordProgressEvent(
      {
        event_type: "review_started",
        issue_id: "ISS-MANAGER-0001",
        graph_refs: ["node:manager_service"],
        actor: "codex",
        role: "reviewer",
        session_ref: "dev-loop:ISS-MANAGER-0001",
      },
      { issueIndexPath: issueIndexRel, progressLedgerPath: ledgerRel },
    );

    const ledger = JSON.parse(readFileSync(resolve(repoRoot, ledgerRel), "utf8"));
    assert.equal(ledger.active_items[0].role, "reviewer");
    assert.equal(ledger.active_items[0].state, "reviewing");
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});

test("records verified state and clears active item on completion (tool-owned gate evidence)", () => {
  const activeLedger = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:00:00.000Z",
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });

  const verifiedLedger = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_completed",
      evidence_refs: [gateEvidenceRel],
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:10:00.000Z",
    },
    issueIndex,
    ledger: activeLedger,
  });

  assert.equal(verifiedLedger.active_items.length, 0);
  assert.equal(verifiedLedger.graph_item_states[0].status, "verified");
  assert.deepEqual(verifiedLedger.graph_item_states[0].evidence_refs, [gateEvidenceRel]);
});

test("#31: rejects completion evidence that is a docs/ prose doc (not under the gate dir)", () => {
  // Uses a real existing doc so the failure is the grammar rejection, not a
  // missing-file error.
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_completed",
          evidence_refs: ["docs/governance/05-development-traceability-method.md"],
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:10:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /verification evidence_ref/,
  );
});

test("rejects graph refs outside the linked issue", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_started",
          graph_refs: ["node:worker_supervisor"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /not linked to issue/,
  );
});

test("rejects completion without evidence", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_completed",
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /requires evidence_refs/,
  );
});

test("rejects completion evidence that does not match verification grammar", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_completed",
          evidence_refs: ["README.md"],
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /verification evidence_ref/,
  );
});

test("rejects evidence refs pointing to missing lines", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_blocked",
          evidence_refs: ["README.md:999999"],
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /missing line/,
  );
});

test("rejects absolute evidence refs even when they point inside the repository", () => {
  // issue_blocked has no verification-grammar requirement, so the absolute path
  // reaches the repository-relative guard rather than failing the grammar check first.
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "issue_blocked",
          evidence_refs: [`${process.cwd()}/docs/governance/05-development-traceability-method.md`],
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /repository-relative/,
  );
});

// ---------------------------------------------------------------------------
// Monotonic graph status + non-regressing updated_at
// ---------------------------------------------------------------------------

const VERIFICATION_EVIDENCE = gateEvidenceRel;

function verifiedLedgerAt(timestamp) {
  return applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "gate_passed",
      evidence_refs: [VERIFICATION_EVIDENCE],
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp,
    },
    issueIndex,
    ledger: createEmptyProgressLedger(),
  });
}

test("late heartbeat after gate_passed does not un-verify or rewind updated_at", () => {
  const verified = verifiedLedgerAt("2026-06-08T12:10:00.000Z");
  assert.equal(verified.graph_item_states[0].status, "verified");
  assert.equal(verified.graph_item_states[0].updated_at, "2026-06-08T12:10:00.000Z");
  assert.equal(verified.updated_at, "2026-06-08T12:10:00.000Z");

  const afterLateHeartbeat = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "heartbeat",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:05:00.000Z",
    },
    issueIndex,
    ledger: verified,
  });

  assert.equal(afterLateHeartbeat.graph_item_states[0].status, "verified", "status must stay verified");
  assert.equal(
    afterLateHeartbeat.graph_item_states[0].updated_at,
    "2026-06-08T12:10:00.000Z",
    "item updated_at must not rewind",
  );
  assert.equal(afterLateHeartbeat.updated_at, "2026-06-08T12:10:00.000Z", "ledger updated_at must not rewind");
});

test("newer heartbeat after gate_passed still does not downgrade verified status", () => {
  const verified = verifiedLedgerAt("2026-06-08T12:10:00.000Z");

  const afterNewerHeartbeat = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "heartbeat",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:20:00.000Z",
    },
    issueIndex,
    ledger: verified,
  });

  assert.equal(afterNewerHeartbeat.graph_item_states[0].status, "verified", "status stays verified");
  assert.equal(afterNewerHeartbeat.graph_item_states[0].updated_at, "2026-06-08T12:20:00.000Z");
});

test("explicit issue_reopened downgrades verified back to in_progress", () => {
  const verified = verifiedLedgerAt("2026-06-08T12:10:00.000Z");

  const reopened = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_reopened",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:30:00.000Z",
    },
    issueIndex,
    ledger: verified,
  });

  assert.equal(reopened.graph_item_states[0].status, "in_progress", "re-open moves status back");
  assert.equal(reopened.graph_item_states[0].updated_at, "2026-06-08T12:30:00.000Z");
  assert.equal(reopened.active_items.length, 1);
  assert.equal(reopened.active_items[0].state, "working");
});

// ---------------------------------------------------------------------------
// Atomic, locked, multi-writer-safe ledger writes
// ---------------------------------------------------------------------------

// recordProgressEvent only accepts repository-relative paths, so the scratch dir
// must live under the repo root.
function makeScratch() {
  const absDir = mkdtempSync(resolve(repoRoot, "_tmp-progress-ledger-test-"));
  const rel = (name) => relative(repoRoot, resolve(absDir, name)).split("\\").join("/");
  const issueIndexRel = rel("issue-index.json");
  const ledgerRel = rel("progress-ledger.json");
  writeFileSync(resolve(repoRoot, issueIndexRel), `${JSON.stringify(issueIndex, null, 2)}\n`);
  return {
    absDir,
    issueIndexRel,
    ledgerRel,
    ledgerAbs: resolve(repoRoot, ledgerRel),
    cleanup() {
      rmSync(absDir, { recursive: true, force: true });
    },
  };
}

const startedEvent = {
  actor: "codex-master",
  event_type: "issue_started",
  graph_refs: ["node:manager_service"],
  issue_id: "ISS-MANAGER-0001",
  session_ref: "thread-1",
  timestamp: "2026-06-08T12:00:00.000Z",
};

test("recordProgressEvent writes atomically and leaves no partial/temp file", () => {
  const scratch = makeScratch();
  try {
    const ledger = recordProgressEvent(startedEvent, {
      issueIndexPath: scratch.issueIndexRel,
      progressLedgerPath: scratch.ledgerRel,
    });

    assert.ok(existsSync(scratch.ledgerAbs), "ledger file exists");
    const onDisk = JSON.parse(readFileSync(scratch.ledgerAbs, "utf8"));
    assert.equal(onDisk.graph_item_states[0].status, "in_progress");
    assert.equal(onDisk.revision, ledger.revision);

    const stray = readdirSync(scratch.absDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));
    assert.deepEqual(stray, [], `unexpected stray files: ${stray.join(", ")}`);
  } finally {
    scratch.cleanup();
  }
});

test("recordProgressEvent increments revision monotonically across writes", () => {
  const scratch = makeScratch();
  try {
    const first = recordProgressEvent(startedEvent, {
      issueIndexPath: scratch.issueIndexRel,
      progressLedgerPath: scratch.ledgerRel,
    });
    assert.equal(first.revision, 1, "first write starts revision at 1");

    const second = recordProgressEvent(
      { ...startedEvent, event_type: "heartbeat", timestamp: "2026-06-08T12:01:00.000Z" },
      { issueIndexPath: scratch.issueIndexRel, progressLedgerPath: scratch.ledgerRel },
    );
    assert.equal(second.revision, 2, "revision increments on the next write");

    const third = recordProgressEvent(
      {
        ...startedEvent,
        event_type: "gate_passed",
        evidence_refs: [VERIFICATION_EVIDENCE],
        timestamp: "2026-06-08T12:02:00.000Z",
      },
      { issueIndexPath: scratch.issueIndexRel, progressLedgerPath: scratch.ledgerRel },
    );
    assert.equal(third.revision, 3);
    assert.equal(JSON.parse(readFileSync(scratch.ledgerAbs, "utf8")).revision, 3);
  } finally {
    scratch.cleanup();
  }
});

test("recordProgressEvent reclaims a stale lock left by a dead writer", () => {
  const scratch = makeScratch();
  try {
    recordProgressEvent(startedEvent, {
      issueIndexPath: scratch.issueIndexRel,
      progressLedgerPath: scratch.ledgerRel,
    });

    // PID 999999999 is outside any real range, so isProcessAlive() reports it dead
    // and the lock is reclaimed without waiting for the age TTL.
    const lockPath = `${scratch.ledgerAbs}.lock`;
    const fd = openSync(lockPath, "wx");
    writeSync(
      fd,
      JSON.stringify({ pid: 999999999, acquired_at: "2000-01-01T00:00:00.000Z", epoch_ms: 0 }),
    );
    closeSync(fd);
    assert.ok(existsSync(lockPath), "stale lock is present before the write");

    const recovered = recordProgressEvent(
      { ...startedEvent, event_type: "heartbeat", timestamp: "2026-06-08T12:05:00.000Z" },
      { issueIndexPath: scratch.issueIndexRel, progressLedgerPath: scratch.ledgerRel },
    );

    assert.equal(recovered.revision, 2, "write succeeded after reclaiming the stale lock");
    assert.ok(!existsSync(lockPath), "lock is released after the write");
  } finally {
    scratch.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Verified is bound to the issue's declared verification_gate_ids
// ---------------------------------------------------------------------------

const gateBoundIssueIndex = {
  verification_evidence_ref_grammar: VERIFICATION_EVIDENCE_REF_GRAMMAR,
  issues: [
    {
      graph_refs: ["node:manager_service"],
      id: "ISS-MANAGER-0001",
      verification_gate_ids: ["gate:test:iss-manager-0001"],
    },
  ],
};

function gateBoundCompletion(evidenceRefs) {
  return applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_completed",
      evidence_refs: evidenceRefs,
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-MANAGER-0001",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:10:00.000Z",
    },
    issueIndex: gateBoundIssueIndex,
    ledger: createEmptyProgressLedger(),
  });
}

test("#31b: accepts a green gate-run record whose gate_id is declared on the issue", () => {
  const ledger = gateBoundCompletion([gateEvidenceRel]);
  assert.equal(ledger.graph_item_states[0].status, "verified");
});

test("#31b: rejects a green gate-run record for a gate the issue did not declare", () => {
  assert.throws(() => gateBoundCompletion([wrongGateEvidenceRel]), /gate_id declared on the issue/);
});

test("#31b: rejects a failed gate-run record for the declared gate", () => {
  assert.throws(() => gateBoundCompletion([failedGateEvidenceRel]), /gate_id declared on the issue/);
});

// ---------------------------------------------------------------------------
// Governance progress contract — required event fields
// ---------------------------------------------------------------------------

test("rejects events without session_ref", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "heartbeat",
          graph_refs: ["node:manager_service"],
          issue_id: "ISS-MANAGER-0001",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /session_ref must be a non-empty string/,
  );
});

test("rejects events with empty graph_refs (no fallback to the issue's full set)", () => {
  assert.throws(
    () =>
      applyProgressEvent({
        event: {
          actor: "codex-master",
          event_type: "heartbeat",
          graph_refs: [],
          issue_id: "ISS-MANAGER-0001",
          session_ref: "thread-1",
          timestamp: "2026-06-08T12:00:00.000Z",
        },
        issueIndex,
        ledger: createEmptyProgressLedger(),
      }),
    /explicit graph focus/,
  );
});

// ---------------------------------------------------------------------------
// Shared graph items aggregate conservatively across linked issues
// ---------------------------------------------------------------------------

const sharedGraphIssueIndex = {
  verification_evidence_ref_grammar: VERIFICATION_EVIDENCE_REF_GRAMMAR,
  issues: [
    { graph_refs: ["node:manager_service"], id: "ISS-A" },
    { graph_refs: ["node:manager_service"], id: "ISS-B" },
  ],
};

test("#34: one issue going verified does not overstate a graph item another issue still works on", () => {
  const working = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "issue_started",
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-B",
      session_ref: "thread-2",
      timestamp: "2026-06-08T12:00:00.000Z",
    },
    issueIndex: sharedGraphIssueIndex,
    ledger: createEmptyProgressLedger(),
  });

  const afterGate = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "gate_passed",
      evidence_refs: [gateEvidenceRel],
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-A",
      session_ref: "thread-1",
      timestamp: "2026-06-08T12:10:00.000Z",
    },
    issueIndex: sharedGraphIssueIndex,
    ledger: working,
  });

  const item = afterGate.graph_item_states[0];
  assert.equal(item.issue_states["ISS-A"], "verified", "the gated issue is recorded verified");
  assert.equal(item.issue_states["ISS-B"], "in_progress", "the other issue stays in_progress");
  assert.equal(item.status, "in_progress", "displayed status is the conservative aggregate");

  const afterSecondGate = applyProgressEvent({
    event: {
      actor: "codex-master",
      event_type: "gate_passed",
      evidence_refs: [gateEvidenceRel],
      graph_refs: ["node:manager_service"],
      issue_id: "ISS-B",
      session_ref: "thread-2",
      timestamp: "2026-06-08T12:20:00.000Z",
    },
    issueIndex: sharedGraphIssueIndex,
    ledger: afterGate,
  });

  assert.equal(afterSecondGate.graph_item_states[0].status, "verified", "all linked issues verified -> verified");
});

// ---------------------------------------------------------------------------
// Artifact readiness — the self-contained development-control files written into
// the temp target root by writeRealArtifacts(), not a host project's files.
// ---------------------------------------------------------------------------

test("real issue-index artifact carries schema, frozen-baseline identity, and grammar", () => {
  assert.equal(realIssueIndex.schema_version, 1);
  assert.ok(typeof realIssueIndex.status === "string" && realIssueIndex.status.length > 0);
  assert.ok(Array.isArray(realIssueIndex.source_corpus) && realIssueIndex.source_corpus.length > 0);
  assert.ok(Array.isArray(realIssueIndex.issues));

  const manifestPath = realIssueIndex.manifest_path;
  assert.ok(typeof manifestPath === "string" && existsSync(resolve(repoRoot, manifestPath)), "manifest_path resolves");
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), "utf8"));
  assert.equal(manifest.status, "frozen", "pinned manifest must be frozen");
  assert.equal(realIssueIndex.baseline_id, manifest.baseline_id);
  assert.equal(realIssueIndex.baseline_version, manifest.version);
  assert.equal(realIssueIndex.manifest_hash, manifest.manifest_hash);
  assert.equal(realIssueIndex.document_set_hash, manifest.document_set_hash);

  const mapText = readFileSync(resolve(repoRoot, "docs/architecture-map/architecture-map.yml"), "utf8");
  const mapGrammar = mapText.match(/^verification_gate_ref_grammar:\s*"([^"]+)"/m);
  assert.ok(mapGrammar, "architecture map declares verification_gate_ref_grammar");
  assert.equal(realIssueIndex.verification_evidence_ref_grammar, mapGrammar[1]);
});

test("real issue-index coverage_summary follows the computed total_doc_lines rule", () => {
  const summary = realIssueIndex.coverage_summary;
  for (const field of ["total_doc_lines", "classified_doc_lines", "requirement_linked_doc_lines", "issue_linked_doc_lines"]) {
    assert.equal(typeof summary[field], "number", `${field} is a number`);
  }
  if (realIssueIndex.issues.length === 0) {
    assert.equal(summary.total_doc_lines, 0, "placeholder total_doc_lines must be 0 until extraction computes it");
  } else {
    const computed = realManifest.files.reduce((sum, file) => {
      const text = readFileSync(resolve(repoRoot, file.path), "utf8");
      return sum + text.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    }, 0);
    assert.equal(summary.total_doc_lines, computed, "total_doc_lines must equal the non-blank manifest files[] count");
  }
});

test("real progress-ledger placeholder is bound to the same frozen baseline", () => {
  const realLedger = JSON.parse(readFileSync(resolve(repoRoot, "spec/development/progress-ledger.json"), "utf8"));
  assert.equal(realLedger.schema_version, 1);
  assert.ok(Array.isArray(realLedger.graph_item_states));
  assert.ok(Array.isArray(realLedger.active_items));
  assert.equal(realLedger.baseline_id, realManifest.baseline_id);
  assert.equal(realLedger.baseline_version, realManifest.version);
  assert.equal(realLedger.manifest_hash, realManifest.manifest_hash);
  assert.equal(realLedger.document_set_hash, realManifest.document_set_hash);
});

test("progress recording is inert against the real empty issue index (Unknown issue_id)", () => {
  const scratch = makeScratch();
  try {
    assert.throws(
      () =>
        recordProgressEvent(
          {
            actor: "codex-master",
            event_type: "issue_started",
            graph_refs: ["node:manager_service"],
            issue_id: "ISS-ANY-0001",
            session_ref: "thread-1",
            timestamp: "2026-06-08T12:00:00.000Z",
          },
          {
            // The real placeholder index (no issues) with a scratch ledger path,
            // so nothing real is written.
            issueIndexPath: "spec/development/issue-index.json",
            progressLedgerPath: scratch.ledgerRel,
          },
        ),
      /Unknown issue_id/,
    );
  } finally {
    scratch.cleanup();
  }
});

test("baseline identity fields on the ledger survive a recorded event", () => {
  const scratch = makeScratch();
  try {
    writeFileSync(
      resolve(repoRoot, scratch.ledgerRel),
      `${JSON.stringify(
        {
          schema_version: 1,
          revision: 0,
          baseline_id: realManifest.baseline_id,
          baseline_version: realManifest.version,
          manifest_hash: realManifest.manifest_hash,
          document_set_hash: realManifest.document_set_hash,
          updated_at: null,
          graph_item_states: [],
          active_items: [],
        },
        null,
        2,
      )}\n`,
    );
    const ledger = recordProgressEvent(startedEvent, {
      issueIndexPath: scratch.issueIndexRel,
      progressLedgerPath: scratch.ledgerRel,
    });
    assert.equal(ledger.baseline_id, realManifest.baseline_id, "baseline_id preserved");
    assert.equal(ledger.manifest_hash, realManifest.manifest_hash, "manifest_hash preserved");
    const onDisk = JSON.parse(readFileSync(scratch.ledgerAbs, "utf8"));
    assert.equal(onDisk.document_set_hash, realManifest.document_set_hash, "identity persisted on disk");
  } finally {
    scratch.cleanup();
  }
});
