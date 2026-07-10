#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSpikes } from "./spike-check.ts";
import { resolveTargetRoot } from "./target-root.ts";

const repoRoot = resolveTargetRoot();

const ISSUE_INDEX = ".vivicy/development/issue-index.json";
const CATALOG = ".vivicy/requirements/catalog.json";
const MATRIX = ".vivicy/requirements/traceability-matrix.json";
const MVP_DISPOSITIONS = new Set(["must_implement", "must_test", "must_verify_with_spike"]);
const MVP_MATURITIES = new Set(["mvp", "phase_0_spike"]);

interface Issue {
  id: string;
  requirement_ids?: string[];
  spike_gates?: string[];
}
interface IssueIndex {
  issues?: Issue[];
}
interface Requirement {
  id: string;
  maturity: string;
  disposition: string;
  coveredByIssues?: string[];
}
interface Catalog {
  requirements?: Requirement[];
}

export interface TraceabilityCheckResult {
  exitCode: number;
  errors: string[];
  placeholder: boolean;
  summary: string;
}

export function runTraceabilityCheck(options: { repoRoot?: string } = {}): TraceabilityCheckResult {
  const root = options.repoRoot ?? repoRoot!;
  const errors: string[] = [];
  const fail = (rule: string, scope: string, evidence: string, expected: string, requiredFix: string) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };
  const readJson = <T>(rel: string): T => JSON.parse(readFileSync(resolveInside(root, rel), "utf8")) as T;

  let index: IssueIndex;
  try {
    index = readJson<IssueIndex>(ISSUE_INDEX);
  } catch (error) {
    return done([`Unable to read issue index ${ISSUE_INDEX}: ${(error as Error).message}`], "no issue index");
  }
  const issues = Array.isArray(index.issues) ? index.issues : [];

  if (issues.length === 0) {
    return { exitCode: 0, errors: [], placeholder: true, summary: "traceability-check: nothing to check yet (no issues extracted)" };
  }

  if (!existsSync(resolveInside(root, CATALOG))) {
    fail("catalog_required", CATALOG, "file missing while issues exist", "the Requirement Catalog exists once extraction has run", `author ${CATALOG}`);
    return done(errors);
  }
  if (!existsSync(resolveInside(root, MATRIX))) {
    fail("matrix_required", MATRIX, "file missing while issues exist", "the Traceability Matrix exists once extraction has run", `author ${MATRIX}`);
    return done(errors);
  }

  let catalog: Catalog;
  try {
    catalog = readJson<Catalog>(CATALOG);
  } catch (error) {
    fail("catalog_parse", CATALOG, `unable to parse: ${(error as Error).message}`, "the Requirement Catalog is valid JSON", `fix ${CATALOG}`);
    return done(errors);
  }
  const requirements = Array.isArray(catalog.requirements) ? catalog.requirements : [];
  const catalogById = new Map(requirements.map((r) => [r.id, r]));

  const referenced = new Set<string>();
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

  // Spike verification status is enforced elsewhere (dev-loop readiness gate); a freshly-extracted spike is `pending` here.
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

  const spikeRequirementIds = new Set<string>();
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

function done(errors: string[], scope = ""): TraceabilityCheckResult {
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

function resolveInside(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`Path must be repository-relative: ${rel}`);
  const absolute = resolve(root, rel);
  const r = relative(root, absolute);
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error(`Path must stay inside repository: ${rel}`);
  return absolute;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
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
