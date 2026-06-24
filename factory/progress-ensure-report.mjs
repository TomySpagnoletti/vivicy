#!/usr/bin/env node
// Stop-hook safety net. Determinism over agent goodwill: if the agent finished a
// leg WITHOUT emitting any progress event for its session (no active item with
// this session_ref), the hook emits a fallback event itself — through the same
// validated recordProgressEvent path — so the map never goes stale because an
// agent "forgot" to report.
//
// The orchestrator injects PROGRESS_* env per leg (issue, graph refs, actor,
// role, session, and the fallback event_type to emit). Exit 0 always: a hook
// must never block the agent's own Stop.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { recordProgressEvent } from "./progress-ledger.mjs";
import { resolveTargetRoot } from "./target-root.mjs";

const repoRoot = resolveTargetRoot();

// Pure + unit-tested: did this session already report?
export function needsFallbackReport(ledger, sessionRef) {
  const items = Array.isArray(ledger?.active_items) ? ledger.active_items : [];
  return !items.some((item) => item.session_ref === sessionRef);
}

function readLedger(relPath) {
  const abs = isAbsolute(relPath) ? relPath : resolve(repoRoot, relPath);
  if (!existsSync(abs)) return { active_items: [] };
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return { active_items: [] };
  }
}

function list(value) {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function main() {
  const env = process.env;
  const sessionRef = env.PROGRESS_SESSION_REF;
  const ledgerPath = env.PROGRESS_PROGRESS_LEDGER_PATH ?? "spec/development/progress-ledger.json";
  if (!sessionRef) return; // nothing to correlate; do not interfere.

  if (!needsFallbackReport(readLedger(ledgerPath), sessionRef)) return; // agent already reported.

  const event = {
    event_type: env.PROGRESS_EVENT_TYPE ?? "heartbeat",
    issue_id: env.PROGRESS_ISSUE_ID,
    graph_refs: list(env.PROGRESS_GRAPH_REFS),
    actor: env.PROGRESS_ACTOR,
    session_ref: sessionRef,
    evidence_refs: list(env.PROGRESS_EVIDENCE_REFS),
  };
  if (env.PROGRESS_ROLE) event.role = env.PROGRESS_ROLE;
  const paths = {};
  if (env.PROGRESS_ISSUE_INDEX_PATH) paths.issueIndexPath = env.PROGRESS_ISSUE_INDEX_PATH;
  if (env.PROGRESS_PROGRESS_LEDGER_PATH) paths.progressLedgerPath = env.PROGRESS_PROGRESS_LEDGER_PATH;

  try {
    recordProgressEvent(event, paths);
  } catch (error) {
    process.stderr.write(`progress-ensure-report fallback failed: ${error instanceof Error ? error.message : String(error)}\n`);
    // Still exit 0 below: a Stop hook must not block the agent.
  }
}

main();
