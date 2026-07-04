import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { impactedIssues, runReopen } from "./reopen.ts";
import type { ReopenEvent } from "./reopen.ts";

const sm = (excerpts: Array<{ id?: string; source_excerpt_sha256?: string | null }>) => ({ requirement_excerpts: excerpts });

test("impactedIssues returns issues referencing a changed or removed requirement", () => {
  const drift = { changed: ["REQ-A-002"], removed: ["REQ-A-009"], added: [], unchanged: ["REQ-A-001"] };
  const index = {
    issues: [
      { id: "ISS-0001", requirement_ids: ["REQ-A-001"] }, // unchanged -> not impacted
      { id: "ISS-0002", requirement_ids: ["REQ-A-002"] }, // changed -> impacted
      { id: "ISS-0003", requirement_ids: ["REQ-A-009", "REQ-A-001"] }, // removed -> impacted
    ],
  };
  assert.deepEqual(impactedIssues(drift, index), ["ISS-0002", "ISS-0003"]);
});

test("runReopen reopens exactly the impacted done issues and leaves unchanged ones done", () => {
  const root = mkdtempSync(resolve(tmpdir(), "reopen-"));
  try {
    const write = (rel: string, content: string) => {
      const abs = resolve(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    };
    write(
      ".vivicy/development/issue-index.json",
      JSON.stringify({
        issues: [
          { id: "ISS-0001", requirement_ids: ["REQ-A-001"], graph_refs: ["node:a"] },
          { id: "ISS-0002", requirement_ids: ["REQ-A-002"], graph_refs: ["node:b"] },
        ],
      }),
    );
    write(".vivicy/development/issues/done/ISS-0001.md", "# done unchanged");
    write(".vivicy/development/issues/done/ISS-0002.md", "# done changed");

    const prior = sm([
      { id: "REQ-A-001", source_excerpt_sha256: "h1" },
      { id: "REQ-A-002", source_excerpt_sha256: "h2" },
    ]);
    const next = sm([
      { id: "REQ-A-001", source_excerpt_sha256: "h1" },
      { id: "REQ-A-002", source_excerpt_sha256: "h2-NEW" }, // a doc edit changed REQ-A-002
    ]);
    const events: ReopenEvent[] = [];
    const res = runReopen({
      repoRoot: root,
      priorSourceMap: prior,
      currentSourceMap: next,
      crRef: "CR-0001",
      recordEvent: (e) => events.push(e),
      now: () => "2026-06-30T00:00:00Z",
    });

    assert.deepEqual(res.reopened, ["ISS-0002"]);
    assert.ok(existsSync(resolve(root, ".vivicy/development/issues/ISS-0002.md")), "reopened issue is active again");
    assert.ok(!existsSync(resolve(root, ".vivicy/development/issues/done/ISS-0002.md")), "reopened issue left done/");
    assert.ok(existsSync(resolve(root, ".vivicy/development/issues/done/ISS-0001.md")), "unchanged issue stays done");
    assert.equal(events.length, 1);
    assert.equal(events[0].event_type, "issue_reopened");
    assert.equal(events[0].issue_id, "ISS-0002");
    assert.deepEqual(events[0].graph_refs, ["node:b"]);
    assert.deepEqual(events[0].evidence_refs, ["CR-0001"]);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("runReopen does nothing when no requirement changed", () => {
  const root = mkdtempSync(resolve(tmpdir(), "reopen-"));
  try {
    const same = sm([{ id: "REQ-A-001", source_excerpt_sha256: "h1" }]);
    const res = runReopen({ repoRoot: root, priorSourceMap: same, currentSourceMap: same, recordEvent: () => {} });
    assert.deepEqual(res.reopened, []);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
