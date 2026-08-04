import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"

import { countForm } from "@/lib/count-form"
import { readFencedBlock } from "@/lib/fenced-block"
import {
  ControlError,
  decideCr,
  getExtractionStatus,
  getFactoryRoot,
  isRunActive,
  readSkillsReport,
  startSkillsInstall,
  type Spawner,
} from "@/lib/control"
import { importIntoGoverned, UPLOADS_DIR, type BatchResult, type ManifestFile, type RawEntry, type RejectedFile } from "@/lib/import-docs"
import type { SecretFileFinding } from "@/lib/secret-scan"
import { languageDisplayName } from "@/lib/language"
import { DEFAULT_VIVI_ACTION_ROUNDS, MAX_VIVI_ACTION_ROUNDS } from "@/lib/leg-budget"
import { ensureProjectRuntimeDir, getProjectRuntimeDir, PROJECT_RUNTIME_SEGMENTS } from "@/lib/project-runtime"
import { openScratchDir, scratchName, sweepAbandonedScratch } from "@/lib/scratch"
import { settingsToEnv } from "@/lib/settings"
import { pruneGitkeeps, VIVICY_DIR } from "@/lib/skeleton"
import { isCanonicalFrozen, type BatchCycleBinding } from "@/lib/spec-cycle"
import { detectSpecKind } from "@/lib/spec-kind"
import { resolveSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"
import { executeViviActions, parseActionDirective, renderActionResults, stripActionFence, type ViviActionResult } from "@/lib/vivi-actions"
import {
  ANSWER_SEPARATOR,
  MAX_OTHER_ANSWER_LENGTH,
  oneLine,
  parseQuestionsDirective,
  remainingQuestions,
  serializeAnswer,
  stripQuestionsFence,
  type ViviQuestion,
  type ViviQuestionAnswerRef,
  type ViviQuestionStack,
} from "@/lib/vivi-questions"

const VIVI_TURN_SCRIPT = "vivi-turn.ts"

const CHANGE_CONTROL_SCRIPT = "change-control.ts"

const CANONICAL_DIRS = [path.join(".vivicy", "canonical"), path.join(".vivicy", "development", "spikes")] as const

const CHANGE_REQUESTS_DIR = path.join(".vivicy", "change-requests")
const POST_FREEZE_DIRS = [CHANGE_REQUESTS_DIR] as const

const UPLOADS_DIR_POSIX = UPLOADS_DIR.split(path.sep).join("/")

// Excluded from every .vivicy snapshot/diff/rollback: the leg writes its own transcript here mid-turn, and the runtime subtree is orchestrator-owned operational state written under Vivi's own feet.
const IGNORED_SUBTREES = new Set([path.join(".vivicy", "development", "transcripts"), path.join(...PROJECT_RUNTIME_SEGMENTS)])

// A card action fires only on the owner's click — nothing ever self-fires.
export interface ViviCardAction {
  id: string
  label: string
  variant?: "default" | "destructive" | "outline"
  action:
    | { kind: "control"; tool: string; args?: Record<string, unknown> }
    | { kind: "cr_decide"; crId: string; decision: "approved" | "rejected" }
    | { kind: "vivi_message"; message: string }
    | { kind: "import_docs" }
    | { kind: "dismiss" }
}

// A card's content is server-authored and deterministic, never from the LLM reply; the question card is the one sanctioned amendment (AGENTS.md, "Vivi enforcement").
export interface ViviCard {
  id: string
  title: string
  body?: string
  actions: ViviCardAction[]
}

export interface ViviCardDecision {
  actionId: string
  at: string
  summary?: string
}

// A pending claim must carry its owner's pid: only that tells a later reader whether the read is in flight or orphaned.
export type ViviImportRead = { status: "pending"; pid: number } | { status: "done" } | { status: "interrupted" }

export interface ViviImportEvent {
  batchId: string
  files: string[]
  read?: ViviImportRead
}

export interface ViviTurn {
  role: "user" | "vivi" | "action" | "card" | "questions"
  text: string
  ts: string
  wrote?: string[]
  rejected?: string
  actions?: ViviActionResult[]
  card?: ViviCard
  decided?: ViviCardDecision
  imported?: ViviImportEvent
  questions?: ViviQuestionStack
  answered?: ViviQuestionAnswerRef
}

export interface ViviReply {
  sessionId: string
  reply: string
  wrote: string[]
  rejected?: string
  actions?: ViviActionResult[]
}

interface FileState {
  ident: string
  bytes: Buffer
  racy: boolean
}

type Snapshot = Map<string, FileState>

const VIVI_STORE_SUBDIR = "vivi"
const TRANSCRIPT_TEMP_PREFIX = ".publish-"
const TURN_SCRATCH_PREFIX = "vivicy-vivi-turn-"

function viviStoreDirOf(targetRoot: string): string {
  return path.join(getProjectRuntimeDir(targetRoot), VIVI_STORE_SUBDIR)
}

function ensureViviStoreDir(targetRoot: string): string {
  ensureProjectRuntimeDir(getProjectRuntimeDir(targetRoot))
  const dir = viviStoreDirOf(targetRoot)
  mkdirSync(dir, { recursive: true })
  return dir
}

// The conversation lives with the project it is about: reads over no project are empty, writes go through resolveTarget's own refusal.
function viviStoreDir(): string | null {
  const targetRoot = getTargetRoot()
  return targetRoot === null ? null : viviStoreDirOf(targetRoot)
}

function transcriptIn(dir: string, sessionId: string): string {
  return path.join(dir, `${sessionId}.jsonl`)
}

// transcriptIn interpolates the session id into a file path unsanitized: refuse anything but our own minted UUID.
function assertSessionId(sessionId: string): void {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    throw new ControlError(`invalid vivi session id: ${sessionId}`, "missing_target")
  }
}

export function readTranscript(sessionId: string): ViviTurn[] {
  const dir = viviStoreDir()
  const file = dir === null ? null : transcriptIn(dir, sessionId)
  if (file === null || !existsSync(file)) return []
  const out: ViviTurn[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      out.push(JSON.parse(trimmed) as ViviTurn)
    } catch {}
  }
  return out
}

function appendTurn(sessionId: string, turn: ViviTurn): void {
  const file = transcriptIn(ensureViviStoreDir(resolveTarget()), sessionId)
  const line = `${JSON.stringify(turn)}\n`
  writeFileSync(file, line, { flag: "a" })
}

export function appendCardTurn(card: ViviCard, sessionId?: string): string {
  const id = sessionId ?? randomUUID()
  if (sessionId) assertSessionId(sessionId)
  appendTurn(id, { role: "card", text: card.title, ts: new Date().toISOString(), card })
  return id
}

const VIVI_WELCOME_INTRO =
  "Ciao, I'm Vivi — I run Vivicy's kitchen. My job is to turn your idea into a spec so exact the factory can build it with nothing left to guess, and I get there by asking you the questions you didn't think to answer."

export const VIVI_WELCOME_MESSAGE = `${VIVI_WELCOME_INTRO} Allora, let's start: what do you want to build?`

export function seedViviWelcome(batch?: BatchResult | null): string {
  const sessionId = randomUUID()
  appendTurn(
    sessionId,
    batch ? importTurn(batch, { welcome: true }) : { role: "vivi", text: VIVI_WELCOME_MESSAGE, ts: new Date().toISOString() }
  )
  return sessionId
}

export const WELCOME_IMPORT_CARD: ViviCard = {
  id: "welcome-import-docs",
  title: "Already wrote some of this down?",
  body: "A brief, notes, a spec, a PDF — if you've got documents, hand them over now and I'll bring them into the kitchen before we start grilling. Nothing to import? Just answer above and we'll build the spec from scratch.",
  actions: [{ id: "import", label: "I have docs to import", action: { kind: "import_docs" } }],
}

// Hand-synced with components/chat/vivi-notifications.tsx's own PENDING_STATUSES — edit together.
const PENDING_CR_STATUSES = new Set(["idea", "under_review"])

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

export interface ViviSessionSummary {
  sessionId: string
  updated_at: string
  preview: string
  turns: number
}

export function listViviSessions(): ViviSessionSummary[] {
  const dir = viviStoreDir()
  if (dir === null || !existsSync(dir)) return []
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

// Publish by temp-then-rename (this file is the conversation's only copy), and keep the temp name outside the session-id shape listViviSessions matches — the rename forbids the OS temp dir, so the name carries this process and planting one sweeps what a killed publish left.
function rewriteTranscript(sessionId: string, turns: ViviTurn[]): void {
  const dir = ensureViviStoreDir(resolveTarget())
  sweepAbandonedScratch(dir, TRANSCRIPT_TEMP_PREFIX)
  const file = transcriptIn(dir, sessionId)
  const tmp = path.join(dir, scratchName(TRANSCRIPT_TEMP_PREFIX))
  try {
    writeFileSync(tmp, turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length > 0 ? "\n" : ""))
    renameSync(tmp, file)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export interface CardDecisionResult {
  ok: boolean
  summary: string
  decided?: ViviCardDecision
  reply?: ViviReply
}

function findCardAction(sessionId: string, cardId: string, actionId: string): { turn: ViviTurn; action: ViviCardAction } {
  const turn = readTranscript(sessionId).find((t) => t.role === "card" && t.card?.id === cardId)
  if (!turn) {
    throw new ControlError(`unknown card "${cardId}" in session ${sessionId}`, "missing_target")
  }
  const action = turn.card?.actions.find((a) => a.id === actionId)
  if (!action) {
    throw new ControlError(`unknown action "${actionId}" on card "${cardId}"`, "missing_target")
  }
  return { turn, action }
}

// Always stamp against a FRESH read: turns appended concurrently must survive the rewrite.
function stampCardDecision(
  sessionId: string,
  cardId: string,
  actionId: string,
  summary: string
): { alreadyDecided: ViviCardDecision | null } {
  const fresh = readTranscript(sessionId)
  const index = fresh.findIndex((t) => t.role === "card" && t.card?.id === cardId)
  if (index === -1) return { alreadyDecided: null }
  const existing = fresh[index].decided
  if (existing && existing.actionId !== actionId) return { alreadyDecided: existing }
  fresh[index] = { ...fresh[index], decided: { actionId, at: existing?.at ?? new Date().toISOString(), summary } }
  rewriteTranscript(sessionId, fresh)
  return { alreadyDecided: null }
}

function alreadyDecidedResult(decided: ViviCardDecision): CardDecisionResult {
  return {
    ok: false,
    summary: `this card was already decided (${decided.actionId} at ${decided.at})`,
    decided,
  }
}

export async function decideCardAction(
  spawner: Spawner,
  input: { sessionId: string; cardId: string; actionId: string }
): Promise<CardDecisionResult> {
  assertSessionId(input.sessionId)
  const { turn: initial, action } = findCardAction(input.sessionId, input.cardId, input.actionId)
  if (action.action.kind === "import_docs") {
    throw new ControlError(
      `action "${input.actionId}" imports documents — use the document upload path, not the decision endpoint`,
      "missing_target"
    )
  }

  const stamp = (summary: string) => stampCardDecision(input.sessionId, input.cardId, action.id, summary)

  // initial.decided is a stale read: the real claim is stamp()'s read-check-write, never this check.
  if (initial.decided) return alreadyDecidedResult(initial.decided)
  const claim = stamp("deciding…")
  if (claim.alreadyDecided) return alreadyDecidedResult(claim.alreadyDecided)
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
      const [result] = await executeViviActions(spawner, [{ tool: action.action.tool, args: action.action.args ?? {} }])
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

export interface QuestionAnswerResult {
  ok: boolean
  summary: string
  answer: string
  remaining: number
}

function findQuestionStack(turns: ViviTurn[], stackId: string): ViviQuestionStack {
  const stack = turns.find((t) => t.role === "questions" && t.questions?.id === stackId)?.questions
  if (!stack) throw new ControlError(`unknown question stack "${stackId}"`, "missing_target")
  return stack
}

function optionLabel(question: ViviQuestion, optionIndex: number | undefined): string {
  if (typeof optionIndex !== "number" || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
    return failAnswer(`answer question "${question.id}" with one of its ${question.options.length} options, or with your own words`)
  }
  return question.options[optionIndex].label
}

function failAnswer(reason: string): never {
  throw new ControlError(reason, "missing_target")
}

// The only writer of an answer: keep the check-then-append synchronous (no await inside), or two racing clicks both record one.
export function answerViviQuestion(
  spawner: Spawner,
  input: {
    sessionId: string
    stackId: string
    questionId: string
    optionIndex?: number
    other?: string
  }
): QuestionAnswerResult {
  assertSessionId(input.sessionId)
  const other = typeof input.other === "string" ? oneLine(input.other) : null
  if (other !== null && input.optionIndex !== undefined) {
    failAnswer("answer with one of the options or with your own words, never both")
  }
  if (other !== null && other.length === 0) failAnswer("write an answer before sending it")
  if (other !== null && other.length > MAX_OTHER_ANSWER_LENGTH) {
    failAnswer(
      `that answer runs to ${other.length} characters — keep it under ${MAX_OTHER_ANSWER_LENGTH}, or send the long version as a message`
    )
  }

  const turns = readTranscript(input.sessionId)
  const stack = findQuestionStack(turns, input.stackId)
  const question = stack.questions.find((q) => q.id === input.questionId)
  if (!question) {
    failAnswer(`unknown question "${input.questionId}" on stack "${input.stackId}"`)
  }

  const remainingBefore = remainingQuestions(stack, turns)
  if (!remainingBefore.some((q) => q.id === question.id)) {
    return {
      ok: false,
      summary: "this question was already answered",
      answer: "",
      remaining: remainingBefore.length,
    }
  }

  const answer = other ?? optionLabel(question, input.optionIndex)
  appendTurn(input.sessionId, {
    role: "user",
    text: serializeAnswer(question.question, answer),
    ts: new Date().toISOString(),
    answered: { stackId: stack.id, questionId: question.id },
  })

  const remaining = remainingBefore.length - 1
  if (remaining === 0) void dispatchQuestionAnswers(spawner, input.sessionId, stack.questions.length)
  return { ok: true, summary: answer, answer, remaining }
}

// Detached and TOTAL: this must never reject — a continuation that cannot run says so in the thread.
async function dispatchQuestionAnswers(spawner: Spawner, sessionId: string, count: number): Promise<void> {
  try {
    await runTurn(spawner, sessionId, { kind: "question_answers", count })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    try {
      appendTurn(sessionId, {
        role: "vivi",
        text:
          `I could not pick up ${countForm(count, "your answer", "your answers")}: ${reason}. ` +
          `${countForm(count, "It is", "They are")} safe in the thread — send me a message and I'll carry on from there.`,
        ts: new Date().toISOString(),
      })
    } catch {}
  }
}

export interface CardImportResult {
  ok: boolean
  summary: string
  decided?: ViviCardDecision
  batchId?: string
  language?: string
  accepted?: ManifestFile[]
  rejected?: RejectedFile[]
}

const MAX_FINDINGS_IN_ACK = 5

// Never emit a secret value here: only the file:line and lib/secret-scan's redacted shape signal.
function secretFindingAckClause(findings: SecretFileFinding[]): string {
  if (findings.length === 0) return ""
  const files = [...new Set(findings.map((f) => f.path))]
  const shown = findings.slice(0, MAX_FINDINGS_IN_ACK)
  const locations = shown.map((f) => `${f.path}:${f.line} (${f.redacted})`).join(", ")
  const remaining = findings.length - shown.length
  const more = remaining > 0 ? `, and ${remaining} more` : ""
  return (
    `\n\n⚠ Attenzione — I spotted ${countForm(findings.length, "what looks like a real secret key", "what look like real secret keys")} ` +
    `in ${countForm(files.length, "1 file", `${files.length} files`)}: ${locations}${more}. ` +
    `A credential must never live in the spec or in git history, so please remove or rotate ${countForm(findings.length, "it", "them")} ` +
    `and re-import the ${countForm(files.length, "cleaned file", "cleaned files")} before we build.`
  )
}

function viviImportAck(batch: BatchResult, opts: { welcome: boolean }): string {
  const count = batch.accepted.length
  const name = languageDisplayName(batch.language)
  const langClause = name ? `, in ${name},` : ""
  const intro = opts.welcome ? `${VIVI_WELCOME_INTRO}\n\n` : ""
  const landed = `Perfetto — ${countForm(count, `1 document${langClause} is`, `${count} documents${langClause} are`)} now in the kitchen.`
  const fate =
    batch.cycle.binding === "seed"
      ? ` The canonical spec is frozen and building right now, so ${countForm(count, "it feeds", "they feed")} the NEXT cycle rather than the frozen corpus.`
      : ""
  const reading = ` I'm reading ${countForm(count, "it", "them")} cover to cover right now — un attimo — then I'll tell you what's inside and what's still open.`
  const security = secretFindingAckClause(batch.findings)
  return `${intro}${landed}${fate}${reading}${security}`
}

function importTurn(batch: BatchResult, opts: { welcome: boolean }): ViviTurn {
  return {
    role: "vivi",
    text: viviImportAck(batch, opts),
    ts: new Date().toISOString(),
    imported: { batchId: batch.batchId, files: batch.accepted.map((f) => f.path) },
  }
}

function importDecisionSummary(count: number, skipped: number, language: string): string {
  const parts = [countForm(count, "1 document imported", `${count} documents imported`)]
  const name = languageDisplayName(language)
  if (name) parts.push(name)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  return parts.join(" · ")
}

// The ONE import+ack+read primitive: every entry point goes through it, never its own sequence.
async function importAndAcknowledge(spawner: Spawner, sessionId: string, entries: RawEntry[]): Promise<BatchResult> {
  const targetRoot = resolveTarget()
  const batch = await importIntoGoverned({ root: targetRoot, entries })
  appendTurn(sessionId, importTurn(batch, { welcome: false }))
  void dispatchImportRead(spawner, { sessionId, batch })
  return batch
}

function readerAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process EXISTS under another user — a live owner we must never steal from.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Exactly one LIVE reader per batch: a done read closes it forever, an orphaned pending one is re-claimable.
function claimable(read: ViviImportRead | undefined): boolean {
  if (read === undefined || read.status === "interrupted") return true
  return read.status === "pending" && !readerAlive(read.pid)
}

// Keep detect→settle→re-claim free of any await: that is what stops two readers recovering one orphan.
function stampImportRead(sessionId: string, batchId: string, read: ViviImportRead): ViviImportEvent | null {
  const fresh = readTranscript(sessionId)
  const index = fresh.findIndex((t) => t.imported?.batchId === batchId)
  if (index === -1) return null
  const imported = fresh[index].imported as ViviImportEvent
  if (read.status === "pending" && !claimable(imported.read)) return null
  const stamped: ViviImportEvent = { ...imported, read }
  fresh[index] = { ...fresh[index], imported: stamped }
  rewriteTranscript(sessionId, fresh)
  return stamped
}

// Detached and TOTAL: both call sites fire this without awaiting, so it must never reject — and it runs exactly once per CLAIM.
export async function dispatchImportRead(spawner: Spawner, input: { sessionId: string; batch: BatchResult }): Promise<boolean> {
  return runImportRead(spawner, input.sessionId, {
    batchId: input.batch.batchId,
    files: input.batch.accepted.map((f) => f.path),
  })
}

async function runImportRead(spawner: Spawner, sessionId: string, imported: { batchId: string; files: string[] }): Promise<boolean> {
  let claimed = false
  try {
    if (stampImportRead(sessionId, imported.batchId, { status: "pending", pid: process.pid }) === null) {
      return false
    }
    claimed = true
    await runTurn(spawner, sessionId, { kind: "import_read", imported })
  } catch (error) {
    noteImportReadFailure(sessionId, imported.files.length, error)
  }
  try {
    if (claimed) stampImportRead(sessionId, imported.batchId, { status: "done" })
  } catch {}
  return claimed
}

// Keep the re-claim synchronous: a session load and a resume poll landing together must never both recover one read.
export function recoverInterruptedReads(spawner: Spawner, sessionId: string): number {
  assertSessionId(sessionId)
  let recovered = 0
  for (const turn of readTranscript(sessionId)) {
    const imported = turn.imported
    if (!imported || imported.read?.status !== "pending" || readerAlive(imported.read.pid)) continue
    const count = imported.files.length
    appendTurn(sessionId, {
      role: "vivi",
      text: `My reading of ${countForm(count, "that document", "those documents")} was cut short — Vivicy stopped while I was still in ${countForm(count, "it", "them")}. Nothing is lost: I'm picking it straight back up.`,
      ts: new Date().toISOString(),
    })
    if (stampImportRead(sessionId, imported.batchId, { status: "interrupted" }) === null) continue
    recovered += 1
    void runImportRead(spawner, sessionId, { batchId: imported.batchId, files: imported.files })
  }
  return recovered
}

function noteImportReadFailure(sessionId: string, count: number, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  const them = countForm(count, "it", "them")
  try {
    appendTurn(sessionId, {
      role: "vivi",
      text: `I could not read ${countForm(count, "the document", "the documents")} I just took in: ${reason}. ${countForm(count, "It is", "They are")} safe in the kitchen — ask me to read ${them} and I'll pick ${them} straight up.`,
      ts: new Date().toISOString(),
    })
  } catch {}
}

// Stamp the card only AFTER the import lands: a failed import must leave it undecided for a clean retry.
export async function decideCardImport(
  spawner: Spawner,
  input: {
    sessionId: string
    cardId: string
    actionId: string
    entries: RawEntry[]
  }
): Promise<CardImportResult> {
  assertSessionId(input.sessionId)
  const { turn, action } = findCardAction(input.sessionId, input.cardId, input.actionId)
  if (action.action.kind !== "import_docs") {
    throw new ControlError(`action "${input.actionId}" on card "${input.cardId}" is not a document import`, "missing_target")
  }
  if (turn.decided) return alreadyDecidedResult(turn.decided)

  const batch = await importAndAcknowledge(spawner, input.sessionId, input.entries)

  const summary = importDecisionSummary(batch.accepted.length, batch.rejected.length, batch.language)
  const claim = stampCardDecision(input.sessionId, input.cardId, action.id, summary)
  if (claim.alreadyDecided) return alreadyDecidedResult(claim.alreadyDecided)

  return {
    ok: true,
    summary,
    decided: { actionId: action.id, at: new Date().toISOString(), summary },
    batchId: batch.batchId,
    language: batch.language,
    accepted: batch.accepted,
    rejected: batch.rejected,
  }
}

export interface SessionImportResult {
  ok: boolean
  sessionId: string
  summary: string
  batchId: string
  language: string
  cycle: BatchCycleBinding
  accepted: ManifestFile[]
  rejected: RejectedFile[]
}

export async function importDocsIntoSession(
  spawner: Spawner,
  input: {
    sessionId?: string
    entries: RawEntry[]
  }
): Promise<SessionImportResult> {
  const sessionId = input.sessionId ?? randomUUID()
  if (input.sessionId) assertSessionId(input.sessionId)

  const batch = await importAndAcknowledge(spawner, sessionId, input.entries)

  return {
    ok: true,
    sessionId,
    summary: importDecisionSummary(batch.accepted.length, batch.rejected.length, batch.language),
    batchId: batch.batchId,
    language: batch.language,
    cycle: batch.cycle,
    accepted: batch.accepted,
    rejected: batch.rejected,
  }
}

function readPersona(factoryRoot: string): string {
  return readFileSync(path.join(factoryRoot, "prompts", "vivi.md"), "utf8")
}

function renderQuestionStack(stack: ViviQuestionStack, turns: ViviTurn[]): string {
  const standing = new Set(remainingQuestions(stack, turns).map((q) => q.id))
  return stack.questions
    .map((q, i) => `${i + 1}. ${q.question} [${standing.has(q.id) ? "still on the pile" : "answered above"}]`)
    .join("\n")
}

function renderTranscript(turns: ViviTurn[]): string {
  if (turns.length === 0) return "(no prior turns — this is the first message)"
  const lastIdx = turns.length - 1
  const lines = turns.map((turn, i) => {
    const who =
      turn.role === "user"
        ? "User"
        : turn.role === "action"
          ? "Tool results"
          : turn.role === "card"
            ? "Choice card"
            : turn.role === "questions"
              ? "Question cards"
              : "Vivi"
    const cardState =
      turn.role === "card"
        ? turn.decided
          ? ` [decided: ${turn.decided.actionId}${turn.decided.summary ? ` — ${firstLine(turn.decided.summary, 80)}` : ""}]`
          : " [awaiting the owner's choice]"
        : ""
    // An answered turn is rendered WHOLE, never through firstLine: the clip is spent on the question and eats the owner's answer.
    const body =
      turn.role === "questions" && turn.questions
        ? renderQuestionStack(turn.questions, turns)
        : turn.answered !== undefined
          ? turn.text
          : (i === lastIdx ? turn.text : firstLine(turn.text, 200)) + cardState
    const wrote = turn.role === "vivi" && turn.wrote && turn.wrote.length > 0 ? ` [wrote: ${turn.wrote.join(", ")}]` : ""
    return `${who}: ${body}${wrote}`
  })
  return lines.join("\n\n")
}

function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0]
  return line.length > max ? `${line.slice(0, max)}…` : line
}

function summarizeVivicyState(targetRoot: string, frozen: boolean): string {
  const sections = CANONICAL_DIRS.map((rel) => {
    const files = listMarkdown(path.join(targetRoot, rel)).map((abs) => path.relative(targetRoot, abs))
    const label = rel.includes("spikes") ? "Spikes" : "Canonical docs"
    if (files.length === 0) return `${label}: (none yet)`
    return `${label}:\n${files.map((f) => `  - ${f}`).join("\n")}`
  })
  if (frozen) {
    const crs = listChangeRequestFiles(targetRoot)
    sections.push(crs.length === 0 ? "Change Requests: (none yet)" : `Change Requests:\n${crs.map((f) => `  - ${f}`).join("\n")}`)
  }
  return sections.join("\n\n")
}

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

// Hand-synced with factory/change-control.ts's own CR_FILENAME — edit together.
const CR_FILENAME = /^CR-(\d{4})-[a-z0-9-]+\.md$/
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"])

function listChangeRequestFiles(targetRoot: string): string[] {
  const dirAbs = path.join(targetRoot, CHANGE_REQUESTS_DIR)
  if (!existsSync(dirAbs)) return []
  return readdirSync(dirAbs)
    .filter((f) => f.toLowerCase().endsWith(".md") && !NON_CR_FILES.has(f.toLowerCase()))
    .sort()
    .map((f) => path.join(CHANGE_REQUESTS_DIR, f))
}

// Compute the id here, never let the agent pick one: change-control gates on sequential numbering.
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

function crDraftOrder(crId: string): string {
  return (
    `do NOT edit any canonical doc or spike — instead draft ONE Change Request ` +
    `capturing that change, written as the single Markdown file ` +
    `\`.vivicy/change-requests/${crId}-<slug>.md\` (use exactly the id \`${crId}\`; pick a ` +
    `short lowercase kebab-case <slug> from the title), following the CR shape in your ` +
    `prompt (status: idea, classification: the closest enum, source: user, owner_decision: ` +
    `pending, all previous_baseline_*/resulting_* left null)`
  )
}

const CANONICAL_WRITE_ORDER =
  `write or update the canonical docs and/or spikes (Markdown only, under ` +
  `\`.vivicy/canonical/\` or \`.vivicy/development/spikes/\`, in the target repo you are ` +
  `running inside)`

// The reading rules live ONLY in factory/prompts/vivi.md — never restate them here.
function importReadTask(imported: ViviImportEvent, frozen: boolean, crId: string): string {
  const count = imported.files.length
  const noun = countForm(count, "1 document", `${count} documents`)
  const them = countForm(count, "it", "them")
  const listing = imported.files.map((f) => `- ${f}`).join("\n")
  const tail = frozen
    ? `The canonical is LOCKED, so if the corpus genuinely changes what the product must do, ` +
      `${crDraftOrder(crId)} — one CR, and if it opens a whole new wave of work propose a ` +
      `feature cycle instead and let the owner choose.`
    : `Where the corpus itself settles an area beyond doubt, ${CANONICAL_WRITE_ORDER} and say ` +
      `exactly which files you wrote; leave every area your questions still cover unwritten.`
  return (
    `The owner just handed you ${noun} — the import IS the request; nobody typed a question, ` +
    `and this reply is what proves you read ${them}. The batch is at ` +
    `\`${UPLOADS_DIR_POSIX}/${imported.batchId}\` ` +
    `(its \`manifest.json\` carries the language and cycle binding):\n\n${listing}\n\n` +
    `Read it now under your document-intake law: the whole corpus first, then the synthesis ` +
    `that proves it, then only the questions the corpus leaves open. ${tail}\n`
  )
}

function questionAnswersTask(count: number, frozen: boolean, crId: string): string {
  const asked = countForm(count, "the question you carded", `the ${count} questions you carded`)
  const tail = frozen
    ? `The canonical is LOCKED, so if what they just settled genuinely changes what the product ` +
      `must do, ${crDraftOrder(crId)}; if it does not, just close the loop for them.`
    : `Where their answers settle an area beyond doubt, ${CANONICAL_WRITE_ORDER} and say exactly ` +
      `which files you wrote; then ask your next batch, carded when those questions are decidable.`
  return (
    `The owner just answered ${asked}: their answers are the user turns above, one line per card ` +
    `(\`question ${ANSWER_SEPARATOR.trim()} answer\`). Take them as given, never re-ask a card that ` +
    `already carries its line, and carry on. ${tail}\n`
  )
}

function composePrompt(
  factoryRoot: string,
  targetRoot: string,
  turns: ViviTurn[],
  frozen: boolean,
  crId: string,
  statusLine: string,
  origin: TurnOrigin
): string {
  const persona = readPersona(factoryRoot)
  const transcript = renderTranscript(turns)
  const state = summarizeVivicyState(targetRoot, frozen)
  const continuation = turns.at(-1)?.role === "action"
  const phaseLine = frozen
    ? `spec_frozen: true — the target already has a FROZEN canonical baseline, so the ` + `canonical spec is LOCKED. `
    : `spec_frozen: false — `
  const task = continuation
    ? `${phaseLine}The tool results of the actions you just requested are in the ` +
      `"Tool results" entry above. Now close the loop for the user: explain plainly what ` +
      `happened and what it means. Only emit another \`vivicy-action\` block if a further ` +
      `action is genuinely required to finish what the user asked — never repeat an action ` +
      `that already succeeded.\n`
    : origin.kind === "import_read"
      ? `${phaseLine}${importReadTask(origin.imported, frozen, crId)}`
      : origin.kind === "question_answers"
        ? `${phaseLine}${questionAnswersTask(origin.count, frozen, crId)}`
        : frozen
          ? `${phaseLine}Respond to the user's latest message above. If it asks ` +
            `for a change to what the product does, ${crDraftOrder(crId)}. ` +
            `If the message needs no product change, just answer it and write nothing. Then ` +
            `tell the user exactly what you did.\n`
          : `${phaseLine}Respond to the user's latest message above. Ask your next ` +
            `focused batch of questions and, when an area is settled, ${CANONICAL_WRITE_ORDER}. ` +
            `Then tell the user exactly which files you wrote.\n`
  return (
    `${persona}\n\n` +
    `---\n\n## Conversation so far\n\n${transcript}\n\n` +
    `---\n\n## Current \`.vivicy\` state (file list only)\n\n${state}\n\n${statusLine}\n\n` +
    `---\n\n## This turn\n\n${task}`
  )
}

// Sync reads only, never a spawn: a failing probe reports "unavailable", never a fabricated value.
function buildStatusLine(spawner: Spawner, targetRoot: string, frozen: boolean): string {
  try {
    const extraction = getExtractionStatus()
    const skills = readSkillsReport()
    const running = isRunActive(spawner)
    const kind = detectSpecKind(targetRoot)
    return (
      `Workflow snapshot: run_active=${running}; extraction=${extraction?.phase ?? "never"}; ` +
      `skills=${skills?.phase ?? "never"}; spec_frozen=${frozen}; spec_kind=${kind}.`
    )
  } catch {
    return "Workflow snapshot: unavailable."
  }
}

// An ignored subtree is pruned at its own directory entry, so its whole depth costs neither a readdir nor a read.
function walkVivicy(targetRoot: string): string[] {
  const root = path.join(targetRoot, VIVICY_DIR)
  if (!existsSync(root)) return []
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop() as string
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = path.join(current, entry.name)
      const rel = path.relative(targetRoot, abs)
      if (IGNORED_SUBTREES.has(rel)) continue
      if (entry.isDirectory()) stack.push(abs)
      else if (entry.isFile()) out.push(rel)
    }
  }
  return out
}

// Wider than any filesystem's timestamp granularity (FAT's 2s is the coarsest a target can sit on): a capture taken this close to the file's last touch cannot tell a later write apart from it.
const RACY_CAPTURE_MARGIN_NS = BigInt(2_000_000_000)

// Never narrow this to the allowlist: restoreSnapshot would then DELETE a pre-existing file it never captured.
function snapshotVivicy(targetRoot: string, prior?: Snapshot): Snapshot {
  const capturedAtNs = BigInt(Date.now()) * BigInt(1_000_000)
  const snap: Snapshot = new Map()
  for (const rel of walkVivicy(targetRoot)) {
    const abs = path.join(targetRoot, rel)
    try {
      const stat = statSync(abs, { bigint: true })
      const ident = `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.ino}`
      const before = prior?.get(rel)
      if (before !== undefined && before.ident === ident && !before.racy) {
        snap.set(rel, before)
        continue
      }
      snap.set(rel, { ident, bytes: readFileSync(abs), racy: stat.ctimeNs + RACY_CAPTURE_MARGIN_NS >= capturedAtNs })
    } catch (error) {
      // Only a file that disappeared under the walk is skipped; anything else must stay loud, or the guard silently stops covering it.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error
    }
  }
  return snap
}

function isAllowedWrite(rel: string, allowedDirs: readonly string[]): boolean {
  if (!rel.endsWith(".md")) return false
  return allowedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`))
}

interface DiffResult {
  allowedWrites: string[]
  violations: string[]
}

// Deletions inside .vivicy are not this guard's concern: only additions and content changes are writes.
function diffVivicy(before: Snapshot, after: Snapshot, allowedDirs: readonly string[]): DiffResult {
  const allowedWrites: string[] = []
  const violations: string[] = []
  for (const [rel, state] of after) {
    const prior = before.get(rel)
    if (prior === state) continue
    if (prior !== undefined && prior.bytes.equals(state.bytes)) continue
    if (isAllowedWrite(rel, allowedDirs)) allowedWrites.push(rel)
    else violations.push(rel)
  }
  return { allowedWrites: allowedWrites.sort(), violations: violations.sort() }
}

function restoreSnapshot(targetRoot: string, diff: DiffResult, before: Snapshot): void {
  for (const rel of [...diff.allowedWrites, ...diff.violations]) {
    const prior = before.get(rel)
    const abs = path.join(targetRoot, rel)
    if (prior === undefined) {
      rmSync(abs, { force: true })
    } else {
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, prior.bytes)
    }
  }
}

// A null return means this probe is unusable, never that Vivi is clean; gitignored paths are structurally invisible to it.
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
    // git porcelain -z rename/copy records carry the origin path in the NEXT NUL field.
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

function isVivicyPath(posixRel: string): boolean {
  return posixRel === VIVICY_DIR || posixRel.startsWith(`${VIVICY_DIR}/`)
}

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

const PRE_DIRTY_SNAPSHOT_CAP = 5 * 1024 * 1024

interface PreDirtyEntry {
  hash: string
  bytes: Buffer | null
}

// The only witness against a leg hiding a code write inside an already-dirty file: detectCodeWrites exempts owner-dirty paths.
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
    } catch {}
  }
  return snapshot
}

function detectPreDirtyTampering(targetRoot: string, snapshot: Map<string, PreDirtyEntry>): string[] {
  const tampered: string[] = []
  for (const [rel, entry] of snapshot) {
    const abs = path.join(targetRoot, ...rel.split("/"))
    try {
      const nowHash = createHash("sha256").update(readFileSync(abs)).digest("hex")
      if (nowHash !== entry.hash) tampered.push(rel)
    } catch {
      tampered.push(rel)
    }
  }
  return tampered.sort()
}

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
      } catch {}
    }
    unrestorable.push(rel)
  }
  return unrestorable
}

// Repeat the pass: restoring a tampered .gitignore can unmask violations git status was hiding.
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

function cleanupCodeWrites(targetRoot: string, violations: string[]): string[] {
  const failed: string[] = []
  for (const rel of violations) {
    const abs = path.join(targetRoot, ...rel.split("/"))
    try {
      execFileSync("git", ["cat-file", "-e", `HEAD:${rel}`], { cwd: targetRoot, stdio: "ignore" })
      execFileSync("git", ["checkout", "HEAD", "--", rel], { cwd: targetRoot, stdio: "ignore" })
    } catch {
      try {
        execFileSync("git", ["rm", "-f", "-q", "--cached", "--ignore-unmatch", "--", rel], {
          cwd: targetRoot,
          stdio: "ignore",
        })
      } catch {}
      try {
        rmSync(abs, { force: true, recursive: true })
      } catch {
        failed.push(rel)
      }
    }
  }
  return failed
}

function resolveTarget(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) {
    throw new ControlError("this server governs no project — open one from the launcher before talking to Vivi", "missing_target")
  }
  if (!existsSync(targetRoot)) {
    throw new ControlError(`target root does not exist: ${targetRoot}`, "missing_target")
  }
  return targetRoot
}

type TurnOrigin =
  { kind: "user"; message: string } | { kind: "import_read"; imported: ViviImportEvent } | { kind: "question_answers"; count: number }

type TurnQueue = Map<string, Promise<void>>

// Cross-request server state stays process-global, never a module `let` — same trap as lib/spawner.ts.
const TURN_QUEUE = Symbol.for("vivicy.vivi.turn-queue")

function turnQueue(): TurnQueue {
  const registry = globalThis as unknown as Record<symbol, TurnQueue | undefined>
  const existing = registry[TURN_QUEUE]
  if (existing) return existing
  const created: TurnQueue = new Map()
  registry[TURN_QUEUE] = created
  return created
}

export function isViviTurnRunning(targetRoot: string): boolean {
  return turnQueue().has(targetRoot)
}

// One turn at a time per TARGET, queued and never refused, released on every path: a concurrent turn's legitimate writes would be wiped by the other's rollback.
async function withTargetTurnLock<T>(targetRoot: string, run: () => Promise<T>): Promise<T> {
  const queue = turnQueue()
  const previous = queue.get(targetRoot)
  const mine = (previous ?? Promise.resolve()).then(run)
  const tail = mine.then(
    () => {},
    () => {}
  )
  queue.set(targetRoot, tail)
  try {
    return await mine
  } finally {
    if (queue.get(targetRoot) === tail) queue.delete(targetRoot)
  }
}

export async function runViviTurn(
  spawner: Spawner,
  input: {
    sessionId?: string
    message: string
  }
): Promise<ViviReply> {
  const message = typeof input.message === "string" ? input.message.trim() : ""
  if (message.length === 0) {
    throw new ControlError("empty message — write something for Vivi to work with", "missing_target")
  }
  const sessionId = input.sessionId ?? randomUUID()
  if (input.sessionId) assertSessionId(input.sessionId)
  return runTurn(spawner, sessionId, { kind: "user", message })
}

// Record the owner's turn BEFORE the queue wait, or the thread hides their message behind whatever is running ahead of it.
async function runTurn(spawner: Spawner, sessionId: string, origin: TurnOrigin): Promise<ViviReply> {
  const targetRoot = resolveTarget()
  const factoryRoot = getFactoryRoot()
  const command = resolveViviTurnScript(factoryRoot)
  if (origin.kind === "user") {
    appendTurn(sessionId, { role: "user", text: origin.message, ts: new Date().toISOString() })
  }
  return withTargetTurnLock(targetRoot, () => runTurnLocked(spawner, { sessionId, origin, targetRoot, factoryRoot, command }))
}

async function runTurnLocked(
  spawner: Spawner,
  ctx: { sessionId: string; origin: TurnOrigin; targetRoot: string; factoryRoot: string; command: string }
): Promise<ViviReply> {
  const { sessionId, origin, targetRoot, factoryRoot, command } = ctx
  // One capture serves both the rollback target (the owner's pre-turn bytes) and the first round's base.
  const before = snapshotVivicy(targetRoot)

  const preDirty = gitDirtyPaths(targetRoot)
  const preDirtySnapshot = snapshotPreDirty(targetRoot, preDirty)
  const gitNote =
    preDirty === null
      ? "\n\n⚠ this target has no usable git repository — Vivi's no-code enforcement outside `.vivicy` was unavailable this turn."
      : ""

  // Re-derive every round: an action tool can freeze or reopen the baseline mid-turn.
  let frozen = isCanonicalFrozen(targetRoot)
  // Fold each accepted round's writes in, or a later round's stricter allowlist re-judges them.
  let roundBase = before

  const maxRounds = resolveMaxActionRounds(process.env.VIVICY_VIVI_MAX_ROUNDS)
  const allActions: ViviActionResult[] = []
  let wrote: string[] = []

  for (let round = 1; ; round++) {
    frozen = isCanonicalFrozen(targetRoot)
    const allowedDirs = frozen ? POST_FREEZE_DIRS : CANONICAL_DIRS
    const crId = nextCrId(targetRoot)
    const statusLine = buildStatusLine(spawner, targetRoot, frozen)
    const turns = readTranscript(sessionId)
    const prompt = composePrompt(factoryRoot, targetRoot, turns, frozen, crId, statusLine, origin)
    const reply = await spawnViviLeg(spawner, { command, targetRoot, prompt, frozen })

    const after = snapshotVivicy(targetRoot, roundBase)
    const diff = diffVivicy(roundBase, after, allowedDirs)

    if (preDirty !== null) {
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
        return rejectTurn(
          sessionId,
          reply,
          targetRoot,
          rollback,
          before,
          withExecutedActionsNote(
            `rejected: Vivi modified your uncommitted work in progress (${tampered.join(", ")}) — code writes are forbidden — the whole turn was rolled back${restoreNote}`,
            allActions
          ),
          allActions
        )
      }

      const codeWrites = detectCodeWrites(targetRoot, preDirty)
      if (codeWrites !== null && codeWrites.length > 0) {
        const cleanupFailed = cleanupCodeWritesDeep(targetRoot, codeWrites, preDirty)
        const rollback: DiffResult = {
          allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
          violations: diff.violations,
        }
        const cleanupNote = cleanupFailed.length > 0 ? `; WARNING: could not clean up: ${cleanupFailed.join(", ")} — remove manually` : ""
        return rejectTurn(
          sessionId,
          reply,
          targetRoot,
          rollback,
          before,
          withExecutedActionsNote(
            `rejected: Vivi wrote outside .vivicy — code writes are forbidden (${codeWrites.join(", ")}) — the whole turn was rolled back${cleanupNote}`,
            allActions
          ),
          allActions
        )
      }
    }

    if (diff.violations.length > 0) {
      const rollback: DiffResult = {
        allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
        violations: diff.violations,
      }
      return rejectTurn(
        sessionId,
        reply,
        targetRoot,
        rollback,
        before,
        withExecutedActionsNote(
          `rejected: Vivi wrote outside its allowlist (${diff.violations.join(", ")}) — the whole turn was rolled back`,
          allActions
        ),
        allActions
      )
    }

    if ((frozen || isCanonicalFrozen(targetRoot)) && diff.allowedWrites.length > 0) {
      const invalid = await validateChangeControlSafely(spawner, factoryRoot, targetRoot)
      if (invalid) {
        const rollback: DiffResult = {
          allowedWrites: [...new Set([...wrote, ...diff.allowedWrites])].sort(),
          violations: diff.violations,
        }
        return rejectTurn(
          sessionId,
          reply,
          targetRoot,
          rollback,
          before,
          withExecutedActionsNote(
            `rejected: Vivi's Change Request did not pass change-control (${invalid}) — the whole turn was rolled back`,
            allActions
          ),
          allActions
        )
      }
    }

    wrote = [...new Set([...wrote, ...diff.allowedWrites])].sort()
    // Re-capture rather than reuse `after`: change-control ran in between and writes its own state.
    roundBase = snapshotVivicy(targetRoot, after)
    if (diff.allowedWrites.length > 0) pruneGitkeeps(targetRoot)

    const directive = parseActionDirective(reply)

    if (directive === null) {
      const spoken = takeQuestions(applySkillsDirective(spawner, reply))
      const finalReply = `${spoken.text}${gitNote}`
      appendViviReply(sessionId, finalReply, diff.allowedWrites, spoken.questions)
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

    if ("malformed" in directive) {
      const spoken = takeQuestions(applySkillsDirective(spawner, reply))
      const finalReply = `${spoken.text}\n\n→ no action executed: ${directive.malformed}.${gitNote}`
      appendViviReply(sessionId, finalReply, diff.allowedWrites, spoken.questions)
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

    const spoken = takeQuestions(applySkillsDirective(spawner, stripActionFence(reply)))
    const spokenText = spoken.text
    appendViviReply(
      sessionId,
      spokenText.length > 0 ? spokenText : spoken.questions === null ? "(requested actions)" : "",
      diff.allowedWrites,
      spoken.questions
    )

    const results = await executeViviActions(spawner, directive.actions)
    allActions.push(...results)
    appendTurn(sessionId, {
      role: "action",
      text: renderActionResults(results),
      ts: new Date().toISOString(),
      actions: results,
    })
    appendPendingCrCards(sessionId, results)

    // Fold the actions' own writes in: that state is orchestrator-owned, and the next round's diff would otherwise roll it back.
    roundBase = snapshotVivicy(targetRoot, roundBase)
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
        `→ action round limit (${maxRounds}) reached this turn; ${countForm(results.length, "the result above is recorded", "the results above are recorded")}.${gitNote}`
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString() })
      return { sessionId, reply: finalReply, wrote, actions: allActions }
    }
  }
}

function resolveMaxActionRounds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return DEFAULT_VIVI_ACTION_ROUNDS
  return Math.max(1, Math.min(MAX_VIVI_ACTION_ROUNDS, parsed))
}

function withExecutedActionsNote(reason: string, executed: ViviActionResult[]): string {
  if (executed.length === 0) return reason
  const note = countForm(
    executed.length,
    "1 action already executed this turn remains in effect",
    `${executed.length} actions already executed this turn remain in effect`
  )
  return `${reason}; note: ${note}`
}

async function spawnViviLeg(
  spawner: Spawner,
  opts: { command: string; targetRoot: string; prompt: string; frozen: boolean }
): Promise<string> {
  const { command, targetRoot, prompt, frozen } = opts
  const scratch = openScratchDir(TURN_SCRATCH_PREFIX)
  const promptFile = path.join(scratch, "prompt.txt")
  const replyFile = path.join(scratch, "reply.txt")
  try {
    writeFileSync(promptFile, prompt)
    const result = await spawner.run({
      command: process.execPath,
      args: [command, "--prompt-file", promptFile, "--reply-file", replyFile, "--target", targetRoot],
      cwd: targetRoot,
      env: {
        ...process.env,
        VIVICY_TARGET_ROOT: targetRoot,
        VIVICY_SPEC_FROZEN: frozen ? "true" : "false",
        ...settingsToEnv(resolveSettings(targetRoot)),
      },
    })
    return readReply(replyFile, result.stdout)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

const SKILLS_TAG = "vivicy-skills"

export type SkillsDirective = { ids: string[] } | { malformed: string } | null

export function parseSkillsDirective(reply: string): SkillsDirective {
  const block = readFencedBlock(reply, SKILLS_TAG)
  if (block === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(block.body)
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

interface SpokenReply {
  text: string
  questions: ViviQuestion[] | null
}

// The fence never reaches the thread, valid or malformed: it always comes out of her prose.
function takeQuestions(reply: string): SpokenReply {
  const directive = parseQuestionsDirective(reply)
  if (directive === null) return { text: reply, questions: null }
  const spoken = stripQuestionsFence(reply)
  if ("malformed" in directive) {
    const note = `→ no question cards rendered: ${directive.malformed}.`
    return { text: spoken.length > 0 ? `${spoken}\n\n${note}` : note, questions: null }
  }
  return { text: spoken, questions: directive.questions }
}

// The stack id is server-minted — the fence never names it — and the stack rides its OWN turn.
function appendViviReply(sessionId: string, text: string, wrote: string[], questions: ViviQuestion[] | null): void {
  if (text.trim().length > 0 || wrote.length > 0 || questions === null) {
    appendTurn(sessionId, { role: "vivi", text, ts: new Date().toISOString(), wrote })
  }
  if (questions === null) return
  appendTurn(sessionId, {
    role: "questions",
    text: countForm(questions.length, "1 question card", `${questions.length} question cards`),
    ts: new Date().toISOString(),
    questions: { id: randomUUID(), questions },
  })
}

function rejectTurn(
  sessionId: string,
  reply: string,
  targetRoot: string,
  diff: DiffResult,
  before: Snapshot,
  rejected: string,
  actions: ViviActionResult[] = []
): ViviReply {
  restoreSnapshot(targetRoot, diff, before)
  appendTurn(sessionId, { role: "vivi", text: reply, ts: new Date().toISOString(), rejected })
  return { sessionId, reply, wrote: [], rejected, actions: actions.length > 0 ? actions : undefined }
}

async function validateChangeControlSafely(spawner: Spawner, factoryRoot: string, targetRoot: string): Promise<string | null> {
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

function resolveViviTurnScript(factoryRoot: string): string {
  const abs = path.join(factoryRoot, VIVI_TURN_SCRIPT)
  if (!existsSync(abs)) {
    throw new ControlError(`factory script not found: ${VIVI_TURN_SCRIPT} (looked under ${factoryRoot})`, "missing_script")
  }
  return abs
}

function readReply(replyFile: string, stdout: string): string {
  if (existsSync(replyFile)) {
    try {
      const text = readFileSync(replyFile, "utf8").trim()
      if (text.length > 0) return text
    } catch {}
  }
  const fallback = stdout.trim()
  return fallback.length > 0 ? fallback : "Vivi could not produce a reply this turn (the agent leg wrote nothing). Try again."
}
