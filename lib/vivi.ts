/**
 * Vivi control plane (G2, S1-chat): drive the conversational spec-building agent.
 * Server-only. Owns the policy — the per-session transcript, the bounded prompt
 * composition, and the STRUCTURAL allowlist enforcement — while staying independent
 * of `child_process` via the same injectable {@link Spawner} the rest of the control
 * plane uses (imported from {@link file://./control}). Real routes pass
 * {@link file://./node-spawner nodeSpawner}; tests inject a fake so a turn never
 * launches a real claude/codex.
 *
 * One turn: the client POSTs `{ sessionId?, message }`; the server appends the user
 * turn to the session transcript, composes ONE prompt (the vivi.md persona + the
 * running transcript + a SUMMARY of the target's `.vivicy` state — the file LIST,
 * not the contents, so the prompt stays bounded — plus the latest message), spawns
 * ONE agent exec (`factory/vivi-turn.ts`, which drives the configured implementer
 * CLI as Vivi's engine, with `cwd` = the target root), captures the reply, and
 * returns `{ sessionId, reply, wrote }`.
 *
 * File writing is enforced structurally, never by trust, and the allowlist DEPENDS on
 * whether the target's canonical spec has been FROZEN (a `.vivicy/baselines/*.json` with
 * status "frozen" and no `superseded` stamp — the same definition the factory uses):
 *
 *   - PRE-freeze (no frozen baseline): Vivi may write ONLY `.md` files under
 *     `.vivicy/canonical/` and `.vivicy/development/spikes/` — she is authoring the spec.
 *   - POST-freeze (a frozen baseline exists): the canonical is LOCKED (change-control
 *     forbids direct edits), so an intention change becomes a Change Request. The ONLY
 *     permitted write target is `.vivicy/change-requests/**.md`; a canonical/spike write
 *     in this state is a violation. Every new/changed CR is additionally VALIDATED with
 *     the change-control checker (the validator of record, run through the same injected
 *     Spawner) — a malformed CR rejects the turn too.
 *
 * Before the spawn we snapshot the bytes of every file under the phase's allowed dirs;
 * after it, we diff the whole `.vivicy` tree — any write outside the allowlist, any
 * non-`.md` write into the allowed dirs, or (post-freeze) a malformed CR REJECTS the
 * turn: the offending files are removed, the snapshotted files are restored, and the turn
 * is recorded as rejected with an honest reason. Legit writes are reported in `wrote`.
 */

import { execFileSync } from "node:child_process"
import {
  createHash,
  randomUUID,
} from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { ControlError, decideCr, getExtractionStatus, getFactoryRoot, isRunActive, readSkillsReport, startSkillsInstall, type Spawner } from "@/lib/control"
import { getProjectRuntimeDir } from "@/lib/project-runtime"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { settingsToEnv } from "@/lib/settings"
import { pruneGitkeeps } from "@/lib/skeleton"
import { hasActiveFrozenBaseline, isSpecCycleOpen } from "@/lib/spec-cycle"
import { detectSpecKind } from "@/lib/spec-kind"
import { readSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"
import {
  executeViviActions,
  parseActionDirective,
  renderActionResults,
  stripActionFence,
  type ViviActionResult,
} from "@/lib/vivi-actions"

/** The factory script that runs one Vivi turn (drives the implementer CLI leg). */
const VIVI_TURN_SCRIPT = "vivi-turn.ts"

/** The factory validator of record for the Change-Request registry (post-freeze). */
const CHANGE_CONTROL_SCRIPT = "change-control.ts"

/**
 * PRE-freeze allowlist: Vivi authors the spec, so she may write canonical docs + spikes.
 * These are also the dirs {@link summarizeVivicyState} lists back to her each turn.
 */
const CANONICAL_DIRS = [
  path.join(".vivicy", "canonical"),
  path.join(".vivicy", "development", "spikes"),
] as const

/**
 * POST-freeze allowlist: the canonical is locked, so the ONLY place Vivi may write is a
 * Change Request under the registry. Its shape is validated by change-control after.
 */
const CHANGE_REQUESTS_DIR = path.join(".vivicy", "change-requests")
const POST_FREEZE_DIRS = [CHANGE_REQUESTS_DIR] as const

/** The `.vivicy` subtree we snapshot/diff to enforce the allowlist. */
const VIVICY_DIR = ".vivicy"

/**
 * Subtree the diff ignores entirely: the agent leg writes its OWN transcript here
 * (gitignored infrastructure, never Vivi's product surface). Without this, every
 * turn that spawns a leg trips the allowlist on the leg's transcript and rolls the
 * whole turn back — destroying the legitimate canonical/spike writes with it.
 */
const IGNORED_SUBTREE = path.join(".vivicy", "development", "transcripts")

/**
 * One typed button on a decision card. `action` is what the SERVER executes when the
 * owner clicks — the click is the only trigger; nothing on a card ever self-fires.
 */
export interface ViviCardAction {
  id: string
  label: string
  variant?: "default" | "destructive" | "outline"
  action:
    | { kind: "control"; tool: string; args?: Record<string, unknown> }
    | { kind: "cr_decide"; crId: string; decision: "approved" | "rejected" }
    | { kind: "vivi_message"; message: string }
    | { kind: "dismiss" }
}

/**
 * A GENERIC in-chat decision card (D6): deterministic server-authored content the
 * panel renders as buttons — onboarding choices, CR approve/reject, retry proposals,
 * feedback triage, anything. Zero LLM involvement in the render; the outcome is
 * recorded on the turn (`decided`) so buttons disable after use and survive
 * rehydration.
 */
export interface ViviCard {
  id: string
  title: string
  body?: string
  actions: ViviCardAction[]
}

/** The recorded outcome of a decided card — set once, never overwritten. */
export interface ViviCardDecision {
  actionId: string
  at: string
  summary?: string
}

/** One recorded conversation turn, persisted as a single JSONL line. An "action"
 *  turn records the honest outcomes of a `vivicy-action` batch the orchestrator
 *  executed between two agent rounds — structured in `actions`, human-rendered in
 *  `text`. A "card" turn is a deterministic decision card (see {@link ViviCard}). */
export interface ViviTurn {
  role: "user" | "vivi" | "action" | "card"
  text: string
  ts: string
  /** Repo-relative `.md` paths this (vivi) turn wrote — omitted for user turns. */
  wrote?: string[]
  /** Set on a vivi turn the allowlist rejected; carries the honest reason. */
  rejected?: string
  /** Per-action outcomes on an "action" turn (the structured record). */
  actions?: ViviActionResult[]
  /** The card payload on a "card" turn. */
  card?: ViviCard
  /** Set once the owner clicked one of the card's actions. */
  decided?: ViviCardDecision
}

/** Outcome of one turn returned to the caller (and the route). */
export interface ViviReply {
  sessionId: string
  reply: string
  /** Repo-relative `.md` paths Vivi actually wrote this turn (post-enforcement). */
  wrote: string[]
  /** Set when the turn's writes broke the allowlist and were rolled back. */
  rejected?: string
  /** Every action executed across this turn's rounds (empty when none). */
  actions?: ViviActionResult[]
}

/** A file's bytes hash keyed by its repo-relative path — one allowlist snapshot. */
type Snapshot = Map<string, string>

/** The current project's `vivi/` runtime dir (sessions + per-round scratch) — per
 *  project since W8 so two governed projects never share a conversation. Falls back
 *  to the legacy root `vivi/` only when no project is selected (never during a turn:
 *  {@link resolveTarget} refuses first). Lazily folds a pre-W8 root-level `vivi/`
 *  into the first project that touches it (same one-time attribution compromise as
 *  the notification-log migration — the legacy store was project-blind anyway;
 *  without the move those conversations would silently disappear). */
function viviRuntimeDir(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return path.join(getRuntimeDir(), "vivi")
  const projectDir = path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "vivi")
  const legacyDir = path.join(getRuntimeDir(), "vivi")
  if (!existsSync(projectDir) && existsSync(legacyDir)) {
    try {
      mkdirSync(path.dirname(projectDir), { recursive: true })
      renameSync(legacyDir, projectDir)
    } catch {
      // Best-effort: a failed move leaves the legacy sessions in place; the project
      // store simply starts fresh.
    }
  }
  return projectDir
}

/** Absolute path to the per-session transcript JSONL under the project runtime dir. */
function transcriptPath(sessionId: string): string {
  return path.join(viviRuntimeDir(), `${sessionId}.jsonl`)
}

/** A session id is our own minted UUID; reject anything that could escape the dir. */
function assertSessionId(sessionId: string): void {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    throw new ControlError(`invalid vivi session id: ${sessionId}`, "missing_target")
  }
}

/** Read a session's transcript (turn per line), or [] when it does not exist yet. */
export function readTranscript(sessionId: string): ViviTurn[] {
  const file = transcriptPath(sessionId)
  if (!existsSync(file)) return []
  const out: ViviTurn[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as ViviTurn)
    } catch {
      // A single corrupt line never sinks the whole conversation; skip it.
    }
  }
  return out
}

/** Append one turn to the session transcript (creating the dir/file on demand). */
function appendTurn(sessionId: string, turn: ViviTurn): void {
  const file = transcriptPath(sessionId)
  mkdirSync(path.dirname(file), { recursive: true })
  const line = `${JSON.stringify(turn)}\n`
  writeFileSync(file, line, { flag: "a" })
}

/**
 * Append a deterministic decision card to a session (server flows only — onboarding,
 * CR review, retry proposals). Mints the session on demand so a card can open a
 * fresh conversation (the onboarding welcome). Returns the sessionId used.
 */
export function appendCardTurn(card: ViviCard, sessionId?: string): string {
  const id = sessionId ?? randomUUID()
  if (sessionId) assertSessionId(sessionId)
  appendTurn(id, { role: "card", text: card.title, ts: new Date().toISOString(), card })
  return id
}

/** CR statuses that still await the owner's decision (mirrors the feed's filter). */
const PENDING_CR_STATUSES = new Set(["idea", "under_review"])

/**
 * Materialize one decision card per PENDING change request surfaced by a
 * `crs.list` action result — the production producer of the generic card
 * mechanism (D6). Idempotent: a CR that already has a card in this session
 * (decided or not) is never carded twice. Bounded so a long registry never
 * floods the thread; the Notifications tab always lists everything.
 */
const MAX_CR_CARDS_PER_TURN = 3

export function appendPendingCrCards(sessionId: string, results: ViviActionResult[]): void {
  const listed = results.find((r) => r.tool === "crs.list" && r.ok)
  const crs = (listed?.data as { crs?: Array<{ id?: string; title?: string; status?: string; classification?: string }> } | undefined)?.crs
  if (!Array.isArray(crs)) return
  const pending = crs.filter((cr) => typeof cr.id === "string" && PENDING_CR_STATUSES.has(cr.status ?? ""))
  if (pending.length === 0) return

  const alreadyCarded = new Set(
    readTranscript(sessionId)
      .filter((t) => t.role === "card" && t.card?.id.startsWith("cr-"))
      .map((t) => t.card!.id)
  )
  let appended = 0
  for (const cr of pending) {
    if (appended >= MAX_CR_CARDS_PER_TURN) break
    const cardId = `cr-${cr.id}`
    if (alreadyCarded.has(cardId)) continue
    appendCardTurn(
      {
        id: cardId,
        title: `${cr.id} — ${cr.title ?? "change request"}`,
        body: `Pending change request (${cr.classification ?? "unclassified"}). Approving folds it into the spec: re-freeze, re-extract, and reopen the impacted issues. Rejecting records the decision and changes nothing else.`,
        actions: [
          { id: "approve", label: "Approve", variant: "default", action: { kind: "cr_decide", crId: cr.id!, decision: "approved" } },
          { id: "reject", label: "Reject", variant: "destructive", action: { kind: "cr_decide", crId: cr.id!, decision: "rejected" } },
          { id: "later", label: "Decide later", variant: "outline", action: { kind: "dismiss" } },
        ],
      },
      sessionId
    )
    appended += 1
  }
}

/** One session as listed to the panel: newest first, with a human preview line. */
export interface ViviSessionSummary {
  sessionId: string
  updated_at: string
  /** First user line (clipped) — how a human recognizes a conversation. */
  preview: string
  turns: number
}

/** List this project's sessions, newest first (transcript files under vivi/). */
export function listViviSessions(): ViviSessionSummary[] {
  const dir = viviRuntimeDir()
  if (!existsSync(dir)) return []
  const out: ViviSessionSummary[] = []
  for (const entry of readdirSync(dir)) {
    const m = entry.match(/^([0-9a-fA-F-]{36})\.jsonl$/)
    if (!m) continue
    const turns = readTranscript(m[1])
    if (turns.length === 0) continue
    const firstUser = turns.find((t) => t.role === "user")
    out.push({
      sessionId: m[1],
      updated_at: turns.at(-1)?.ts ?? "",
      preview: firstLine(firstUser?.text ?? turns[0].text, 80),
      turns: turns.length,
    })
  }
  return out.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1))
}

/** Rewrite one session's turns in place (the card-decision stamp — same full-rewrite
 *  posture as notification dismissal; sessions stay small). */
function rewriteTranscript(sessionId: string, turns: ViviTurn[]): void {
  const file = transcriptPath(sessionId)
  writeFileSync(file, turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length > 0 ? "\n" : ""))
}

/** Outcome of a card decision returned to the panel. */
export interface CardDecisionResult {
  ok: boolean
  summary: string
  /** The decision stamped on the card by this call (or the one already there):
   *  present whenever the card IS decided — even when `ok` is false because the
   *  executed action failed, so the client can render the permanent decided state
   *  instead of offering a re-click the server would refuse. */
  decided?: ViviCardDecision
  /** Present when the click ran a full Vivi turn (kind "vivi_message"). */
  reply?: ViviReply
}

/**
 * Execute the owner's click on a decision card (D6). The CLICK is the trigger —
 * server-side, validated, recorded: the card must exist and be undecided, the action
 * id must be one of its actions, and the outcome is stamped onto the turn so the
 * card renders decided forever after. Kinds:
 *   - "control": one registry action through the SAME executor as the vivicy-action
 *     fence (allowlist, notifications, honest per-action result);
 *   - "cr_decide": the owner's CR decision (P2 — recorded as owner:vivi-ui);
 *   - "vivi_message": send a prepared message to Vivi as a normal turn;
 *   - "dismiss": record the choice, do nothing else.
 */
export async function decideCardAction(
  spawner: Spawner,
  input: { sessionId: string; cardId: string; actionId: string }
): Promise<CardDecisionResult> {
  assertSessionId(input.sessionId)
  const turns = readTranscript(input.sessionId)
  const initial = turns.find((t) => t.role === "card" && t.card?.id === input.cardId)
  if (!initial) {
    throw new ControlError(`unknown card "${input.cardId}" in session ${input.sessionId}`, "missing_target")
  }
  const action = initial.card?.actions.find((a) => a.id === input.actionId)
  if (!action) {
    throw new ControlError(`unknown action "${input.actionId}" on card "${input.cardId}"`, "missing_target")
  }

  // Stamp against a FRESH read every time: turns appended between our reads (a
  // concurrent Vivi turn, the action turns below) must survive the rewrite.
  const stamp = (summary: string): { alreadyDecided: ViviCardDecision | null } => {
    const fresh = readTranscript(input.sessionId)
    const index = fresh.findIndex((t) => t.role === "card" && t.card?.id === input.cardId)
    if (index === -1) return { alreadyDecided: null }
    const existing = fresh[index].decided
    if (existing && existing.actionId !== action.id) return { alreadyDecided: existing }
    fresh[index] = { ...fresh[index], decided: { actionId: action.id, at: existing?.at ?? new Date().toISOString(), summary } }
    rewriteTranscript(input.sessionId, fresh)
    return { alreadyDecided: null }
  }

  // CLAIM before executing (double-click / double-tab guard): the claim itself is
  // the read-check-write, so the unguarded window is the fs write, not an await.
  // Every path returns the card's PERMANENT decision (even with ok:false) so the
  // client renders the decided state rather than offering a re-click the server
  // would refuse.
  if (initial.decided) {
    return {
      ok: false,
      summary: `this card was already decided (${initial.decided.actionId} at ${initial.decided.at})`,
      decided: initial.decided,
    }
  }
  const claim = stamp("deciding…")
  if (claim.alreadyDecided) {
    return {
      ok: false,
      summary: `this card was already decided (${claim.alreadyDecided.actionId} at ${claim.alreadyDecided.at})`,
      decided: claim.alreadyDecided,
    }
  }
  const decidedAs = (summary: string): ViviCardDecision => ({
    actionId: action.id,
    at: new Date().toISOString(),
    summary,
  })

  switch (action.action.kind) {
    case "dismiss": {
      stamp("dismissed")
      return { ok: true, summary: "dismissed", decided: decidedAs("dismissed") }
    }
    case "control": {
      const [result] = await executeViviActions(spawner, [
        { tool: action.action.tool, args: action.action.args ?? {} },
      ])
      appendTurn(input.sessionId, {
        role: "action",
        text: renderActionResults([result]),
        ts: new Date().toISOString(),
        actions: [result],
      })
      stamp(result.summary)
      return { ok: result.ok, summary: result.summary, decided: decidedAs(result.summary) }
    }
    case "cr_decide": {
      const { crId, decision } = action.action
      const result = await decideCr(spawner, { id: crId, decision, decidedBy: "owner:vivi-ui" })
      const summary = result.summary || `CR ${crId} ${decision}`
      appendTurn(input.sessionId, {
        role: "action",
        text: `${result.ok ? "✓" : "✗"} cr.decide: ${summary}`,
        ts: new Date().toISOString(),
      })
      stamp(summary)
      return { ok: result.ok, summary, decided: decidedAs(summary) }
    }
    case "vivi_message": {
      const sentSummary = `sent: ${firstLine(action.action.message, 80)}`
      stamp(sentSummary)
      const reply = await runViviTurn(spawner, { sessionId: input.sessionId, message: action.action.message })
      return {
        ok: !reply.rejected,
        summary: reply.rejected ?? "message sent to Vivi",
        decided: decidedAs(sentSummary),
        reply,
      }
    }
  }
}

/** Read the vivi.md persona prompt bundled with the factory. */
function readPersona(factoryRoot: string): string {
  return readFileSync(path.join(factoryRoot, "prompts", "vivi.md"), "utf8")
}

/**
 * Render the running transcript for the prompt, BOUNDED: every turn's role + one
 * short line each (so the model has the whole thread's shape and the decisions it
 * already recorded), except the single most recent prior turn, which is included in
 * FULL so the immediate context is never truncated. Keeps the prompt from growing
 * without limit across a long session while never losing the last exchange.
 */
function renderTranscript(turns: ViviTurn[]): string {
  if (turns.length === 0) return "(no prior turns — this is the first message)"
  const lastIdx = turns.length - 1
  const lines = turns.map((turn, i) => {
    const who =
      turn.role === "user" ? "User"
      : turn.role === "action" ? "Tool results"
      : turn.role === "card" ? "Choice card"
      : "Vivi"
    const cardState =
      turn.role === "card"
        ? turn.decided
          ? ` [decided: ${turn.decided.actionId}${turn.decided.summary ? ` — ${firstLine(turn.decided.summary, 80)}` : ""}]`
          : " [awaiting the owner's choice]"
        : ""
    const body = (i === lastIdx ? turn.text : firstLine(turn.text, 200)) + cardState
    const wrote =
      turn.role === "vivi" && turn.wrote && turn.wrote.length > 0
        ? ` [wrote: ${turn.wrote.join(", ")}]`
        : ""
    return `${who}: ${body}${wrote}`
  })
  return lines.join("\n\n")
}

/** The first line of `text`, clipped to `max` chars with an ellipsis marker. */
function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0]
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/**
 * Summarize the target's current `.vivicy` spec state as a FILE LIST (never the
 * contents — that would blow the prompt budget), so Vivi knows what already exists
 * and can update rather than duplicate. Lists the canonical docs and the spikes;
 * post-freeze it also lists the Change Requests already on file (so she does not
 * duplicate one) — the same registry she now writes into.
 */
function summarizeVivicyState(targetRoot: string, frozen: boolean): string {
  const sections = CANONICAL_DIRS.map((rel) => {
    const files = listMarkdown(path.join(targetRoot, rel)).map((abs) =>
      path.relative(targetRoot, abs)
    )
    const label = rel.includes("spikes") ? "Spikes" : "Canonical docs"
    if (files.length === 0) return `${label}: (none yet)`
    return `${label}:\n${files.map((f) => `  - ${f}`).join("\n")}`
  })
  if (frozen) {
    const crs = listChangeRequestFiles(targetRoot)
    sections.push(
      crs.length === 0
        ? "Change Requests: (none yet)"
        : `Change Requests:\n${crs.map((f) => `  - ${f}`).join("\n")}`
    )
  }
  return sections.join("\n\n")
}

/** Every `.md` file under `dir` (recursive, sorted); [] when the dir is absent. */
function listMarkdown(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile() && entry.name.endsWith(".md")) out.push(abs)
    }
  }
  return out.sort()
}

/** The single source of truth for Vivi's phase — the shared derivation in
 *  lib/spec-cycle.ts ({@link hasActiveFrozenBaseline}), kept under the historical
 *  local name so every phase decision in this file reads the same way. */
function hasFrozenBaseline(targetRoot: string): boolean {
  return hasActiveFrozenBaseline(targetRoot)
}

/** CR filename grammar the registry enforces (mirrors change-control's CR_FILENAME). */
const CR_FILENAME = /^CR-(\d{4})-[a-z0-9-]+\.md$/
/** Files under change-requests/ that are NOT change requests (skipped everywhere). */
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"])

/** The real CR files on disk (repo-relative), template/readme excluded, sorted. */
function listChangeRequestFiles(targetRoot: string): string[] {
  const dirAbs = path.join(targetRoot, CHANGE_REQUESTS_DIR)
  if (!existsSync(dirAbs)) return []
  return readdirSync(dirAbs)
    .filter((f) => f.toLowerCase().endsWith(".md") && !NON_CR_FILES.has(f.toLowerCase()))
    .sort()
    .map((f) => path.join(CHANGE_REQUESTS_DIR, f))
}

/**
 * The next sequential CR id (`CR-####`) the target should use — the highest existing CR
 * number plus one, `CR-0001` when none exist. Computed here (not by the agent) so lib
 * hands Vivi the exact id to name her file, and change-control's sequential-numbering gate
 * stays satisfied. Reads both the frontmatter `id:` and the filename number so a partly
 * written registry still yields a gap-free next id.
 */
function nextCrId(targetRoot: string): string {
  const dirAbs = path.join(targetRoot, CHANGE_REQUESTS_DIR)
  let max = 0
  if (existsSync(dirAbs)) {
    for (const file of readdirSync(dirAbs)) {
      if (!file.toLowerCase().endsWith(".md") || NON_CR_FILES.has(file.toLowerCase())) continue
      const fromName = file.match(CR_FILENAME)
      const fromFm = readCrIdFromFrontmatter(path.join(dirAbs, file))
      max = Math.max(max, fromName ? Number(fromName[1]) : 0, fromFm ?? 0)
    }
  }
  return `CR-${String(max + 1).padStart(4, "0")}`
}

/** The numeric part of a CR file's frontmatter `id: CR-####`, or null. */
function readCrIdFromFrontmatter(abs: string): number | null {
  try {
    const m = readFileSync(abs, "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return null
    const id = m[1].split(/\r?\n/).find((l) => /^id:\s*CR-\d{4}\s*$/.test(l))
    return id ? Number(id.replace(/^id:\s*CR-/, "").trim()) : null
  } catch {
    return null
  }
}

/**
 * Compose the full turn prompt: persona + transcript + `.vivicy` state (file list +
 * a one-line deterministic pipeline snapshot) + task. The task section (and the
 * `spec_frozen` flag it announces) DEPENDS on the phase:
 *   - PRE-freeze: author canonical docs + spikes, as before.
 *   - POST-freeze: the canonical is locked — draft ONE Change Request under the registry
 *     with the exact next id `nextCrId`; never touch canonical/spikes. The persona's
 *     frozen-baseline section (keyed on this same `spec_frozen: true`) governs the CR shape.
 * A CONTINUATION round (the previous transcript turn is an "action" turn carrying tool
 * results) swaps the task for a "read your results and close the loop" instruction —
 * the persona's action section governs whether another batch is warranted.
 */
function composePrompt(
  factoryRoot: string,
  targetRoot: string,
  turns: ViviTurn[],
  frozen: boolean,
  crId: string,
  statusLine: string
): string {
  const persona = readPersona(factoryRoot)
  const transcript = renderTranscript(turns)
  const state = summarizeVivicyState(targetRoot, frozen)
  const continuation = turns.at(-1)?.role === "action"
  const phaseLine = frozen
    ? `spec_frozen: true — the target already has a FROZEN canonical baseline, so the ` +
      `canonical spec is LOCKED. `
    : `spec_frozen: false — `
  const task = continuation
    ? `${phaseLine}The tool results of the actions you just requested are in the ` +
      `"Tool results" entry above. Now close the loop for the user: explain plainly what ` +
      `happened and what it means. Only emit another \`vivicy-action\` block if a further ` +
      `action is genuinely required to finish what the user asked — never repeat an action ` +
      `that already succeeded.\n`
    : frozen
      ? `${phaseLine}Respond to the user's latest message above. If it asks ` +
        `for a change to what the product does, do NOT edit any canonical doc or spike — ` +
        `instead draft ONE Change Request capturing that change, written as the single ` +
        `Markdown file \`.vivicy/change-requests/${crId}-<slug>.md\` (use exactly the id ` +
        `\`${crId}\`; pick a short lowercase kebab-case <slug> from the title), following ` +
        `the CR shape in your prompt (status: idea, classification: the closest enum, source: ` +
        `user, owner_decision: pending, all previous_baseline_*/resulting_* left null). ` +
        `If the message needs no product change, just answer it and write nothing. Then ` +
        `tell the user exactly what you did.\n`
      : `${phaseLine}Respond to the user's latest message above. Ask your next ` +
        `focused batch of questions and, when an area is settled, write or update the ` +
        `canonical docs and/or spikes (Markdown only, under \`.vivicy/canonical/\` or ` +
        `\`.vivicy/development/spikes/\`, in the target repo you are running inside). ` +
        `Then tell the user exactly which files you wrote.\n`
  return (
    `${persona}\n\n` +
    `---\n\n## Conversation so far\n\n${transcript}\n\n` +
    `---\n\n## Current \`.vivicy\` state (file list only)\n\n${state}\n\n${statusLine}\n\n` +
    `---\n\n## This turn\n\n${task}`
  )
}

/**
 * One deterministic pipeline-snapshot line for the prompt — real sync reads only
 * (run lock + the extraction/skills status files), never a spawn and never a
 * fabricated value (P1): a probe that fails reads as "unavailable". Vivi gets the
 * full numbers (issues done/total, gates, quota) via the `status.read` action when
 * she needs them; this line only keeps her from acting blind on the basics.
 */
function buildStatusLine(spawner: Spawner, targetRoot: string, frozen: boolean): string {
  try {
    const extraction = getExtractionStatus()
    const skills = readSkillsReport()
    const running = isRunActive(spawner)
    // The spec kind (W7a/D1) is detected mechanically so Vivi grills the RIGHT way
    // from the very first turn: full product definition on a bare repo, scoped
    // evolution on an existing codebase.
    const kind = detectSpecKind(targetRoot)
    return (
      `Pipeline snapshot: run_active=${running}; extraction=${extraction?.phase ?? "never"}; ` +
      `skills=${skills?.phase ?? "never"}; spec_frozen=${frozen}; spec_kind=${kind}.`
    )
  } catch {
    return "Pipeline snapshot: unavailable."
  }
}

/** Depth-first list of every file under `dir` (absolute), dirs excluded. */
function walkFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(abs)
    }
  }
  return out
}

/** Hash every file under `.vivicy` (repo-relative path -> sha256) — the pre-spawn snapshot. */
function snapshotVivicy(targetRoot: string): Snapshot {
  const snap: Snapshot = new Map()
  for (const abs of walkFiles(path.join(targetRoot, VIVICY_DIR))) {
    snap.set(path.relative(targetRoot, abs), hashFile(abs))
  }
  return snap
}

function hashFile(abs: string): string {
  return createHash("sha256").update(readFileSync(abs)).digest("hex")
}

/** Is a repo-relative path a `.md` file inside one of this phase's allowed write dirs? */
function isAllowedWrite(rel: string, allowedDirs: readonly string[]): boolean {
  if (!rel.endsWith(".md")) return false
  return allowedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`))
}

/**
 * Snapshot the pre-spawn bytes of the WHOLE `.vivicy` tree (excluding the leg's own
 * ignored transcript subtree) so a rejected turn restores every touched file exactly —
 * whatever the phase. Snapshotting only the allowlist would leave a pre-existing file
 * OUTSIDE it (e.g. a frozen canonical doc Vivi illegally edited post-freeze) removed by
 * the rollback but never restored; a whole-tree byte snapshot closes that gap.
 */
function snapshotVivicyBytes(targetRoot: string): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>()
  for (const abs of walkFiles(path.join(targetRoot, VIVICY_DIR))) {
    const rel = path.relative(targetRoot, abs)
    if (rel === IGNORED_SUBTREE || rel.startsWith(`${IGNORED_SUBTREE}${path.sep}`)) continue
    bytes.set(rel, readFileSync(abs))
  }
  return bytes
}

/** What the post-spawn `.vivicy` diff found, split into legit writes and violations. */
interface DiffResult {
  /** Repo-relative `.md` paths written/changed inside the allowlist (the good ones). */
  allowedWrites: string[]
  /** Repo-relative paths written/changed OUTSIDE the allowlist (the violations). */
  violations: string[]
}

/**
 * Diff the `.vivicy` tree against the pre-spawn snapshot: any path that is new or
 * whose hash changed is a WRITE. Classify each write as allowed (a `.md` under this
 * phase's allowed dirs) or a violation. Deletions inside `.vivicy` are not our concern
 * here (Vivi's contract is about what it may WRITE); a violation is a forbidden write.
 */
function diffVivicy(targetRoot: string, before: Snapshot, allowedDirs: readonly string[]): DiffResult {
  const allowedWrites: string[] = []
  const violations: string[] = []
  for (const abs of walkFiles(path.join(targetRoot, VIVICY_DIR))) {
    const rel = path.relative(targetRoot, abs)
    if (rel === IGNORED_SUBTREE || rel.startsWith(`${IGNORED_SUBTREE}${path.sep}`)) continue
    const priorHash = before.get(rel)
    const changed = priorHash === undefined || priorHash !== hashFile(abs)
    if (!changed) continue
    if (isAllowedWrite(rel, allowedDirs)) allowedWrites.push(rel)
    else violations.push(rel)
  }
  return { allowedWrites: allowedWrites.sort(), violations: violations.sort() }
}

/**
 * Roll a rejected turn back to the pre-spawn state (copy-on-detect restore): remove
 * every file the diff flagged as a write (allowed OR violating — the whole turn is
 * discarded, not just the illegal part), then restore the exact bytes of every file that
 * existed anywhere under `.vivicy` before the spawn. After this the tree is byte-identical
 * to before for every path the turn touched; net-new paths are gone.
 */
function restoreSnapshot(
  targetRoot: string,
  diff: DiffResult,
  bytesBefore: Map<string, Buffer>
): void {
  for (const rel of [...diff.allowedWrites, ...diff.violations]) {
    const prior = bytesBefore.get(rel)
    const abs = path.join(targetRoot, rel)
    if (prior === undefined) {
      rmSync(abs, { force: true }) // net-new this turn — discard it
    } else {
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, prior) // pre-existing — restore its exact bytes
    }
  }
}

/**
 * WHOLE-TARGET no-code enforcement (W2): the `.vivicy` byte diff above cannot see a
 * write into `src/`, `app/`, or any other product path — the leg runs with
 * `cwd = targetRoot` and permissions bypassed, so "Vivi never codes" must be proven,
 * not trusted. Git is the witness: the scaffold guarantees every target is a git
 * repository, so `git status --porcelain -z --untracked-files=all` before the turn
 * vs. after each round yields exactly the paths the turn dirtied. Any NEW dirty path
 * outside `.vivicy/` is a code-write violation: the turn is rejected, net-new files
 * are removed, and newly-modified tracked files are restored from HEAD. Paths that
 * were ALREADY dirty before the turn are the owner's work in progress — never
 * touched, never restored. Gitignored paths are invisible to the probe by design
 * (they are never product code; the leg's own transcript lives there).
 *
 * When the target has no usable git (deleted .git, git missing from PATH) the probe
 * returns null and the turn proceeds with `.vivicy`-only enforcement plus a LOUD
 * note appended to the reply (P3 — never silent about a weakened guarantee).
 */
function gitDirtyPaths(targetRoot: string): Set<string> | null {
  let raw: string
  try {
    raw = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: targetRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
  } catch {
    return null
  }
  const dirty = new Set<string>()
  const entries = raw.split("\0")
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    dirty.add(entry.slice(3))
    // A rename entry carries the ORIGIN path as the next NUL field; consume it —
    // the origin is dirty too (it disappeared from the worktree).
    if (status.includes("R") || status.includes("C")) {
      const origin = entries[i + 1]
      if (origin && origin.length > 0) {
        dirty.add(origin)
        i += 1
      }
    }
  }
  return dirty
}

/** Is a git-reported (POSIX) path inside the `.vivicy` tree (byte-diff territory)? */
function isVivicyPath(posixRel: string): boolean {
  return posixRel === VIVICY_DIR || posixRel.startsWith(`${VIVICY_DIR}/`)
}

/** The turn's NEW dirty paths outside `.vivicy` — the code-write violations. */
function detectCodeWrites(targetRoot: string, preDirty: Set<string>): string[] | null {
  const now = gitDirtyPaths(targetRoot)
  if (now === null) return null
  const violations: string[] = []
  for (const rel of now) {
    if (preDirty.has(rel) || isVivicyPath(rel)) continue
    violations.push(rel)
  }
  return violations.sort()
}

/** Bytes above this are hash-guarded but not restorable from memory (loud note). */
const PRE_DIRTY_SNAPSHOT_CAP = 5 * 1024 * 1024

interface PreDirtyEntry {
  hash: string
  /** Pre-turn bytes when the file fit the cap; null = hash-only guard. */
  bytes: Buffer | null
}

/**
 * Content-guard the paths that were ALREADY dirty before the turn: `detectCodeWrites`
 * deliberately skips them (they are the owner's work in progress), which would let a
 * leg hide a code write INSIDE an owner-dirty file. Snapshot their bytes (capped) so
 * a mid-turn modification is detected by hash and restored to the owner's exact
 * pre-turn bytes — never to HEAD, which would destroy the owner's WIP.
 */
function snapshotPreDirty(targetRoot: string, preDirty: Set<string> | null): Map<string, PreDirtyEntry> {
  const snapshot = new Map<string, PreDirtyEntry>()
  if (preDirty === null) return snapshot
  for (const rel of preDirty) {
    if (isVivicyPath(rel)) continue
    const abs = path.join(targetRoot, ...rel.split("/"))
    try {
      const bytes = readFileSync(abs)
      snapshot.set(rel, {
        hash: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length <= PRE_DIRTY_SNAPSHOT_CAP ? bytes : null,
      })
    } catch {
      // A dirty-but-unreadable path (deleted, special) — nothing to guard beyond
      // detectCodeWrites' own accounting.
    }
  }
  return snapshot
}

/** Pre-dirty paths whose content changed during the turn (Vivi tampered with WIP). */
function detectPreDirtyTampering(targetRoot: string, snapshot: Map<string, PreDirtyEntry>): string[] {
  const tampered: string[] = []
  for (const [rel, entry] of snapshot) {
    const abs = path.join(targetRoot, ...rel.split("/"))
    try {
      const nowHash = createHash("sha256").update(readFileSync(abs)).digest("hex")
      if (nowHash !== entry.hash) tampered.push(rel)
    } catch {
      // The dirty file disappeared during the turn — that IS tampering.
      tampered.push(rel)
    }
  }
  return tampered.sort()
}

/** Restore tampered owner-WIP files to their exact pre-turn bytes (when captured). */
function restorePreDirty(targetRoot: string, snapshot: Map<string, PreDirtyEntry>, tampered: string[]): string[] {
  const unrestorable: string[] = []
  for (const rel of tampered) {
    const entry = snapshot.get(rel)
    const abs = path.join(targetRoot, ...rel.split("/"))
    if (entry?.bytes) {
      try {
        mkdirSync(path.dirname(abs), { recursive: true })
        writeFileSync(abs, entry.bytes)
        continue
      } catch {
        // fall through to the unrestorable note
      }
    }
    unrestorable.push(rel)
  }
  return unrestorable
}

/**
 * Undo the turn's code writes in REPEATED passes: cleaning one violation can unmask
 * another (restoring a tampered `.gitignore` re-reveals the files it was hiding from
 * `git status`), so after each pass the detector runs again until nothing new shows
 * up (bounded). Returns the paths that could not be cleaned (P1: the rejection note
 * never claims a cleanup that did not happen).
 */
function cleanupCodeWritesDeep(targetRoot: string, initial: string[], preDirty: Set<string>): string[] {
  const failed: string[] = []
  const processed = new Set<string>()
  let pending = initial
  for (let pass = 0; pass < 3 && pending.length > 0; pass++) {
    for (const rel of pending) processed.add(rel)
    failed.push(...cleanupCodeWrites(targetRoot, pending))
    const revealed = detectCodeWrites(targetRoot, preDirty)
    pending = (revealed ?? []).filter((rel) => !processed.has(rel))
  }
  failed.push(...pending)
  return failed
}

/**
 * Undo one batch of code writes: a net-new path (untracked or index-only) is
 * removed; a path tracked in HEAD is restored to its committed bytes (index +
 * worktree). Best-effort per path.
 */
function cleanupCodeWrites(targetRoot: string, violations: string[]): string[] {
  const failed: string[] = []
  for (const rel of violations) {
    const abs = path.join(targetRoot, ...rel.split("/"))
    try {
      // Tracked in HEAD? Restore committed bytes into index + worktree.
      execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: targetRoot, stdio: "ignore" })
      execFileSync("git", ["checkout", "HEAD", "--", rel], { cwd: targetRoot, stdio: "ignore" })
    } catch {
      // Not in HEAD: a net-new file this turn — unstage it if staged, then delete it.
      try {
        execFileSync("git", ["rm", "-f", "-q", "--cached", "--ignore-unmatch", "--", rel], {
          cwd: targetRoot,
          stdio: "ignore",
        })
      } catch {
        // Unstaging is best-effort; deletion below is what removes the bytes.
      }
      try {
        rmSync(abs, { force: true, recursive: true })
      } catch {
        failed.push(rel)
      }
    }
  }
  return failed
}

/** Resolve the target root or refuse (Vivi is standalone — no implicit target). */
function resolveTarget(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) {
    throw new ControlError(
      "no project selected — choose a target project before talking to Vivi",
      "missing_target"
    )
  }
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  return targetRoot
}

/**
 * Run ONE Vivi turn. Appends the user turn, detects the PHASE (is the canonical frozen?),
 * composes the phase-appropriate bounded prompt, snapshots the phase's allowlist, drives
 * `vivi-turn.ts` through the injected {@link Spawner} with the configured agent settings
 * in the env and `cwd` = the target root, then enforces the allowlist by diffing the
 * target's `.vivicy` tree: on a violation the turn is REJECTED and rolled back (recorded
 * as rejected, the allowed dirs restored byte-for-byte, the violating paths removed);
 * otherwise the reply + the legit writes are recorded and returned. A missing `sessionId`
 * mints a new one.
 *
 * The allowlist is phase-dependent (this is B8.1 — mid-run intention changes become CRs):
 *   - PRE-freeze: canonical docs + spikes (Vivi authors the spec).
 *   - POST-freeze: the canonical is LOCKED, so the ONLY allowed write is a Change Request
 *     under `.vivicy/change-requests/`. Every written CR is then validated by the
 *     change-control checker (the validator of record, run through the SAME spawner) — a
 *     malformed CR is rejected + rolled back exactly like an allowlist violation. Nothing
 *     is trusted: the shape is proven, not asserted.
 *
 * Enforcement scope is the `.vivicy` tree — where every allowed write and any misdirected
 * `.vivicy` write lands. This is structural, not trust: it holds regardless of the prompt.
 */
export async function runViviTurn(spawner: Spawner, input: {
  sessionId?: string
  message: string
}): Promise<ViviReply> {
  const message = typeof input.message === "string" ? input.message.trim() : ""
  if (message.length === 0) {
    throw new ControlError("empty message — write something for Vivi to work with", "missing_target")
  }

  const targetRoot = resolveTarget()
  const factoryRoot = getFactoryRoot()
  const command = resolveViviTurnScript(factoryRoot)

  const sessionId = input.sessionId ?? randomUUID()
  if (input.sessionId) assertSessionId(input.sessionId)

  // Record the user's turn BEFORE any spawn, so the transcript is durable even if
  // the agent leg dies — the conversation is never silently lost.
  appendTurn(sessionId, { role: "user", text: message, ts: new Date().toISOString() })

  // Snapshot the whole `.vivicy` tree's bytes BEFORE round 1 — a rejected turn (any
  // round) restores every touched file from here, so the WHOLE turn stays atomic on
  // the write side even across action rounds.
  const bytesBefore = snapshotVivicyBytes(targetRoot)

  // W2 — whole-target no-code witness: the target's dirty set BEFORE the turn. Null
  // means git is unusable here; the turn proceeds with `.vivicy`-only enforcement and
  // a loud note (never silently weakened). Already-dirty paths are additionally
  // CONTENT-guarded (bytes snapshot) — being the owner's WIP exempts them from the
  // new-write check, not from tampering detection.
  const preDirty = gitDirtyPaths(targetRoot)
  const preDirtySnapshot = snapshotPreDirty(targetRoot, preDirty)
  const gitNote =
    preDirty === null
      ? "\n\n⚠ this target has no usable git repository — Vivi's no-code enforcement outside `.vivicy` was unavailable this turn."
      : ""

  // The phase is re-derived every round: an action can freeze the baseline mid-turn
  // (pipeline.extract closes an open cycle), and a cycle.open action can REOPEN
  // drafting on top of a frozen baseline (W7b). "Frozen" for the allowlist means:
  // an active frozen baseline exists AND no drafting cycle is open on it.
  let frozen = hasFrozenBaseline(targetRoot) && !isSpecCycleOpen(targetRoot)
  // The per-round diff base: each accepted round's writes are validated against ITS
  // round's allowlist, then folded into the base — so a pre-freeze canonical write in
  // round 1 is never re-judged by round 2's post-freeze allowlist.
  let roundBase = snapshotVivicy(targetRoot)

  const maxRounds = resolveMaxActionRounds(process.env.VIVICY_VIVI_MAX_ROUNDS)
  const allActions: ViviActionResult[] = []
  let wrote: string[] = []

  for (let round = 1; ; round++) {
    frozen = hasFrozenBaseline(targetRoot) && !isSpecCycleOpen(targetRoot)
    const allowedDirs = frozen ? POST_FREEZE_DIRS : CANONICAL_DIRS
    const crId = nextCrId(targetRoot)
    const statusLine = buildStatusLine(spawner, targetRoot, frozen)
    const turns = readTranscript(sessionId)
    const prompt = composePrompt(factoryRoot, targetRoot, turns, frozen, crId, statusLine)
    const reply = await spawnViviLeg(spawner, { command, targetRoot, sessionId, prompt, frozen })

    // Enforce the allowlist structurally: diff `.vivicy` against this round's base.
    const diff = diffVivicy(targetRoot, roundBase, allowedDirs)

    // W2 — no code, proven: any NEW dirty path outside `.vivicy` rejects the turn.
    // The code writes are undone (net-new removed, tracked restored from HEAD) and
    // the `.vivicy` writes roll back with the turn — full atomicity, honest note.
    if (preDirty !== null) {
      // A write hidden INSIDE an owner-dirty file first: those paths are exempt from
      // the new-write check below, so their CONTENT guard is the only witness.
      const tampered = detectPreDirtyTampering(targetRoot, preDirtySnapshot)
      if (tampered.length > 0) {
        const unrestorable = restorePreDirty(targetRoot, preDirtySnapshot, tampered)
        const rollback: DiffResult = {
          allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
          violations: diff.violations,
        }
        const restoreNote =
          unrestorable.length > 0
            ? `; WARNING: could not restore your pre-turn bytes for: ${unrestorable.join(", ")} — check them manually`
            : " (your in-progress bytes were restored)"
        return rejectTurn(sessionId, reply, targetRoot, rollback, bytesBefore,
          withExecutedActionsNote(
            `rejected: Vivi modified your uncommitted work in progress (${tampered.join(", ")}) — code writes are forbidden — the whole turn was rolled back${restoreNote}`,
            allActions
          ), allActions)
      }

      const codeWrites = detectCodeWrites(targetRoot, preDirty)
      if (codeWrites !== null && codeWrites.length > 0) {
        const cleanupFailed = cleanupCodeWritesDeep(targetRoot, codeWrites, preDirty)
        const rollback: DiffResult = {
          allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
          violations: diff.violations,
        }
        const cleanupNote =
          cleanupFailed.length > 0
            ? `; WARNING: could not clean up: ${cleanupFailed.join(", ")} — remove manually`
            : ""
        return rejectTurn(sessionId, reply, targetRoot, rollback, bytesBefore,
          withExecutedActionsNote(
            `rejected: Vivi wrote outside .vivicy — code writes are forbidden (${codeWrites.join(", ")}) — the whole turn was rolled back${cleanupNote}`,
            allActions
          ), allActions)
      }
    }

    if (diff.violations.length > 0) {
      const rollback: DiffResult = {
        allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
        violations: diff.violations,
      }
      return rejectTurn(sessionId, reply, targetRoot, rollback, bytesBefore,
        withExecutedActionsNote(
          `rejected: Vivi wrote outside its allowlist (${diff.violations.join(", ")}) — the whole turn was rolled back`,
          allActions
        ), allActions)
    }

    // POST-freeze: a written CR must PASS the change-control checker (the validator of
    // record) before it is kept. Fail-closed: any error running the checker rejects the
    // turn rather than letting an unproven CR through. The phase is re-derived after
    // the spawn (same cycle-aware formula) so a baseline that froze mid-round still
    // forces validation — while an OPEN drafting cycle keeps canonical writes out of
    // the CR validator's scope.
    if ((frozen || (hasFrozenBaseline(targetRoot) && !isSpecCycleOpen(targetRoot))) && diff.allowedWrites.length > 0) {
      const invalid = await validateChangeControlSafely(spawner, factoryRoot, targetRoot)
      if (invalid) {
        const rollback: DiffResult = {
          allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
          violations: diff.violations,
        }
        return rejectTurn(sessionId, reply, targetRoot, rollback, bytesBefore,
          withExecutedActionsNote(
            `rejected: Vivi's Change Request did not pass change-control (${invalid}) — the whole turn was rolled back`,
            allActions
          ), allActions)
      }
    }

    wrote = [...new Set([...wrote, ...diff.allowedWrites])].sort()
    roundBase = snapshotVivicy(targetRoot)
    if (diff.allowedWrites.length > 0) pruneGitkeeps(targetRoot)

    const directive = parseActionDirective(reply)

    // No action block: this round's reply closes the turn. (The legacy vivicy-skills
    // fence — the deprecated alias — is still honored on the accepted final text.)
    if (directive === null) {
      const finalReply = `${applySkillsDirective(spawner, reply)}${gitNote}`
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString(), wrote: diff.allowedWrites })
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

    // A present-but-broken block is an honest note, never a rejection — same posture
    // as the legacy skills fence.
    if ("malformed" in directive) {
      const finalReply = `${applySkillsDirective(spawner, reply)}\n\n→ no action executed: ${directive.malformed}.${gitNote}`
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString(), wrote: diff.allowedWrites })
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

    // Execute the batch (sequential, per-action honest results, notifications inside),
    // record the vivi turn (fence stripped — the structured action turn is the record)
    // and the action turn, then either continue for a bounded follow-up round or close.
    const spokenText = applySkillsDirective(spawner, stripActionFence(reply))
    appendTurn(sessionId, {
      role: "vivi",
      text: spokenText.length > 0 ? spokenText : "(requested actions)",
      ts: new Date().toISOString(),
      wrote: diff.allowedWrites,
    })

    const results = await executeViviActions(spawner, directive.actions)
    allActions.push(...results)
    appendTurn(sessionId, {
      role: "action",
      text: renderActionResults(results),
      ts: new Date().toISOString(),
      actions: results,
    })
    // A crs.list Vivi just ran surfaces PENDING change requests: materialize each
    // as an in-chat decision card (D6) so the owner can decide right where the
    // conversation is — deterministic server content, the CLICK stays the single
    // human touchpoint (P2). Idempotent per CR id across the session.
    appendPendingCrCards(sessionId, results)

    // Fold the actions' OWN writes into every comparison base: what an executed verb
    // wrote (a cycle-state file, a map layout patch, a freshly extracted corpus, a
    // skills report) is ORCHESTRATOR-owned state, not Vivi's writes — without this,
    // the next round's diff would attribute it to Vivi, falsely reject the turn, and
    // the rollback would destroy the very state the action just created (P1/P3).
    // Newly dirty paths also enter the CONTENT guard, so a later round editing them
    // is still tampering, not a free pass.
    roundBase = snapshotVivicy(targetRoot)
    if (preDirty !== null) {
      const dirtyNow = gitDirtyPaths(targetRoot)
      if (dirtyNow !== null) {
        const fresh = new Set<string>()
        for (const rel of dirtyNow) {
          if (!preDirty.has(rel)) fresh.add(rel)
          preDirty.add(rel)
        }
        for (const [rel, entry] of snapshotPreDirty(targetRoot, fresh)) {
          preDirtySnapshot.set(rel, entry)
        }
      }
    }

    if (round >= maxRounds) {
      const finalReply =
        `${spokenText.length > 0 ? `${spokenText}\n\n` : ""}${renderActionResults(results)}\n\n` +
        `→ action round limit (${maxRounds}) reached this turn; the results above are recorded.${gitNote}`
      // Persist the limit note as a vivi turn so a rehydrated thread carries the
      // same honest close the caller saw.
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString() })
      return { sessionId, reply: finalReply, wrote, actions: allActions }
    }
  }
}

/** Bounded action rounds per HTTP turn: VIVICY_VIVI_MAX_ROUNDS, default 3, clamped 1..5. */
function resolveMaxActionRounds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(1, Math.min(5, parsed))
}

/** Executed actions are side effects, not writes — a later rejection cannot undo them,
 *  so the rejection reason says so honestly instead of implying a full undo. */
function withExecutedActionsNote(reason: string, executed: ViviActionResult[]): string {
  if (executed.length === 0) return reason
  return `${reason}; note: ${executed.length} action(s) already executed this turn remain in effect`
}

/**
 * Spawn ONE agent round: hand the composed prompt to the leg via a file (it can be
 * large; an argv string is fragile). The factory script reads --prompt-file and writes
 * its reply to --reply-file so we capture the full reply regardless of stdout noise.
 * The scratch names carry a per-ROUND token (not just the session id) so concurrent
 * turns — and rounds — never race on each other's files.
 */
async function spawnViviLeg(
  spawner: Spawner,
  opts: { command: string; targetRoot: string; sessionId: string; prompt: string; frozen: boolean }
): Promise<string> {
  const { command, targetRoot, sessionId, prompt, frozen } = opts
  const turnToken = randomUUID()
  const viviDir = viviRuntimeDir()
  const promptFile = path.join(viviDir, `${sessionId}.${turnToken}.prompt.txt`)
  const replyFile = path.join(viviDir, `${sessionId}.${turnToken}.reply.txt`)
  mkdirSync(viviDir, { recursive: true })
  writeFileSync(promptFile, prompt)

  let result
  try {
    result = await spawner.run({
      command: process.execPath,
      args: [command, "--prompt-file", promptFile, "--reply-file", replyFile, "--target", targetRoot],
      cwd: targetRoot,
      // The agent settings the user picked drive which CLI is Vivi's engine (the
      // implementer role) and its model/effort/fast — Vivi never defines its own.
      // VIVICY_SPEC_FROZEN threads the phase to the leg -> the composed prompt, so the
      // persona's frozen-baseline section keys on the same flag the allowlist enforces.
      env: {
        ...process.env,
        VIVICY_TARGET_ROOT: targetRoot,
        VIVICY_SPEC_FROZEN: frozen ? "true" : "false",
        ...settingsToEnv(readSettings()),
      },
    })
  } finally {
    // The prompt scratch is throwaway once the leg has consumed it.
    rmSync(promptFile, { force: true })
  }

  const reply = readReply(replyFile, result.stdout)
  // The reply scratch has been read into memory; drop it too (per-round, so it would
  // otherwise accumulate).
  rmSync(replyFile, { force: true })
  return reply
}

/** Matches the persona's skills-install fenced block (see prompts/vivi.md). */
const SKILLS_FENCE = /```vivicy-skills\s*\n([\s\S]*?)\n\s*```/

/** Outcome of {@link parseSkillsDirective}: ids to install, an honest malformed
 *  reason, or null when the reply carries no directive at all. */
export type SkillsDirective = { ids: string[] } | { malformed: string } | null

/**
 * Parse the optional `vivicy-skills` fenced block out of a Vivi reply. STRICT:
 * the block must be valid JSON of shape `{"install": [<non-empty strings>]}`.
 * A present-but-broken block returns `{ malformed }` so the caller can append
 * an honest note WITHOUT rejecting the turn; no block at all returns null.
 * Pure, exported for unit tests.
 */
export function parseSkillsDirective(reply: string): SkillsDirective {
  const match = reply.match(SKILLS_FENCE)
  if (!match) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(match[1])
  } catch {
    return { malformed: "the vivicy-skills block is not valid JSON" }
  }
  const install = (parsed as { install?: unknown } | null)?.install
  if (!Array.isArray(install) || install.length === 0) {
    return { malformed: 'the vivicy-skills block must be {"install": ["<id>", ...]} with at least one id' }
  }
  const ids: string[] = []
  for (const entry of install) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return { malformed: "the vivicy-skills block must list only non-empty string ids" }
    }
    ids.push(entry.trim())
  }
  return { ids }
}

/**
 * Act on a skills directive in an accepted reply: start an EXPLICIT-mode install
 * through the control plane (Vivi itself never installs anything) and append a
 * short status line to the reply. A malformed block appends an honest note
 * instead — never rejects the turn; a control refusal (install already running,
 * missing script/target) surfaces its message the same way.
 */
function applySkillsDirective(spawner: Spawner, reply: string): string {
  const directive = parseSkillsDirective(reply)
  if (directive === null) return reply
  if ("malformed" in directive) {
    return `${reply}\n\n→ skills install NOT started: ${directive.malformed}.`
  }
  try {
    startSkillsInstall(spawner, { ids: directive.ids })
    return `${reply}\n\n→ skills install started (explicit mode); check the Skills section.`
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `${reply}\n\n→ skills install NOT started: ${message}.`
  }
}

/** Record a rejected turn (restore the snapshot, stamp the transcript, return the reply).
 *  Executed actions (side effects, not writes) ride along honestly — they are not undone. */
function rejectTurn(
  sessionId: string,
  reply: string,
  targetRoot: string,
  diff: DiffResult,
  bytesBefore: Map<string, Buffer>,
  rejected: string,
  actions: ViviActionResult[] = []
): ViviReply {
  restoreSnapshot(targetRoot, diff, bytesBefore)
  appendTurn(sessionId, { role: "vivi", text: reply, ts: new Date().toISOString(), rejected })
  return { sessionId, reply, wrote: [], rejected, actions: actions.length > 0 ? actions : undefined }
}

/**
 * Run the change-control checker on the target through the SAME injected Spawner used for
 * the turn (never importing the factory's excluded module graph — every lib caller drives
 * factory validators as subprocesses, e.g. {@link file://./control#decideCr}). Returns a
 * short reason string when the CR registry is not proven well-formed, or null when it is.
 *
 * FAIL-CLOSED: a missing script, a non-zero exit, OR a spawn that throws all return a
 * reason (never null), so a broken/erroring checker can never let an unproven CR through —
 * the turn is rolled back instead. This mirrors the allowlist's zero-trust discipline: the
 * CR's validity is proven before it is kept, or the turn is rejected.
 */
async function validateChangeControlSafely(
  spawner: Spawner,
  factoryRoot: string,
  targetRoot: string
): Promise<string | null> {
  const script = path.join(factoryRoot, CHANGE_CONTROL_SCRIPT)
  if (!existsSync(script)) return `${CHANGE_CONTROL_SCRIPT} not found under the factory`
  try {
    const run = await spawner.run({
      command: process.execPath,
      args: [script],
      cwd: factoryRoot,
      env: { ...process.env, VIVICY_TARGET_ROOT: targetRoot },
    })
    if (run.code === 0) return null
    const detail = (run.stderr || run.stdout || run.lastLine || "").trim().split("\n").filter(Boolean).slice(-1)[0]
    return detail || "change-control reported errors"
  } catch (error) {
    return `change-control could not run: ${error instanceof Error ? error.message : String(error)}`
  }
}

/** Resolve the vivi-turn script inside the factory and verify it exists. */
function resolveViviTurnScript(factoryRoot: string): string {
  const abs = path.join(factoryRoot, VIVI_TURN_SCRIPT)
  if (!existsSync(abs)) {
    throw new ControlError(
      `factory script not found: ${VIVI_TURN_SCRIPT} (looked under ${factoryRoot})`,
      "missing_script"
    )
  }
  return abs
}

/**
 * Read the agent's reply: the `--reply-file` the leg wrote is authoritative; fall
 * back to captured stdout when the file is absent (a dead/aborted leg), so the user
 * always sees SOMETHING honest rather than a blank turn.
 */
function readReply(replyFile: string, stdout: string): string {
  if (existsSync(replyFile)) {
    try {
      const text = readFileSync(replyFile, "utf8").trim()
      if (text.length > 0) return text
    } catch {
      // fall through to stdout
    }
  }
  const fallback = stdout.trim()
  return fallback.length > 0
    ? fallback
    : "Vivi could not produce a reply this turn (the agent leg wrote nothing). Try again."
}
