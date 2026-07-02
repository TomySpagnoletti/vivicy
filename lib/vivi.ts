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
 * ONE agent exec (`factory/vivi-turn.mjs`, which drives the configured implementer
 * CLI as Vivi's engine, with `cwd` = the target root), captures the reply, and
 * returns `{ sessionId, reply, wrote }`.
 *
 * File writing is enforced structurally, never by trust: Vivi may write ONLY `.md`
 * files under `.vivicy/canonical/` and `.vivicy/development/spikes/` in the target.
 * Before the spawn we snapshot the bytes of every file under those two dirs; after
 * it, we diff the whole `.vivicy` tree — any write outside the allowlist, or any
 * non-`.md` write into the allowed dirs, REJECTS the turn: the offending files are
 * removed, the snapshotted files are restored, and the turn is recorded as rejected
 * with an honest reason. Legit canonical/spike writes are reported in `wrote`.
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

import { ControlError, getFactoryRoot, type Spawner } from "@/lib/control"
import { getRuntimeDir } from "@/lib/runtime-dir"
import { settingsToEnv } from "@/lib/settings"
import { readSettings } from "@/lib/settings-store"
import { getTargetRoot } from "@/lib/target"

/** The factory script that runs one Vivi turn (drives the implementer CLI leg). */
const VIVI_TURN_SCRIPT = "vivi-turn.mjs"

/** Repo-relative dirs Vivi may write into (the ONLY allowed write destinations). */
const ALLOWED_DIRS = [
  path.join(".vivicy", "canonical"),
  path.join(".vivicy", "development", "spikes"),
] as const

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
 * and can update rather than duplicate. Lists the canonical docs and the spikes.
 */
function summarizeVivicyState(targetRoot: string): string {
  const sections = ALLOWED_DIRS.map((rel) => {
    const files = listMarkdown(path.join(targetRoot, rel)).map((abs) =>
      path.relative(targetRoot, abs)
    )
    const label = rel.includes("spikes") ? "Spikes" : "Canonical docs"
    if (files.length === 0) return `${label}: (none yet)`
    return `${label}:\n${files.map((f) => `  - ${f}`).join("\n")}`
  })
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

/** Compose the full turn prompt: persona + transcript + `.vivicy` state + task. */
function composePrompt(
  factoryRoot: string,
  targetRoot: string,
  turns: ViviTurn[]
): string {
  const persona = readPersona(factoryRoot)
  const transcript = renderTranscript(turns)
  const state = summarizeVivicyState(targetRoot)
  return (
    `${persona}\n\n` +
    `---\n\n## Conversation so far\n\n${transcript}\n\n` +
    `---\n\n## Current \`.vivicy\` state (file list only)\n\n${state}\n\n` +
    `---\n\n## This turn\n\n` +
    `Respond to the user's latest message above. Ask your next focused batch of ` +
    `questions and, when an area is settled, write or update the canonical docs ` +
    `and/or spikes (Markdown only, under \`.vivicy/canonical/\` or ` +
    `\`.vivicy/development/spikes/\`, in the target repo you are running inside). ` +
    `Then tell the user exactly which files you wrote.\n`
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

/** Is a repo-relative path a `.md` file inside one of the allowed write dirs? */
function isAllowedWrite(rel: string): boolean {
  if (!rel.endsWith(".md")) return false
  return ALLOWED_DIRS.some((dir) => rel === dir || rel.startsWith(`${dir}${path.sep}`))
}

/** Snapshot the two allowed dirs' bytes so a rejected turn can restore them exactly. */
function snapshotAllowedBytes(targetRoot: string): Map<string, Buffer> {
  const bytes = new Map<string, Buffer>()
  for (const rel of ALLOWED_DIRS) {
    for (const abs of walkFiles(path.join(targetRoot, rel))) {
      bytes.set(path.relative(targetRoot, abs), readFileSync(abs))
    }
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
 * whose hash changed is a WRITE. Classify each write as allowed (a `.md` under the
 * allowed dirs) or a violation. Deletions inside `.vivicy` are not our concern here
 * (Vivi's contract is about what it may WRITE); a violation is a forbidden write.
 */
function diffVivicy(targetRoot: string, before: Snapshot): DiffResult {
  const allowedWrites: string[] = []
  const violations: string[] = []
  for (const abs of walkFiles(path.join(targetRoot, VIVICY_DIR))) {
    const rel = path.relative(targetRoot, abs)
    if (rel === IGNORED_SUBTREE || rel.startsWith(`${IGNORED_SUBTREE}${path.sep}`)) continue
    const priorHash = before.get(rel)
    const changed = priorHash === undefined || priorHash !== hashFile(abs)
    if (!changed) continue
    if (isAllowedWrite(rel)) allowedWrites.push(rel)
    else violations.push(rel)
  }
  return { allowedWrites: allowedWrites.sort(), violations: violations.sort() }
}

/**
 * Roll a rejected turn back to the pre-spawn state (copy-on-detect restore): remove
 * every file the diff flagged as a write (allowed OR violating — the whole turn is
 * discarded, not just the illegal part), then restore the exact bytes of every file
 * that existed under the allowed dirs before the spawn. After this the two allowed
 * dirs are byte-identical to before; the violating paths are gone.
 */
function restoreSnapshot(
  targetRoot: string,
  diff: DiffResult,
  allowedBytesBefore: Map<string, Buffer>
): void {
  for (const rel of [...diff.allowedWrites, ...diff.violations]) {
    rmSync(path.join(targetRoot, rel), { force: true })
  }
  for (const [rel, bytes] of allowedBytesBefore) {
    const abs = path.join(targetRoot, rel)
    mkdirSync(path.dirname(abs), { recursive: true })
    writeFileSync(abs, bytes)
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
 * Run ONE Vivi turn. Appends the user turn, composes the bounded prompt, snapshots
 * the allowlist, drives `vivi-turn.mjs` through the injected {@link Spawner} with the
 * configured agent settings in the env and `cwd` = the target root, then enforces the
 * allowlist by diffing the target's `.vivicy` tree: on a violation the turn is
 * REJECTED and rolled back (recorded as rejected, the `.vivicy` allowed dirs restored
 * byte-for-byte, the violating paths removed); otherwise the reply + the legit writes
 * are recorded and returned. A missing `sessionId` mints a new one.
 *
 * Enforcement scope is the `.vivicy` tree — the tree Vivi's two allowed dirs live in
 * and where any misdirected `.vivicy` write lands. This is structural, not trust: it
 * holds regardless of what the agent's prompt says. (Writes elsewhere in the target
 * are outside this guard's scope; Vivi's persona forbids them, and the pre-freeze,
 * non-loop nature of the chat keeps the blast radius to the spec dirs.)
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

  // Record the user's turn BEFORE the spawn, so the transcript is durable even if
  // the agent leg dies — the conversation is never silently lost.
  appendTurn(sessionId, { role: "user", text: message, ts: new Date().toISOString() })

  const turns = readTranscript(sessionId)
  const prompt = composePrompt(factoryRoot, targetRoot, turns)

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

  // Snapshot the allowlist bytes + the whole `.vivicy` hash set BEFORE the spawn.
  const allowedBytesBefore = snapshotAllowedBytes(targetRoot)
  const before = snapshotVivicy(targetRoot)

  let result
  try {
    result = await spawner.run({
      command: process.execPath,
      args: [command, "--prompt-file", promptFile, "--reply-file", replyFile, "--target", targetRoot],
      cwd: targetRoot,
      // The agent settings the user picked drive which CLI is Vivi's engine (the
      // implementer role) and its model/effort/fast — Vivi never defines its own.
      env: { ...process.env, VIVICY_TARGET_ROOT: targetRoot, ...settingsToEnv(readSettings()) },
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
  const diff = diffVivicy(targetRoot, before)

  if (diff.violations.length > 0) {
    restoreSnapshot(targetRoot, diff, allowedBytesBefore)
    const rejected = `rejected: Vivi wrote outside its allowlist (${diff.violations.join(", ")}) — the whole turn was rolled back`
    appendTurn(sessionId, { role: "vivi", text: reply, ts: new Date().toISOString(), rejected })
    return { sessionId, reply, wrote: [], rejected }
  }

  appendTurn(sessionId, {
    role: "vivi",
    text: reply,
    ts: new Date().toISOString(),
    wrote: diff.allowedWrites,
  })
  return { sessionId, reply, wrote: diff.allowedWrites }
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
