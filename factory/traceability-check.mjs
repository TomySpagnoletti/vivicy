#!/usr/bin/env node
// traceability:check — the implementation-coverage gate from the Development
// Traceability Method. It is the complement of semantic-extraction:check (which
// proves SOURCE coverage): this proves every requirement is carried forward to an
// issue, and every issue points at real requirements. It is deterministic and
// read-only.
//
//   VIVICY_TARGET_ROOT=<root> node vivicy/factory/traceability-check.mjs
//
// Until extraction has run (the committed placeholder issue index has no
// issues), it exits 0 with "nothing to check yet", mirroring
// semantic-extraction:check. Once issues exist it requires the Requirement
// Catalog and Traceability Matrix and enforces the coverage rules below.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSpikes } from "./spike-check.mjs";
import { resolveTargetRoot } from "./target-root.mjs";

const repoRoot = resolveTargetRoot();

const ISSUE_INDEX = ".vivicy/development/issue-index.json";
const CATALOG = ".vivicy/requirements/catalog.json";
const MATRIX = ".vivicy/requirements/traceability-matrix.json";
const MVP_DISPOSITIONS = new Set(["must_implement", "must_test", "must_verify_with_spike"]);
const MVP_MATURITIES = new Set(["mvp", "phase_0_spike"]);

export function runTraceabilityCheck(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const errors = [];
  const fail = (rule, scope, evidence, expected, requiredFix) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };
  const readJson = (rel) => JSON.parse(readFileSync(resolveInside(root, rel), "utf8"));

  let index;
  try {
    index = readJson(ISSUE_INDEX);
  } catch (error) {
    return done([`Unable to read issue index ${ISSUE_INDEX}: ${error.message}`], "no issue index");
  }
  const issues = Array.isArray(index.issues) ? index.issues : [];

  // Placeholder: extraction has not run yet -> nothing to check (like sec:check).
  if (issues.length === 0) {
    return { exitCode: 0, errors: [], placeholder: true, summary: "traceability-check: nothing to check yet (no issues extracted)" };
  }

  // Once issues exist, the catalog and matrix are mandatory (Development Traceability Method).
  if (!existsSync(resolveInside(root, CATALOG))) {
    fail("catalog_required", CATALOG, "file missing while issues exist", "the Requirement Catalog exists once extraction has run", `author ${CATALOG}`);
    return done(errors);
  }
  if (!existsSync(resolveInside(root, MATRIX))) {
    fail("matrix_required", MATRIX, "file missing while issues exist", "the Traceability Matrix exists once extraction has run", `author ${MATRIX}`);
    return done(errors);
  }

  let catalog;
  try {
    catalog = readJson(CATALOG);
  } catch (error) {
    fail("catalog_parse", CATALOG, `unable to parse: ${error.message}`, "the Requirement Catalog is valid JSON", `fix ${CATALOG}`);
    return done(errors);
  }
  const requirements = Array.isArray(catalog.requirements) ? catalog.requirements : [];
  const catalogById = new Map(requirements.map((r) => [r.id, r]));

  // 1. Every requirement_id referenced by an issue must exist in the catalog.
  const referenced = new Set();
  for (const issue of issues) {
    for (const reqId of issue.requirement_ids ?? []) {
      referenced.add(reqId);
      if (!catalogById.has(reqId)) {
        fail(
          "issue_requirement_resolves",
          `issue ${issue.id}`,
          `requirement_id ${reqId} not in the catalog`,
          "every issue requirement_id resolves to a catalog requirement",
          `add ${reqId} to ${CATALOG} or correct the issue`,
        );
      }
    }
  }

  // 2. Every MVP/must-implement requirement must be covered by at least one issue.
  for (const req of requirements) {
    const isMvp = MVP_MATURITIES.has(req.maturity) && MVP_DISPOSITIONS.has(req.disposition);
    if (!isMvp) continue;
    const coveredByIssues = Array.isArray(req.coveredByIssues) && req.coveredByIssues.length > 0;
    if (!referenced.has(req.id) && !coveredByIssues) {
      fail(
        "requirement_covered",
        `requirement ${req.id}`,
        `maturity=${req.maturity} disposition=${req.disposition} has no covering issue`,
        "every MVP must_implement requirement is covered by at least one issue",
        `add an issue whose requirement_ids include ${req.id}, or change its disposition`,
      );
    }
  }

  // 3. coveredByIssues must reference real issues.
  const issueIds = new Set(issues.map((i) => i.id));
  for (const req of requirements) {
    for (const issueId of req.coveredByIssues ?? []) {
      if (!issueIds.has(issueId)) {
        fail(
          "covered_by_resolves",
          `requirement ${req.id}`,
          `coveredByIssues references unknown issue ${issueId}`,
          "every coveredByIssues entry resolves to an issue in the index",
          `correct ${req.id}.coveredByIssues in ${CATALOG}`,
        );
      }
    }
  }

  // 4. Spike referential integrity + back-fill. Every issue spike_gate must
  //    resolve to a well-formed spike on disk, and every spike's requirement_ids
  //    must be back-filled (not the template placeholder) and resolve to the
  //    catalog. Verification STATUS is enforced at build time by the dev-loop
  //    readiness gate, not here: at extraction a freshly-minted spike is `pending`.
  const spikes = readSpikes(root);
  const spikeGateIds = new Set(spikes.map((spike) => spike.gate_id));
  for (const issue of issues) {
    for (const gateId of issue.spike_gates ?? []) {
      if (!spikeGateIds.has(gateId)) {
        fail(
          "issue_spike_resolves",
          `issue ${issue.id}`,
          `spike_gate ${gateId} has no well-formed spike under .vivicy/development/spikes/`,
          "every issue spike_gate resolves to an existing spike",
          `author the spike for ${gateId} or correct the issue's spike_gates`,
        );
      }
    }
  }
  for (const spike of spikes) {
    const reqField = (spike.requirement_ids ?? "").trim();
    if (/^pending-extraction\b/.test(reqField)) {
      fail(
        "spike_requirement_backfilled",
        spike.file,
        "requirement_ids is still the template placeholder",
        "extraction back-fills each spike's requirement_ids with the catalog id(s) it gates",
        `set requirement_ids in ${spike.file} to the phase_0_spike requirement id(s)`,
      );
      continue;
    }
    for (const reqId of reqField.split(/[\s,]+/).filter(Boolean)) {
      if (!catalogById.has(reqId)) {
        fail(
          "spike_requirement_resolves",
          spike.file,
          `requirement_id ${reqId} is not in the catalog`,
          "every spike requirement_id resolves to a catalog requirement",
          `add ${reqId} to ${CATALOG} or correct ${spike.file}`,
        );
      }
    }
  }

  // 5. Every must_verify_with_spike requirement must be gated by a spike: some
  //    spike's (back-filled) requirement_ids must reference it. This closes the
  //    loop — an obligation that depends on unproven external behaviour cannot
  //    reach implementation without a spike standing as its evidence gate.
  const spikeRequirementIds = new Set();
  for (const spike of spikes) {
    for (const id of (spike.requirement_ids ?? "").split(/[\s,]+/).filter(Boolean)) spikeRequirementIds.add(id);
  }
  for (const req of requirements) {
    if (req.disposition === "must_verify_with_spike" && !spikeRequirementIds.has(req.id)) {
      fail(
        "spike_requirement_gated",
        `requirement ${req.id}`,
        "disposition is must_verify_with_spike but no spike references it",
        "every must_verify_with_spike requirement is gated by a spike",
        `author a spike whose requirement_ids include ${req.id}`,
      );
    }
  }

  return done(errors, `${requirements.length} requirement(s), ${issues.length} issue(s)`);
}

function done(errors, scope = "") {
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    errors,
    placeholder: false,
    summary:
      errors.length > 0
        ? `traceability-check: FAILED with ${errors.length} error(s)`
        : `traceability-check: OK${scope ? ` (${scope})` : ""}`,
  };
}

function resolveInside(root, rel) {
  if (isAbsolute(rel)) throw new Error(`Path must be repository-relative: ${rel}`);
  const absolute = resolve(root, rel);
  const r = relative(root, absolute);
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error(`Path must stay inside repository: ${rel}`);
  return absolute;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  // Vivicy is standalone: with no target there is nothing to check, so exit
  // clearly instead of guessing a directory.
  if (!repoRoot) {
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check.",
    );
    process.exit(2);
  }
  const result = runTraceabilityCheck();
  for (const error of result.errors) console.error(`error:\n${error}`);
  console.log(result.summary);
  process.exit(result.exitCode);
}
