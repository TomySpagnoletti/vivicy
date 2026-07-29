import { resolve } from "node:path"

import type { AgentIssue, LegDeps } from "./agent-spawn.ts"
import { agentCliArgs, composePrompt } from "./dev-loop.ts"

function legDepsRootedAt(repoRoot: string, compose: LegDeps["composePrompt"]): LegDeps {
  return {
    composePrompt: compose,
    agentCliArgs,
    abs: (rel: string) => resolve(repoRoot, rel),
    execRoot: repoRoot,
    cwdFilter: null,
  }
}

export function legDepsForTarget(repoRoot: string, context: string): LegDeps {
  return legDepsRootedAt(repoRoot, (template: string, issue: AgentIssue) => composePrompt(template, issue) + context)
}

export function legDepsForVerbatimPrompt(execRoot: string, promptText: string): LegDeps {
  return legDepsRootedAt(execRoot, () => promptText)
}
