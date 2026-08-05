#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { claudeRolloutPath, compactBoundaryTriggers, readPrompt, runClaudeLeg, runCodexLeg } from "./agent-spawn.ts"
import type { AgentIssue, AgentLeg, ContextPressure, LegConfig, LegRunResult } from "./agent-spawn.ts"
import type { LegResult } from "./leg-timeout.ts"
import { legDepsForVerbatimPrompt } from "./leg-deps.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import { openViviSidecar, readViviLegSession, runViviLegSession, stableCwd, viviSidecarPath } from "./vivi-session.ts"
import type { ViviForkReason, ViviLegIdentity } from "./vivi-session.ts"
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts"

interface ViviSpawnArgs {
  promptText: string
  targetRoot: string | null
  cfg: LegConfig
  leg: AgentLeg
  resumeSessionId?: string
}

interface ViviTurnOptions {
  seedText?: string
  incrementText?: string
  targetRoot?: string | null
  sessionId?: string
  cfg?: Partial<LegConfig>
  spawnVivi?: (args: ViviSpawnArgs) => Promise<LegRunResult>
}

export interface ViviTurnOutcome {
  reply: string
  status: number | null
  stderr: string
  cliSessionId?: string
  context?: ContextPressure
  forked: ViviForkReason | null
  resumed: boolean
}

type SpokenTurn = Omit<ViviTurnOutcome, "forked" | "resumed">

export async function runViviTurn(options: ViviTurnOptions = {}): Promise<ViviTurnOutcome> {
  const { seedText, incrementText } = options
  for (const [text, flag] of [
    [seedText, "--seed-file"],
    [incrementText, "--increment-file"],
  ] as const) {
    if (typeof text !== "string" || text.length === 0) {
      throw new Error(`vivi-turn: no prompt text (pass ${flag} <abs>; a turn composes both halves and this process picks one).`)
    }
  }
  const targetRoot = options.targetRoot ?? resolveTargetRoot()
  const cfg = viviLegConfig(options.cfg)

  const legs = resolveAgentLegs(process.env)
  const implementer: Omit<AgentLeg, "role"> = legs?.implementer ?? {
    actor: "claude",
    provider: "claude",
    model: CLI_DEFAULTS.claude.model,
    effort: CLI_DEFAULTS.claude.effort,
    fast: false,
  }
  const leg: AgentLeg = { ...implementer, role: "vivi" }

  const spawnVivi = options.spawnVivi ?? defaultSpawnVivi
  const run = await runViviLegSession<SpokenTurn>({
    sidecar: targetRoot === null || options.sessionId === undefined ? null : openViviSidecar(targetRoot, options.sessionId),
    identity: legIdentity(leg, cfg, targetRoot),
    // The ONE place the split is spent: a conversation being created (or reseeded by a fork) takes the seed, a resumed one takes the increment and nothing else.
    spawn: async (resumeSessionId) => {
      const promptText = (resumeSessionId === undefined ? seedText : incrementText) as string
      const { result, reply, sessionId, context } = await spawnVivi({ promptText, targetRoot, cfg, leg, resumeSessionId })
      const turn: SpokenTurn = { reply, status: result.status, stderr: result.stderr, cliSessionId: sessionId, context }
      return {
        turn,
        cliSessionId: sessionId,
        spoke: legFailureReason(turn) === null,
        resumeRefused: resumeSessionId !== undefined && refusedTheConversation(result),
      }
    },
  })
  return { ...run.turn, forked: run.forked, resumed: run.resumed }
}

// The leg roots itself through its LegDeps, never through the config: the prompt directory is this seam's business.
function viviLegConfig(over: Partial<LegConfig> = {}): LegConfig {
  return { ...DEFAULT_CONFIG, promptsDir: FACTORY_PROMPTS_DIR, ...over }
}

function legIdentity(leg: AgentLeg, cfg: LegConfig, targetRoot: string | null): ViviLegIdentity {
  return {
    provider: leg.provider ?? "claude",
    model: leg.model ?? "",
    cwd: stableCwd(targetRoot ?? "."),
    personaHash: createHash("sha256").update(readPrompt(cfg, leg.role)).digest("hex"),
  }
}

// The CLI refusing the conversation is the ONLY resume failure: a leg the watchdog killed, or a CLI that never started, says nothing about the session and must never cost a second spawn.
function refusedTheConversation(result: LegResult): boolean {
  return result.status !== null && result.status !== 0 && result.timedOut !== true
}

const MAX_LEG_DETAIL = 200

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n")
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (line.length > 0) return line.length > MAX_LEG_DETAIL ? `${line.slice(0, MAX_LEG_DETAIL)}…` : line
  }
  return ""
}

// The one verdict on whether the leg spoke: a non-zero status or an empty stdout is the orchestrator's to report, never Vivi's to say.
export function legFailureReason(outcome: Pick<ViviTurnOutcome, "reply" | "status" | "stderr">): string | null {
  const detail = lastNonEmptyLine(outcome.stderr)
  const said = detail.length > 0 ? ` — ${detail}` : ""
  if (outcome.status === null) return `the agent CLI reported no exit status${said}`
  if (outcome.status !== 0) return `the agent CLI exited ${outcome.status}${said}`
  if (outcome.reply.length === 0) return `the agent CLI exited 0 without writing a reply${said}`
  return null
}

async function defaultSpawnVivi({ promptText, targetRoot, cfg, leg, resumeSessionId }: ViviSpawnArgs): Promise<LegRunResult> {
  const execRoot = targetRoot
  const issue = viviIssue()
  const deps = legDepsForVerbatimPrompt(execRoot!, promptText)
  return leg.provider === "codex"
    ? runCodexLeg(leg, issue, cfg, deps, { resumeSessionId, measureContext: true })
    : runClaudeLeg(leg, issue, cfg, deps, { resumeSessionId, jsonReply: true, measureContext: true })
}

function viviIssue(): AgentIssue {
  return { id: "vivi", transcript_dir: null }
}

export type ViviMaintenanceOutcome = "compacted" | "reseeded" | "no_conversation" | "undecided"

const COMPACT_COMMAND = "/compact"

function compactBoundaryCount(cliSessionId: string): number {
  const rollout = claudeRolloutPath(cliSessionId)
  return rollout === null ? 0 : compactBoundaryTriggers(rollout).length
}

// Stewardship between two owner turns, invisible to the chat: relieve the conversation in place, or drop it so the next turn reseeds through the ONE create path. `codex exec` has no compaction — "/compact" reaches it as a plain user message the model answers "Context compacted." to while the rollout keeps growing (measured, 0.146) — so a non-claude conversation never buys that leg. A leg that could not run decides nothing rather than throwing a healthy conversation away.
export function runViviMaintenance(options: { targetRoot: string; sessionId: string; cfg?: Partial<LegConfig> }): ViviMaintenanceOutcome {
  const { targetRoot, sessionId } = options
  const sidecar = viviSidecarPath(targetRoot, sessionId)
  const prior = readViviLegSession(sidecar)
  if (prior === null) return "no_conversation"
  const reseed = (): ViviMaintenanceOutcome => {
    rmSync(sidecar, { force: true })
    return "reseeded"
  }
  if (prior.provider !== "claude") return reseed()
  const before = compactBoundaryCount(prior.cliSessionId)
  const leg: AgentLeg = { actor: "claude", role: "vivi", provider: "claude", model: prior.model }
  const deps = legDepsForVerbatimPrompt(targetRoot, COMPACT_COMMAND)
  const { result } = runClaudeLeg(leg, viviIssue(), viviLegConfig(options.cfg), deps, {
    resumeSessionId: prior.cliSessionId,
  })
  if (result.status === null || result.timedOut === true) return "undecided"
  if (result.status === 0 && compactBoundaryCount(prior.cliSessionId) > before) return "compacted"
  return reseed()
}

interface ViviTurnArgs {
  seedFile?: string
  incrementFile?: string
  replyFile?: string
  failureFile?: string
  pressureFile?: string
  targetRoot?: string
  sessionId?: string
  maintain: boolean
}

function parseArgs(argv: string[]): ViviTurnArgs {
  const out: ViviTurnArgs = { maintain: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--seed-file") out.seedFile = argv[i + 1]
    else if (argv[i] === "--increment-file") out.incrementFile = argv[i + 1]
    else if (argv[i] === "--reply-file") out.replyFile = argv[i + 1]
    else if (argv[i] === "--failure-file") out.failureFile = argv[i + 1]
    else if (argv[i] === "--pressure-file") out.pressureFile = argv[i + 1]
    else if (argv[i] === "--target") out.targetRoot = argv[i + 1]
    else if (argv[i] === "--session") out.sessionId = argv[i + 1]
    else if (argv[i] === "--maintain") out.maintain = true
  }
  return out
}

// The conversation the turn ran in is the server log's business and never the owner's: a fork is invisible in the chat by contract. The half that was sent, its size, and how full the conversation now is are where the per-turn cost is read off.
function sessionLine(outcome: ViviTurnOutcome, sent: { seed: string; increment: string }): string {
  const id = outcome.cliSessionId ?? "unrecorded"
  const half = outcome.resumed ? "increment" : "seed"
  const cost = `${half} ${(outcome.resumed ? sent.increment : sent.seed).length} chars${contextClause(outcome.context)}`
  if (outcome.forked !== null) return `forked (${outcome.forked}) into ${id} — ${cost}`
  return `${outcome.resumed ? `resumed ${id}` : `new conversation ${id}`} — ${cost}`
}

function contextClause(context: ContextPressure | undefined): string {
  if (context === undefined) return ""
  return `, context ${context.used}/${context.window} (${Math.round((context.used / context.window) * 100)}%)`
}

function writeFile(file: string, body: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, body)
}

// process.stdout/stderr are async on a pipe and process.exit drops what they still hold — every line this entry prints is written to the fd.
function say(fd: 1 | 2, line: string): void {
  writeSync(fd, `${line}\n`)
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null
if (cliEntry === fileURLToPath(import.meta.url)) {
  const { seedFile, incrementFile, replyFile, failureFile, pressureFile, targetRoot, sessionId, maintain } = parseArgs(
    process.argv.slice(2)
  )
  if (maintain) {
    if (!targetRoot || !sessionId) {
      say(2, "error: vivi-turn --maintain requires --target <abs> and --session <chat session>.")
      process.exit(2)
    }
    let outcome: ViviMaintenanceOutcome
    try {
      outcome = runViviMaintenance({ targetRoot: resolve(targetRoot), sessionId })
    } catch (error) {
      say(2, `vivi maintenance failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exit(1)
    }
    say(1, `vivi maintenance: ${outcome}`)
    process.exit(outcome === "undecided" ? 1 : 0)
  }
  if (!seedFile || !incrementFile || !replyFile) {
    say(2, "error: vivi-turn requires --seed-file <abs>, --increment-file <abs> and --reply-file <abs>.")
    process.exit(2)
  }
  for (const file of [seedFile, incrementFile]) {
    if (!existsSync(file)) {
      say(2, `error: prompt file not found: ${file}`)
      process.exit(2)
    }
  }
  // Two channels, one writer each: the reply file carries Vivi's own words and NOTHING else, the failure file the orchestrator's reason.
  const fail = (reason: string): never => {
    if (failureFile) {
      try {
        writeFile(failureFile, reason)
      } catch {}
    }
    say(2, `vivi turn failed: ${reason}`)
    process.exit(1)
  }
  const sent = { seed: readFileSync(seedFile, "utf8"), increment: readFileSync(incrementFile, "utf8") }
  runViviTurn({ seedText: sent.seed, incrementText: sent.increment, targetRoot: targetRoot ? resolve(targetRoot) : undefined, sessionId })
    .then((outcome) => {
      // The measurement the ceiling is watched on rides its own channel: the caller decides, this process only reports what the conversation now holds.
      if (pressureFile && outcome.context !== undefined) {
        try {
          writeFile(pressureFile, JSON.stringify(outcome.context))
        } catch {}
      }
      const reason = legFailureReason(outcome)
      if (reason !== null) fail(reason)
      writeFile(replyFile, outcome.reply)
      say(1, `vivi turn: reply ${outcome.reply.length} chars — ${sessionLine(outcome, sent)}`)
      process.exit(0)
    })
    .catch((error) => {
      fail(`the turn could not run: ${error instanceof Error ? error.message : String(error)}`)
    })
}
