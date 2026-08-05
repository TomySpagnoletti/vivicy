#!/usr/bin/env node
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { readPrompt, runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts"
import type { AgentIssue, AgentLeg, LegConfig, LegRunResult } from "./agent-spawn.ts"
import type { LegResult } from "./leg-timeout.ts"
import { legDepsForVerbatimPrompt } from "./leg-deps.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import { openViviSidecar, runViviLegSession, stableCwd } from "./vivi-session.ts"
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
  promptText?: string
  targetRoot?: string | null
  sessionId?: string
  cfg?: Partial<LegConfig>
  spawnVivi?: (args: ViviSpawnArgs) => Promise<LegRunResult>
}

export interface ViviTurnOutcome {
  reply: string
  status: number | null
  stderr: string
  transcriptRel?: string
  cliSessionId?: string
  usage?: Record<string, unknown>
  forked: ViviForkReason | null
  resumed: boolean
}

type SpokenTurn = Omit<ViviTurnOutcome, "forked" | "resumed">

export async function runViviTurn(options: ViviTurnOptions = {}): Promise<ViviTurnOutcome> {
  const promptText = options.promptText
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("vivi-turn: no prompt text (pass --prompt-file <abs> with the composed prompt).")
  }
  const targetRoot = options.targetRoot ?? resolveTargetRoot()
  const cfg = { ...DEFAULT_CONFIG, promptsDir: FACTORY_PROMPTS_DIR, execRoot: targetRoot, ...(options.cfg ?? {}) }

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
    spawn: async (resumeSessionId) => {
      const { result, transcriptRel, reply, sessionId, usage } = await spawnVivi({ promptText, targetRoot, cfg, leg, resumeSessionId })
      const turn: SpokenTurn = { reply, status: result.status, stderr: result.stderr, transcriptRel, cliSessionId: sessionId, usage }
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
    ? runCodexLeg(leg, issue, cfg, deps, { resumeSessionId })
    : runClaudeLeg(leg, issue, cfg, deps, { resumeSessionId, jsonReply: true })
}

function viviIssue(): AgentIssue {
  return { id: TRANSCRIPT_DIRS.vivi, transcript_dir: TRANSCRIPT_DIRS.vivi, graph_refs: ["node:vivi-chat"], path: "" }
}

interface ViviTurnArgs {
  promptFile?: string
  replyFile?: string
  failureFile?: string
  targetRoot?: string
  sessionId?: string
}

function parseArgs(argv: string[]): ViviTurnArgs {
  const out: ViviTurnArgs = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--prompt-file") out.promptFile = argv[i + 1]
    else if (argv[i] === "--reply-file") out.replyFile = argv[i + 1]
    else if (argv[i] === "--failure-file") out.failureFile = argv[i + 1]
    else if (argv[i] === "--target") out.targetRoot = argv[i + 1]
    else if (argv[i] === "--session") out.sessionId = argv[i + 1]
  }
  return out
}

// The conversation the turn ran in is the server log's business and never the owner's: a fork is invisible in the chat by contract.
function sessionLine(outcome: ViviTurnOutcome): string {
  const id = outcome.cliSessionId ?? "unrecorded"
  if (outcome.forked !== null) return `forked (${outcome.forked}) into ${id}`
  return outcome.resumed ? `resumed ${id}` : `new conversation ${id}`
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
  const { promptFile, replyFile, failureFile, targetRoot, sessionId } = parseArgs(process.argv.slice(2))
  if (!promptFile || !replyFile) {
    say(2, "error: vivi-turn requires --prompt-file <abs> and --reply-file <abs>.")
    process.exit(2)
  }
  if (!existsSync(promptFile)) {
    say(2, `error: prompt file not found: ${promptFile}`)
    process.exit(2)
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
  const promptText = readFileSync(promptFile, "utf8")
  runViviTurn({ promptText, targetRoot: targetRoot ? resolve(targetRoot) : undefined, sessionId })
    .then((outcome) => {
      const reason = legFailureReason(outcome)
      if (reason !== null) fail(reason)
      writeFile(replyFile, outcome.reply)
      say(1, `vivi turn: reply ${outcome.reply.length} chars — ${sessionLine(outcome)}`)
      process.exit(0)
    })
    .catch((error) => {
      fail(`the turn could not run: ${error instanceof Error ? error.message : String(error)}`)
    })
}
