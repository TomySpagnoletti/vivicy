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

import { readDevStatusFromDisk } from "@/lib/dev-status-fs"
import type { DetachedHandle, RunOptions, RunResult, Spawner } from "@/lib/control"
import { getControlTargetRoot } from "@/lib/control"
import { nodeSpawner } from "@/lib/node-spawner"

const FAKE_PID = 424242

/** Process-lifetime flag tracking whether the fake "supervisor" is alive. */
let fakeAlive = false

function scriptName(args: string[]): string {
  const scriptArg = args.find((a) => a.endsWith(".mjs") || a.endsWith(".ts")) ?? ""
  return scriptArg.split("/").pop() ?? scriptArg
}

export const fakeSpawner: Spawner = {
  spawnDetached(): DetachedHandle {
    fakeAlive = true
    return { pid: FAKE_PID }
  },

  async run({ args }: RunOptions): Promise<RunResult> {
    const name = scriptName(args)
    if (name === "dev-status.mjs") {
      // Read the real demo ledger from disk; overlay liveness from the fake.
      const status = readDevStatusFromDisk(getControlTargetRoot())
      const withLive = { ...status, process_alive: fakeAlive }
      const json = JSON.stringify(withLive, null, 2)
      return { code: 0, lastLine: json.split("\n").at(-1) ?? "", stdout: json, stderr: "" }
    }
    // Extraction / generation steps: report a benign success line.
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
