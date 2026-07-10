// Framework-free (no filesystem access): loads under both the Next.js bundler and the factory generator's raw Node TS execution; both /api/map and generate-viewer-data.ts share this derivation so the ledger->overlay mapping can't diverge between them.

export const OVERLAY_STATUSES = [
  "not_started",
  "in_progress",
  "reviewing",
  "implemented",
  "verified",
  "blocked",
] as const

export type OverlayStatus = (typeof OVERLAY_STATUSES)[number]

export const ACTIVE_ITEM_STATES = ["working", "reviewing", "verifying", "blocked"] as const

export type ActiveItemState = (typeof ACTIVE_ITEM_STATES)[number]

export type OverlayGraphItemState = {
  graph_ref: string
  status: OverlayStatus
  issue_ids: string[]
  evidence_refs: string[]
  transcript_refs?: string[]
}

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

export type DevelopmentOverlayState = {
  graph_item_states: OverlayGraphItemState[]
  active_items: OverlayActiveItem[]
}

export type OverlayIssue = {
  id: string
  graph_refs: string[]
}

// Read path omits this checker deliberately — enforcing on-disk evidence at request time would 500 the API on any stale evidence_ref.
export type EvidenceRefChecker = (evidenceRef: string, owner: string) => void

export type DeriveOverlayOptions = {
  graphRefs: Set<string>
  issues: OverlayIssue[]
  ledger: unknown
  verificationGateMatcher: RegExp
  evidenceRefChecker?: EvidenceRefChecker
}

const ISO_8601_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

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
  // `blocked` evidence need not point to implemented code — it may reference the blocking issue, an unresolved decision, missing access, or a failed gate.
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

export function nodeGraphRef(nodeId: string): string {
  return `node:${nodeId}`
}

// Edges are structural only — EdgeSpec carries no status/evidence field, so edge-level progress isn't tracked (deliberately, not an oversight).
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

// Must stay byte-for-byte identical to generate-viewer-data.ts's slugGraphRefPart — overlay code consumes generator-emitted graph_refs verbatim and never recomputes them independently.
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
  // Liveness/expiry is deliberately not checked here.
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

// Kept local, not imported from @/lib/type-guards: the factory's raw Node TS loader can't resolve the @/ alias or extensionless .ts imports, so a cross-module import would break here.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
