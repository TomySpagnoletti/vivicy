#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";

const VERIFY_ISSUE_ID = "UPLOAD-VERIFY";

type Verdict = "green" | "red";

interface Problem {
  file: string;
  kind: string;
  detail: string;
}

interface Report {
  verdict: Verdict;
  problems: Problem[];
  summary: string;
}

interface VerifyResult {
  verdict: Verdict;
  report: Report;
  transcriptRel?: string;
}

interface VerifierArgs {
  stagingDir: string;
  normalizedDir: string;
  reportPath: string;
  targetRoot: string | null;
  cfg: LegConfig;
}

interface VerifyOptions {
  stagingDir?: string;
  normalizedDir?: string;
  reportPath?: string;
  targetRoot?: string | null;
  cfg?: Partial<LegConfig>;
  promptsDir?: string;
  spawnVerifier?: (args: VerifierArgs) => Promise<LegRunResult>;
  readReport?: (args: { reportPath: string }) => Report | null;
  writeReport?: (args: { reportPath: string; report: Report }) => void;
}

// Every exit path must either return a green report or write+return a red one — never resolve without a report.json verdict on disk.
export async function verifyUpload(options: VerifyOptions = {}): Promise<VerifyResult> {
  const stagingDir = options.stagingDir;
  if (!stagingDir) {
    throw new Error("verify-upload: no --staging <abs> provided (the staging directory to verify).");
  }
  const normalizedDir = options.normalizedDir ?? join(stagingDir, "normalized");
  const reportPath = options.reportPath ?? join(stagingDir, "report.json");
  const targetRoot = options.targetRoot ?? resolveTargetRoot();
  const cfg = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };

  const legs = resolveAgentLegs(process.env);
  const spawnVerifier = options.spawnVerifier ?? makeDefaultSpawnVerifier(options, cfg, legs);
  const readReport = options.readReport ?? defaultReadReport;
  const writeReport = options.writeReport ?? defaultWriteReport;

  // Clear any stale report first so a dead leg reads as "no report" (red), never a leftover green from a prior run.
  rmSync(reportPath, { force: true });

  let leg: LegRunResult;
  try {
    leg = await spawnVerifier({ stagingDir, normalizedDir, reportPath, targetRoot, cfg });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const report = redReport(`upload-verifier leg failed to run: ${detail}`, "leg_error");
    writeReport({ reportPath, report });
    return { verdict: "red", report };
  }

  if (leg?.result?.timedOut) {
    const report = redReport(
      `upload-verifier leg was killed: ${leg.result.timeoutReason || "leg timed out"}`,
      "leg_timeout",
    );
    writeReport({ reportPath, report });
    return { verdict: "red", report, transcriptRel: leg.transcriptRel };
  }

  const report = readReport({ reportPath });
  if (!report || report.verdict !== "green") {
    const finalReport = report ?? redReport(
      `upload-verifier wrote no report at ${reportPath}`,
      "no_report",
    );
    if (!report) writeReport({ reportPath, report: finalReport });
    return { verdict: "red", report: finalReport, transcriptRel: leg?.transcriptRel };
  }

  return { verdict: "green", report, transcriptRel: leg?.transcriptRel };
}

function redReport(summary: string, kind: string): Report {
  return { verdict: "red", problems: [{ file: "*", kind, detail: summary }], summary };
}

function makeDefaultSpawnVerifier(
  options: VerifyOptions,
  baseCfg: LegConfig,
  legs: { implementer?: AgentLeg; reviewer?: AgentLeg } | undefined,
): (args: VerifierArgs) => Promise<LegRunResult> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const implementer: Omit<AgentLeg, "role"> = legs?.implementer ?? {
    actor: "claude",
    provider: "claude",
    model: CLI_DEFAULTS.claude.model,
    effort: CLI_DEFAULTS.claude.effort,
    fast: false,
  };
  const leg: AgentLeg = { ...implementer, role: "upload-verifier" };
  return async ({ stagingDir, normalizedDir, reportPath, targetRoot, cfg }: VerifierArgs) => {
    // execRoot must be the target repo so canonical cross-checks resolve; corpus/report stay under staging, passed by absolute path.
    const execRoot = targetRoot ?? stagingDir;
    const legCfg = { ...cfg, promptsDir, execRoot };
    const issue = verifyIssue();
    const context = verifierContext({ normalizedDir, reportPath, targetRoot });
    const deps = legDepsForTarget(legCfg, issue, execRoot, context);
    return runClaudeLeg(leg, issue, legCfg, deps);
  };
}

function verifyIssue(): AgentIssue {
  return { id: VERIFY_ISSUE_ID, graph_refs: ["node:upload-verify"], path: "report.json" };
}

function verifierContext({ normalizedDir, reportPath, targetRoot }: { normalizedDir: string; reportPath: string; targetRoot: string | null }): string {
  const canonicalDir = targetRoot ? resolve(targetRoot, ".vivicy/canonical") : null;
  const existingCanonical =
    canonicalDir && existsSync(canonicalDir)
      ? `\`${canonicalDir}\` — read every .md there and check the upload does not DRIFT from or CONTRADICT it.`
      : "(the target has no existing canonical docs yet — check the upload's INTERNAL consistency only.)";
  return (
    `\n\n---\n\n## Upload verification context for this run\n\n` +
    `- Normalized upload corpus to verify: \`${normalizedDir}\`. Read EVERY file under it.\n` +
    `- Existing target canonical: ${existingCanonical}\n` +
    `- Write your STRUCTURED verdict — and nothing else — to \`${reportPath}\`, as JSON ` +
    `\`{ "verdict": "green"|"red", "problems": [{ "file": string, "kind": string, "detail": string }], "summary": string }\`. ` +
    `Do NOT edit ANY file — you report; you never modify the corpus or the canonical.\n`
  );
}

function legDepsForTarget(legCfg: LegConfig, issue: AgentIssue, execRoot: string, context: string): LegDeps {
  const abs = (rel: string) => resolve(execRoot, rel);
  return {
    composePrompt: (template: string, iss: AgentIssue) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir}/${issue.id}`),
    cwdFilter: null,
  };
}

function defaultReadReport({ reportPath }: { reportPath: string }): Report | null {
  if (!existsSync(reportPath)) return null;
  let parsed: { verdict?: unknown; problems?: unknown; summary?: unknown };
  try {
    parsed = JSON.parse(readFileSync(reportPath, "utf8")) as { verdict?: unknown; problems?: unknown; summary?: unknown };
  } catch {
    return null;
  }
  const verdict = parsed?.verdict === "green" ? "green" : "red";
  const problems = Array.isArray(parsed?.problems) ? parsed.problems : [];
  const summary = typeof parsed?.summary === "string" ? parsed.summary : "";
  return { verdict, problems, summary };
}

function defaultWriteReport({ reportPath, report }: { reportPath: string; report: Report }): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(argv: string[]): { stagingDir?: string } {
  const out: { stagingDir?: string } = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--staging") out.stagingDir = argv[i + 1];
  }
  return out;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const { stagingDir } = parseArgs(process.argv.slice(2));
  if (!stagingDir) {
    console.error("error: verify-upload requires --staging <abs> (the staging directory to verify).");
    process.exit(2);
  }
  verifyUpload({ stagingDir: resolve(stagingDir) })
    .then((result) => {
      console.log(`upload verification: ${result.verdict} — ${result.report?.summary ?? ""}`);
      process.exit(result.verdict === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
