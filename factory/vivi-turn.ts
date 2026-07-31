#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { runClaudeLeg, runCodexLeg, TRANSCRIPT_DIRS } from "./agent-spawn.ts"
import type { AgentIssue, AgentLeg, LegConfig, LegRunResult } from "./agent-spawn.ts"
import { legDepsForVerbatimPrompt } from "./leg-deps.ts"
import { CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts"
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts"

interface ViviSpawnArgs {
  promptText: string
  targetRoot: string | null
  cfg: LegConfig
  leg: AgentLeg
}

interface ViviTurnOptions {
  promptText?: string
  targetRoot?: string | null
  cfg?: Partial<LegConfig>
  spawnVivi?: (args: ViviSpawnArgs) => Promise<LegRunResult>
}

export async function runViviTurn(options: ViviTurnOptions = {}): Promise<{ reply: string; transcriptRel?: string }> {
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
  const result = await spawnVivi({ promptText, targetRoot, cfg, leg })
  return { reply: (result?.output ?? "").trim(), transcriptRel: result?.transcriptRel }
}

async function defaultSpawnVivi({ promptText, targetRoot, cfg, leg }: ViviSpawnArgs): Promise<LegRunResult> {
  const execRoot = targetRoot
  const issue = viviIssue()
  const deps = legDepsForVerbatimPrompt(execRoot!, promptText)
  return leg.provider === "codex" ? runCodexLeg(leg, issue, cfg, deps) : runClaudeLeg(leg, issue, cfg, deps)
}

function viviIssue(): AgentIssue {
  return { id: TRANSCRIPT_DIRS.vivi, transcript_dir: TRANSCRIPT_DIRS.vivi, graph_refs: ["node:vivi-chat"], path: "" }
}

function parseArgs(argv: string[]): { promptFile?: string; replyFile?: string; targetRoot?: string } {
  const out: { promptFile?: string; replyFile?: string; targetRoot?: string } = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--prompt-file") out.promptFile = argv[i + 1]
    else if (argv[i] === "--reply-file") out.replyFile = argv[i + 1]
    else if (argv[i] === "--target") out.targetRoot = argv[i + 1]
  }
  return out
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null
if (cliEntry === fileURLToPath(import.meta.url)) {
  const { promptFile, replyFile, targetRoot } = parseArgs(process.argv.slice(2))
  if (!promptFile || !replyFile) {
    console.error("error: vivi-turn requires --prompt-file <abs> and --reply-file <abs>.")
    process.exit(2)
  }
  if (!existsSync(promptFile)) {
    console.error(`error: prompt file not found: ${promptFile}`)
    process.exit(2)
  }
  const promptText = readFileSync(promptFile, "utf8")
  runViviTurn({ promptText, targetRoot: targetRoot ? resolve(targetRoot) : undefined })
    .then((result) => {
      mkdirSync(dirname(replyFile), { recursive: true })
      writeFileSync(replyFile, result.reply)
      console.log(`vivi turn: reply ${result.reply.length} chars`)
      process.exit(0)
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      try {
        mkdirSync(dirname(replyFile), { recursive: true })
        writeFileSync(replyFile, `Vivi hit an error this turn: ${message}`)
      } catch {}
      console.error(`error: ${message}`)
      process.exit(1)
    })
}
