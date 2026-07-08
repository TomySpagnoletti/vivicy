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

import {
  createHash,
  randomUUID,
} from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import path from "node:path"

import { ControlError, getFactoryRoot, startSkillsInstall, type Spawner } from "@/lib/control"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { settingsToEnv } from "@/lib/settings"
import { pruneGitkeeps } from "@/lib/skeleton"
import { readSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"

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

/** Repo-relative dir holding the frozen-baseline manifests we probe for the phase. */
const BASELINES_DIR = path.join(".vivicy", "baselines")

/** The `.vivicy` subtree we snapshot/diff to enforce the allowlist. */
const VIVICY_DIR = ".vivicy"

/**
 * Subtree the diff ignores entirely: the agent leg writes its OWN transcript here
 * (gitignored infrastructure, never Vivi's product surface). Without this, every
 * turn that spawns a leg trips the allowlist on the leg's transcript and rolls the
 * whole turn back — destroying the legitimate canonical/spike writes with it.
 */
const IGNORED_SUBTREE = path.join(".vivicy", "development", "transcripts")

/** One recorded conversation turn, persisted as a single JSONL line. */
export interface ViviTurn {
  role: "user" | "vivi"
  text: string
  ts: string
  /** Repo-relative `.md` paths this (vivi) turn wrote — omitted for user turns. */
  wrote?: string[]
  /** Set on a vivi turn the allowlist rejected; carries the honest reason. */
  rejected?: string
}

/** Outcome of one turn returned to the caller (and the route). */
export interface ViviReply {
  sessionId: string
  reply: string
  /** Repo-relative `.md` paths Vivi actually wrote this turn (post-enforcement). */
  wrote: string[]
  /** Set when the turn's writes broke the allowlist and were rolled back. */
  rejected?: string
}

/** A file's bytes hash keyed by its repo-relative path — one allowlist snapshot. */
type Snapshot = Map<string, string>

/** Absolute path to the per-session transcript JSONL under the runtime dir. */
function transcriptPath(sessionId: string): string {
  return path.join(getRuntimeDir(), "vivi", `${sessionId}.jsonl`)
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
    const who = turn.role === "user" ? "User" : "Vivi"
    const body = i === lastIdx ? turn.text : firstLine(turn.text, 200)
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

/**
 * Does the target carry an ACTIVE FROZEN baseline? The single source of truth for the
 * phase Vivi is in: a `.vivicy/baselines/*.json` whose `status` is "frozen" and that
 * carries no `superseded` marker — the exact definition the factory uses
 * ({@link file://../factory/extract-issues#findFrozenManifest} /
 * change-control's `readFrozenBaselineIdentity`). Read-only, dependency-free, and
 * deliberately NOT a spawn: it decides which allowlist this turn enforces, so it must be
 * cheap and synchronous. A malformed/unreadable manifest is simply not a freeze.
 */
function hasFrozenBaseline(targetRoot: string): boolean {
  const dir = path.join(targetRoot, BASELINES_DIR)
  if (!existsSync(dir)) return false
  for (const entry of readdirSync(dir)) {
    if (!entry.toLowerCase().endsWith(".json")) continue
    let manifest: { status?: unknown; superseded?: unknown; baseline_id?: unknown }
    try {
      manifest = JSON.parse(readFileSync(path.join(dir, entry), "utf8"))
    } catch {
      continue
    }
    if (
      manifest &&
      manifest.status === "frozen" &&
      !manifest.superseded &&
      typeof manifest.baseline_id === "string" &&
      manifest.baseline_id.length > 0
    ) {
      return true
    }
  }
  return false
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
 * Compose the full turn prompt: persona + transcript + `.vivicy` state + task. The task
 * section (and the `spec_frozen` flag it announces) DEPENDS on the phase:
 *   - PRE-freeze: author canonical docs + spikes, as before.
 *   - POST-freeze: the canonical is locked — draft ONE Change Request under the registry
 *     with the exact next id `nextCrId`; never touch canonical/spikes. The persona's
 *     frozen-baseline section (keyed on this same `spec_frozen: true`) governs the CR shape.
 */
function composePrompt(
  factoryRoot: string,
  targetRoot: string,
  turns: ViviTurn[],
  frozen: boolean,
  crId: string
): string {
  const persona = readPersona(factoryRoot)
  const transcript = renderTranscript(turns)
  const state = summarizeVivicyState(targetRoot, frozen)
  const task = frozen
    ? `spec_frozen: true — the target already has a FROZEN canonical baseline, so the ` +
      `canonical spec is LOCKED. Respond to the user's latest message above. If it asks ` +
      `for a change to what the product does, do NOT edit any canonical doc or spike — ` +
      `instead draft ONE Change Request capturing that change, written as the single ` +
      `Markdown file \`.vivicy/change-requests/${crId}-<slug>.md\` (use exactly the id ` +
      `\`${crId}\`; pick a short lowercase kebab-case <slug> from the title), following ` +
      `the CR shape in your prompt (status: idea, classification: the closest enum, source: ` +
      `user, owner_decision: pending, all previous_baseline_*/resulting_* left null). ` +
      `If the message needs no product change, just answer it and write nothing. Then ` +
      `tell the user exactly what you did.\n`
    : `spec_frozen: false — Respond to the user's latest message above. Ask your next ` +
      `focused batch of questions and, when an area is settled, write or update the ` +
      `canonical docs and/or spikes (Markdown only, under \`.vivicy/canonical/\` or ` +
      `\`.vivicy/development/spikes/\`, in the target repo you are running inside). ` +
      `Then tell the user exactly which files you wrote.\n`
  return (
    `${persona}\n\n` +
    `---\n\n## Conversation so far\n\n${transcript}\n\n` +
    `---\n\n## Current \`.vivicy\` state (file list only)\n\n${state}\n\n` +
    `---\n\n## This turn\n\n${task}`
  )
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

  const sessionId = input.sessionId ?? randomUUID()
  if (input.sessionId) assertSessionId(input.sessionId)

  // The phase decides the whole turn: which allowlist to enforce, what the prompt tells
  // Vivi to do, and whether written CRs get validated afterwards.
  const frozen = hasFrozenBaseline(targetRoot)
  const allowedDirs = frozen ? POST_FREEZE_DIRS : CANONICAL_DIRS
  const crId = nextCrId(targetRoot)

  // Record the user's turn BEFORE the spawn, so the transcript is durable even if
  // the agent leg dies — the conversation is never silently lost.
  appendTurn(sessionId, { role: "user", text: message, ts: new Date().toISOString() })

  const turns = readTranscript(sessionId)
  const prompt = composePrompt(factoryRoot, targetRoot, turns, frozen, crId)

  // Hand the composed prompt to the leg via a file (it can be large; an argv string
  // is fragile). The factory script reads --prompt-file and writes its reply to
  // --reply-file so we capture the full reply regardless of stdout noise. The file
  // names carry a per-TURN token (not just the session id) so two concurrent turns
  // on the SAME session never race on each other's prompt/reply scratch files.
  const turnToken = randomUUID()
  const viviDir = path.join(getRuntimeDir(), "vivi")
  const promptFile = path.join(viviDir, `${sessionId}.${turnToken}.prompt.txt`)
  const replyFile = path.join(viviDir, `${sessionId}.${turnToken}.reply.txt`)
  mkdirSync(viviDir, { recursive: true })
  writeFileSync(promptFile, prompt)

  const command = resolveViviTurnScript(factoryRoot)

  // Snapshot the whole `.vivicy` tree's bytes + hash set BEFORE the spawn — the bytes so a
  // rejected turn restores any touched file, the hashes so the diff detects writes.
  const bytesBefore = snapshotVivicyBytes(targetRoot)
  const before = snapshotVivicy(targetRoot)

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
  // The reply scratch has been read into memory; drop it too (per-turn, so it would
  // otherwise accumulate).
  rmSync(replyFile, { force: true })

  // Enforce the allowlist structurally: diff `.vivicy` against the snapshot.
  const diff = diffVivicy(targetRoot, before, allowedDirs)

  if (diff.violations.length > 0) {
    return rejectTurn(sessionId, reply, targetRoot, diff, bytesBefore,
      `rejected: Vivi wrote outside its allowlist (${diff.violations.join(", ")}) — the whole turn was rolled back`)
  }

  // POST-freeze: a written CR must PASS the change-control checker (the validator of
  // record) before it is kept. A malformed CR is rolled back like any other violation —
  // trust nothing the agent wrote, prove the registry stays well-formed. Re-detect the
  // phase AFTER the spawn (not just the pre-spawn `frozen`) so a baseline that froze
  // mid-turn still forces validation — the check is fail-closed: any error running the
  // checker rejects the turn rather than letting an unproven CR through.
  if ((frozen || hasFrozenBaseline(targetRoot)) && diff.allowedWrites.length > 0) {
    const invalid = await validateChangeControlSafely(spawner, factoryRoot, targetRoot)
    if (invalid) {
      return rejectTurn(sessionId, reply, targetRoot, diff, bytesBefore,
        `rejected: Vivi's Change Request did not pass change-control (${invalid}) — the whole turn was rolled back`)
    }
  }

  if (diff.allowedWrites.length > 0) pruneGitkeeps(targetRoot)

  // An ACCEPTED turn may carry a skills-install directive (the vivicy-skills
  // fenced block the persona emits on an explicit user request). Acted on only
  // here — a rejected turn's directive dies with the turn.
  const finalReply = applySkillsDirective(spawner, reply)

  appendTurn(sessionId, {
    role: "vivi",
    text: finalReply,
    ts: new Date().toISOString(),
    wrote: diff.allowedWrites,
  })
  return { sessionId, reply: finalReply, wrote: diff.allowedWrites }
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

/** Record a rejected turn (restore the snapshot, stamp the transcript, return the reply). */
function rejectTurn(
  sessionId: string,
  reply: string,
  targetRoot: string,
  diff: DiffResult,
  bytesBefore: Map<string, Buffer>,
  rejected: string
): ViviReply {
  restoreSnapshot(targetRoot, diff, bytesBefore)
  appendTurn(sessionId, { role: "vivi", text: reply, ts: new Date().toISOString(), rejected })
  return { sessionId, reply, wrote: [], rejected }
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
