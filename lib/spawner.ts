/**
 * Server-side spawner selection. Routes call {@link getSpawner} so the dry/test
 * path is a single env switch.
 *
 * `VIVICY_FAKE_SPAWN=1` returns a fake that never launches real claude/codex:
 * `spawnDetached` returns a synthetic pid that {@link fakeSpawner.isAlive}
 * reports alive (until stopped), and `run` resolves a benign status/extract
 * payload from the recorded run-state when present. This lets E2E exercise the
 * full Run -> running -> Stop -> idle -> Extract flow against the real demo
 * ledger without spawning agents.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"

import { readDevStatusFromDisk } from "@/lib/dev-status-fs"
import type { DetachedHandle, RunOptions, RunResult, Spawner } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"
import { getTargetRoot } from "@/lib/target"

const FAKE_PID = 424242

/** Process-lifetime flag tracking whether the fake "supervisor" is alive. */
let fakeAlive = false

function scriptName(args: string[]): string {
  const scriptArg = args.find((a) => a.endsWith(".mjs") || a.endsWith(".ts")) ?? ""
  return scriptArg.split("/").pop() ?? scriptArg
}

/** Write a benign reply to the vivi-turn `--reply-file`, so the dry/E2E chat shows
 *  a response without spawning a real agent (and writes nothing under `.vivicy`). */
function writeFakeViviReply(args: string[]): void {
  const flag = args.indexOf("--reply-file")
  const replyFile = flag >= 0 ? args[flag + 1] : undefined
  if (!replyFile) return
  try {
    mkdirSync(path.dirname(replyFile), { recursive: true })
    writeFileSync(
      replyFile,
      "Vivi is running in dry mode — no agent was spawned this turn. Connect an agent CLI to grill your spec for real."
    )
  } catch {
    // Best-effort: the fake path must never throw and break the demo flow.
  }
}

/** Mirror the green terminal status the extraction orchestrator writes, so the
 *  dry/E2E `runExtract` reads back success without spawning a real agent. */
function writeFakeExtractionStatus(targetRoot: string): void {
  try {
    const file = path.join(targetRoot, ".vivicy/development/reports/extraction-status.json")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(
      file,
      `${JSON.stringify({ phase: "green", summary: "extraction green (fake spawn)" }, null, 2)}\n`
    )
  } catch {
    // Best-effort: the fake path must never throw and break the demo flow.
  }
}

export const fakeSpawner: Spawner = {
  spawnDetached(): DetachedHandle {
    fakeAlive = true
    return { pid: FAKE_PID }
  },

  async run({ args }: RunOptions): Promise<RunResult> {
    const name = scriptName(args)
    // The control plane only reaches a run after resolveContext() has asserted a
    // target, so a null here would be a caller bug; the fake stays inert either way.
    const targetRoot = getTargetRoot()
    if (name === "dev-status.mjs" && targetRoot !== null) {
      // Read the real demo ledger from disk; overlay liveness from the fake.
      const status = readDevStatusFromDisk(targetRoot)
      const withLive = { ...status, process_alive: fakeAlive }
      const json = JSON.stringify(withLive, null, 2)
      return { code: 0, lastLine: json.split("\n").at(-1) ?? "", stdout: json, stderr: "" }
    }
    if (name === "extract-issues.mjs" && targetRoot !== null) {
      // Never launch a real agent in the dry/E2E path: write the green terminal
      // status the orchestrator would emit so runExtract reports success without
      // authoring anything (the demo target is already extracted).
      writeFakeExtractionStatus(targetRoot)
      return { code: 0, lastLine: "extraction green (fake spawn)", stdout: "extraction green (fake spawn)\n", stderr: "" }
    }
    if (name === "vivi-turn.mjs") {
      // Never launch a real agent in the dry/E2E path: write a benign reply to the
      // --reply-file the control plane reads, and touch nothing under .vivicy (a
      // fake turn writes no docs, so the allowlist diff stays clean).
      writeFakeViviReply(args)
      return { code: 0, lastLine: "vivi turn: fake", stdout: "vivi turn: fake\n", stderr: "" }
    }
    // Other generation steps: report a benign success line.
    return {
      code: 0,
      lastLine: `${name}: OK (fake spawn)`,
      stdout: `${name}: OK (fake spawn)\n`,
      stderr: "",
    }
  },

  killGroup(): boolean {
    fakeAlive = false
    return true
  },

  isAlive(pid: number): boolean {
    return pid === FAKE_PID && fakeAlive
  },
}

/** The spawner the route handlers should use for this process. */
export function getSpawner(): Spawner {
  return process.env.VIVICY_FAKE_SPAWN === "1" ? fakeSpawner : nodeSpawner
}
