#!/usr/bin/env node
// End-to-end rehearsal of the development method against an isolated fake project
// (Pocket Ledger). It exercises the WHOLE chain with the REAL tooling: freeze ->
// baseline verify -> semantic-extraction check -> viewer-data generation -> the
// two-agent dev loop (Claude implementer + Codex reviewer) -> gate -> done/ ->
// progress ledger -> regenerated viewer data showing each issue verified and
// linked to its transcript.
//
// Self-contained: this is Vivicy's OWN self-test. The fixture and role prompts are
// bundled in factory/ (factory/rehearsal/pocket-ledger, factory/prompts); the
// fixture is copied into a throwaway temp git repo and the root-aware tools are
// pointed at it via VIVICY_TARGET_ROOT. No target/host project is read or written
// (the only output beyond the temp repo is the report under factory/rehearsal/).
//
// Modes:
//   node factory/dev-rehearsal.mjs            run the real two-agent loop
//   node factory/dev-rehearsal.mjs --dry      validate the harness with fake agents
//   REHEARSAL_KEEP=1 ...                      keep the temp repo for inspection
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FACTORY_REHEARSAL_DIR } from "./target-root.mjs";

const factoryDir = dirname(fileURLToPath(import.meta.url));
// The rehearsal is Vivicy's OWN self-test: the fixture, the role prompts, and the
// report all live inside the factory bundle — it is fully self-contained and does
// NOT read from or write to any target/host project. The factory scripts it drives
// are this dir's own siblings; the isolated temp repo it materializes is the only
// project ever written to.
const fixtureDir = join(FACTORY_REHEARSAL_DIR, "pocket-ledger");
const reportPath = join(FACTORY_REHEARSAL_DIR, "reports/method-rehearsal-report.md");
const BASELINE_ID = "baseline-v1.0.0";
const MANIFEST_REL = `docs/baselines/${BASELINE_ID}.json`;
// Absolute path to a sibling factory script (the rehearsal runs them as children).
const factoryScript = (name) => join(factoryDir, name);

const stages = [];
function record(name, ok, detail = "") {
  stages.push({ name, ok, detail });
  process.stdout.write(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}
function sh(args, env) {
  // Run each driven factory script with the isolated temp repo as its cwd (and as
  // its VIVICY_TARGET_ROOT). The rehearsal never touches a host/target project.
  const cwd = env?.VIVICY_TARGET_ROOT ?? factoryDir;
  return spawnSync("node", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8" });
}
function lastLine(result) {
  return (result.stdout || result.stderr || "").trim().split("\n").pop() ?? "";
}
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Fake agents for --dry: write a minimal transcript and let the real gate run.
function dryImplementer(temp) {
  return (issue) => writeFakeTranscript(temp, issue, "claude-implementer");
}
function dryReviewer(temp) {
  return (issue) => writeFakeTranscript(temp, issue, "codex-reviewer");
}
function writeFakeTranscript(temp, issue, who) {
  const rel = `spec/development/transcripts/${issue.id}/${who}-dry.jsonl`;
  const abs = join(temp, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ type: "assistant", message: { content: `dry ${who} for ${issue.id}` } })}\n`);
  return { transcriptRel: rel };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const keep = process.env.REHEARSAL_KEEP === "1";
  // REHEARSAL_DIR pins a persistent workspace so a run killed mid-way (e.g. a
  // background-task lifetime limit) RESUMES on relaunch: the dev loop already
  // resumes from done/ + the ledger, so only the unfinished issues re-run.
  const fixedDir = process.env.REHEARSAL_DIR ? resolve(process.env.REHEARSAL_DIR) : null;

  // 1. Materialize (or resume) an isolated git repo from the bundled fixture. The
  //    role prompts are NOT copied in: the dev loop reads them from the factory
  //    bundle, so the target only ever holds the dev OUTPUT (issues/ledger/gates/
  //    done), exactly like a real standalone run against an arbitrary project.
  const git = (a, cwd) => spawnSync("git", a, { cwd, encoding: "utf8" });
  let temp;
  if (fixedDir && existsSync(join(fixedDir, ".git"))) {
    temp = fixedDir;
    const done = existsSync(join(temp, "spec/development/issues/done"))
      ? readdirSync(join(temp, "spec/development/issues/done")).filter((f) => f.endsWith(".md")).length
      : 0;
    record("resume isolated temp repo", true, `${temp} (${done} issue(s) already done)`);
  } else {
    temp = fixedDir ?? mkdtempSync(join(tmpdir(), "vivicy-rehearsal-"));
    if (fixedDir) mkdirSync(fixedDir, { recursive: true });
    cpSync(fixtureDir, temp, { recursive: true });
    git(["init", "-q"], temp);
    git(["add", "-A"], temp);
    git(["-c", "user.email=rehearsal@local", "-c", "user.name=rehearsal", "commit", "-qm", "rehearsal fixture"], temp);
    record("materialize isolated temp repo", existsSync(join(temp, ".git")), temp);
  }

  const env = { VIVICY_TARGET_ROOT: temp };

  // 2. Baseline freeze verification.
  let r = sh([factoryScript("doc-baseline.mjs"), "verify", "--manifest", MANIFEST_REL, "--require-status", "frozen", "--require-baseline-id", BASELINE_ID], env);
  record("doc-baseline verify (frozen)", r.status === 0, lastLine(r));

  // 3. Semantic extraction check: full line coverage, references resolve.
  r = sh([factoryScript("semantic-extraction-check.mjs")], env);
  const uncovered = /(\d+) UNCOVERED/.exec(r.stdout || "")?.[1];
  record("semantic-extraction:check (0 uncovered)", r.status === 0 && uncovered === "0", lastLine(r));

  // 3b. Traceability check: every issue requirement resolves; MVP reqs covered.
  r = sh([factoryScript("traceability-check.mjs")], env);
  record("traceability:check", r.status === 0, lastLine(r));

  // 4. Viewer data generation (pre-loop): every issue resolves to the graph.
  r = sh([factoryScript("generate-viewer-data.ts")], env);
  const preData = generatedData(temp);
  record("generate-viewer-data (pre-loop)", r.status === 0 && (preData?.development?.issues?.length ?? 0) > 0, `${preData?.development?.issues?.length ?? 0} issue(s)`);

  // 5. The two-agent dev loop (Claude implementer + Codex reviewer). Dynamic
  //    import AFTER setting the env so dev-loop binds repoRoot to the temp repo.
  process.env.VIVICY_TARGET_ROOT = temp;
  const devloop = await import(pathToFileURL(factoryScript("dev-loop.mjs")).href);
  const steps = dry ? { runImplementer: dryImplementer(temp), runReviewer: dryReviewer(temp) } : {};
  let processed = [];
  try {
    processed = devloop.runLoop({ defaultGateCommand: "npm test" }, steps);
  } catch (error) {
    record("dev-loop two-agent run", false, String(error?.message ?? error));
  }
  const verified = processed.filter((p) => p.status === "verified").map((p) => p.id);
  const blocked = processed.filter((p) => p.status === "blocked").map((p) => p.id);
  const totalIssues = preData?.development?.issues?.length ?? 0;
  // Cumulative completion (resume-safe): count issues in done/, not just this
  // run's processed set — a resumed run only processes the unfinished issues.
  const doneDir = join(temp, "spec/development/issues/done");
  const doneCount = existsSync(doneDir) ? readdirSync(doneDir).filter((f) => f.endsWith(".md")).length : 0;
  record(
    `dev-loop ${dry ? "(dry agents)" : "two-agent"} run`,
    doneCount === totalIssues && blocked.length === 0,
    `${doneCount}/${totalIssues} done (this run +${verified.length}${blocked.length ? `, blocked ${blocked.join(",")}` : ""})`,
  );

  // Guard: the temp workspace must survive the run. If it vanished mid-run (e.g.
  // an external process cleaning the OS temp dir), fail clearly instead of a raw
  // ENOENT stack trace, and never run the rehearsal with another process touching
  // the OS temp directory.
  if (!existsSync(join(temp, "spec/development/progress-ledger.json"))) {
    record("temp workspace survived the run", false, "workspace vanished mid-run — re-run with no concurrent process touching the OS temp dir");
    writeReport({ dry, temp, processed, verified, blocked, totalIssues, doneCount: 0, verifiedStates: 0, passingGates: 0 });
    process.stdout.write("\nREHEARSAL FAILED (workspace vanished)\n");
    process.exit(1);
  }

  // 6. Ledger verification + gate evidence assertions (done/ counted above).
  record("issues moved to done/", doneCount === totalIssues, `${doneCount}/${totalIssues} in done/`);

  const ledger = readJson(join(temp, "spec/development/progress-ledger.json"));
  const verifiedStates = (ledger.graph_item_states ?? []).filter((s) => s.status === "verified");
  const withTranscripts = verifiedStates.filter((s) => Array.isArray(s.transcript_refs) && s.transcript_refs.length > 0);
  record("ledger: graph items verified with transcript refs", verifiedStates.length > 0 && withTranscripts.length === verifiedStates.length, `${verifiedStates.length} verified, ${withTranscripts.length} with transcripts`);

  const gatesDir = join(temp, "spec/development/gates");
  const gateRecords = existsSync(gatesDir) ? readdirSync(gatesDir).filter((f) => f.endsWith(".json")) : [];
  const passingGates = gateRecords.filter((f) => readJson(join(gatesDir, f)).status === "pass").length;
  record("gate-run evidence records (pass)", passingGates === totalIssues, `${passingGates}/${totalIssues} passing`);

  // 7. Viewer data generation (post-loop): issues show verified + transcripts.
  r = sh([factoryScript("generate-viewer-data.ts")], env);
  const postData = generatedData(temp);
  const postVerified = (postData?.development?.graph_item_states ?? []).filter((s) => s.status === "verified").length;
  record("generate-viewer-data (post-loop, verified overlay)", r.status === 0 && postVerified > 0, `${postVerified} verified graph item(s)`);

  // 8. Write the rehearsal report (the deliverable evidence) to the real repo.
  writeReport({ dry, temp, processed, verified, blocked, totalIssues, doneCount, verifiedStates: verifiedStates.length, passingGates });
  record("write method-rehearsal-report.md", existsSync(reportPath), reportPath);

  const allPass = stages.every((s) => s.ok);
  process.stdout.write(`\n${allPass ? "REHEARSAL PASSED" : "REHEARSAL FAILED"} (${stages.filter((s) => s.ok).length}/${stages.length} stages)\n`);
  // Never delete a pinned (REHEARSAL_DIR) workspace: it is the resume point.
  if (keep || !allPass || fixedDir) {
    process.stdout.write(`temp repo kept${fixedDir ? " (pinned)" : ""}: ${temp}\n`);
  } else {
    rmSync(temp, { recursive: true, force: true });
  }
  process.exit(allPass ? 0 : 1);
}

function generatedData(temp) {
  const path = join(temp, "docs/architecture-map/viewer/src/architecture-data.json");
  return existsSync(path) ? readJson(path) : null;
}

function writeReport(ctx) {
  mkdirSync(dirname(reportPath), { recursive: true });
  const verdict = stages.every((s) => s.ok) ? "passed" : "failed";
  const rows = stages.map((s) => `| ${s.ok ? "✅" : "❌"} | ${s.name} | ${s.detail.replace(/\|/g, "\\|")} |`).join("\n");
  const body = `# Method Rehearsal Report

Verdict: **${verdict}**${ctx.dry ? " (dry agents — harness validation only)" : " (real two-agent loop)"}

This report records an end-to-end rehearsal of the development method against the
factory-bundled Pocket Ledger fixture (\`factory/rehearsal/pocket-ledger/\`). The
fixture was copied into a throwaway git repo and every tool was driven through
\`VIVICY_TARGET_ROOT\`; the rehearsal is fully self-contained (bundled fixture +
bundled role prompts) and no target/host project was committed to by this run.

## Stages

| | Stage | Detail |
| --- | --- | --- |
${rows}

## Issue outcomes

- total issues: ${ctx.totalIssues}
- verified: ${ctx.verified.length} (${ctx.verified.join(", ") || "none"})
- blocked: ${ctx.blocked.length} (${ctx.blocked.join(", ") || "none"})
- moved to done/: ${ctx.doneCount}
- verified graph items in ledger: ${ctx.verifiedStates}
- passing gate-run records: ${ctx.passingGates}

## Notes

- Mode: ${ctx.dry ? "dry (fake agents; the gate, chain, ledger, and viewer are real)" : "real Claude implementer + Codex reviewer"}.
- Isolation: throwaway temp repo at run time; the committed fixture holds only inputs.
- Gates exercised end to end: baseline freeze + verify, semantic-extraction:check,
  traceability:check, viewer-data generation, the two-agent dev loop, gate-run
  evidence, and the verified progress overlay.
`;
  writeFileSync(reportPath, body);
}

main();
