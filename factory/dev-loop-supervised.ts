#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findFrozenManifest } from "./extract-issues.ts";
import { SKILLS_REPORT_REL } from "./install-skills.ts";
import { notify } from "./notify.ts";
import { resolveTargetRoot } from "./target-root.ts";
import { ACCEPTANCE_REPORT_FILE } from "../lib/acceptance-report.ts";
import { RETRO_REPORT_FILE } from "../lib/retro-report.ts";

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

export function skillsStageNeeded(
  baseline: { baselineId: string } | null,
  report: { phase?: unknown; baseline_id?: unknown } | null,
): boolean {
  if (!baseline) return false;
  if (!report) return true;
  const settled = report.phase === "green" || report.phase === "skipped";
  return !settled || report.baseline_id !== baseline.baselineId;
}

type SupervisorNotifyLevel = "info" | "success" | "warning" | "error";
interface SupervisorNotification {
  level: SupervisorNotifyLevel;
  stage: string;
  event: string;
  message: string;
}

// The acceptance-not-green exit maps to null on purpose: acceptance.ts already emits its own SA notification for that moment, so mapping it here would double it.
export function supervisorTerminalNotification(
  action: SupervisorAction,
  { done, total, blocked }: { done: number; total: number; blocked: number },
): SupervisorNotification | null {
  const progress = `${done}/${total} delivered`;
  switch (action) {
    case "done":
      return {
        level: "success",
        stage: "S12",
        event: "run_finished",
        message: `build complete — all ${total} issue(s) delivered and whole-product acceptance passed; your project is ready`,
      };
    case "blocked":
      return {
        level: "error",
        stage: "S12",
        event: "run_blocked",
        message: `build halted — ${blocked} issue(s) blocked (${progress}); open the blocked report or ask Vivi to get it moving`,
      };
    case "stalled":
      return {
        level: "error",
        stage: "S12",
        event: "run_stalled",
        message: `build halted — no progress across repeated relaunches (${progress}); ask Vivi to diagnose the stall`,
      };
    case "max_relaunches":
      return {
        level: "error",
        stage: "S12",
        event: "run_max_relaunches",
        message: `build halted — reached the relaunch ceiling (${progress}); ask Vivi to diagnose`,
      };
    default:
      return null;
  }
}

// Any outcome other than a written "green" report (explicit "findings"/"failed", a crashed child, a missing report) withholds Done loudly — never a silent success.
function runAcceptanceStage(scriptDir: string, repoRoot: string): "green" | "findings" | "failed" {
  process.stdout.write("supervisor: running the whole-product acceptance stage (acceptance.ts)\n");
  spawnSync("node", [join(scriptDir, "acceptance.ts")], { cwd: repoRoot, stdio: "inherit", env: process.env });
  let phase: unknown;
  try {
    phase = (JSON.parse(readFileSync(join(repoRoot, ACCEPTANCE_REPORT_FILE), "utf8")) as { phase?: unknown }).phase;
  } catch {
    phase = undefined;
  }
  if (phase === "green") return "green";
  if (phase === "findings") return "findings";
  return "failed";
}

// Observability-class, runs AFTER acceptance green: retro NEVER blocks the close — its outcome is a loud note, never an exit signal.
function runRetroStage(scriptDir: string, repoRoot: string): void {
  process.stdout.write("supervisor: running the post-cycle retro stage (retro.ts) — observability, never blocks the close\n");
  spawnSync("node", [join(scriptDir, "retro.ts")], { cwd: repoRoot, stdio: "inherit", env: process.env });
  let phase: unknown;
  try {
    phase = (JSON.parse(readFileSync(join(repoRoot, RETRO_REPORT_FILE), "utf8")) as { phase?: unknown }).phase;
  } catch {
    phase = undefined;
  }
  const note =
    phase === "proposals" ? "method amendments proposed for the owner to decide"
    : phase === "quiet" ? "no recurring failure classes this cycle"
    : "retro did not complete (non-blocking; see the report)";
  process.stdout.write(`supervisor: retro ${String(phase ?? "failed")} — ${note}; the cycle close is not affected\n`);
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
  const target = join(scriptDir, rehearsal ? "dev-rehearsal.ts" : "dev-loop.ts");
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
      if (action === "done" && !rehearsal) {
        const outcome = runAcceptanceStage(scriptDir, repoRoot);
        if (outcome !== "green") {
          writeState({ status: `acceptance_${outcome}`, attempt, done, total, blocked });
          process.stdout.write(`supervisor: acceptance ${outcome} — Done withheld (done ${done}/${total}); see ${ACCEPTANCE_REPORT_FILE}\n`);
          process.exit(1);
        }
        runRetroStage(scriptDir, repoRoot);
      }
      writeState({ status: action, attempt, done, total, blocked });
      const terminal = supervisorTerminalNotification(action, { done, total, blocked });
      if (terminal) notify(terminal);
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
