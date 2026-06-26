#!/usr/bin/env node
// Vivicy semantic issue EXTRACTION orchestrator.
//
// The missing half of Vivicy's promise — "the owner writes the canonical spec,
// Vivicy does the rest". `doc-baseline.mjs` can FREEZE a spec and
// `semantic-extraction-check.mjs` / `traceability-check.mjs` can VALIDATE an
// extraction, but nothing AUTHORED the issues from the spec. This orchestrator
// does, by driving a real agent and validating its output:
//
//   1. FREEZE if needed   — if no frozen baseline manifest exists under
//                           docs/baselines/, freeze docs/canonical/** at v1.0.0;
//                           otherwise reuse the existing frozen baseline.
//   2. AUTHOR (agent leg) — spawn a real Claude agent with the extractor prompt
//                           and the frozen baseline; it writes the full corpus
//                           (Requirement Catalog, Traceability Matrix, line
//                           exclusions, vertical issues, issue index, arch map).
//   3. VALIDATE           — run the two deterministic checks. They own the verdict.
//   4. FIX LOOP           — on a red check, re-spawn the agent with the EXACT
//                           check output + the current corpus to FIX, bounded
//                           retries; stop with extraction_blocked if still red.
//   5. MAP                — on green, regenerate architecture-data.json.
//
// Every step is an injectable seam so the flow is unit-tested with a FAKE agent
// (no real CLI); the defaults invoke the real tooling + a real Claude leg via the
// shared agent-spawn primitives (the same spawn/MCP/transcript path the dev-loop
// uses — reused, not duplicated).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg } from "./agent-spawn.mjs";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG } from "./dev-loop.mjs";
import { runSemanticExtractionCheck } from "./semantic-extraction-check.mjs";
import { runTraceabilityCheck } from "./traceability-check.mjs";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.mjs";

const BASELINE_DIR = "docs/baselines";
const ISSUE_INDEX_REL = "spec/development/issue-index.json";
const EXTRACTION_STATUS_REL = "spec/development/reports/extraction-status.json";
const DEFAULT_FREEZE_VERSION = "1.0.0";
const DEFAULT_MAX_RETRIES = 3;

// The synthetic "issue" the extractor leg runs against. It is NOT a product issue
// (no product issues exist yet — that is what we are authoring); it is the leg's
// identity/transcript handle, so the shared spawn infra names the transcript and
// injects the actor/role env exactly as it does for a dev-loop leg.
const EXTRACTOR_ISSUE_ID = "EXTRACTION";

/**
 * Drive freeze -> author -> validate -> fix -> map for the target project.
 *
 * Injectable seams (all default to the real tooling):
 *   spawnAgent({ repoRoot, manifestPath, cfg, attempt, checkOutput })
 *       -> { transcriptRel?, output?, status? }   (authors/fixes the corpus)
 *   runFreeze({ repoRoot, version })               -> { manifestPath, baselineId }
 *   runSemanticCheck({ repoRoot })                 -> { exitCode, errors, warnings, summary }
 *   runTraceability({ repoRoot })                  -> { exitCode, errors, summary }
 *   runGenerateMap({ repoRoot })                   -> { code, output }
 *   emitStatus(status, repoRoot)                   -> persists extraction status
 *
 * @returns {{ status: "green"|"extraction_blocked", attempts, manifestPath,
 *             baselineId, checks, transcripts, summary }}
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
  const spawnAgent = options.spawnAgent ?? makeDefaultSpawnAgent(options);
  const runFreeze = options.runFreeze ?? defaultRunFreeze;
  const runSemanticCheck = options.runSemanticCheck ?? defaultRunSemanticCheck;
  const runTraceability = options.runTraceability ?? defaultRunTraceability;
  const runGenerateMap = options.runGenerateMap ?? defaultRunGenerateMap;
  const emitStatus = options.emitStatus ?? defaultEmitStatus;
  const cfg = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };

  const transcripts = [];
  const record = (status) => emitStatus(status, repoRoot);

  // --- 1. Freeze if needed --------------------------------------------------
  record({ phase: "freezing", attempt: 0 });
  let frozen = findFrozenManifest(repoRoot);
  let froze = false;
  if (!frozen) {
    frozen = await runFreeze({ repoRoot, version });
    froze = true;
  }
  const { manifestPath, baselineId } = frozen;

  // --- 2/3/4. Author -> validate -> fix loop --------------------------------
  let lastChecks = null;
  const maxAttempts = maxRetries + 1; // the initial author + up to maxRetries fixes
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isFix = attempt > 1;
    record({ phase: isFix ? "fixing" : "authoring", attempt });

    const checkOutput = isFix ? formatCheckOutput(lastChecks) : null;
    const leg = await spawnAgent({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput, isFix });
    if (leg?.transcriptRel) transcripts.push(leg.transcriptRel);

    record({ phase: "validating", attempt });
    const semantic = runSemanticCheck({ repoRoot });
    const traceability = runTraceability({ repoRoot });
    lastChecks = { semantic, traceability, attempt };

    const green = semantic.exitCode === 0 && traceability.exitCode === 0 && !semantic.placeholder;
    if (green) {
      // --- 5. Map -----------------------------------------------------------
      record({ phase: "mapping", attempt });
      const map = runGenerateMap({ repoRoot });
      const status = {
        status: "green",
        attempts: attempt,
        manifestPath,
        baselineId,
        froze,
        checks: { semantic, traceability },
        map,
        transcripts,
        summary: `extraction green after ${attempt} attempt(s): ${countIssues(repoRoot)} issue(s); map ${map.code === 0 ? "regenerated" : `FAILED (code ${map.code})`}`,
      };
      record({ phase: "green", attempt, summary: status.summary });
      return status;
    }
    // The semantic checker treats an unchanged placeholder index as exit 0 +
    // placeholder:true — that means the agent authored nothing usable. Treat it as
    // a failed attempt so the fix loop re-prompts rather than declaring success.
  }

  // --- Bounded retries exhausted: blocked -----------------------------------
  const status = {
    status: "extraction_blocked",
    attempts: maxAttempts,
    manifestPath,
    baselineId,
    froze,
    checks: lastChecks ? { semantic: lastChecks.semantic, traceability: lastChecks.traceability } : null,
    transcripts,
    summary:
      `extraction_blocked: the deterministic checks were still red after ${maxAttempts} attempt(s). ` +
      formatCheckOutput(lastChecks),
  };
  record({ phase: "extraction_blocked", attempt: maxAttempts, summary: status.summary });
  return status;
}

// ---------------------------------------------------------------------------
// Default seams (the real tooling)
// ---------------------------------------------------------------------------

// Build the real agent-spawn seam: drive a Claude leg with the extractor prompt.
function makeDefaultSpawnAgent(options) {
  const model = options.model ?? CLI_DEFAULTS.claude.model;
  const effort = options.effort ?? CLI_DEFAULTS.claude.effort;
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  return async ({ repoRoot, manifestPath, baselineId, cfg, attempt, checkOutput, isFix }) => {
    const leg = { actor: "claude", role: "extractor", provider: "claude", model, effort, fast: false };
    // The leg cfg points the shared spawn infra at the TARGET repo for the
    // transcript store and at the factory prompts for the role prompt. abs/execRoot
    // resolve against the target so the agent runs inside the project it extracts.
    const legCfg = {
      ...cfg,
      promptsDir,
      // The extractor authors directly in the target; no worktree isolation.
      execRoot: repoRoot,
    };
    // Extra prompt context: the frozen baseline + (on a fix pass) the exact check
    // output, appended to the composed extractor prompt (see legDepsForTarget) so
    // the agent knows precisely what to author/fix this run.
    const issue = {
      id: EXTRACTOR_ISSUE_ID,
      graph_refs: ["node:extraction"],
      path: ISSUE_INDEX_REL,
    };
    // Append the dynamic context to the composed prompt. We compose the base prompt
    // through the shared runner (it reads extractor.md and substitutes issue_id),
    // then the runner spawns claude. The baseline + check context is appended to
    // the prompt file content via a wrapper composePrompt extra below.
    const deps = legDepsForTarget(legCfg, issue, repoRoot, { manifestPath, baselineId, attempt, checkOutput, isFix });
    return runClaudeLeg(leg, issue, legCfg, deps);
  };
}

// Bind the shared Claude leg runner to the TARGET repo's roots, and inject the
// extraction-specific prompt context (frozen manifest + fix check output) by
// wrapping composePrompt so the extra {{baseline_manifest_path}} /
// {{check_output}} / {{attempt}} placeholders resolve.
function legDepsForTarget(legCfg, issue, repoRoot, extra) {
  const abs = (rel) => resolve(repoRoot, rel);
  const context =
    `\n\n---\n\n## Extraction context for this run\n\n` +
    `- Frozen baseline manifest: \`${extra.manifestPath}\` (baseline_id \`${extra.baselineId}\`). ` +
    `Read it for the exact corpus files + hashes to pin.\n` +
    `- Attempt: ${extra.attempt}${extra.isFix ? " (FIX pass)" : " (initial author)"}.\n` +
    (extra.checkOutput
      ? `\n### Deterministic check output to FIX\n\nThe previous corpus FAILED these checks. ` +
        `Read every line, locate the exact file/field, and correct it without regressing the rest:\n\n` +
        "```text\n" +
        extra.checkOutput +
        "\n```\n"
      : "");
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
