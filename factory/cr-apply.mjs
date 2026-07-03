#!/usr/bin/env node
// Vivicy CR APPLICATION chain (S11 / G7): the docs_applied automation for an APPROVED
// Change Request. Today the sequence "patch canonical -> re-freeze -> re-extract -> reopen impacted issues"
// is run by hand; this module makes it mechanical for a CR in status
// accepted_current_build, honouring the fold rule (§4): the CR ends `docs_applied` and the
// canonical becomes the single consolidated intention (never an old spec + infinite annexes).
//
// It is a STANDALONE factory script (like extract-issues.mjs), so both the CLI (G14) and
// the app route drive it identically through the control plane. Sequence, each step
// recorded to .vivicy/development/reports/cr-apply-<id>.json as it progresses (a `phase`
// field, honest failures — a blocked step leaves the CR accepted_current_build, never a
// half-applied docs_applied):
//
//   (a) APPLY   — one implementer leg (role "cr-applier", prompt cr-applier.md) reads the
//                 CR's decided intent and folds it into .vivicy/canonical/** with the
//                 smallest faithful edit, touching no other file. Bounded: one retry if the
//                 read-only gate below stays red.
//   (b) VERIFY  — reference-check must stay green (the same read-only guard extraction
//                 uses); a broken canonical link means the applier damaged the corpus.
//   (c) FREEZE  — a new frozen baseline via the SAME doc-baseline path extraction uses
//                 (patch bump of the CR's previous_baseline_version; approved_by from the
//                 CR's owner_decision_by; approval_ref = the CR id). The CR is then stamped
//                 docs_applied with resulting_baseline_* (stampChangeRequestApplied — the
//                 stamped file must pass change-control).
//   (d) EXTRACT — spawn extract-issues.mjs as a CHILD. That orchestrator already snapshots
//                 the prior source-map and, on green, reopens impacted issues INTERNALLY to
//                 reopen exactly the impacted done issues (see extract-issues.mjs, the runReopen
//                 block near the green return). So reopening is INTRINSIC to the extraction
//                 spawn — this chain deliberately does NOT call runReopen itself, to keep a
//                 single owner of the reopening step.
//   (e) TERMINAL — { status: "green" | "blocked", cr, baseline, extraction }.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.mjs";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.mjs";
import { readChangeRequest, stampChangeRequestApplied } from "./change-control.mjs";
import { runReferenceCheck as runReferenceCheckImpl } from "./reference-check.mjs";
import { readSpikes } from "./spike-check.mjs";
import { flipSpikeStatus } from "./spike-prover.mjs";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.mjs";

const BASELINE_DIR = ".vivicy/baselines";
const REPORTS_DIR = ".vivicy/development/reports";
const CHANGE_REQUESTS_DIR = ".vivicy/change-requests";
// The synthetic "issue" the applier leg runs against (transcript + actor/role handle),
// keyed by the CR id so the transcript lands under a per-CR dir — the same pattern the
// extractor and prover use for a leg that is not a product issue.
const APPLIER_GRAPH_REF = "node:cr-apply";
const DEFAULT_APPLY_ATTEMPTS = 2; // the initial apply + one bounded retry on a red gate

/**
 * Run the application chain for one APPROVED CR. Deterministic orchestration around a
 * single bounded agent leg; the report file is the running source of truth (phase per
 * step, honest block on any failure).
 *
 * Injectable seams (all default to the real tooling):
 *   spawnApplier({ repoRoot, cr, cfg, attempt, feedback }) -> leg result; the applier edits
 *       .vivicy/canonical/** to fold in the CR's decided intent.
 *   runReferenceCheck({ repoRoot }) -> { exitCode, ... } (read-only canonical-link guard)
 *   runFreeze({ repoRoot, version, previousVersion, approvedBy, approvalRef })
 *       -> { manifestPath, baselineId, version, documentSetHash, manifestHash }
 *   runExtraction({ repoRoot }) -> { status, summary, reopened?, ... } (spawns extract-issues.mjs)
 *   recordReport(report) -> persists the progressing report (defaults to the report file)
 *   now() -> ISO timestamp (tests pin it).
 *
 * @returns {Promise<{ status: "green"|"blocked", phase: string, cr: string, baseline?: object,
 *                     extraction?: object, summary: string }>}
 */
export async function applyChangeRequest(args = {}) {
  const repoRoot = args.repoRoot;
  if (!repoRoot) {
    throw new Error("No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project, or pass repoRoot.");
  }
  const id = args.id;
  if (!id) throw new Error("applyChangeRequest: a CR id (e.g. CR-0001) is required");

  const cfg = { ...DEFAULT_CONFIG, ...(args.cfg ?? {}) };
  const legs = args.legs ?? resolveAgentLegs(process.env);
  const now = args.now ?? (() => new Date().toISOString());
  const spawnApplier = args.spawnApplier ?? makeDefaultSpawnApplier(cfg, legs);
  const runReferenceCheck = args.runReferenceCheck ?? ((a) => runReferenceCheckImpl(a));
  const runFreeze = args.runFreeze ?? defaultRunFreeze;
  const commitApplied = args.commitApplied ?? defaultCommitApplied;
  const runExtraction = args.runExtraction ?? defaultRunExtraction;
  const recordReport = args.recordReport ?? ((report) => defaultRecordReport(repoRoot, id, report));

  // The CR must exist and be APPROVED into the current build. Any other status is a caller
  // error (a docs_applied CR is already folded; an idea/rejected one is not approved) — we
  // block loudly rather than apply an undecided CR.
  const found = readChangeRequest(repoRoot, id);
  if (!found) {
    return terminal(recordReport, "blocked", "resolve", id, { summary: `cr-apply: no CR with id ${id} under .vivicy/change-requests/` });
  }
  // readChangeRequests yields a BARE filename in `file`; normalize to the repo-relative path
  // so the applier context, its transcript key, and any display reference the real path.
  const cr = { ...found, file: `${CHANGE_REQUESTS_DIR}/${found.file}` };
  const status = String(cr.fm?.status ?? "");
  if (status !== "accepted_current_build") {
    return terminal(recordReport, "blocked", "resolve", id, { summary: `cr-apply: CR ${id} is "${status}", the application chain only runs on accepted_current_build` });
  }

  // (a) APPLY — one bounded agent leg edits the canonical to fold in the CR. A retry runs
  // only when the read-only gate (b) stayed red, feeding the failure back. A leg that dies
  // authors no usable edit, so the gate simply stays red and the attempt is honest.
  recordReport({ phase: "apply", cr: id, attempt: 1, started_at: now() });
  let referenceOk = false;
  let reference = null;
  let feedback = null;
  for (let attempt = 1; attempt <= DEFAULT_APPLY_ATTEMPTS; attempt += 1) {
    recordReport({ phase: "apply", cr: id, attempt, updated_at: now() });
    await spawnApplier({ repoRoot, cr, cfg, attempt, feedback });

    // (b) VERIFY the canonical edit — reference-check must stay green (the applier must not
    // have broken a doc-to-doc link). This is the read-only gate that bounds the retry.
    recordReport({ phase: "verify", cr: id, attempt, updated_at: now() });
    reference = runReferenceCheck({ repoRoot });
    if (reference.exitCode === 0) {
      referenceOk = true;
      break;
    }
    feedback = formatReferenceFailure(reference);
  }
  if (!referenceOk) {
    return terminal(recordReport, "blocked", "verify", id, {
      reference,
      summary: `cr-apply: reference-check stayed red after ${DEFAULT_APPLY_ATTEMPTS} apply attempt(s) — the canonical edit for ${id} broke a doc link. CR left accepted_current_build.`,
    });
  }

  // (c) FREEZE — a new frozen baseline via the same doc-baseline path extraction uses. The
  // new version is the patch bump of the CR's recorded previous_baseline_version (an
  // accepted_current_build CR always carries it). approved_by comes from the CR's owner
  // decision (the owner who approved the CR is the one approving this freeze); approval_ref
  // is the CR id, so the frozen manifest points back at the decision that produced it.
  const previousVersion = String(cr.fm?.previous_baseline_version ?? "");
  if (!/^\d+\.\d+\.\d+$/.test(previousVersion)) {
    return terminal(recordReport, "blocked", "freeze", id, { summary: `cr-apply: CR ${id} has no valid previous_baseline_version to bump from (got "${previousVersion}")` });
  }
  const newVersion = patchBump(previousVersion);
  const approvedBy = String(cr.fm?.owner_decision_by ?? "owner:cr-apply");

  // Record the freeze phase BEFORE committing, so the commit sweeps up this status
  // write too. The order matters: doc-baseline refuses to freeze a dirty tree, and the
  // cr-apply report file is tracked — writing it AFTER the commit would re-dirty the
  // tree and the freeze would fail with "working tree clean: false" (caught in the
  // torture run). Same discipline extraction uses: freeze precedes no un-committed write.
  recordReport({ phase: "freeze", cr: id, from_version: previousVersion, to_version: newVersion, updated_at: now() });

  // COMMIT the applied canonical edit (and this status write) so the tree is clean for
  // the freeze — the same commit-before-freeze extraction does.
  const committed = commitApplied({ repoRoot, id });
  if (!committed.committed) {
    return terminal(recordReport, "blocked", "commit", id, { summary: `cr-apply: could not commit the applied canonical edit for ${id} before freezing (git add/commit failed)` });
  }
  let baseline;
  try {
    baseline = await runFreeze({ repoRoot, version: newVersion, previousVersion, approvedBy, approvalRef: id });
  } catch (error) {
    return terminal(recordReport, "blocked", "freeze", id, { summary: `cr-apply: freeze failed for ${id}: ${error instanceof Error ? error.message : String(error)}` });
  }

  // Stamp the CR docs_applied with the resulting baseline identity (the folded state). The
  // stamped file must pass change-control (stampChangeRequestApplied enforces it).
  try {
    stampChangeRequestApplied({
      repoRoot,
      id,
      resulting: {
        resulting_baseline_id: baseline.baselineId,
        resulting_baseline_version: baseline.version,
        resulting_baseline_manifest_path: baseline.manifestPath,
        resulting_document_set_hash: baseline.documentSetHash,
        resulting_manifest_hash: baseline.manifestHash,
      },
      now,
    });
  } catch (error) {
    return terminal(recordReport, "blocked", "stamp", id, { baseline, summary: `cr-apply: could not stamp ${id} docs_applied: ${error instanceof Error ? error.message : String(error)}` });
  }
  recordReport({ phase: "stamped", cr: id, baseline, updated_at: now() });

  // (c.1) RETIRE the now-moot spike(s). A CR that folds a DISPROVEN spike's correction into
  // the canonical carries that spike's gate_id on affected_verification_gates. Once the fold
  // is applied, the disproven assumption is gone from the intention — there is nothing left
  // to prove — so the failed spike must stop gating, or G13 (transitivelyVerifiedGates in
  // extract-issues) would block re-extraction forever with blocked_on_unverified_spikes. We
  // RETIRE (failed -> deferred), never auto-RE-AUTHOR: a fresh spike is a new intention the
  // owner drives, not something this mechanical fold invents. `deferred` is the enum value
  // meaning "no longer blocking" — G13 explicitly skips deferred spikes. This runs BEFORE the
  // child extraction spawns so that gate already reads as deferred, and its file edit is
  // committed here (same commit-before-freeze discipline: the child may freeze, and doc-baseline
  // refuses a dirty tree). Only spikes named on THIS CR and currently `failed` are touched.
  const retired = retireAffectedSpikes({ repoRoot, cr });
  if (retired.length > 0) {
    recordReport({ phase: "retire_spikes", cr: id, retired, updated_at: now() });
    const committedRetire = commitApplied({ repoRoot, id });
    if (!committedRetire.committed) {
      return terminal(recordReport, "blocked", "retire_spikes", id, { baseline, retired, summary: `cr-apply: could not commit the retired spike(s) ${retired.join(", ")} for ${id} before re-extraction (git add/commit failed)` });
    }
  }

  // (d) RE-EXTRACT (+ REOPEN, intrinsic): spawn extract-issues.mjs. It captures the prior
  // source-map and, on green, reopens exactly the impacted done issues
  // INTERNALLY — see extract-issues.mjs. We do NOT reopen here; the extraction owns it.
  recordReport({ phase: "extract", cr: id, updated_at: now() });
  const extraction = await runExtraction({ repoRoot });
  if (extraction.status !== "green") {
    return terminal(recordReport, "blocked", "extract", id, {
      baseline,
      extraction,
      summary: `cr-apply: ${id} applied + re-frozen (baseline ${baseline.baselineId}), but re-extraction did not reach green: ${extraction.summary ?? extraction.status}`,
    });
  }

  return terminal(recordReport, "green", "green", id, {
    baseline,
    extraction,
    summary: `cr-apply: ${id} applied — canonical folded, re-frozen as ${baseline.baselineId}, re-extracted green${extraction.reopened?.length ? ` (reopened ${extraction.reopened.length} impacted issue(s))` : ""}.`,
  });
}

// ---------------------------------------------------------------------------
// Terminal report
// ---------------------------------------------------------------------------

// Persist and return the terminal report. A `blocked` terminal is honest: the CR stays
// accepted_current_build (only stampChangeRequestApplied moves it to docs_applied, and only
// on the freeze success path), so a re-run resumes from a clean, decided CR.
function terminal(recordReport, status, phase, cr, extra) {
  const report = { status, phase, cr, ...extra };
  recordReport(report);
  return report;
}

// ---------------------------------------------------------------------------
// Default seams (the real tooling)
// ---------------------------------------------------------------------------

// The APPLIER seam: drive the IMPLEMENTER-role CLI (Claude by default), re-roled to
// "cr-applier" so it reads cr-applier.md and names its transcript. Runs in the TARGET repo
// so it edits the project's canonical in place.
function makeDefaultSpawnApplier(baseCfg, legs) {
  const implementer = legs?.implementer ?? { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg = { ...implementer, role: "cr-applier" };
  return async ({ repoRoot, cr, cfg, attempt, feedback }) => {
    const legCfg = { ...cfg, promptsDir: cfg?.promptsDir ?? FACTORY_PROMPTS_DIR, execRoot: repoRoot };
    const issue = applierIssue(cr);
    const context = applierContext({ cr, attempt, feedback });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg, deps) : runClaudeLeg(leg, issue, legCfg, deps);
  };
}

// The synthetic issue the applier leg runs against (transcript + actor/role identity),
// keyed by the CR id so its transcript lands under a per-CR dir. path points at the CR file
// so the leg's identity references the artifact it is folding.
function applierIssue(cr) {
  return { id: `CR-APPLY-${crStem(cr)}`, graph_refs: [APPLIER_GRAPH_REF], path: cr.file };
}

// Extra prompt context for the APPLIER leg: which CR to fold, into which canonical, and —
// on a retry — the reference-check failure to repair.
function applierContext({ cr, attempt, feedback }) {
  return (
    `\n\n---\n\n## CR application context for this run\n\n` +
    `- Change Request to fold: \`${cr.file}\` (id \`${cr.fm?.id}\`, status \`${cr.fm?.status}\`).\n` +
    `- Read its DECIDED intent (the Idea / Required Documentation Changes and the owner decision) and fold it into ` +
    `\`.vivicy/canonical/**\` with the SMALLEST faithful edit. The canonical becomes the single consolidated intention — ` +
    `never an old spec plus an annex. Touch NO other file (no issues, no baselines, no map, no other CR).\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback
      ? `\n### Repair this — the previous edit failed the read-only reference gate\n\n` + "```text\n" + feedback + "\n```\n"
      : "")
  );
}

// Bind the shared leg runner to the TARGET repo's roots and inject the run-specific prompt
// context, exactly as extract-issues' legDepsForTarget.
function legDepsForTarget(legCfg, issue, repoRoot, context) {
  const abs = (rel) => resolve(repoRoot, rel);
  return {
    composePrompt: (template, iss) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot: repoRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir}/${issue.id}`),
    cwdFilter: null,
  };
}

// Freeze .vivicy/canonical/** at the patch-bumped version via doc-baseline (shelled out so
// its corpus-policy + git-clean + approval + bump-class guards run exactly as in
// production). Returns the new baseline identity parsed from the written manifest.
// Commit the applier's canonical edit so the tree is clean before the freeze. `git
// add -A` is safe: the scaffold .gitignore covers the never-commit set. A no-op
// commit (nothing staged — the applier made no net change) is tolerated as an
// already-clean tree, not a failure.
function defaultCommitApplied({ repoRoot, id }) {
  const add = spawnSync("git", ["add", "-A"], { cwd: repoRoot, encoding: "utf8" });
  if ((add.status ?? 1) !== 0) {
    process.stderr.write(`cr-apply: git add -A failed: ${add.stderr || add.stdout}\n`);
    return { committed: false };
  }
  const message = `change-request: fold ${id} into the canonical`;
  const commit = spawnSync("git", ["commit", "-m", message], { cwd: repoRoot, encoding: "utf8" });
  const out = `${commit.stdout ?? ""}\n${commit.stderr ?? ""}`;
  if ((commit.status ?? 1) !== 0 && !/nothing to commit/i.test(out)) {
    process.stderr.write(`cr-apply: applied-edit commit failed: ${out.trim()}\n`);
    return { committed: false };
  }
  return { committed: true };
}

function defaultRunFreeze({ repoRoot, version, previousVersion, approvedBy, approvalRef }) {
  const tool = resolve(FACTORY_DIR, "doc-baseline.mjs");
  const baselineId = `baseline-v${version}`;
  const args = [
    tool, "generate",
    "--version", version,
    "--status", "frozen",
    "--bump", "patch",
    "--previous-version", previousVersion,
    "--approved-by", approvedBy,
    "--approval-ref", approvalRef,
  ];
  const result = spawnSync("node", args, { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`freeze failed (exit ${result.status}):\n${out}`);
  }
  const manifestPath = `${BASELINE_DIR}/${baselineId}.json`;
  const abs = resolve(repoRoot, manifestPath);
  if (!existsSync(abs)) throw new Error(`freeze reported success but ${manifestPath} is missing`);
  const manifest = JSON.parse(readFileSync(abs, "utf8"));
  return {
    manifestPath,
    baselineId,
    version,
    documentSetHash: manifest.document_set_hash,
    manifestHash: manifest.manifest_hash,
  };
}

// Spawn the extraction orchestrator as a CHILD (re-extract + reopen; reopening intrinsic
// to it). We shell out — rather than import extractIssues — so the child runs the full real
// path (freeze reuse, spike gating, commit) exactly as a standalone extraction, and reads
// the terminal state back from the status file it writes (the same file the control plane
// reads). The child's own reopening restores the impacted done issues.
function defaultRunExtraction({ repoRoot }) {
  const tool = resolve(FACTORY_DIR, "extract-issues.mjs");
  const result = spawnSync("node", [tool], { cwd: repoRoot, env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot }, encoding: "utf8" });
  const status = readExtractionStatus(repoRoot);
  return {
    status: status?.phase ?? (result.status === 0 ? "green" : "error"),
    summary: status?.summary ?? `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split("\n").filter(Boolean).at(-1) ?? "",
    ...(Array.isArray(status?.reopened) ? { reopened: status.reopened } : {}),
    exitCode: result.status ?? 1,
  };
}

function readExtractionStatus(repoRoot) {
  const abs = resolve(repoRoot, `${REPORTS_DIR}/extraction-status.json`);
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

// Persist the progressing report to .vivicy/development/reports/cr-apply-<id>.json. Each
// call overwrites with the latest snapshot (a `phase` field + an `updated_at`), so a reader
// (UI/CLI) always sees where the chain is; the terminal call leaves the final status.
function defaultRecordReport(repoRoot, id, report) {
  const abs = resolve(repoRoot, `${REPORTS_DIR}/cr-apply-${id}.json`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify({ ...report, updated_at: report.updated_at ?? new Date().toISOString() }, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Retire every spike this CR resolves at the intention level: for each gate_id on the CR's
// affected_verification_gates that maps to a spike currently `status: failed`, flip it to
// `deferred` in place (the same byte-preserving Traceability rewrite the prover uses). A
// disproven spike whose correction is now folded into the canonical has nothing left to
// prove, and a `deferred` spike does not gate G13 — so this is what actually unblocks
// re-extraction. Returns the gate_ids retired (empty when the CR names none, or none of the
// named spikes is failed). A gate that resolves to no spike, or to a non-failed spike, is a
// deliberate no-op — never a re-authoring and never a downgrade of a verified spike.
function retireAffectedSpikes({ repoRoot, cr }) {
  const gates = toGateList(cr.fm?.affected_verification_gates);
  if (gates.length === 0) return [];
  const spikeByGate = new Map(readSpikes(repoRoot).map((spike) => [spike.gate_id, spike]));
  const retired = [];
  for (const gate of gates) {
    const spike = spikeByGate.get(gate);
    if (!spike || spike.status !== "failed") continue;
    flipSpikeStatus(repoRoot, spike, "deferred");
    retired.push(gate);
  }
  return retired;
}

// affected_verification_gates parses to an array (parseFrontmatter's [a, b] form), but a
// single value may arrive as a bare string; normalize both to a string[] so a lone gate is
// still honoured.
function toGateList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function patchBump(version) {
  const [M, m, p] = version.split(".").map(Number);
  return `${M}.${m}.${p + 1}`;
}

function crStem(cr) {
  const base = (cr.file.split("/").pop() ?? cr.file).replace(/\.md$/i, "");
  return base;
}

function formatReferenceFailure(reference) {
  const errors = (reference?.errors ?? []).join("\n");
  return `reference-check FAILED (exit ${reference?.exitCode}). A canonical doc link no longer resolves — repair the link(s) you broke:\n${errors}`;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const id = opt("cr");
  if (!id) {
    console.error("usage: cr-apply.mjs --cr CR-#### [--dir <target>]");
    process.exit(2);
  }
  const dir = opt("dir");
  const repoRoot = dir ? resolve(dir) : resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT or pass --dir <target>.");
    process.exit(2);
  }
  applyChangeRequest({ repoRoot, id })
    .then((result) => {
      console.log(result.summary);
      process.exit(result.status === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
