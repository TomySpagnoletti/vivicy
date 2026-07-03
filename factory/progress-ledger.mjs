import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveTargetRoot } from "./target-root.mjs";
import { atomicWriteJson } from "./atomic-write.mjs";
import { sleepSync } from "./sleep-sync.mjs";

// The target project whose ledger and issue index this module reads/writes.
// Resolution lives in target-root.mjs (VIVICY_TARGET_ROOT, else null).
// Entrypoints surface the null case; the in-process helpers below resolve
// repo-relative paths against it.
const repoRoot = resolveTargetRoot();
const issueIndexPath = ".vivicy/development/issue-index.json";
const progressLedgerPath = ".vivicy/development/progress-ledger.json";

export const progressEventTypes = [
  "issue_claimed",
  "issue_started",
  "graph_item_focus",
  "heartbeat",
  "gate_started",
  "gate_passed",
  "gate_failed",
  "issue_blocked",
  "issue_completed",
  // The only event allowed to downgrade a terminal status (verified/implemented)
  // back to in_progress; it also bypasses the stale-timestamp guard.
  "issue_reopened",
  "review_started",
  "review_completed",
  // S3 spike proving (G3): the substance-verification stage emits these around each
  // spike's prover/verifier pair. They are keyed by spike gate_id (not a graph item),
  // so they are recorded through the spike prover's own sink, not applyProgressEvent.
  "spike_proof_started",
  "spike_proof_completed",
  // S8 readiness check (G5): the per-issue non-linear-dev verdict and its
  // consequences. readiness_update_applied records a bounded issue-text (execution
  // detail) edit; issue_parked_on_cr records an intention-level block that parks the
  // issue on a change request while the loop keeps moving on other ready issues.
  "readiness_check_started",
  "readiness_check_completed",
  "readiness_update_applied",
  "issue_parked_on_cr",
  // S10 merge integrity (G6): the two integration-time judgments. post_merge_gate_failed
  // is the deterministic detection that a merge damaged the integration tree (green
  // pre-merge, red post-merge); the merge_conflict_* pair records whether the bounded
  // merge-resolver leg reconciled a conflicting worktree branch.
  "post_merge_gate_failed",
  "merge_conflict_resolved",
  "merge_conflict_unresolved",
];

// Optional actor role on an event/active item, so the map can show which agent
// (the implementer or the independent reviewer) is acting. The orchestrator sets
// the role mechanically from the leg it is running, never the agent itself.
// spike_prover / spike_verifier are the S3 proving legs (G3), the R12 pair on the
// spike substance stage. readiness-checker (S8) and merge-resolver (S10) are advisory
// legs that run on the implementer CLI; their verdicts the orchestrator re-gates deterministically.
export const progressRoles = ["implementer", "reviewer", "spike_prover", "spike_verifier", "readiness-checker", "merge-resolver"];

const activeStateByEvent = {
  gate_failed: "verifying",
  gate_started: "verifying",
  graph_item_focus: "working",
  heartbeat: "working",
  issue_blocked: "blocked",
  issue_claimed: "working",
  issue_reopened: "working",
  issue_started: "working",
  review_completed: "reviewing",
  review_started: "reviewing",
  // S8 readiness: the check + a bounded issue edit are working-phase; parking on a CR
  // is a block state so the map lights the parked node until a CR decision reopens it.
  readiness_check_started: "working",
  readiness_check_completed: "working",
  readiness_update_applied: "working",
  issue_parked_on_cr: "blocked",
  // S10 merge integrity: a damaged-merge detection or an unresolved conflict is a block;
  // a resolved conflict returns the issue to the working phase for its retried merge.
  post_merge_gate_failed: "blocked",
  merge_conflict_unresolved: "blocked",
  merge_conflict_resolved: "working",
};

// Higher rank = more advanced; normal events may only raise (or hold) a status.
// "blocked" shares in_progress's rank so blocking an in-progress item is allowed
// while a stray block still cannot downgrade a verified item.
const graphStatusRank = {
  in_progress: 1,
  blocked: 1,
  reviewing: 2,
  implemented: 3,
  verified: 4,
};

// Hand-rolled O_EXCL lockfile to avoid extra dependencies; locks past
// LOCK_STALE_MS or held by a dead PID are reclaimed as abandoned.
const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const CAS_MAX_ATTEMPTS = 50;

export function recordProgressEvent(event, paths = {}) {
  const issueIndexPathResolved = paths.issueIndexPath ?? issueIndexPath;
  const ledgerRelPath = paths.progressLedgerPath ?? progressLedgerPath;
  const issueIndex = readJson(issueIndexPathResolved, "issue index");
  const absoluteLedgerPath = resolveRepoPath(ledgerRelPath);
  const lockPath = `${absoluteLedgerPath}.lock`;

  mkdirSync(dirname(absoluteLedgerPath), { recursive: true });

  const lock = acquireLock(lockPath);
  try {
    // The lock already serializes writers; the compare-and-swap additionally
    // guards against a lock force-stolen mid-write.
    for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt += 1) {
      const baseLedger = readProgressLedger(ledgerRelPath);
      const baseRevision = baseLedger.revision ?? 0;
      const nextLedger = applyProgressEvent({ event, issueIndex, ledger: baseLedger });
      nextLedger.revision = baseRevision + 1;

      const currentRevision = (readProgressLedger(ledgerRelPath).revision ?? 0);
      if (currentRevision !== baseRevision) {
        continue;
      }

      atomicWriteJson(absoluteLedgerPath, nextLedger);
      return nextLedger;
    }
    throw new Error("Unable to record progress event: ledger revision kept changing (compare-and-swap exhausted)");
  } finally {
    releaseLock(lock);
  }
}

// The lockfile body records owner pid + timestamp so a crashed holder's lock
// can be reclaimed.
function acquireLock(lockPath) {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), epoch_ms: Date.now() }));
      closeSync(fd);
      return { lockPath };
    } catch (error) {
      if (error && error.code === "EEXIST") {
        if (reclaimStaleLock(lockPath)) {
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`Timed out acquiring progress ledger lock: ${lockPath}`);
        }
        sleepSync(LOCK_RETRY_MS);
        continue;
      }
      throw error;
    }
  }
}

function releaseLock(lock) {
  try {
    unlinkSync(lock.lockPath);
  } catch {
    // Lock already removed (e.g. reclaimed as stale by another writer); ignore.
  }
}

// Returns true if a stale lock was found and removed (caller should retry acquire).
function reclaimStaleLock(lockPath) {
  let stat;
  try {
    stat = statSync(lockPath);
  } catch {
    // Lock vanished between EEXIST and stat — treat as reclaimable, retry.
    return true;
  }
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8"));
  } catch {
    owner = null;
  }
  const ageMs = Date.now() - stat.mtimeMs;
  const ownerEpoch = owner && typeof owner.epoch_ms === "number" ? owner.epoch_ms : null;
  const effectiveAgeMs = ownerEpoch != null ? Date.now() - ownerEpoch : ageMs;
  const tooOld = effectiveAgeMs > LOCK_STALE_MS;
  const ownerDead = owner && typeof owner.pid === "number" && owner.pid !== process.pid && !isProcessAlive(owner.pid);

  if (!tooOld && !ownerDead) {
    return false;
  }
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    // Someone else reclaimed it first; retry the acquire loop anyway.
    return true;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process. EPERM => process exists but not ours (alive).
    return error && error.code === "EPERM";
  }
}

export function applyProgressEvent({ event, issueIndex, ledger }) {
  const normalized = normalizeProgressEvent(event);
  validateProgressEvent(normalized, issueIndex);
  const now = normalized.timestamp;
  // Never substitute the issue's full set: events declare their explicit graph
  // focus (validated above).
  const graphRefs = normalized.graph_refs;
  const activeItemId = normalized.active_item_id ?? `${normalized.actor}:${normalized.session_ref}:${normalized.issue_id}`;
  const nextLedger = {
    // Spread first: unknown fields (e.g. the unconditional baseline identity
    // fields baseline_id/baseline_version/manifest_hash/document_set_hash) are
    // preserved across writes instead of being silently dropped.
    ...ledger,
    schema_version: 1,
    updated_at: maxTimestamp(ledger.updated_at, now),
    revision: ledger.revision ?? 0,
    graph_item_states: cloneGraphStates(ledger.graph_item_states),
    active_items: [...(ledger.active_items ?? [])],
  };

  if (normalized.event_type === "issue_completed" || normalized.event_type === "gate_passed") {
    upsertGraphStates(nextLedger, graphRefs, normalized.issue_id, "verified", normalized.evidence_refs, now, { transcriptRefs: normalized.transcript_refs });
    removeActiveItemsForIssue(nextLedger, normalized.issue_id);
    return nextLedger;
  }

  if (normalized.event_type === "issue_blocked") {
    upsertGraphStates(nextLedger, graphRefs, normalized.issue_id, "blocked", normalized.evidence_refs, now, { transcriptRefs: normalized.transcript_refs });
    upsertActiveItem(nextLedger, activeItemId, normalized, graphRefs, "blocked", now);
    return nextLedger;
  }

  if (normalized.event_type === "issue_reopened") {
    upsertGraphStates(nextLedger, graphRefs, normalized.issue_id, "in_progress", normalized.evidence_refs, now, { reopen: true, transcriptRefs: normalized.transcript_refs });
    upsertActiveItem(nextLedger, activeItemId, normalized, graphRefs, "working", now);
    return nextLedger;
  }

  if (normalized.event_type === "review_started" || normalized.event_type === "review_completed") {
    // review_completed carrying implemented-evidence advances the node to
    // implemented; any other review event keeps the node in the reviewing phase
    // so it shows as a distinct light on the map.
    const reviewStatus =
      normalized.event_type === "review_completed" && normalized.evidence_refs.length > 0 ? "implemented" : "reviewing";
    upsertGraphStates(nextLedger, graphRefs, normalized.issue_id, reviewStatus, normalized.evidence_refs, now, { transcriptRefs: normalized.transcript_refs });
    upsertActiveItem(nextLedger, activeItemId, normalized, graphRefs, "reviewing", now);
    return nextLedger;
  }

  upsertGraphStates(nextLedger, graphRefs, normalized.issue_id, "in_progress", normalized.evidence_refs, now, { transcriptRefs: normalized.transcript_refs });
  upsertActiveItem(nextLedger, activeItemId, normalized, graphRefs, activeStateByEvent[normalized.event_type] ?? "working", now);
  return nextLedger;
}

export function createEmptyProgressLedger() {
  return {
    schema_version: 1,
    // Monotonic compare-and-swap token for the locked writer.
    revision: 0,
    updated_at: null,
    graph_item_states: [],
    active_items: [],
  };
}

function normalizeProgressEvent(event) {
  return {
    active_item_id: optionalString(event.active_item_id),
    actor: requiredString(event.actor, "actor"),
    evidence_refs: stringArray(event.evidence_refs ?? []),
    event_type: requiredString(event.event_type, "event_type"),
    graph_refs: stringArray(event.graph_refs ?? []),
    issue_id: requiredString(event.issue_id, "issue_id"),
    role: optionalString(event.role),
    // Required so active items always correlate to a real session.
    session_ref: requiredString(event.session_ref, "session_ref"),
    timestamp: optionalString(event.timestamp) ?? new Date().toISOString(),
    // Repo-relative paths to the full agent transcript(s) for this leg (the
    // gitignored JSONL captured by the orchestrator). Not existence-validated:
    // transcripts live in a gitignored store and may be absent in tests.
    transcript_refs: stringArray(event.transcript_refs ?? []),
    worktree: optionalString(event.worktree),
  };
}

function validateProgressEvent(event, issueIndex) {
  if (!progressEventTypes.includes(event.event_type)) {
    throw new Error(`Unsupported progress event_type: ${event.event_type}`);
  }
  if (event.role !== undefined && !progressRoles.includes(event.role)) {
    throw new Error(`Unsupported role: ${event.role} (expected one of ${progressRoles.join(", ")})`);
  }
  if (event.graph_refs.length === 0) {
    throw new Error("graph_refs must be a non-empty array: events declare their explicit graph focus");
  }
  if (!Array.isArray(issueIndex.issues)) {
    throw new Error("Issue index must define issues[]");
  }
  const verificationEvidenceMatcher = createVerificationEvidenceMatcher(issueIndex.verification_evidence_ref_grammar);
  const issue = issueIndex.issues.find((entry) => entry.id === event.issue_id);
  if (!issue) {
    throw new Error(`Unknown issue_id: ${event.issue_id}`);
  }
  for (const graphRef of event.graph_refs) {
    if (!issue.graph_refs.includes(graphRef)) {
      throw new Error(`Event graph_ref ${graphRef} is not linked to issue ${event.issue_id}`);
    }
  }
  if ((event.event_type === "gate_passed" || event.event_type === "issue_completed") && event.evidence_refs.length === 0) {
    throw new Error(`${event.event_type} requires evidence_refs`);
  }
  if (
    (event.event_type === "gate_passed" || event.event_type === "issue_completed") &&
    !event.evidence_refs.some((ref) => verificationEvidenceMatcher.test(ref))
  ) {
    throw new Error(`${event.event_type} requires at least one verification evidence_ref`);
  }
  if (event.event_type === "issue_blocked" && event.evidence_refs.length === 0) {
    throw new Error("issue_blocked requires evidence_refs");
  }
  validateEvidenceRefs(event.evidence_refs);
  if (event.event_type === "gate_passed" || event.event_type === "issue_completed") {
    validateVerificationGateBinding(event, issue, verificationEvidenceMatcher);
  }
  return issue;
}

// When the issue declares verification_gate_ids, a grammar-matching path alone is
// not proof: at least one evidence ref must be a green gate-run record (per the
// governance method) for one of the issue's own declared gate ids.
function validateVerificationGateBinding(event, issue, matcher) {
  const declaredGateIds = Array.isArray(issue.verification_gate_ids) ? issue.verification_gate_ids : [];
  if (declaredGateIds.length === 0) {
    return;
  }
  const satisfied = event.evidence_refs.some((ref) => {
    if (!matcher.test(ref)) {
      return false;
    }
    let record;
    try {
      record = JSON.parse(readFileSync(resolveRepoPath(parseEvidenceRef(ref).filePath), "utf8"));
    } catch {
      return false;
    }
    return (
      record !== null &&
      typeof record === "object" &&
      record.status === "pass" &&
      record.exit_code === 0 &&
      declaredGateIds.includes(record.gate_id)
    );
  });
  if (!satisfied) {
    throw new Error(
      `${event.event_type} requires a gate-run record evidence_ref with status "pass", exit_code 0, and a gate_id declared on the issue (${declaredGateIds.join(", ")})`,
    );
  }
}

function upsertGraphStates(ledger, graphRefs, issueId, status, evidenceRefs, timestamp, options = {}) {
  const reopen = options.reopen === true;
  const transcriptRefs = options.transcriptRefs ?? [];
  for (const graphRef of graphRefs) {
    const existing = ledger.graph_item_states.find((state) => state.graph_ref === graphRef);
    if (existing) {
      // issue_ids/evidence_refs/transcript_refs are append-only facts; status and
      // updated_at must not regress on a late or downgrading event.
      existing.issue_ids = [...new Set([...existing.issue_ids, issueId])];
      existing.evidence_refs = [...new Set([...existing.evidence_refs, ...evidenceRefs])];
      if (transcriptRefs.length) {
        existing.transcript_refs = [...new Set([...(existing.transcript_refs ?? []), ...transcriptRefs])];
      }
      ensureIssueStates(existing);

      const stale = timestamp !== undefined && existing.updated_at != null && timestamp < existing.updated_at;
      if (reopen) {
        existing.issue_states[issueId] = status;
        existing.status = aggregateGraphStatus(existing.issue_states);
        existing.updated_at = maxTimestamp(existing.updated_at, timestamp);
        continue;
      }
      if (stale) {
        continue;
      }
      const currentIssueStatus = existing.issue_states[issueId];
      if (currentIssueStatus === undefined || rankOf(status) >= rankOf(currentIssueStatus)) {
        existing.issue_states[issueId] = status;
      }
      existing.status = aggregateGraphStatus(existing.issue_states);
      existing.updated_at = maxTimestamp(existing.updated_at, timestamp);
      continue;
    }
    ledger.graph_item_states.push({
      graph_ref: graphRef,
      status,
      issue_states: { [issueId]: status },
      issue_ids: [issueId],
      evidence_refs: [...evidenceRefs],
      ...(transcriptRefs.length ? { transcript_refs: [...transcriptRefs] } : {}),
      updated_at: timestamp ?? null,
    });
  }
}

// Migration shim: ledgers written before per-issue states synthesize issue_states
// from the recorded scalar status.
function ensureIssueStates(state) {
  if (!state.issue_states || typeof state.issue_states !== "object") {
    state.issue_states = Object.fromEntries(state.issue_ids.map((id) => [id, state.status]));
  }
}

// A shared graph item displays the least-advanced linked issue state; at equal
// lowest rank, blocked wins so a blocker stays visible.
function aggregateGraphStatus(issueStates) {
  const statuses = Object.values(issueStates);
  let lowest = statuses[0];
  for (const status of statuses) {
    if (rankOf(status) < rankOf(lowest) || (rankOf(status) === rankOf(lowest) && status === "blocked")) {
      lowest = status;
    }
  }
  return lowest;
}

function rankOf(status) {
  return graphStatusRank[status] ?? 0;
}

// ISO-8601 timestamps compare correctly lexicographically; null sorts first.
function maxTimestamp(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return b > a ? b : a;
}

function cloneGraphStates(states) {
  return (states ?? []).map((state) => ({
    ...state,
    issue_ids: [...state.issue_ids],
    evidence_refs: [...state.evidence_refs],
    ...(Array.isArray(state.transcript_refs) ? { transcript_refs: [...state.transcript_refs] } : {}),
    ...(state.issue_states && typeof state.issue_states === "object" ? { issue_states: { ...state.issue_states } } : {}),
  }));
}

function upsertActiveItem(ledger, id, event, graphRefs, state, heartbeatAt) {
  const next = {
    actor: event.actor,
    graph_refs: graphRefs,
    heartbeat_at: heartbeatAt,
    id,
    issue_id: event.issue_id,
    state,
    ...(event.role ? { role: event.role } : {}),
    ...(event.transcript_refs && event.transcript_refs.length ? { transcript_refs: event.transcript_refs } : {}),
    ...(event.session_ref ? { session_ref: event.session_ref } : {}),
    ...(event.worktree ? { worktree: event.worktree } : {}),
    started_at: event.timestamp,
  };
  const index = ledger.active_items.findIndex((item) => item.id === id);
  if (index >= 0) {
    ledger.active_items[index] = { ...ledger.active_items[index], ...next, started_at: ledger.active_items[index].started_at ?? next.started_at };
    return;
  }
  ledger.active_items.push(next);
}

// A completed issue has no active work, so clear EVERY active item for it — not
// only the one matching the completing actor. The reviewer leg runs under a
// different actor than the implementer, so a single-id removal would leave the
// reviewer's "reviewing" item dangling and hold the shared node's conservative
// aggregate below verified forever.
function removeActiveItemsForIssue(ledger, issueId) {
  ledger.active_items = ledger.active_items.filter((item) => item.issue_id !== issueId);
}

function readProgressLedger(path) {
  if (!existsSync(resolveRepoPath(path))) return createEmptyProgressLedger();
  return readJson(path, "progress ledger");
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolveRepoPath(path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEvidenceRefs(evidenceRefs) {
  for (const ref of evidenceRefs) {
    const { filePath, line } = parseEvidenceRef(ref);
    const absolutePath = resolveRepoPath(filePath);
    if (!existsSync(absolutePath)) {
      throw new Error(`Evidence ref points to a missing file: ${ref}`);
    }
    if (line !== undefined) {
      const lineCount = readFileSync(absolutePath, "utf8").split(/\r?\n/).length;
      if (line < 1 || line > lineCount) {
        throw new Error(`Evidence ref points to a missing line: ${ref}`);
      }
    }
  }
}

function parseEvidenceRef(ref) {
  const withoutAnchor = ref.split("#")[0];
  const match = withoutAnchor.match(/^(.+):(\d+)$/);
  if (!match) {
    return { filePath: withoutAnchor };
  }
  return { filePath: match[1], line: Number(match[2]) };
}

function createVerificationEvidenceMatcher(grammar) {
  if (typeof grammar !== "string" || !grammar) {
    throw new Error("Issue index must define verification_evidence_ref_grammar");
  }
  try {
    return new RegExp(grammar, "i");
  } catch (error) {
    throw new Error(`Issue index verification_evidence_ref_grammar is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveRepoPath(path) {
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project Vivicy should build.",
    );
  }
  if (isAbsolute(path)) throw new Error(`Path must be repository-relative: ${path}`);
  const absolute = resolve(repoRoot, path);
  const rel = relative(repoRoot, absolute);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Path must stay inside repository: ${path}`);
  return absolute;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Expected string array");
  }
  return value;
}
