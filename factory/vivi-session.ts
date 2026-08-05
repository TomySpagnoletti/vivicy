import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"

import { isLegSessionId } from "./agent-spawn.ts"
import { atomicWriteJson } from "./atomic-write.ts"
import { ensureViviStoreDir, getViviStoreDir, VIVI_SESSION_ID_PATTERN } from "../lib/project-runtime.ts"

// What the conversation was created under. A model change is deliberately NOT part of the fork set: switching it mid-conversation is free (measured).
export interface ViviLegIdentity {
  provider: string
  cwd: string
  personaHash: string
  model: string
}

export interface ViviLegSession extends ViviLegIdentity {
  cliSessionId: string
}

export type ViviForkReason = "cwd_changed" | "provider_changed" | "persona_changed" | "resume_refused"

const SIDECAR_SUFFIX = ".leg.json"

export function assertViviSessionId(sessionId: string): void {
  if (typeof sessionId !== "string" || !VIVI_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(`vivi-session: "${String(sessionId)}" is not a usable vivi session id — it names a file beside the conversation store.`)
  }
}

export function viviSidecarPath(targetRoot: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertViviSessionId(sessionId)
  return path.join(getViviStoreDir(targetRoot, env), `${sessionId}${SIDECAR_SUFFIX}`)
}

export function openViviSidecar(targetRoot: string, sessionId: string, env: NodeJS.ProcessEnv = process.env): string {
  assertViviSessionId(sessionId)
  return path.join(ensureViviStoreDir(targetRoot, env), `${sessionId}${SIDECAR_SUFFIX}`)
}

// Two spellings of one directory (macOS symlinks /tmp) would read as a moved target and fork every turn.
export function stableCwd(dir: string): string {
  try {
    return realpathSync(path.resolve(dir))
  } catch {
    return path.resolve(dir)
  }
}

function serialize(session: ViviLegSession): string {
  return `${JSON.stringify(ordered(session), null, 2)}\n`
}

// One field order, so an unchanged identity serializes to the very bytes already on disk.
function ordered(session: ViviLegSession): ViviLegSession {
  return {
    provider: session.provider,
    cliSessionId: session.cliSessionId,
    cwd: session.cwd,
    personaHash: session.personaHash,
    model: session.model,
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
}

// Anything but a whole, well-formed record reads as NO session: the turn then creates one instead of resuming an id nothing minted.
export function readViviLegSession(file: string): ViviLegSession | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const { provider, cliSessionId, cwd, personaHash, model } = parsed as Record<string, unknown>
  if (!isLegSessionId(cliSessionId)) return null
  if (!nonEmptyString(provider) || !nonEmptyString(cwd) || !nonEmptyString(personaHash) || typeof model !== "string") return null
  return ordered({ provider, cliSessionId, cwd, personaHash, model })
}

export function publishViviLegSession(file: string, session: ViviLegSession): void {
  const next = serialize(session)
  let current: string | null = null
  try {
    current = readFileSync(file, "utf8")
  } catch {}
  if (current === next) return
  atomicWriteJson(file, ordered(session))
}

export function identityDrift(prior: ViviLegSession, now: ViviLegIdentity): ViviForkReason | null {
  if (prior.cwd !== now.cwd) return "cwd_changed"
  if (prior.provider !== now.provider) return "provider_changed"
  if (prior.personaHash !== now.personaHash) return "persona_changed"
  return null
}

export interface ViviLegAttempt<T> {
  turn: T
  cliSessionId?: string
  spoke: boolean
  resumeRefused: boolean
}

export interface ViviSessionRun<T> {
  turn: T
  forked: ViviForkReason | null
  resumed: boolean
}

// The ONE fork/recovery path: a moved target, a swapped CLI, a persona that drifted, and a resume the CLI itself refused all land here, and the owner is told nothing — the caller's prompt is the whole render, so a fork reseeds the new conversation with the conversation it lost.
export async function runViviLegSession<T>(options: {
  sidecar: string | null
  identity: ViviLegIdentity
  spawn: (resumeSessionId?: string) => Promise<ViviLegAttempt<T>>
}): Promise<ViviSessionRun<T>> {
  const { sidecar, identity, spawn } = options
  const prior = sidecar === null ? null : readViviLegSession(sidecar)
  const drift = prior === null ? null : identityDrift(prior, identity)

  if (prior !== null && drift === null) {
    const resumed = await spawn(prior.cliSessionId)
    if (!resumed.resumeRefused) {
      recordConversation(sidecar, identity, resumed, prior.cliSessionId)
      return { turn: resumed.turn, forked: null, resumed: true }
    }
  }

  const created = await spawn(undefined)
  recordConversation(sidecar, identity, created, undefined)
  return { turn: created.turn, forked: prior === null ? null : (drift ?? "resume_refused"), resumed: false }
}

// A turn that never spoke records nothing: its conversation carries no exchange the thread shows, and the next turn is free to create a clean one.
function recordConversation<T>(
  sidecar: string | null,
  identity: ViviLegIdentity,
  attempt: ViviLegAttempt<T>,
  resumedId: string | undefined
): void {
  if (sidecar === null || !attempt.spoke) return
  const cliSessionId = attempt.cliSessionId ?? resumedId
  if (cliSessionId === undefined || !isLegSessionId(cliSessionId)) return
  publishViviLegSession(sidecar, { ...identity, cliSessionId })
}
