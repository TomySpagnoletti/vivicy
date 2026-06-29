/**
 * The ONE shared derivation of the live development overlay from the progress
 * ledger. The progress ledger (`.vivicy/development/progress-ledger.json`) is the
 * single source of truth for live per-issue/per-graph-item progress; the
 * architecture map data is a STATIC graph generated once at extraction. The live
 * overlay — `graph_item_states` and `active_items` — is DERIVED from the ledger,
 * never baked in and never regenerated during the dev-loop.
 *
 * Both callers use this one implementation so the ledger -> overlay mapping can
 * never diverge:
 *   - `factory/generate-viewer-data.ts` (extraction-time, strict): passes an
 *     `evidenceRefChecker` that verifies every evidence_ref points at a real
 *     file/line on disk, so the authored corpus is provably honest.
 *   - the `/api/map` read path (request-time, tolerant): omits the checker and
 *     overlays the live ledger onto the static graph with zero regeneration, so
 *     loading a target always shows current progress.
 *
 * Framework-free: imports only `node:*`-free pure logic so it loads under both
 * the Next.js bundler (`@/lib/...`) and raw Node TS execution (a relative import
 * from the factory generator). No filesystem access here — strict file checks
 * are injected by the caller that needs them.
 */

/** The development statuses a graph item can carry, in display order. */
export const OVERLAY_STATUSES = [
  "not_started",
  "in_progress",
  "reviewing",
  "implemented",
  "verified",
  "blocked",
] as const

export type OverlayStatus = (typeof OVERLAY_STATUSES)[number]

/** States an active development agent can be in. */
export const ACTIVE_ITEM_STATES = ["working", "reviewing", "verifying", "blocked"] as const

export type ActiveItemState = (typeof ACTIVE_ITEM_STATES)[number]

/** A single graph item's live progress, derived from the ledger. */
export type OverlayGraphItemState = {
  graph_ref: string
  status: OverlayStatus
  issue_ids: string[]
  evidence_refs: string[]
  transcript_refs?: string[]
}

/** A development agent actively working on one or more graph items. */
export type OverlayActiveItem = {
  id: string
  actor: string
  issue_id: string
  graph_refs: string[]
  state: ActiveItemState
  role?: "implementer" | "reviewer"
  transcript_refs?: string[]
  worktree?: string
  session_ref?: string
  started_at?: string
  heartbeat_at: string
}

/** The live overlay derived from the ledger: the only per-issue-changing part. */
export type DevelopmentOverlayState = {
  graph_item_states: OverlayGraphItemState[]
  active_items: OverlayActiveItem[]
}

/** The minimum an issue must expose for graph-ref membership checks. */
export type OverlayIssue = {
  id: string
  graph_refs: string[]
}

/**
 * Verify an evidence_ref points at a real file (and, when line-qualified, a real
 * line). Throws on a missing target. The strict (extraction) caller injects this;
 * the read path omits it so a stale on-disk evidence file never 500s a request.
 */
export type EvidenceRefChecker = (evidenceRef: string, owner: string) => void

export type DeriveOverlayOptions = {
  /** Valid graph_refs from the STATIC graph (every node + edge ref). */
  graphRefs: Set<string>
  /** The static issue list (from the issue index), for membership checks. */
  issues: OverlayIssue[]
  /** The parsed progress ledger JSON (or `undefined`/`null` when none exists). */
  ledger: unknown
  /** Matches a verification-gate evidence_ref; required for `verified` items. */
  verificationGateMatcher: RegExp
  /** Strict-only: verify each evidence_ref exists on disk. Omitted on read. */
  evidenceRefChecker?: EvidenceRefChecker
}

const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

/**
 * Derive the live overlay (`graph_item_states`, `active_items`) from the ledger.
 *
 * Pure and deterministic: maps every ledger entry to a typed overlay item,
 * scoped to the static graph_refs and known issues, with the SAME validation
 * both callers share. The only injected difference is `evidenceRefChecker`
 * (on-disk evidence verification), which the strict extraction caller supplies
 * and the tolerant read caller omits.
 */
export function deriveDevelopmentOverlay(options: DeriveOverlayOptions): DevelopmentOverlayState {
  const { graphRefs, issues, ledger, verificationGateMatcher, evidenceRefChecker } = options
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]))
  const activeItems = deriveActiveItems(ledger, graphRefs, issuesById)
  const graphItemStates = deriveGraphItemStates(
    ledger,
    graphRefs,
    issuesById,
    verificationGateMatcher,
    activeItems,
    evidenceRefChecker
  )
  return { graph_item_states: graphItemStates, active_items: activeItems }
}

function deriveGraphItemStates(
  ledger: unknown,
  graphRefs: Set<string>,
  issuesById: Map<string, OverlayIssue>,
  verificationGateMatcher: RegExp,
  activeItems: OverlayActiveItem[],
  evidenceRefChecker: EvidenceRefChecker | undefined
): OverlayGraphItemState[] {
  if (ledger === undefined || ledger === null) return []
  if (!isRecord(ledger) || !Array.isArray(ledger.graph_item_states)) {
    throw new Error("Development progress ledger must define a graph_item_states array")
  }
  const states = ledger.graph_item_states.map((entry, index) =>
    validateGraphItemState(
      entry,
      index,
      graphRefs,
      issuesById,
      verificationGateMatcher,
      activeItems,
      evidenceRefChecker
    )
  )
  const seen = new Set<string>()
  for (const state of states) {
    if (seen.has(state.graph_ref)) {
      throw new Error(`Development progress ledger has duplicate graph_item_state for ${state.graph_ref}`)
    }
    seen.add(state.graph_ref)
  }
  return states
}

function validateGraphItemState(
  input: unknown,
  index: number,
  graphRefs: Set<string>,
  issuesById: Map<string, OverlayIssue>,
  verificationGateMatcher: RegExp,
  activeItems: OverlayActiveItem[],
  evidenceRefChecker: EvidenceRefChecker | undefined
): OverlayGraphItemState {
  if (!isRecord(input)) {
    throw new Error(`Progress graph_item_states entry ${index} must be an object`)
  }
  const graph_ref = requiredString(input.graph_ref, `Progress graph item state ${index}.graph_ref`)
  validateGraphRefs([graph_ref], graphRefs, `Progress graph item state ${graph_ref}`)
  const issueIds = requiredStringArray(input.issue_ids, `Progress graph item state ${graph_ref}.issue_ids`)
  if (issueIds.length === 0) {
    throw new Error(`Progress graph item state ${graph_ref}.issue_ids must reference at least one issue`)
  }
  validateIssueRefsForGraphRef(issueIds, graph_ref, issuesById, `Progress graph item state ${graph_ref}`)
  const evidenceRefs = requiredStringArray(input.evidence_refs, `Progress graph item state ${graph_ref}.evidence_refs`)
  if (evidenceRefChecker) {
    for (const evidenceRef of evidenceRefs) {
      evidenceRefChecker(evidenceRef, `Progress graph item state ${graph_ref}`)
    }
  }
  if ((statusNeedsEvidence(input.status) || input.status === "verified") && evidenceRefs.length === 0) {
    throw new Error(`Progress graph item state ${graph_ref} status ${String(input.status)} requires evidence_refs`)
  }
  if (input.status === "verified" && !evidenceRefs.some((ref) => verificationGateMatcher.test(ref))) {
    throw new Error(`Progress graph item state ${graph_ref} verified status requires a verification gate evidence_ref`)
  }
  if (
    input.status === "in_progress" &&
    !activeItems.some(
      (item) => issueIds.includes(item.issue_id) && item.graph_refs.includes(graph_ref) && item.heartbeat_at
    )
  ) {
    throw new Error(`Progress graph item state ${graph_ref} in_progress requires a matching active item heartbeat`)
  }
  return {
    graph_ref,
    status: requiredEnum(input.status, OVERLAY_STATUSES, `Progress graph item state ${graph_ref}.status`),
    issue_ids: issueIds,
    evidence_refs: evidenceRefs,
    ...(Array.isArray(input.transcript_refs)
      ? {
          transcript_refs: input.transcript_refs.map((ref, i) =>
            requiredString(ref, `Progress graph item state ${graph_ref}.transcript_refs[${i}]`)
          ),
        }
      : {}),
  }
}

function deriveActiveItems(
  ledger: unknown,
  graphRefs: Set<string>,
  issuesById: Map<string, OverlayIssue>
): OverlayActiveItem[] {
  if (ledger === undefined || ledger === null) return []
  if (!isRecord(ledger) || !Array.isArray(ledger.active_items)) {
    throw new Error("Development progress ledger must define an active_items array")
  }
  return ledger.active_items.map((entry, index) => validateActiveItem(entry, index, graphRefs, issuesById))
}

function validateActiveItem(
  input: unknown,
  index: number,
  graphRefs: Set<string>,
  issuesById: Map<string, OverlayIssue>
): OverlayActiveItem {
  if (!isRecord(input)) {
    throw new Error(`Progress active_items entry ${index} must be an object`)
  }
  const id = requiredString(input.id, `Progress active item ${index}.id`)
  const issue_id = requiredString(input.issue_id, `Progress active item ${id}.issue_id`)
  if (!issuesById.has(issue_id)) {
    throw new Error(`Progress active item ${id} references unknown issue: ${issue_id}`)
  }
  const graph_refs = requiredStringArray(input.graph_refs, `Progress active item ${id}.graph_refs`)
  validateGraphRefs(graph_refs, graphRefs, `Progress active item ${id}`)
  validateIssueRefsForGraphRef([issue_id], graph_refs, issuesById, `Progress active item ${id}`)
  return {
    id,
    actor: requiredString(input.actor, `Progress active item ${id}.actor`),
    issue_id,
    graph_refs,
    state: requiredEnum(input.state, ACTIVE_ITEM_STATES, `Progress active item ${id}.state`),
    ...(input.role === "implementer" || input.role === "reviewer" ? { role: input.role } : {}),
    ...(Array.isArray(input.transcript_refs)
      ? {
          transcript_refs: input.transcript_refs.map((ref, i) =>
            requiredString(ref, `Progress active item ${id}.transcript_refs[${i}]`)
          ),
        }
      : {}),
    ...(typeof input.worktree === "string" ? { worktree: input.worktree } : {}),
    ...(typeof input.session_ref === "string" ? { session_ref: input.session_ref } : {}),
    ...(typeof input.started_at === "string" ? { started_at: input.started_at } : {}),
    heartbeat_at: requiredIsoTimestamp(input.heartbeat_at, `Progress active item ${id}.heartbeat_at`),
  }
}

function validateIssueRefsForGraphRef(
  issueIds: string[],
  graphRefs: string | string[],
  issuesById: Map<string, OverlayIssue>,
  owner: string
): void {
  const expected = Array.isArray(graphRefs) ? graphRefs : [graphRefs]
  for (const issueId of issueIds) {
    const issue = issuesById.get(issueId)
    if (!issue) {
      throw new Error(`${owner} references unknown issue: ${issueId}`)
    }
    for (const graphRef of expected) {
      if (!issue.graph_refs.includes(graphRef)) {
        throw new Error(`${owner} references ${graphRef}, but issue ${issueId} does not include that graph_ref`)
      }
    }
  }
}

function validateGraphRefs(refs: string[], graphRefs: Set<string>, owner: string): void {
  for (const graphRef of refs) {
    if (!graphRefs.has(graphRef)) {
      throw new Error(`${owner} references unknown graph item: ${graphRef}`)
    }
  }
}

function statusNeedsEvidence(status: unknown): boolean {
  return status === "implemented" || status === "blocked"
}

/** `node:<id>` graph_ref for a map node. Shared with the static-graph derivation. */
export function nodeGraphRef(nodeId: string): string {
  return `node:${nodeId}`
}

/** Canonical edge graph_ref, mirroring the source-map / generator convention. */
export function edgeGraphRef(edge: {
  from: string
  to: string
  relation?: string
  protocol?: string
}): string {
  return `edge:${edge.from}->${edge.to}:${slugGraphRefPart(edge.relation ?? "")}:${slugGraphRefPart(
    edge.protocol ?? ""
  )}`
}

function slugGraphRefPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requiredStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${label} must be a string array`)
  }
  return [...value]
}

function requiredIsoTimestamp(value: unknown, label: string): string {
  const stringValue = requiredString(value, label)
  // Liveness/expiry is deliberately not checked here (see the method).
  if (!ISO_8601_TIMESTAMP.test(stringValue) || Number.isNaN(Date.parse(stringValue))) {
    throw new Error(`${label} must be an ISO-8601 timestamp`)
  }
  return stringValue
}

function requiredEnum<T extends readonly string[]>(value: unknown, allowedValues: T, label: string): T[number] {
  if (typeof value !== "string" || !(allowedValues as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of: ${allowedValues.join(", ")}`)
  }
  return value as T[number]
}

/**
 * Kept local rather than imported from `@/lib/type-guards` because this module
 * must also load under the raw Node TS loader (the factory generator imports it
 * by relative `.ts` path), where neither the `@/` alias nor extensionless `.ts`
 * imports resolve. A cross-module import would force a `.ts` extension the
 * Next/root tsconfig rejects, so the guard stays self-contained here.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
