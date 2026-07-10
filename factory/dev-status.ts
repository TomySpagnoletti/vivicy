#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveTargetRoot } from "./target-root.ts";

const STALE_IDLE_SECONDS = 600;

function flag(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
const asJson = process.argv.includes("--json");
const dir = flag("--dir");
// Deliberate: the cast keeps join(root, …) crashing on an unset target instead of guarding it away.
const root = (dir ? resolve(dir) : resolveTargetRoot()) as string;

interface Issue {
  id: string;
  graph_refs?: string[];
}
interface IssueIndex {
  issues?: Issue[];
}
interface GraphItemState {
  graph_ref: string;
  issue_states?: Record<string, string>;
}
interface ActiveItem {
  issue_id: string;
  state: string;
  actor: string;
  heartbeat_at?: string;
  started_at?: string;
}
interface Ledger {
  graph_item_states?: GraphItemState[];
  active_items?: ActiveItem[];
}
interface QuotaWindow {
  used_pct?: number;
}
interface QuotaAgent {
  model?: string;
  windows?: Record<string, QuotaWindow | undefined>;
  status?: string;
  reset_at?: string;
}
interface Quota {
  updated_at: string | null;
  agents?: Record<string, QuotaAgent>;
}
interface GateRecord {
  file: string;
  status?: string;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}
function ageSeconds(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? Math.round((Date.now() - ms) / 1000) : null;
}
function formatWindow(label: string, win: QuotaWindow | undefined): string | null {
  if (!win) return null;
  const pct = typeof win.used_pct === "number" ? `${Math.round(win.used_pct)}%` : "—";
  return `${label} ${pct}`;
}

function formatQuotaLine(quota: Quota): string {
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

function newestMtimeMs(path: string): number {
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

const index = readJson<IssueIndex>(join(root, ".vivicy/development/issue-index.json"), { issues: [] });
const issues = Array.isArray(index.issues) ? index.issues : [];

const quota = readJson<Quota>(join(root, ".vivicy/development/reports/quota-state.json"), {
  updated_at: null,
  agents: {},
});
const ledger = readJson<Ledger>(join(root, ".vivicy/development/progress-ledger.json"), { graph_item_states: [], active_items: [] });
const doneDir = join(root, ".vivicy/development/issues/done");
const doneFiles = existsSync(doneDir) ? readdirSync(doneDir).filter((f) => f.endsWith(".md")) : [];
const gatesDir = join(root, ".vivicy/development/gates");
const gateRecords: GateRecord[] = existsSync(gatesDir)
  ? readdirSync(gatesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => ({ file: f, ...readJson<{ status?: string }>(join(gatesDir, f), {}) }))
  : [];

const verifiedIssuesByRef = new Map<string, Set<string>>();
for (const state of ledger.graph_item_states ?? []) {
  const verified = Object.entries(state.issue_states ?? {})
    .filter(([, s]) => s === "verified")
    .map(([id]) => id);
  verifiedIssuesByRef.set(state.graph_ref, new Set(verified));
}
function issueDone(issue: Issue): boolean {
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

let psOut = "";
try {
  psOut = execFileSync("ps", ["-Ao", "pid,etime,command"], { encoding: "utf8" });
} catch {
  psOut = "";
}
const loopLine = psOut.split("\n").find((l) => /dev-(loop|rehearsal)\.ts/.test(l) && !/dev-status\.ts/.test(l));
const codexLegs = psOut.split("\n").filter((l) => /codex exec/.test(l) && l.includes(root)).length;
const idleMs = Date.now() - Math.max(
  newestMtimeMs(join(root, ".vivicy/development/transcripts")),
  newestMtimeMs(join(root, ".vivicy/development/gates")),
  newestMtimeMs(join(root, ".vivicy/development/progress-ledger.json")),
  newestMtimeMs(join(root, "src")),
  newestMtimeMs(join(root, "test")),
);
const idleSeconds = Number.isFinite(idleMs) ? Math.round(idleMs / 1000) : null;
const processAlive = Boolean(loopLine);

let verdict: string;
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
