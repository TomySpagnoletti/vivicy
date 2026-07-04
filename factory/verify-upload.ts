#!/usr/bin/env node
// Vivicy S1-import CHECK (G1): the standalone agent leg that verifies a NORMALIZED
// upload corpus before it is placed into a target's .vivicy/. Deterministic
// normalization already ran (lib/upload normalizeStaging wrote <staging>/normalized/);
// this script drives ONE claude leg (role upload-verifier) that reads that corpus,
// checks it for internal contradictions, drift vs any EXISTING .vivicy/canonical
// docs, and confirms normalization preserved intention verbatim — then writes
// <staging>/report.json { verdict, problems, summary }.
//
// It reuses the same leg infrastructure the extractor does (agent-spawn.ts +
// dev-loop.ts helpers), built minimally like extract-issues.ts. Honest failure
// (P1/P3): the script exits 0 ONLY when the report exists with verdict green; if
// the leg dies, times out, or writes nothing usable, the script WRITES a red report
// with the reason and exits non-zero — it never exits 0 without a green report.
//
// Usage: node verify-upload.ts --staging <abs>
//   env VIVICY_TARGET_ROOT   the target project root (for canonical cross-checks;
//                            an empty/absent canonical is fine — then the leg only
//                            checks the corpus's internal consistency).
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg } from "./agent-spawn.ts";
import type { AgentIssue, AgentLeg, LegConfig, LegDeps, LegRunResult } from "./agent-spawn.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";

// The synthetic "issue" the leg runs against — its transcript/identity handle, not
// a product issue (identical role to extract-issues.ts's extractionIssue()).
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

// Where the normalized corpus + report live, plus the target for drift checks; the
// leg the spawnVerifier seam runs against.
interface VerifierArgs {
  stagingDir: string;
  normalizedDir: string;
  reportPath: string;
  targetRoot: string | null;
  cfg: LegConfig;
}

// The verifyUpload options: the staging inputs and the injectable seams (each
// defaults to the real tooling).
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

/**
 * Verify a staged upload's normalized corpus with one agent leg, writing
 * <staging>/report.json. Injectable seams (default to the real tooling):
 *   spawnVerifier — the agent leg; writes report.json
 *   readReport    — read the leg's report back (null when missing/unparseable)
 *   writeReport   — persist a report the script authors
 */
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

  // The leg writes report.json itself; clear any stale one first so a dead leg is
  // read as "no report" (=> red), never a leftover green from a prior run.
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

  // Honest failure: a timed-out/killed leg authors no usable report. If the leg
  // reports a timeout (leg-timeout.ts sets result.timedOut) OR no report exists,
  // WRITE a red report naming the reason — never exit 0 without a green report.
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
    // A missing/unparseable report, or a red one, stays red. If the leg wrote
    // nothing at all, synthesize a red report so the caller always has one.
    const finalReport = report ?? redReport(
      `upload-verifier wrote no report at ${reportPath}`,
      "no_report",
    );
    if (!report) writeReport({ reportPath, report: finalReport });
    return { verdict: "red", report: finalReport, transcriptRel: leg?.transcriptRel };
  }

  return { verdict: "green", report, transcriptRel: leg?.transcriptRel };
}

// A red report the SCRIPT authors when the agent leg could not produce one — so
// there is always a report on disk, and it is never a false green.
function redReport(summary: string, kind: string): Report {
  return { verdict: "red", problems: [{ file: "*", kind, detail: summary }], summary };
}

// Build the real verifier seam: drive the IMPLEMENTER-role CLI (Claude by default)
// with the upload-verifier prompt, re-roled to "upload-verifier". The leg runs
// inside the TARGET repo so it can read EXISTING .vivicy/canonical docs for drift
// cross-checks; the normalized corpus + the report path it must write are injected
// via the appended prompt context.
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
    // execRoot is the TARGET repo (so canonical cross-checks resolve); the corpus +
    // report live under the staging dir, given to the leg by absolute path.
    const execRoot = targetRoot ?? stagingDir;
    const legCfg = { ...cfg, promptsDir, execRoot };
    const issue = verifyIssue();
    const context = verifierContext({ normalizedDir, reportPath, targetRoot });
    const deps = legDepsForTarget(legCfg, issue, execRoot, context);
    return runClaudeLeg(leg, issue, legCfg, deps);
  };
}

// The synthetic issue the leg runs against (transcript + actor/role identity handle).
function verifyIssue(): AgentIssue {
  return { id: VERIFY_ISSUE_ID, graph_refs: ["node:upload-verify"], path: "report.json" };
}

// Extra prompt context for the upload-verifier leg: where the normalized corpus is,
// where the existing canonical is (for drift), and the ABSOLUTE report path to write.
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

// Bind the shared leg runner to the exec repo's roots, appending the run-specific
// prompt context onto the role prompt (same wrapping extract-issues.ts uses).
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

// Read the leg's structured report. A missing or unparseable file is NOT green:
// return null so the caller writes/keeps a red report (never a silent pass).
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

// Persist a report the SCRIPT authors (honest-failure path). The leg writes its own
// report directly; this is only for the reasons the leg could not.
function defaultWriteReport({ reportPath, report }: { reportPath: string; report: Report }): void {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

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
