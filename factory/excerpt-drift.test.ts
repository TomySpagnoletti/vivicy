import assert from "node:assert/strict";
import test from "node:test";

import { compareExcerpts, excerptMap, formatExcerptDrift } from "./excerpt-drift.ts";

const sm = (excerpts: Array<{ id?: string; source_excerpt_sha256?: string | null }>) => ({ requirement_excerpts: excerpts });

test("excerptMap builds id -> hash from requirement_excerpts; tolerates a missing array", () => {
  const m = excerptMap(sm([{ id: "REQ-A-001", source_excerpt_sha256: "h1" }]));
  assert.equal(m.get("REQ-A-001"), "h1");
  assert.equal(excerptMap({}).size, 0);
  assert.equal(excerptMap(null).size, 0);
});

test("compareExcerpts classifies unchanged / changed / added / removed", () => {
  const prior = sm([
    { id: "REQ-A-001", source_excerpt_sha256: "h1" },
    { id: "REQ-A-002", source_excerpt_sha256: "h2" },
    { id: "REQ-A-003", source_excerpt_sha256: "h3" },
  ]);
  const next = sm([
    { id: "REQ-A-001", source_excerpt_sha256: "h1" }, // unchanged
    { id: "REQ-A-002", source_excerpt_sha256: "h2-NEW" }, // changed by a doc edit
    { id: "REQ-A-004", source_excerpt_sha256: "h4" }, // added
    // REQ-A-003 removed
  ]);
  const d = compareExcerpts(prior, next);
  assert.deepEqual(d.unchanged, ["REQ-A-001"]);
  assert.deepEqual(d.changed, ["REQ-A-002"]);
  assert.deepEqual(d.added, ["REQ-A-004"]);
  assert.deepEqual(d.removed, ["REQ-A-003"]);
});

test("formatExcerptDrift maps changed->amended, added->new, removed->removed + counts unchanged", () => {
  const s = formatExcerptDrift({ unchanged: ["x"], changed: ["c"], added: ["a"], removed: ["r"] });
  assert.match(s, /amended \(excerpt changed\): c/);
  assert.match(s, /new: a/);
  assert.match(s, /removed: r/);
  assert.match(s, /unchanged: 1/);
});

test("formatExcerptDrift reports cleanly when nothing changed", () => {
  assert.match(
    formatExcerptDrift({ unchanged: ["a", "b"], changed: [], added: [], removed: [] }),
    /no requirement excerpts changed/,
  );
});
