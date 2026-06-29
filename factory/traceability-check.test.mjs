import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runTraceabilityCheck } from "./traceability-check.mjs";

function fixture({ issues, requirements }) {
  const root = mkdtempSync(resolve(tmpdir(), "traceability-check-"));
  const write = (rel, obj) => {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(obj, null, 2)}\n`);
  };
  write(".vivicy/development/issue-index.json", { schema_version: 1, issues });
  if (requirements) {
    write(".vivicy/requirements/catalog.json", { requirements });
    write(".vivicy/requirements/traceability-matrix.json", { rows: [] });
  }
  return {
    run: () => runTraceabilityCheck({ repoRoot: root }),
    cleanup: () => rmSync(root, { force: true, recursive: true }),
  };
}

const req = (id, over = {}) => ({ id, maturity: "mvp", disposition: "must_implement", coveredByIssues: [], ...over });

test("placeholder index: nothing to check yet", () => {
  const f = fixture({ issues: [] });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 0);
    assert.equal(r.placeholder, true);
  } finally {
    f.cleanup();
  }
});

test("passes when MVP requirements are covered and all refs resolve", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
  });
  try {
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("fails when an issue references an unknown requirement", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-GHOST-999"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /REQ-GHOST-999/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("fails when an MVP requirement is covered by no issue", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] }), req("REQ-B-002")],
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /REQ-B-002/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("requires the catalog once issues exist", () => {
  const f = fixture({ issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"] }] }); // no requirements => no catalog
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /catalog_required/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});
