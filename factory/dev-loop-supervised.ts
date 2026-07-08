#!/usr/bin/env node
// Supervisor that lets a resumable dev-loop run survive multi-hour work. It
// relaunches the loop whenever its process dies for any reason (the loop resumes
// from done/ + the ledger), and stops cleanly on:
//   - all issues done,
//   - a hard block (an *-blocked.json report), for a human,
//   - a no-progress stall (no new done/ across N consecutive relaunches),
//   - a relaunch cap.
// It writes a heartbeat run-state file so `vivicy status` and any agent can
// see liveness across relaunches.
//
// Launch it DETACHED so it outlives the launching shell/task (this is what kept
// killing single-process runs — the parent task was killed, taking the loop):
//   nohup node vivicy/factory/dev-loop-supervised.ts > /tmp/vivicy-dev-loop.log 2>&1 &
//   vivicy status                 # progress anytime
// Stop it via the pid recorded in the run-state file.
//
// Modes: default supervises the real dev-loop.ts against the target project.
// With --rehearsal it supervises dev-rehearsal.ts against REHEARSAL_DIR.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findFrozenManifest } from "./extract-issues.ts";
import { SKILLS_REPORT_REL } from "./install-skills.ts";
import { resolveTargetRoot } from "./target-root.ts";

const STALL_LIMIT = Number(process.env.DEV_LOOP_STALL_LIMIT ?? "3");
const MAX_RELAUNCHES = Number(process.env.DEV_LOOP_MAX_RELAUNCHES ?? "200");

type SupervisorAction = "done" | "blocked" | "max_relaunches" | "stalled" | "relaunch";

interface SupervisorState {
  done: number;
  total: number;
  blocked: number;
  attempt: number;
  stall: number;
}

interface SupervisorLimits {
  stallLimit?: number;
  maxRelaunches?: number;
}

// Pure decision: given the observed run state, what should the supervisor do?
// Exported so the policy is unit-tested without spawning anything.
export function nextSupervisorAction(
  { done, total, blocked, attempt, stall }: SupervisorState,
  limits: SupervisorLimits = {},
): { action: SupervisorAction } {
  const stallLimit = limits.stallLimit ?? STALL_LIMIT;
  const maxRelaunches = limits.maxRelaunches ?? MAX_RELAUNCHES;
  if (total > 0 && done >= total) return { action: "done" };
  if (blocked > 0) return { action: "blocked" };
  if (attempt >= maxRelaunches) return { action: "max_relaunches" };
  if (stall >= stallLimit) return { action: "stalled" };
  return { action: "relaunch" };
}

// Pure decision: does the project-skills stage (install-skills.ts, AUTO mode) need to
// run before issue cycles start? Yes when a frozen baseline exists and the skills
// report is missing, unsettled, or was produced for a DIFFERENT baseline. No baseline
// means extraction has not run yet — the stage has nothing to select from.
export function skillsStageNeeded(
  baseline: { baselineId: string } | null,
  report: { phase?: unknown; baseline_id?: unknown } | null,
): boolean {
  if (!baseline) return false;
  if (!report) return true;
  const settled = report.phase === "green" || report.phase === "skipped";
  return !settled || report.baseline_id !== baseline.baselineId;
}

function main() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project Vivicy should build.",
    );
    process.exit(2);
  }
  const rehearsal = process.argv.includes("--rehearsal");
  // The supervised child is a sibling factory script; resolve it by absolute
  // path so the supervisor works regardless of cwd or where the target lives.
  const target = join(scriptDir, rehearsal ? "dev-rehearsal.ts" : "dev-loop.ts");
  // Where progress lives: the rehearsal writes into REHEARSAL_DIR; the real loop
  // into the target project (VIVICY_TARGET_ROOT).
  const progressRoot = rehearsal && process.env.REHEARSAL_DIR ? resolve(process.env.REHEARSAL_DIR) : repoRoot;
  const statePath = join(repoRoot, ".vivicy/development/reports/dev-loop-supervisor.json");

  const readJson = (p: string, fb: unknown): unknown => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return fb;
    }
  };
  const count = (rel: string, suffix: string): number => {
    const dir = join(progressRoot, rel);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(suffix)).length : 0;
  };
  const doneCount = () => count(".vivicy/development/issues/done", ".md");
  const blockedCount = () => count(".vivicy/development/reports", "-blocked.json");
  const totalIssues = () => {
    const index = readJson(join(progressRoot, ".vivicy/development/issue-index.json"), { issues: [] }) as {
      issues?: unknown;
    };
    return Array.isArray(index.issues) ? index.issues.length : 0;
  };
  const writeState = (extra: Record<string, unknown>): void => {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, `${JSON.stringify({ pid: process.pid, target, progress_root: progressRoot, updated_at: new Date().toISOString(), ...extra }, null, 2)}\n`);
  };

  // Project-skills stage (S-K), before issue cycles: bounded synchronous run of
  // install-skills.ts in AUTO mode when the report is missing or stale for the active
  // baseline. NON-FATAL by design: a red skills stage is loud (its own report +
  // notifications) but never blocks the dev loop — zero skills is legal, and the stage
  // stays retryable on the next supervised start. Skipped in rehearsal (the fixture
  // exercises the loop, not the registry).
  if (!rehearsal) {
    const skillsReport = readJson(join(repoRoot, SKILLS_REPORT_REL), null) as { phase?: unknown; baseline_id?: unknown } | null;
    if (skillsStageNeeded(findFrozenManifest(repoRoot), skillsReport)) {
      process.stdout.write("supervisor: running the project-skills stage (install-skills.ts, auto mode)\n");
      const skills = spawnSync("node", [join(scriptDir, "install-skills.ts")], { cwd: repoRoot, stdio: "inherit", env: process.env });
      if ((skills.status ?? 1) !== 0) {
        process.stdout.write("supervisor: skills stage did not go green (non-fatal, retryable on next start); the dev loop proceeds\n");
      }
    }
  }

  const total = totalIssues();
  let attempt = 0;
  let lastDone = -1;
  let stall = 0;
  for (;;) {
    const done = doneCount();
    const blocked = blockedCount();
    stall = done === lastDone ? stall + 1 : 0;
    lastDone = done;
    const { action } = nextSupervisorAction({ done, total, blocked, attempt, stall });
    if (action !== "relaunch") {
      writeState({ status: action, attempt, done, total, blocked });
      const ok = action === "done";
      process.stdout.write(`supervisor: ${action} (done ${done}/${total}, blocked ${blocked}, attempts ${attempt})\n`);
      process.exit(ok ? 0 : 1);
    }
    attempt += 1;
    writeState({ status: "running", attempt, done, total, blocked, child_started_at: new Date().toISOString() });
    process.stdout.write(`supervisor: launch #${attempt} of ${target} (done ${done}/${total})\n`);
    const res = spawnSync("node", [target], { cwd: repoRoot, stdio: "inherit", env: process.env });
    process.stdout.write(`supervisor: child exited code=${res.status ?? "null"} signal=${res.signal ?? "none"}\n`);
  }
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) main();
