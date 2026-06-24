#!/usr/bin/env node
// Read-only health probe for a dev-loop / rehearsal run. Any agent can ask
// "is the run going well?" instead of waiting blind for a success/fail.
//
//   node vivicy/factory/dev-status.mjs                # the vendored project
//   node vivicy/factory/dev-status.mjs --dir <root>   # a specific root (e.g. a rehearsal temp)
//   VIVICY_TARGET_ROOT=<root> node vivicy/factory/dev-status.mjs
//   node vivicy/factory/dev-status.mjs --json          # machine-readable
//
// It never writes anything. It reads the issue index, the progress ledger, the
// done/ folder, and gate records, and inspects live processes + file activity to
// distinguish RUNNING / STALE / STOPPED / BLOCKED / DONE.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTargetRoot } from "./target-root.mjs";

const STALE_IDLE_SECONDS = 600; // process alive but no file activity this long => suspect stall

function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const asJson = process.argv.includes("--json");
const dir = flag("--dir");
const root = dir ? resolve(dir) : resolveTargetRoot();

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function ageSeconds(ts) {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null;
}
// Render one window's real percentage honestly: "5h 38%" when known, "5h —"
// when the provider exposes no number (we never fabricate a percentage).
function formatWindow(label, win) {
  if (!win) return null;
  const pct = typeof win.used_pct === "number" ? `${Math.round(win.used_pct)}%` : "—";
  return `${label} ${pct}`;
}

// One-line human summary of the per-agent quota block for the text output.
// Surfaces the REAL 5h + weekly percentages when present (honest "—" otherwise).
function formatQuotaLine(quota) {
  const agents = quota?.agents ?? {};
  const names = Object.keys(agents);
  if (names.length === 0) return "(unknown)";
  return names
    .map((name) => {
      const a = agents[name];
      const model = a.model ? ` ${a.model}` : "";
      const windows = a.windows ?? {};
      const pcts = [formatWindow("5h", windows["5h"]), formatWindow("wk", windows.weekly)]
        .filter(Boolean)
        .join(" · ");
      const pctSuffix = pcts ? ` (${pcts})` : "";
      if (a.status === "throttled") {
        const eta = a.reset_at ? `, resets ${a.reset_at}` : "";
        return `${name}${model}: throttled${eta}${pctSuffix}`;
      }
      return `${name}${model}: ${a.status ?? "available"}${pctSuffix}`;
    })
    .join("; ");
}

function newestMtimeMs(path) {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return st.mtimeMs;
    let m = st.mtimeMs;
    for (const entry of readdirSync(path)) m = Math.max(m, newestMtimeMs(join(path, entry)));
    return m;
  } catch {
    return 0;
  }
}

const index = readJson(join(root, "spec/development/issue-index.json"), { issues: [] });
const issues = Array.isArray(index.issues) ? index.issues : [];

// Per-agent quota/rate-limit state written by the dev-loop quota handler.
// Absent or unreadable => unknown (we report nothing rather than fabricating a
// number). The handler keeps this honest: only real status + a parsed reset.
const quota = readJson(join(root, "spec/development/reports/quota-state.json"), {
  updated_at: null,
  agents: {},
});
const ledger = readJson(join(root, "spec/development/progress-ledger.json"), { graph_item_states: [], active_items: [] });
const doneDir = join(root, "spec/development/issues/done");
const doneFiles = existsSync(doneDir) ? readdirSync(doneDir).filter((f) => f.endsWith(".md")) : [];
const gatesDir = join(root, "spec/development/gates");
const gateRecords = existsSync(gatesDir)
  ? readdirSync(gatesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, ...readJson(join(gatesDir, f), {}) }))
  : [];

// Per-issue done: file in done/ OR this issue verified on every one of its graph refs.
const verifiedIssuesByRef = new Map();
for (const state of ledger.graph_item_states ?? []) {
  const verified = Object.entries(state.issue_states ?? {})
    .filter(([, s]) => s === "verified")
    .map(([id]) => id);
  verifiedIssuesByRef.set(state.graph_ref, new Set(verified));
}
function issueDone(issue) {
  if (doneFiles.includes(`${issue.id}.md`)) return true;
  const refs = Array.isArray(issue.graph_refs) ? issue.graph_refs : [];
  return refs.length > 0 && refs.every((ref) => verifiedIssuesByRef.get(ref)?.has(issue.id));
}
const doneIds = issues.filter(issueDone).map((i) => i.id);
const blockedGates = gateRecords.filter((g) => g.status === "fail");
const activeItems = (ledger.active_items ?? []).map((a) => ({
  issue_id: a.issue_id,
  state: a.state,
  actor: a.actor,
  heartbeat_age_s: ageSeconds(a.heartbeat_at ?? a.started_at),
}));

// Live process + file-activity signals.
let psOut = "";
try {
  psOut = execFileSync("ps", ["-Ao", "pid,etime,command"], { encoding: "utf8" });
} catch {
  psOut = "";
}
const loopLine = psOut.split("\n").find((l) => /dev-(loop|rehearsal)\.mjs/.test(l) && !/dev-status\.mjs/.test(l));
const codexLegs = psOut.split("\n").filter((l) => /codex exec/.test(l) && l.includes(root)).length;
const idleMs = Date.now() - Math.max(
  newestMtimeMs(join(root, "spec/development/transcripts")),
  newestMtimeMs(join(root, "spec/development/gates")),
  newestMtimeMs(join(root, "spec/development/progress-ledger.json")),
  newestMtimeMs(join(root, "src")),
  newestMtimeMs(join(root, "test")),
);
const idleSeconds = Number.isFinite(idleMs) ? Math.round(idleMs / 1000) : null;
const processAlive = Boolean(loopLine);

let verdict;
if (issues.length > 0 && doneIds.length === issues.length) verdict = "DONE";
else if (processAlive && idleSeconds !== null && idleSeconds > STALE_IDLE_SECONDS) verdict = "STALE?";
else if (processAlive) verdict = "RUNNING";
else if (blockedGates.length > 0 && doneIds.length < issues.length) verdict = "STOPPED (last gate failed)";
else if (doneIds.length > 0) verdict = "STOPPED (resume to continue)";
else verdict = "NOT STARTED";

const status = {
  root,
  verdict,
  issues_total: issues.length,
  issues_done: doneIds.length,
  done: doneIds,
  remaining: issues.filter((i) => !doneIds.includes(i.id)).map((i) => i.id),
  active: activeItems,
  process_alive: processAlive,
  codex_legs_running: codexLegs,
  idle_seconds: idleSeconds,
  gates: { pass: gateRecords.filter((g) => g.status === "pass").length, fail: blockedGates.length },
  quota: quota && typeof quota === "object" && quota.agents ? quota : { updated_at: null, agents: {} },
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
} else {
  const bar = `${doneIds.length}/${issues.length || "?"}`;
  process.stdout.write(
    [
      `dev run @ ${root}`,
      `verdict:   ${verdict}`,
      `progress:  ${bar} issues verified${status.remaining.length ? ` — next: ${status.remaining[0]}` : ""}`,
      `done:      ${doneIds.join(", ") || "(none)"}`,
      `active:    ${activeItems.map((a) => `${a.issue_id}:${a.state}(${a.actor}, hb ${a.heartbeat_age_s ?? "?"}s)`).join(", ") || "(none)"}`,
      `process:   ${processAlive ? "alive" : "not running"}${codexLegs ? `, ${codexLegs} codex leg(s)` : ""}, idle ${idleSeconds ?? "?"}s`,
      `gates:     ${status.gates.pass} pass, ${status.gates.fail} fail`,
      `quota:     ${formatQuotaLine(status.quota)}`,
    ].join("\n") + "\n",
  );
}
process.exit(0);
