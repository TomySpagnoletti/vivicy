// Deterministic Change-Control re-drive.
//
// After an accepted CR patches canonical, re-freezes, and re-extracts, this reopens EXACTLY
// the issues whose requirements changed or were removed — computed mechanically from the C1'
// excerpt drift, never left to an agent to remember. Unchanged issues stay done. The dev-loop
// then re-implements + re-gates the reopened issues on its next pass.
//
// An issue is "done" when BOTH its file lives under issues/done/ AND the ledger is not
// downgraded, so reopening clears both: move done/ISS-X.md back to active and emit
// issue_reopened. `recordEvent` + `now` are seams for testing.
import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareExcerpts } from "./excerpt-drift.mjs";
import { recordProgressEvent } from "./progress-ledger.mjs";
import { resolveTargetRoot } from "./target-root.mjs";

const ISSUE_INDEX_REL = ".vivicy/development/issue-index.json";
const SOURCE_MAP_REL = ".vivicy/requirements/source-map.json";
const ISSUES_DIR_REL = ".vivicy/development/issues";
const DONE_DIR_REL = ".vivicy/development/issues/done";

// Pure: the ids of issues that reference any changed-or-removed requirement.
export function impactedIssues(drift, issueIndex) {
  const impacted = new Set([...(drift?.changed ?? []), ...(drift?.removed ?? [])]);
  const issues = Array.isArray(issueIndex?.issues) ? issueIndex.issues : [];
  return issues.filter((iss) => (iss.requirement_ids ?? []).some((r) => impacted.has(r))).map((iss) => iss.id);
}

function readJsonSafe(abs) {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

// Reopen the impacted, currently-done issues. Returns { drift, impacted, reopened }.
export function runReDrive({
  repoRoot = resolveTargetRoot(),
  priorSourceMap,
  currentSourceMap,
  crRef = null,
  recordEvent = recordProgressEvent,
  now = () => new Date().toISOString(),
} = {}) {
  const drift = compareExcerpts(priorSourceMap, currentSourceMap);
  const issueIndex = readJsonSafe(resolve(repoRoot, ISSUE_INDEX_REL)) ?? { issues: [] };
  const issuesById = new Map((issueIndex.issues ?? []).map((iss) => [iss.id, iss]));
  const impacted = impactedIssues(drift, issueIndex);
  const reopened = [];
  const timestamp = now();
  for (const id of impacted) {
    const donePath = resolve(repoRoot, DONE_DIR_REL, `${id}.md`);
    if (!existsSync(donePath)) continue; // only reopen issues that were actually done
    renameSync(donePath, resolve(repoRoot, ISSUES_DIR_REL, `${id}.md`));
    const issue = issuesById.get(id) ?? { id, graph_refs: [] };
    recordEvent({
      event_type: "issue_reopened",
      issue_id: id,
      graph_refs: issue.graph_refs ?? [],
      actor: "orchestrator",
      session_ref: `change-control${crRef ? `:${crRef}` : ""}`,
      evidence_refs: crRef ? [crRef] : [],
      timestamp,
    });
    reopened.push(id);
  }
  return { drift, impacted, reopened };
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT.");
    process.exit(2);
  }
  const args = process.argv.slice(2);
  const priorIdx = args.indexOf("--prior");
  const priorPath = priorIdx !== -1 ? args[priorIdx + 1] : null;
  if (!priorPath) {
    console.error("usage: re-drive.mjs --prior <prior baseline source-map.json> [--cr CR-####]");
    process.exit(2);
  }
  const crIdx = args.indexOf("--cr");
  const crRef = crIdx !== -1 ? args[crIdx + 1] : null;
  const priorSourceMap = readJsonSafe(resolve(repoRoot, priorPath));
  const currentSourceMap = readJsonSafe(resolve(repoRoot, SOURCE_MAP_REL));
  if (!priorSourceMap || !currentSourceMap) {
    console.error(`error: missing source-map (prior=${Boolean(priorSourceMap)}, current=${Boolean(currentSourceMap)})`);
    process.exit(1);
  }
  const result = runReDrive({ repoRoot, priorSourceMap, currentSourceMap, crRef });
  console.log(`re-drive: reopened ${result.reopened.length} impacted issue(s): ${result.reopened.join(", ") || "none"}`);
}
