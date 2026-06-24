#!/usr/bin/env node
// Hook-facing CLI that emits one development progress event through the SAME
// validated path as the MCP tool (recordProgressEvent). Lifecycle hooks in
// Claude Code and Codex CLI run shell commands, not MCP tools, so they call this
// script. It never hand-edits the ledger — the MCP-owned invariant holds because
// both the MCP tool and this CLI go through recordProgressEvent.
//
// Fields are read from `--key value` / `--key=value` flags, falling back to
// PROGRESS_* environment variables (so a hook can inject a fixed actor/role/
// session_ref once and let the command line carry only the per-event fields).
// `graph_refs` and `evidence_refs` accept comma-separated values.
//
// Exit code is 0 on a recorded event, 1 on any validation or write error.
import { recordProgressEvent } from "./progress-ledger.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const eq = token.indexOf("=");
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = "true";
    }
  }
  return out;
}

function list(value) {
  if (value === undefined || value === "") return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const args = parseArgs(process.argv.slice(2));
const pick = (key) => args[key] ?? process.env[`PROGRESS_${key.toUpperCase()}`];

const event = {
  event_type: pick("event_type"),
  issue_id: pick("issue_id"),
  graph_refs: list(pick("graph_refs")),
  actor: pick("actor"),
  session_ref: pick("session_ref"),
};
const role = pick("role");
if (role) event.role = role;
const worktree = pick("worktree");
if (worktree) event.worktree = worktree;
const activeItemId = pick("active_item_id");
if (activeItemId) event.active_item_id = activeItemId;
const timestamp = pick("timestamp");
if (timestamp) event.timestamp = timestamp;
event.evidence_refs = list(pick("evidence_refs"));
const transcriptRefs = list(pick("transcript_refs"));
if (transcriptRefs.length) event.transcript_refs = transcriptRefs;

const paths = {};
const issueIndexPath = pick("issue_index_path");
if (issueIndexPath) paths.issueIndexPath = issueIndexPath;
const progressLedgerPath = pick("progress_ledger_path");
if (progressLedgerPath) paths.progressLedgerPath = progressLedgerPath;

try {
  const ledger = recordProgressEvent(event, paths);
  process.stdout.write(
    `${JSON.stringify({ ok: true, issue_id: event.issue_id, event_type: event.event_type, updated_at: ledger.updated_at })}\n`,
  );
} catch (error) {
  process.stderr.write(`progress-emit failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
