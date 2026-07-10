import { existsSync, readFileSync, renameSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compareExcerpts } from "./excerpt-drift.ts";
import type { ExcerptDrift, SourceMap } from "./excerpt-drift.ts";
import { recordProgressEvent } from "./progress-ledger.ts";
import { resolveTargetRoot } from "./target-root.ts";

const ISSUE_INDEX_REL = ".vivicy/development/issue-index.json";
const SOURCE_MAP_REL = ".vivicy/requirements/source-map.json";
const ISSUES_DIR_REL = ".vivicy/development/issues";
const DONE_DIR_REL = ".vivicy/development/issues/done";

interface IssueIndexEntry {
  id: string;
  requirement_ids?: string[];
  graph_refs?: string[];
}
interface IssueIndex {
  issues?: IssueIndexEntry[];
}

export interface ReopenEvent {
  event_type: "issue_reopened";
  issue_id: string;
  graph_refs: string[];
  actor: string;
  session_ref: string;
  evidence_refs: string[];
  timestamp: string;
}

export function impactedIssues(drift: ExcerptDrift | null | undefined, issueIndex: IssueIndex | null | undefined): string[] {
  const impacted = new Set([...(drift?.changed ?? []), ...(drift?.removed ?? [])]);
  const issues = Array.isArray(issueIndex?.issues) ? issueIndex.issues : [];
  return issues.filter((iss) => (iss.requirement_ids ?? []).some((r) => impacted.has(r))).map((iss) => iss.id);
}

function readJsonSafe<T>(abs: string): T | null {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8")) as T;
  } catch {
    return null;
  }
}

// "done" = file under issues/done/ AND ledger not downgraded; reopen must do both (move the file back + emit issue_reopened) or the two fall out of sync.
export function runReopen({
  repoRoot = resolveTargetRoot(),
  priorSourceMap,
  currentSourceMap,
  crRef = null,
  recordEvent = recordProgressEvent,
  now = () => new Date().toISOString(),
}: {
  repoRoot?: string | null;
  priorSourceMap?: SourceMap | null;
  currentSourceMap?: SourceMap | null;
  crRef?: string | null;
  recordEvent?: (event: ReopenEvent) => void;
  now?: () => string;
} = {}): { drift: ExcerptDrift; impacted: string[]; reopened: string[] } {
  const drift = compareExcerpts(priorSourceMap, currentSourceMap);
  const issueIndex = readJsonSafe<IssueIndex>(resolve(repoRoot!, ISSUE_INDEX_REL)) ?? { issues: [] };
  const issuesById = new Map((issueIndex.issues ?? []).map((iss) => [iss.id, iss]));
  const impacted = impactedIssues(drift, issueIndex);
  const reopened: string[] = [];
  const timestamp = now();
  for (const id of impacted) {
    const donePath = resolve(repoRoot!, DONE_DIR_REL, `${id}.md`);
    if (!existsSync(donePath)) continue;
    renameSync(donePath, resolve(repoRoot!, ISSUES_DIR_REL, `${id}.md`));
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
    console.error("usage: reopen.ts --prior <prior baseline source-map.json> [--cr CR-####]");
    process.exit(2);
  }
  const crIdx = args.indexOf("--cr");
  const crRef = crIdx !== -1 ? args[crIdx + 1] : null;
  const priorSourceMap = readJsonSafe<SourceMap>(resolve(repoRoot, priorPath));
  const currentSourceMap = readJsonSafe<SourceMap>(resolve(repoRoot, SOURCE_MAP_REL));
  if (!priorSourceMap || !currentSourceMap) {
    console.error(`error: missing source-map (prior=${Boolean(priorSourceMap)}, current=${Boolean(currentSourceMap)})`);
    process.exit(1);
  }
  const result = runReopen({ repoRoot, priorSourceMap, currentSourceMap, crRef });
  console.log(`reopen: reopened ${result.reopened.length} impacted issue(s): ${result.reopened.join(", ") || "none"}`);
}
