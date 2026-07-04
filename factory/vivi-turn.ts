#!/usr/bin/env node
// Vivi turn runner (G2, S1-chat): the standalone agent leg for ONE turn of the
// spec-building conversation. The control plane (lib/vivi.ts) owns the policy — the
// per-session transcript, the bounded prompt composition, and the STRUCTURAL
// allowlist enforcement (snapshot/diff/restore of .vivicy). This script is the thin
// impure leg: read the fully-composed prompt from --prompt-file, drive the
// configured IMPLEMENTER-role CLI (Claude or Codex — Vivi's engine) inside the
// TARGET repo so the agent can write .md files there, and write its textual reply to
// --reply-file for the control plane to capture.
//
// It reuses the SAME leg infrastructure the extractor and the upload verifier use
// (agent-spawn.ts + dev-loop.ts helpers), so the model/effort/fast flag policy and
// the transcript capture are defined ONCE and never diverge. It reads those helpers;
// it does not modify them.
//
// Usage: node vivi-turn.ts --prompt-file <abs> --reply-file <abs> --target <abs>
//   env VIVICY_IMPLEMENTER_CLI / VIVICY_CLAUDE_* / VIVICY_CODEX_* (from settings) —
//       which CLI is Vivi's engine and its model/thinking level/fast flag.
//   env VIVICY_SPEC_FROZEN ("true"/"false") — the phase the control plane detected.
//       It also rides inside the composed --prompt-file (as `spec_frozen: <bool>`), which
//       is what the persona reads; the env var carries the same fact to the leg so the
//       phase is observable here, and travels intact to the agent's process environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";

// The synthetic "issue" the leg runs against — its transcript/identity handle, not a
// product issue (same role as extract-issues.ts's extractionIssue / verify's).
const VIVI_ISSUE_ID = "VIVI-CHAT";

// What defaultSpawnVivi (or an injected seam) receives to run the leg.
interface ViviSpawnArgs {
  promptText: string;
  targetRoot: string | null;
  cfg: LegConfig;
  leg: AgentLeg;
}

// runViviTurn options: the composed prompt + target, and the injectable leg seam.
interface ViviTurnOptions {
  promptText?: string;
  targetRoot?: string | null;
  cfg?: Partial<LegConfig>;
  spawnVivi?: (args: ViviSpawnArgs) => Promise<LegRunResult>;
}

/**
 * Run one Vivi turn. Injectable seam (defaults to the real leg tooling):
 *   spawnVivi — drives Vivi's engine CLI and captures the transcript.
 */
export async function runViviTurn(options: ViviTurnOptions = {}): Promise<{ reply: string; transcriptRel?: string }> {
  const promptText = options.promptText;
  if (typeof promptText !== "string" || promptText.length === 0) {
    throw new Error("vivi-turn: no prompt text (pass --prompt-file <abs> with the composed prompt).");
  }
  const targetRoot = options.targetRoot ?? resolveTargetRoot();
  const cfg = { ...DEFAULT_CONFIG, promptsDir: FACTORY_PROMPTS_DIR, execRoot: targetRoot, ...(options.cfg ?? {}) };

  // Vivi's engine is the IMPLEMENTER-role CLI, re-roled to "vivi" so the transcript
  // is named for the persona (and its bundled prompt resolves).
  const legs = resolveAgentLegs(process.env);
  const implementer: Omit<AgentLeg, "role"> = legs?.implementer ?? {
    actor: "claude",
    provider: "claude",
    model: CLI_DEFAULTS.claude.model,
    effort: CLI_DEFAULTS.claude.effort,
    fast: false,
  };
  const leg: AgentLeg = { ...implementer, role: "vivi" };

  const spawnVivi = options.spawnVivi ?? defaultSpawnVivi;
  const result = await spawnVivi({ promptText, targetRoot, cfg, leg });
  return { reply: (result?.output ?? "").trim(), transcriptRel: result?.transcriptRel };
}

// The real leg seam: drive Vivi's engine CLI with the FULLY-COMPOSED prompt as the
// leg's prompt (lib/vivi.ts already assembled persona + transcript + .vivicy state),
// running inside the target repo so the agent can write its .md files there.
async function defaultSpawnVivi({ promptText, targetRoot, cfg, leg }: ViviSpawnArgs): Promise<LegRunResult> {
  const execRoot = targetRoot;
  const issue = viviIssue();
  const deps = legDepsForTarget(cfg, issue, execRoot!, promptText);
  // The provider decides which CLI runner; both preserve identical capture shape.
  return leg.provider === "codex"
    ? runCodexLeg(leg, issue, cfg, deps)
    : runClaudeLeg(leg, issue, cfg, deps);
}

// The synthetic issue the leg runs against (transcript + actor/role identity handle).
function viviIssue(): AgentIssue {
  return { id: VIVI_ISSUE_ID, graph_refs: ["node:vivi-chat"], path: "" };
}

// Bind the shared leg runner to the target repo. composePrompt IGNORES the role
// template and returns the already-composed prompt verbatim — lib/vivi.ts owns the
// full prompt (persona + transcript + state); the leg only executes it.
function legDepsForTarget(legCfg: LegConfig, issue: AgentIssue, execRoot: string, promptText: string): LegDeps {
  const abs = (rel: string) => resolve(execRoot, rel);
  return {
    composePrompt: () => promptText,
    agentCliArgs,
    abs,
    execRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir}/${issue.id}`),
    cwdFilter: null,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { promptFile?: string; replyFile?: string; targetRoot?: string } {
  const out: { promptFile?: string; replyFile?: string; targetRoot?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--prompt-file") out.promptFile = argv[i + 1];
    else if (argv[i] === "--reply-file") out.replyFile = argv[i + 1];
    else if (argv[i] === "--target") out.targetRoot = argv[i + 1];
  }
  return out;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const { promptFile, replyFile, targetRoot } = parseArgs(process.argv.slice(2));
  if (!promptFile || !replyFile) {
    console.error("error: vivi-turn requires --prompt-file <abs> and --reply-file <abs>.");
    process.exit(2);
  }
  if (!existsSync(promptFile)) {
    console.error(`error: prompt file not found: ${promptFile}`);
    process.exit(2);
  }
  const promptText = readFileSync(promptFile, "utf8");
  runViviTurn({ promptText, targetRoot: targetRoot ? resolve(targetRoot) : undefined })
    .then((result) => {
      mkdirSync(dirname(replyFile), { recursive: true });
      writeFileSync(replyFile, result.reply);
      // Echo a short line for the supervisor log; the reply file is authoritative.
      console.log(`vivi turn: reply ${result.reply.length} chars`);
      process.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      // Honest failure: write the reason to the reply file so the user sees SOMETHING.
      try {
        mkdirSync(dirname(replyFile), { recursive: true });
        writeFileSync(replyFile, `Vivi hit an error this turn: ${message}`);
      } catch {
        // best-effort
      }
      console.error(`error: ${message}`);
      process.exit(1);
    });
}
