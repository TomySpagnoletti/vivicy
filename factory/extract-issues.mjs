#!/usr/bin/env node
// Vivicy semantic issue EXTRACTION orchestrator.
//
// The missing half of Vivicy's promise — "the owner writes the canonical spec,
// Vivicy does the rest". `doc-baseline.mjs` can FREEZE a spec and
// `semantic-extraction-check.mjs` / `traceability-check.mjs` can VALIDATE an
// extraction, but nothing AUTHORED the issues from the spec. This orchestrator
// does — and, mirroring the dev-loop's implement+review, it does so as a
// TWO-AGENT loop: an EXTRACTOR agent authors, deterministic checks gate, then an
// INDEPENDENT FIDELITY VERIFIER agent (the configured reviewer CLI, never the
// extractor) judges what the line-coverage check cannot — source fidelity:
//
//   1. FREEZE if needed   — if no frozen baseline manifest exists under
//                           docs/baselines/, freeze docs/canonical/** at v1.0.0;
//                           otherwise reuse the existing frozen baseline. The
//                           freeze runs BEFORE any status is written: nothing
//                           tracked is touched before it, so the doc-baseline
//                           working-tree-clean guard never trips on our own
//                           status file (a live-run fragility this orchestrator
//                           hit and now structurally prevents).
//   2. AUTHOR (extractor)  — spawn the extractor agent (Claude by default) with
//                           the extractor prompt + the frozen baseline; it writes
//                           the full corpus (Requirement Catalog, Traceability
//                           Matrix, line exclusions, vertical issues, issue index,
//                           arch map).
//   3. VALIDATE (det.)     — run the two deterministic checks. They own the FIRST
//                           verdict (line coverage, pin integrity, DAG, schema).
//   4. VERIFY (verifier)   — on a deterministic GREEN, spawn the INDEPENDENT
//                           verifier leg (the reviewer CLI, e.g. Codex). It judges
//                           FIDELITY: do each issue's source_line_refs really cite
//                           the canonical lines? Is every issue a faithful, ISO
//                           restatement of exactly that content (nothing invented,
//                           nothing silently dropped, no scope drift)? Do the
//                           requirement_ids / graph_refs match, and does the arch
//                           map reflect the spec? It writes a STRUCTURED verdict
//                           JSON. The extraction is GREEN only when the
//                           deterministic checks pass AND the verdict is
//                           faithful:true.
//   5. FIX LOOP            — on a red check OR an unfaithful verdict, re-spawn the
//                           EXTRACTOR with the EXACT check output / verdict
//                           problems + the current corpus to FIX, bounded retries;
//                           stop with extraction_blocked if still red/unfaithful.
//   6. MAP                 — on green, regenerate architecture-data.json.
//
// The verifier reuses the SAME shared reviewer-leg infra the dev-loop uses
// (runCodexLeg via agent-spawn.mjs) and honors the configurable role -> CLI
// assignment (implementer CLI = extractor, reviewer CLI = verifier), with the
// distinct-agent invariant: the agent that verifies fidelity never authored the
// corpus.
//
// Every step is an injectable seam so the flow is unit-tested with FAKE agents
// (no real CLI); the defaults invoke the real tooling + real agent legs via the
// shared agent-spawn primitives (the same spawn/MCP/transcript path the dev-loop
// uses — reused, not duplicated).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.mjs";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.mjs";
import { runSemanticExtractionCheck } from "./semantic-extraction-check.mjs";
import { runTraceabilityCheck } from "./traceability-check.mjs";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.mjs";

const BASELINE_DIR = "docs/baselines";
const ISSUE_INDEX_REL = "spec/development/issue-index.json";
const EXTRACTION_STATUS_REL = "spec/development/reports/extraction-status.json";
// Where the independent fidelity verifier writes its structured verdict. A
// dedicated evidence file (NOT committed as corpus) the orchestrator reads to
// decide green vs. feed-back-to-extractor, and that a human/the UI can inspect.
const VERDICT_REL = "spec/development/reports/extraction-fidelity-verdict.json";
const DEFAULT_FREEZE_VERSION = "1.0.0";
const DEFAULT_MAX_RETRIES = 3;

// The synthetic "issue" the agent legs run against. It is NOT a product issue
// (no product issues exist yet — that is what we are authoring); it is the leg's
// identity/transcript handle, so the shared spawn infra names the transcript and
// injects the actor/role env exactly as it does for a dev-loop leg.
const EXTRACTOR_ISSUE_ID = "EXTRACTION";

/**
 * Drive freeze -> author -> validate -> verify-fidelity -> fix -> map for the
 * target project, as a two-agent loop (extractor authors, independent verifier
 * judges fidelity).
 *
 * Injectable seams (all default to the real tooling):
 *   spawnExtractor({ repoRoot, manifestPath, cfg, attempt, checkOutput, isFix })
 *       -> { transcriptRel?, output?, status? }   (authors/fixes the corpus)
 *   spawnVerifier({ repoRoot, manifestPath, baselineId, cfg, attempt })
 *       -> { transcriptRel?, output? }   (writes the structured fidelity verdict)
 *   runFreeze({ repoRoot, version })               -> { manifestPath, baselineId }
 *   runSemanticCheck({ repoRoot })                 -> { exitCode, errors, warnings, summary }
 *   runTraceability({ repoRoot })                  -> { exitCode, errors, summary }
 *   readVerdict({ repoRoot })                      -> { faithful, problems } | null
 *   runGenerateMap({ repoRoot })                   -> { code, output }
 *   emitStatus(status, repoRoot)                   -> persists extraction status
 *
 * `options.spawnAgent` is still accepted as a back-compat alias for
 * `options.spawnExtractor` (the extractor leg), so existing callers/tests keep
 * working.
 *
 * @returns {{ status: "green"|"extraction_blocked", attempts, manifestPath,
 *             baselineId, checks, verdict, transcripts, summary }}
 */
export async function extractIssues(options = {}) {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new Error(
      "No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to extract, or pass options.repoRoot.",
    );
  }
  const maxRetries = Number.isInteger(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES;
  const version = options.version ?? DEFAULT_FREEZE_VERSION;
  const cfg = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  // The two legs are assigned to distinct CLIs (R12): implementer CLI = extractor,
  // reviewer CLI = verifier. resolveAgentLegs enforces the distinct-CLI invariant
  // so the agent that verifies fidelity never authored the corpus.
  const legs = resolveAgentLegs(process.env);
  const spawnExtractor =
    options.spawnExtractor ?? options.spawnAgent ?? makeDefaultSpawnExtractor(options, cfg, legs);
  const spawnVerifier = options.spawnVerifier ?? makeDefaultSpawnVerifier(options, cfg, legs);
  const runFreeze = options.runFreeze ?? defaultRunFreeze;
  const runSemanticCheck = options.runSemanticCheck ?? defaultRunSemanticCheck;
  const runTraceability = options.runTraceability ?? defaultRunTraceability;
  const readVerdict = options.readVerdict ?? defaultReadVerdict;
  const runGenerateMap = options.runGenerateMap ?? defaultRunGenerateMap;
  const emitStatus = options.emitStatus ?? defaultEmitStatus;

  const transcripts = [];
  const record = (status) => emitStatus(status, repoRoot);

  // --- 1. Freeze if needed (BEFORE any status emission) ---------------------
  // The freeze must precede every record(): doc-baseline refuses to cut a frozen
  // baseline on a dirty tree, and our own extraction-status.json lives under a
  // tracked path. Emitting status first would dirty the tree and make the freeze
  // fail ("working tree clean: false"). So we resolve/freeze the baseline before
  // writing anything, and only THEN emit the first status. (extraction-status.json
  // is also gitignored as defence in depth — see the scaffold/fixture .gitignore —
  // so even a stale copy from a prior run never dirties the freeze.)
  let frozen = findFrozenManifest(repoRoot);
  let froze = false;
  if (!frozen) {
    frozen = await runFreeze({ repoRoot, version });
    froze = true;
  }
  const { manifestPath, baselineId } = frozen;

  // --- 2/3/4/5. Author -> validate -> verify fidelity -> fix loop -----------
  let lastChecks = null;
  let lastVerdict = null;
  const maxAttempts = maxRetries + 1; // the initial author + up to maxRetries fixes
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isFix = attempt > 1;
    record({ phase: isFix ? "fixing" : "authoring", attempt });

    // On a fix pass, feed BACK whatever made the previous attempt non-green: the
    // deterministic check output and/or the fidelity verdict problems.
    const fixContext = isFix ? formatFixContext(lastChecks, lastVerdict) : null;
    const leg = await spawnExtractor({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput: fixContext, isFix });
    if (leg?.transcriptRel) transcripts.push(leg.transcriptRel);

    // --- Deterministic checks (first verdict: coverage / pins / DAG / schema) ---
    record({ phase: "validating", attempt });
    const semantic = runSemanticCheck({ repoRoot });
    const traceability = runTraceability({ repoRoot });
    lastChecks = { semantic, traceability, attempt };
    const deterministicGreen = semantic.exitCode === 0 && traceability.exitCode === 0 && !semantic.placeholder;
    // The semantic checker treats an unchanged placeholder index as exit 0 +
    // placeholder:true — the agent authored nothing usable. Treat it as a failed
    // attempt so the fix loop re-prompts rather than declaring success. A red
    // deterministic check short-circuits the verifier (no point judging fidelity
    // of a corpus that fails coverage/pins) and re-prompts the extractor.
    if (!deterministicGreen) {
      lastVerdict = null;
      continue;
    }

    // --- Independent fidelity verifier (second verdict: source fidelity) -------
    record({ phase: "verifying", attempt });
    const verifierLeg = await spawnVerifier({ repoRoot, manifestPath, baselineId, cfg, attempt });
    if (verifierLeg?.transcriptRel) transcripts.push(verifierLeg.transcriptRel);
    const verdict = readVerdict({ repoRoot });
    lastVerdict = verdict;
    // A missing/unparseable verdict is NOT faithful — never declare green without a
    // structured faithful:true from the independent verifier.
    const faithful = verdict?.faithful === true;
    if (!faithful) {
      // Fidelity failure: re-prompt the EXTRACTOR (not the verifier) to fix.
      continue;
    }

    // --- 6. Map (only on deterministic-green AND faithful:true) --------------
    record({ phase: "mapping", attempt });
    const map = runGenerateMap({ repoRoot });
    const status = {
      status: "green",
      attempts: attempt,
      manifestPath,
      baselineId,
      froze,
      checks: { semantic, traceability },
      verdict,
      map,
      transcripts,
      summary: `extraction green after ${attempt} attempt(s): ${countIssues(repoRoot)} issue(s); verifier faithful:true; map ${map.code === 0 ? "regenerated" : `FAILED (code ${map.code})`}`,
    };
    record({ phase: "green", attempt, summary: status.summary });
    return status;
  }

  // --- Bounded retries exhausted: blocked -----------------------------------
  const status = {
    status: "extraction_blocked",
    attempts: maxAttempts,
    manifestPath,
    baselineId,
    froze,
    checks: lastChecks ? { semantic: lastChecks.semantic, traceability: lastChecks.traceability } : null,
    verdict: lastVerdict,
    transcripts,
    summary:
      `extraction_blocked: the extraction was still not green after ${maxAttempts} attempt(s). ` +
      formatFixContext(lastChecks, lastVerdict),
  };
  record({ phase: "extraction_blocked", attempt: maxAttempts, summary: status.summary });
  return status;
}

// ---------------------------------------------------------------------------
// Default seams (the real tooling)
// ---------------------------------------------------------------------------

// The synthetic issue both legs run against (transcript + hook identity handle).
function extractionIssue() {
  return { id: EXTRACTOR_ISSUE_ID, graph_refs: ["node:extraction"], path: ISSUE_INDEX_REL };
}

// Build the real EXTRACTOR seam: drive the implementer CLI (Claude by default)
// with the extractor prompt. The CLI follows the configured role assignment via
// `legs.implementer` (resolveAgentLegs), so the extractor CLI/model/effort track
// the same settings the dev-loop honors.
function makeDefaultSpawnExtractor(options, baseCfg, legs) {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  // The extractor is the IMPLEMENTER-role CLI, re-roled to "extractor" so it reads
  // extractor.md and names its transcript / hook identity for extraction.
  const implementer = legs?.implementer ?? { actor: "claude", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg = { ...implementer, role: "extractor" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput, isFix }) => {
    // The leg cfg points the shared spawn infra at the TARGET repo for the
    // transcript store and at the factory prompts for the role prompt. abs/execRoot
    // resolve against the target so the agent runs inside the project it extracts.
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// Build the real VERIFIER seam: drive the REVIEWER CLI (Codex by default) with
// the independent fidelity-verifier prompt. resolveAgentLegs guarantees the
// reviewer CLI differs from the implementer CLI, so the agent that judges fidelity
// never authored the corpus — the same distinct-agent invariant the dev-loop
// enforces for implement+review.
function makeDefaultSpawnVerifier(options, baseCfg, legs) {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const reviewer = legs?.reviewer ?? { actor: "codex", provider: "codex", model: CLI_DEFAULTS.codex.model, effort: CLI_DEFAULTS.codex.effort, fast: false };
  const leg = { ...reviewer, role: "extraction-verifier" };
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue = extractionIssue();
    const context = verifierContext({ manifestPath, baselineId, attempt });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return runLegForProvider(leg, issue, legCfg, deps);
  };
}

// Dispatch a leg to the shared spawn helper for its assigned CLI. Both legs reuse
// the SAME reviewer/implementer-leg infra the dev-loop uses (runClaudeLeg /
// runCodexLeg via agent-spawn.mjs) — the extractor through the Claude/implementer
// path, the verifier through the Codex/reviewer path — so neither the flags, the
// MCP wiring, nor the transcript capture are duplicated here.
function runLegForProvider(leg, issue, legCfg, deps) {
  if (leg.provider === "codex") return runCodexLeg(leg, issue, legCfg, deps);
  return runClaudeLeg(leg, issue, legCfg, deps);
}

// Extra prompt context for the EXTRACTOR leg: the frozen baseline + (on a fix
// pass) the exact deterministic-check output and/or fidelity-verdict problems.
function extractorContext({ manifestPath, baselineId, attempt, checkOutput, isFix }) {
  return (
    `\n\n---\n\n## Extraction context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). ` +
    `Read it for the exact corpus files + hashes to pin.\n` +
    `- Attempt: ${attempt}${isFix ? " (FIX pass)" : " (initial author)"}.\n` +
    (checkOutput
      ? `\n### What to FIX this run\n\nThe previous corpus did NOT reach green — either a deterministic ` +
        `check failed or the INDEPENDENT fidelity verifier rejected it. Read every line, locate the exact ` +
        `file/field, and correct it without regressing the rest:\n\n` +
        "```text\n" +
        checkOutput +
        "\n```\n"
      : "")
  );
}

// Extra prompt context for the VERIFIER leg: where the corpus + manifest are, and
// where to WRITE its structured verdict. The verifier writes ONLY the verdict file
// (it never edits the corpus — fixes flow back to the extractor).
function verifierContext({ manifestPath, baselineId, attempt }) {
  return (
    `\n\n---\n\n## Fidelity verification context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). ` +
    `Read it for the authoritative corpus files + line numbers.\n` +
    `- Attempt under review: ${attempt}.\n` +
    `- Write your STRUCTURED verdict — and nothing else — to \`${VERDICT_REL}\`, ` +
    `as JSON \`{ "faithful": boolean, "problems": [{ "issue": string, "kind": string, "detail": string }] }\`. ` +
    `Do NOT edit any corpus file; report problems for the extractor to fix.\n`
  );
}

// Bind the shared leg runner to the TARGET repo's roots, and inject the
// run-specific prompt context by wrapping composePrompt so the appended context
// rides on the role prompt the shared runner reads.
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

// Freeze docs/canonical/** at the given version via the existing doc-baseline tool.
// We shell out to it (rather than import) so the corpus-policy + git-clean +
// approval guards it owns run exactly as in production. A frozen baseline needs
// owner-approval evidence; for an unattended first freeze we pass a recorded
// self-approval reference so the manifest is auditable (the owner froze by
// invoking extraction). The git-clean guard still applies — a frozen baseline must
// be cut from a committed tree.
function defaultRunFreeze({ repoRoot, version }) {
  const tool = resolve(FACTORY_DIR, "doc-baseline.mjs");
  const baselineId = `baseline-v${version}`;
  const args = [
    tool,
    "generate",
    "--version",
    version,
    "--status",
    "frozen",
    "--approved-by",
    "vivicy:extraction-orchestrator",
    "--approval-ref",
    `vivicy-extract-${new Date().toISOString()}`,
  ];
  const result = spawnSync("node", args, {
    cwd: repoRoot,
    env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`extract-issues: freeze failed (exit ${result.status}):\n${out}`);
  }
  const manifestPath = `${BASELINE_DIR}/${baselineId}.json`;
  if (!existsSync(resolve(repoRoot, manifestPath))) {
    throw new Error(`extract-issues: freeze reported success but ${manifestPath} is missing`);
  }
  return { manifestPath, baselineId };
}

function defaultRunSemanticCheck({ repoRoot }) {
  return runSemanticExtractionCheck({ repoRoot });
}

function defaultRunTraceability({ repoRoot }) {
  return runTraceabilityCheck({ repoRoot });
}

// Read the independent verifier's structured fidelity verdict. The verdict is the
// authority on FIDELITY (source faithfulness), the half the deterministic checks
// cannot judge. A missing or unparseable file is NOT faithful: we return a verdict
// that says so, with an explicit problem the extractor can act on, so a verifier
// that wrote nothing usable can never be mistaken for a passing run.
export function defaultReadVerdict({ repoRoot }) {
  const abs = resolve(repoRoot, VERDICT_REL);
  if (!existsSync(abs)) {
    return { faithful: false, problems: [{ issue: "*", kind: "no_verdict", detail: `verifier wrote no verdict at ${VERDICT_REL}` }] };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(abs, "utf8"));
  } catch (error) {
    return {
      faithful: false,
      problems: [{ issue: "*", kind: "unparseable_verdict", detail: `verdict JSON is invalid: ${error instanceof Error ? error.message : String(error)}` }],
    };
  }
  // Honest shape coercion: faithful is true ONLY when the boolean is exactly true;
  // anything else (missing, truthy-but-not-true, string "true") is treated as not
  // faithful so a malformed verdict never green-lights the extraction.
  const faithful = parsed?.faithful === true;
  const problems = Array.isArray(parsed?.problems) ? parsed.problems : [];
  return { faithful, problems };
}

// Regenerate the viewer's architecture-data.json. generate-viewer-data.ts is a TS
// entry the project runs via the same node-with-TS path the rest of the factory
// uses; we shell out and surface its exit code.
function defaultRunGenerateMap({ repoRoot }) {
  const tool = resolve(FACTORY_DIR, "generate-viewer-data.ts");
  const result = spawnSync("node", [tool], {
    cwd: repoRoot,
    env: { ...process.env, VIVICY_TARGET_ROOT: repoRoot },
    encoding: "utf8",
  });
  return { code: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() };
}

// Persist a small, honest extraction-status report so the UI/map can show where
// extraction is (authoring / validating / fixing / green / blocked). This is a
// dedicated status surface, NOT the per-issue progress ledger (which is keyed by
// graph items of issues that do not exist until extraction finishes).
function defaultEmitStatus(status, repoRoot) {
  const abs = resolve(repoRoot, EXTRACTION_STATUS_REL);
  mkdirSync(dirname(abs), { recursive: true });
  const payload = { ...status, updated_at: new Date().toISOString() };
  writeFileSync(abs, `${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The active frozen baseline, or null. A manifest is frozen-and-active when its
// status is "frozen" and it carries no `superseded` marker.
export function findFrozenManifest(repoRoot) {
  const dir = resolve(repoRoot, BASELINE_DIR);
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(resolve(dir, entry), "utf8"));
    } catch {
      continue;
    }
    if (
      manifest &&
      manifest.status === "frozen" &&
      !manifest.superseded &&
      typeof manifest.baseline_id === "string" &&
      manifest.baseline_id.length > 0
    ) {
      return { manifestPath: `${BASELINE_DIR}/${entry}`, baselineId: manifest.baseline_id };
    }
  }
  return null;
}

// Flatten the two checks' errors/warnings into a single text block the fix prompt
// (and the blocked report) hands to the agent / human.
export function formatCheckOutput(checks) {
  if (!checks) return "(no check output)";
  const parts = [];
  const { semantic, traceability } = checks;
  if (semantic) {
    parts.push(`semantic-extraction-check: ${semantic.summary ?? `exit ${semantic.exitCode}`}`);
    for (const e of semantic.errors ?? []) parts.push(`  error: ${e}`);
    for (const w of semantic.warnings ?? []) parts.push(`  warning: ${w}`);
    if (semantic.placeholder) parts.push("  note: issue index is still the pending-extraction placeholder (nothing authored)");
  }
  if (traceability) {
    parts.push(`traceability-check: ${traceability.summary ?? `exit ${traceability.exitCode}`}`);
    for (const e of traceability.errors ?? []) parts.push(`  error:\n${e}`);
  }
  return parts.join("\n");
}

// Flatten the independent verifier's structured fidelity verdict into a readable
// block the fix prompt (and the blocked report) hands to the extractor / human.
export function formatVerdict(verdict) {
  if (!verdict) return null;
  if (verdict.faithful === true) return "fidelity-verifier: faithful:true";
  const parts = ["fidelity-verifier: faithful:false (independent verifier rejected the corpus)"];
  for (const p of verdict.problems ?? []) {
    const issue = p?.issue ?? "?";
    const kind = p?.kind ?? "fidelity";
    const detail = p?.detail ?? "";
    parts.push(`  problem [${issue}] ${kind}: ${detail}`);
  }
  if ((verdict.problems ?? []).length === 0) {
    parts.push("  problem: verifier reported faithful:false but listed no specific problems");
  }
  return parts.join("\n");
}

// Build the combined feedback block for a FIX pass / the blocked report: the
// deterministic check output AND/OR the fidelity verdict problems, whichever made
// the previous attempt non-green. Either part may be absent (a red deterministic
// check short-circuits the verifier, so there is no verdict that round).
export function formatFixContext(checks, verdict) {
  const blocks = [];
  // Only include the deterministic block when it actually failed (a green
  // deterministic check that was then rejected on fidelity should not re-feed
  // passing check output as if it were the problem).
  if (checks) {
    const semGreen = checks.semantic?.exitCode === 0 && !checks.semantic?.placeholder;
    const traceGreen = checks.traceability?.exitCode === 0;
    if (!(semGreen && traceGreen)) blocks.push(formatCheckOutput(checks));
  }
  const verdictBlock = formatVerdict(verdict);
  if (verdictBlock && verdict?.faithful !== true) blocks.push(verdictBlock);
  if (blocks.length === 0) return "(no check or verdict output)";
  return blocks.join("\n\n");
}

function countIssues(repoRoot) {
  try {
    const index = JSON.parse(readFileSync(resolve(repoRoot, ISSUE_INDEX_REL), "utf8"));
    return Array.isArray(index.issues) ? index.issues.length : 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to extract.",
    );
    process.exit(2);
  }
  extractIssues({ repoRoot })
    .then((result) => {
      console.log(result.summary);
      process.exit(result.status === "green" ? 0 : 1);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    });
}
