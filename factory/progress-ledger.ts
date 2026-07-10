import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { resolveTargetRoot } from "./target-root.ts";
import { atomicWriteJson } from "./atomic-write.ts";
import { sleepSync } from "./sleep-sync.ts";

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
  "issue_reopened",
  "review_started",
  "review_completed",
  // Keyed by a spike gate_id, not a graph item; recorded via the spike prover's own sink, not applyProgressEvent.
  "spike_proof_started",
  "spike_proof_completed",
  "readiness_check_started",
  "readiness_check_completed",
  "readiness_update_applied",
  "issue_parked_on_cr",
  "post_merge_gate_failed",
  "merge_conflict_resolved",
  "merge_conflict_unresolved",
] as const;

export type ProgressEventType = (typeof progressEventTypes)[number];

export const progressRoles = ["implementer", "reviewer", "spike_prover", "spike_verifier", "readiness-checker", "merge-resolver"] as const;

export type ProgressRole = (typeof progressRoles)[number];

export type ActiveItemState = "working" | "verifying" | "reviewing" | "blocked";

const activeStateByEvent: Partial<Record<ProgressEventType, ActiveItemState>> = {
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
  readiness_check_started: "working",
  readiness_check_completed: "working",
  readiness_update_applied: "working",
  issue_parked_on_cr: "blocked",
  post_merge_gate_failed: "blocked",
  merge_conflict_unresolved: "blocked",
  merge_conflict_resolved: "working",
};

export type GraphItemStatus = "in_progress" | "blocked" | "reviewing" | "implemented" | "verified";

// Rank only moves forward (>=); blocked shares in_progress's rank so it can flip an in-progress item but never downgrade a verified one.
const graphStatusRank: Record<GraphItemStatus, number> = {
  in_progress: 1,
  blocked: 1,
  reviewing: 2,
  implemented: 3,
  verified: 4,
};

// Hand-rolled O_EXCL lockfile: deliberately avoids adding a dependency.
const LOCK_STALE_MS = 30_000;
const LOCK_ACQUIRE_TIMEOUT_MS = 10_000;
const LOCK_RETRY_MS = 25;
const CAS_MAX_ATTEMPTS = 50;

export interface ProgressEvent {
  event_type: ProgressEventType;
  issue_id: string;
  actor: string;
  session_ref: string;
  graph_refs: string[];
  active_item_id?: string;
  evidence_refs?: string[];
  role?: ProgressRole;
  timestamp?: string;
  transcript_refs?: string[];
  worktree?: string;
}

export interface ProgressIssue {
  id: string;
  graph_refs: string[];
  verification_gate_ids?: string[];
}

export interface ProgressIssueIndex {
  issues: ProgressIssue[];
  verification_evidence_ref_grammar: string;
}

// Written by the dev-loop gate runner (a separate module).
export interface GateRunRecord {
  gate_id: string;
  issue_id: string;
  command: string;
  exit_code: number;
  status: "pass" | "fail";
  finished_at: string;
  baseline_id: string;
}

export interface GraphItemState {
  graph_ref: string;
  status: GraphItemStatus;
  issue_states: Record<string, GraphItemStatus>;
  issue_ids: string[];
  evidence_refs: string[];
  transcript_refs?: string[];
  updated_at: string | null;
}

export interface ActiveItem {
  id: string;
  actor: string;
  issue_id: string;
  graph_refs: string[];
  state: ActiveItemState;
  heartbeat_at: string;
  started_at: string;
  role?: ProgressRole;
  transcript_refs?: string[];
  session_ref?: string;
  worktree?: string;
}

export interface ProgressLedger {
  schema_version: number;
  revision: number;
  updated_at: string | null;
  graph_item_states: GraphItemState[];
  active_items: ActiveItem[];
  // Deliberately open: unknown fields (e.g. baseline identity data) are written by other code and pass through untouched.
  [key: string]: unknown;
}

export interface ProgressLedgerPaths {
  issueIndexPath?: string;
  progressLedgerPath?: string;
}

export function recordProgressEvent(event: ProgressEvent, paths: ProgressLedgerPaths = {}): ProgressLedger {
  const issueIndexPathResolved = paths.issueIndexPath ?? issueIndexPath;
  const ledgerRelPath = paths.progressLedgerPath ?? progressLedgerPath;
  const issueIndex = readJson<ProgressIssueIndex>(issueIndexPathResolved, "issue index");
  const absoluteLedgerPath = resolveRepoPath(ledgerRelPath);
  const lockPath = `${absoluteLedgerPath}.lock`;

  mkdirSync(dirname(absoluteLedgerPath), { recursive: true });

  const lock = acquireLock(lockPath);
  try {
    // Lock already serializes writers; CAS additionally guards against a lock force-stolen mid-write.
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

interface LockHandle {
  lockPath: string;
}

interface LockOwner {
  pid?: number;
  acquired_at?: string;
  epoch_ms?: number;
}

function acquireLock(lockPath: string): LockHandle {
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString(), epoch_ms: Date.now() }));
      closeSync(fd);
      return { lockPath };
    } catch (error) {
      if (error && (error as NodeJS.ErrnoException).code === "EEXIST") {
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

function releaseLock(lock: LockHandle): void {
  try {
    unlinkSync(lock.lockPath);
  } catch {
    // Lock already removed (e.g. reclaimed as stale by another writer); ignore.
  }
}

function reclaimStaleLock(lockPath: string): boolean {
  let stat: Stats;
  try {
    stat = statSync(lockPath);
  } catch {
    // Lock vanished between EEXIST and stat — treat as reclaimable, retry.
    return true;
  }
  let owner: LockOwner | null = null;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf8")) as LockOwner;
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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH => no such process. EPERM => process exists but not ours (alive).
    return (error && (error as NodeJS.ErrnoException).code === "EPERM") as boolean;
  }
}

export function applyProgressEvent({
  event,
  issueIndex,
  ledger,
}: {
  event: ProgressEvent;
  issueIndex: ProgressIssueIndex;
  ledger: ProgressLedger;
}): ProgressLedger {
  const normalized = normalizeProgressEvent(event);
  validateProgressEvent(normalized, issueIndex);
  const now = normalized.timestamp;
  // graphRefs come from the event, not the issue's full set — events declare their explicit graph focus (validated above).
  const graphRefs = normalized.graph_refs;
  const activeItemId = normalized.active_item_id ?? `${normalized.actor}:${normalized.session_ref}:${normalized.issue_id}`;
  const nextLedger: ProgressLedger = {
    // Spread the ledger first: reordering would silently drop unknown fields (e.g. baseline identity data) instead of round-tripping them.
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

export function createEmptyProgressLedger(): ProgressLedger {
  return {
    schema_version: 1,
    revision: 0,
    updated_at: null,
    graph_item_states: [],
    active_items: [],
  };
}

// Casts below are sound only because validateProgressEvent, called right after, enforces event_type/role membership.
interface NormalizedProgressEvent {
  active_item_id: string | undefined;
  actor: string;
  evidence_refs: string[];
  event_type: ProgressEventType;
  graph_refs: string[];
  issue_id: string;
  role: ProgressRole | undefined;
  session_ref: string;
  timestamp: string;
  transcript_refs: string[];
  worktree: string | undefined;
}

function normalizeProgressEvent(event: ProgressEvent): NormalizedProgressEvent {
  return {
    active_item_id: optionalString(event.active_item_id),
    actor: requiredString(event.actor, "actor"),
    evidence_refs: stringArray(event.evidence_refs ?? []),
    event_type: requiredString(event.event_type, "event_type") as ProgressEventType,
    graph_refs: stringArray(event.graph_refs ?? []),
    issue_id: requiredString(event.issue_id, "issue_id"),
    role: optionalString(event.role) as ProgressRole | undefined,
    session_ref: requiredString(event.session_ref, "session_ref"),
    timestamp: optionalString(event.timestamp) ?? new Date().toISOString(),
    // Gitignored JSONL transcript paths captured by the orchestrator; unlike evidence_refs, not existence-validated (may be absent in tests).
    transcript_refs: stringArray(event.transcript_refs ?? []),
    worktree: optionalString(event.worktree),
  };
}

function validateProgressEvent(event: NormalizedProgressEvent, issueIndex: ProgressIssueIndex): ProgressIssue {
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

function validateVerificationGateBinding(event: NormalizedProgressEvent, issue: ProgressIssue, matcher: RegExp): void {
  const declaredGateIds = Array.isArray(issue.verification_gate_ids) ? issue.verification_gate_ids : [];
  if (declaredGateIds.length === 0) {
    return;
  }
  const satisfied = event.evidence_refs.some((ref) => {
    if (!matcher.test(ref)) {
      return false;
    }
    let record: GateRunRecord | null;
    try {
      record = JSON.parse(readFileSync(resolveRepoPath(parseEvidenceRef(ref).filePath), "utf8")) as GateRunRecord | null;
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

function upsertGraphStates(
  ledger: ProgressLedger,
  graphRefs: string[],
  issueId: string,
  status: GraphItemStatus,
  evidenceRefs: string[],
  timestamp: string,
  options: { reopen?: boolean; transcriptRefs?: string[] } = {},
): void {
  const reopen = options.reopen === true;
  const transcriptRefs = options.transcriptRefs ?? [];
  for (const graphRef of graphRefs) {
    const existing = ledger.graph_item_states.find((state) => state.graph_ref === graphRef);
    if (existing) {
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

// Migration shim: ledgers written before per-issue states synthesize issue_states from the recorded scalar status.
function ensureIssueStates(state: GraphItemState): void {
  if (!state.issue_states || typeof state.issue_states !== "object") {
    state.issue_states = Object.fromEntries(state.issue_ids.map((id) => [id, state.status] as const));
  }
}

// Displays the least-advanced linked issue state; blocked wins ties so a blocker stays visible.
function aggregateGraphStatus(issueStates: Record<string, GraphItemStatus>): GraphItemStatus {
  const statuses = Object.values(issueStates);
  let lowest = statuses[0];
  for (const status of statuses) {
    if (rankOf(status) < rankOf(lowest) || (rankOf(status) === rankOf(lowest) && status === "blocked")) {
      lowest = status;
    }
  }
  return lowest;
}

function rankOf(status: GraphItemStatus): number {
  return graphStatusRank[status] ?? 0;
}

// ISO-8601 timestamps compare correctly lexicographically; null sorts first.
function maxTimestamp(a: string | null, b: string | null): string | null {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return b > a ? b : a;
}

function cloneGraphStates(states: GraphItemState[] | undefined): GraphItemState[] {
  return (states ?? []).map((state) => ({
    ...state,
    issue_ids: [...state.issue_ids],
    evidence_refs: [...state.evidence_refs],
    ...(Array.isArray(state.transcript_refs) ? { transcript_refs: [...state.transcript_refs] } : {}),
    ...(state.issue_states && typeof state.issue_states === "object" ? { issue_states: { ...state.issue_states } } : {}),
  }));
}

function upsertActiveItem(
  ledger: ProgressLedger,
  id: string,
  event: NormalizedProgressEvent,
  graphRefs: string[],
  state: ActiveItemState,
  heartbeatAt: string,
): void {
  const next: ActiveItem = {
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

// Clears every active item for the issue, not just the completing actor's — the reviewer runs under a different actor than the implementer, so a single-id removal would leave its item dangling and hold the aggregate below verified forever.
function removeActiveItemsForIssue(ledger: ProgressLedger, issueId: string): void {
  ledger.active_items = ledger.active_items.filter((item) => item.issue_id !== issueId);
}

function readProgressLedger(path: string): ProgressLedger {
  if (!existsSync(resolveRepoPath(path))) return createEmptyProgressLedger();
  return readJson<ProgressLedger>(path, "progress ledger");
}

// T is the caller's trusted shape only — JSON.parse here isn't validated; downstream guards (validateProgressEvent, ?? defaults) tolerate drift.
function readJson<T>(path: string, label: string): T {
  try {
    return JSON.parse(readFileSync(resolveRepoPath(path), "utf8")) as T;
  } catch (error) {
    throw new Error(`Unable to read ${label} at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateEvidenceRefs(evidenceRefs: string[]): void {
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

function parseEvidenceRef(ref: string): { filePath: string; line?: number } {
  const withoutAnchor = ref.split("#")[0];
  const match = withoutAnchor.match(/^(.+):(\d+)$/);
  if (!match) {
    return { filePath: withoutAnchor };
  }
  return { filePath: match[1], line: Number(match[2]) };
}

function createVerificationEvidenceMatcher(grammar: unknown): RegExp {
  if (typeof grammar !== "string" || !grammar) {
    throw new Error("Issue index must define verification_evidence_ref_grammar");
  }
  try {
    return new RegExp(grammar, "i");
  } catch (error) {
    throw new Error(`Issue index verification_evidence_ref_grammar is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resolveRepoPath(path: string): string {
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

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error("Expected string array");
  }
  return value;
}
