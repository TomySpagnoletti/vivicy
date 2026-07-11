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

const VIVI_TURN_SCRIPT = "vivi-turn.ts"

const CHANGE_CONTROL_SCRIPT = "change-control.ts"

const CANONICAL_DIRS = [
  path.join(".vivicy", "canonical"),
  path.join(".vivicy", "development", "spikes"),
] as const

const CHANGE_REQUESTS_DIR = path.join(".vivicy", "change-requests")
const POST_FREEZE_DIRS = [CHANGE_REQUESTS_DIR] as const

const VIVICY_DIR = ".vivicy"

// Ignored by every .vivicy snapshot/diff: the leg writes its own transcript here mid-turn, which would otherwise trip the allowlist and roll back every turn's legitimate writes.
const IGNORED_SUBTREE = path.join(".vivicy", "development", "transcripts")

// action executes only on the owner's click — nothing on a card ever self-fires.
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

// server-authored, deterministic — a card's content never comes from the LLM reply.
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

export interface ViviTurn {
  role: "user" | "vivi" | "action" | "card"
  text: string
  ts: string
  wrote?: string[]
  rejected?: string
  actions?: ViviActionResult[]
  card?: ViviCard
  decided?: ViviCardDecision
}

export interface ViviReply {
  sessionId: string
  reply: string
  wrote: string[]
  rejected?: string
  actions?: ViviActionResult[]
}

type Snapshot = Map<string, string>

function viviRuntimeDir(): string {
  const targetRoot = getTargetRoot()
  if (targetRoot === null) return path.join(getRuntimeDir(), "vivi")
  const projectDir = path.join(getProjectRuntimeDir(getRuntimeDir(), targetRoot), "vivi")
  const legacyDir = path.join(getRuntimeDir(), "vivi")
  if (!existsSync(projectDir) && existsSync(legacyDir)) {
    try {
      mkdirSync(path.dirname(projectDir), { recursive: true })
      renameSync(legacyDir, projectDir)
    } catch {}
  }
  return projectDir
}

function transcriptPath(sessionId: string): string {
  return path.join(viviRuntimeDir(), `${sessionId}.jsonl`)
}

// reject anything that isn't our own minted UUID — this guards against path traversal via the session id.
function assertSessionId(sessionId: string): void {
  if (!/^[0-9a-fA-F-]{36}$/.test(sessionId)) {
    throw new ControlError(`invalid vivi session id: ${sessionId}`, "missing_target")
  }
}

export function readTranscript(sessionId: string): ViviTurn[] {
  const file = transcriptPath(sessionId)
  if (!existsSync(file)) return []
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
  const file = transcriptPath(sessionId)
  mkdirSync(path.dirname(file), { recursive: true })
  const line = `${JSON.stringify(turn)}\n`
  writeFileSync(file, line, { flag: "a" })
}

export function appendCardTurn(card: ViviCard, sessionId?: string): string {
  const id = sessionId ?? randomUUID()
  if (sessionId) assertSessionId(sessionId)
  appendTurn(id, { role: "card", text: card.title, ts: new Date().toISOString(), card })
  return id
}

export const VIVI_WELCOME_MESSAGE =
  "Ciao, I'm Vivi — I run Vivicy's kitchen. My job is to turn your idea into a spec so exact the factory can build it with nothing left to guess, and I get there by asking you the questions you didn't think to answer. Allora, let's start: what do you want to build?"

export function seedViviWelcome(): string {
  const sessionId = randomUUID()
  appendTurn(sessionId, {
    role: "vivi",
    text: VIVI_WELCOME_MESSAGE,
    ts: new Date().toISOString(),
  })
  return sessionId
}

// mirrors the feed's own status filter — keep both in sync.
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

function rewriteTranscript(sessionId: string, turns: ViviTurn[]): void {
  const file = transcriptPath(sessionId)
  writeFileSync(file, turns.map((t) => JSON.stringify(t)).join("\n") + (turns.length > 0 ? "\n" : ""))
}

export interface CardDecisionResult {
  ok: boolean
  summary: string
  decided?: ViviCardDecision
  reply?: ViviReply
}

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

  // stamps against a fresh read every time — turns appended concurrently (another Vivi turn, the action turns below) must survive the rewrite.
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

  // initial.decided is a stale read; stamp() below does the real read-check-write claim, so two concurrent clicks can't both execute the action.
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

function readPersona(factoryRoot: string): string {
  return readFileSync(path.join(factoryRoot, "prompts", "vivi.md"), "utf8")
}

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

function firstLine(text: string, max: number): string {
  const line = text.split("\n", 1)[0]
  return line.length > max ? `${line.slice(0, max)}…` : line
}

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

function hasFrozenBaseline(targetRoot: string): boolean {
  return hasActiveFrozenBaseline(targetRoot)
}

// must mirror change-control's own CR_FILENAME regex — keep both in sync.
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

// computed here, not left to the agent, so the id it's told to use always satisfies change-control's sequential-numbering gate.
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

// sync reads only, never a spawn — a failing probe reports "unavailable", never a fabricated value.
function buildStatusLine(spawner: Spawner, targetRoot: string, frozen: boolean): string {
  try {
    const extraction = getExtractionStatus()
    const skills = readSkillsReport()
    const running = isRunActive(spawner)
    const kind = detectSpecKind(targetRoot)
    return (
      `Pipeline snapshot: run_active=${running}; extraction=${extraction?.phase ?? "never"}; ` +
      `skills=${skills?.phase ?? "never"}; spec_frozen=${frozen}; spec_kind=${kind}.`
    )
  } catch {
    return "Pipeline snapshot: unavailable."
  }
}

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

function isAllowedWrite(rel: string, allowedDirs: readonly string[]): boolean {
  if (!rel.endsWith(".md")) return false
  return allowedDirs.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`))
}

// snapshots the WHOLE .vivicy tree, not just the allowlist — narrowing it would make restoreSnapshot delete (not restore) a pre-existing out-of-allowlist file it never hashed.
function snapshotVivicyBytes(targetRoot: string): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>()
  for (const abs of walkFiles(path.join(targetRoot, VIVICY_DIR))) {
    const rel = path.relative(targetRoot, abs)
    if (rel === IGNORED_SUBTREE || rel.startsWith(`${IGNORED_SUBTREE}${path.sep}`)) continue
    bytes.set(rel, readFileSync(abs))
  }
  return bytes
}

interface DiffResult {
  allowedWrites: string[]
  violations: string[]
}

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

function restoreSnapshot(
  targetRoot: string,
  diff: DiffResult,
  bytesBefore: Map<string, Buffer>
): void {
  for (const rel of [...diff.allowedWrites, ...diff.violations]) {
    const prior = bytesBefore.get(rel)
    const abs = path.join(targetRoot, rel)
    if (prior === undefined) {
      rmSync(abs, { force: true })
    } else {
      mkdirSync(path.dirname(abs), { recursive: true })
      writeFileSync(abs, prior)
    }
  }
}

// git status is the whole-target witness that Vivi wrote no code outside .vivicy — the byte diff above can't see there, since the leg runs with cwd=targetRoot and permissions bypassed. Gitignored paths (e.g. the leg's own transcript) are invisible to this probe by design; null means git is unusable, so the caller falls back to .vivicy-only enforcement with a loud note.
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
    // git porcelain -z rename/copy records carry the origin path as the next NUL field — consumed here since the origin disappeared from the worktree too.
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

// guards a leg hiding a code write inside an already-dirty file: detectCodeWrites exempts owner-dirty paths from the new-write check, so this snapshot is their only witness.
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

// repeated passes: restoring a tampered .gitignore can re-reveal files it was hiding from git status, unmasking a new violation only after cleanup.
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

  appendTurn(sessionId, { role: "user", text: message, ts: new Date().toISOString() })

  const bytesBefore = snapshotVivicyBytes(targetRoot)

  const preDirty = gitDirtyPaths(targetRoot)
  const preDirtySnapshot = snapshotPreDirty(targetRoot, preDirty)
  const gitNote =
    preDirty === null
      ? "\n\n⚠ this target has no usable git repository — Vivi's no-code enforcement outside `.vivicy` was unavailable this turn."
      : ""

  // re-derived every round: an action tool (e.g. pipeline.extract, cycle.open/close) can freeze or reopen the baseline mid-turn.
  let frozen = hasFrozenBaseline(targetRoot) && !isSpecCycleOpen(targetRoot)
  // folds in each accepted round's writes so they're never re-judged by a later round's (possibly stricter) allowlist.
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

    const diff = diffVivicy(targetRoot, roundBase, allowedDirs)

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

    if (directive === null) {
      const finalReply = `${applySkillsDirective(spawner, reply)}${gitNote}`
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString(), wrote: diff.allowedWrites })
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

    if ("malformed" in directive) {
      const finalReply = `${applySkillsDirective(spawner, reply)}\n\n→ no action executed: ${directive.malformed}.${gitNote}`
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString(), wrote: diff.allowedWrites })
      return { sessionId, reply: finalReply, wrote, actions: allActions.length > 0 ? allActions : undefined }
    }

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
    appendPendingCrCards(sessionId, results)

    // actions' own writes fold into roundBase here — that state is orchestrator-owned, not Vivi's; without this the next round's diff would blame Vivi and roll back what the action just created.
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
      appendTurn(sessionId, { role: "vivi", text: finalReply, ts: new Date().toISOString() })
      return { sessionId, reply: finalReply, wrote, actions: allActions }
    }
  }
}

function resolveMaxActionRounds(raw: string | undefined): number {
  const parsed = Number.parseInt(raw ?? "", 10)
  if (!Number.isFinite(parsed)) return 3
  return Math.max(1, Math.min(5, parsed))
}

function withExecutedActionsNote(reason: string, executed: ViviActionResult[]): string {
  if (executed.length === 0) return reason
  return `${reason}; note: ${executed.length} action(s) already executed this turn remain in effect`
}

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
      env: {
        ...process.env,
        VIVICY_TARGET_ROOT: targetRoot,
        VIVICY_SPEC_FROZEN: frozen ? "true" : "false",
        ...settingsToEnv(readSettings()),
      },
    })
  } finally {
    rmSync(promptFile, { force: true })
  }

  const reply = readReply(replyFile, result.stdout)
  rmSync(replyFile, { force: true })
  return reply
}

const SKILLS_FENCE = /```vivicy-skills\s*\n([\s\S]*?)\n\s*```/

export type SkillsDirective = { ids: string[] } | { malformed: string } | null

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

function readReply(replyFile: string, stdout: string): string {
  if (existsSync(replyFile)) {
    try {
      const text = readFileSync(replyFile, "utf8").trim()
      if (text.length > 0) return text
    } catch {}
  }
  const fallback = stdout.trim()
  return fallback.length > 0
    ? fallback
    : "Vivi could not produce a reply this turn (the agent leg wrote nothing). Try again."
}
