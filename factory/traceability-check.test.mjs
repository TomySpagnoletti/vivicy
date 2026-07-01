import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { runTraceabilityCheck } from "./traceability-check.mjs";

function fixture({ issues, requirements, spikes }) {
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
  for (const [name, content] of Object.entries(spikes ?? {})) {
    const abs = resolve(root, ".vivicy/development/spikes", name);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
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

// gate_id MUST equal `gate:phase0:s<filename-stem>` or readSpikes skips the file.
const spikeMd = ({ slug, status = "pending", reqIds = "REQ-A-001" }) =>
  [
    "# S01 - X",
    "## Traceability",
    "```text",
    `requirement_ids: ${reqIds}`,
    `gate_id: gate:phase0:s${slug}`,
    `status: ${status}`,
    "```",
  ].join("\n");

test("spike gating: an issue spike_gate resolving to a pending spike passes (referential-only)", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s01-x"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
    spikes: { "01-x.md": spikeMd({ slug: "01-x", status: "pending", reqIds: "REQ-A-001" }) },
  });
  try {
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("spike gating: an issue spike_gate with no spike file fails", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s99-missing"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /issue_spike_resolves/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("spike gating: a malformed gate_id (slug != filename) does not resolve -> issue fails", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s01-x"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
    spikes: { "01-x.md": spikeMd({ slug: "99-wrong", reqIds: "REQ-A-001" }) },
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /issue_spike_resolves/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("spike gating: a spike still carrying the placeholder requirement_ids fails", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s01-x"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
    spikes: { "01-x.md": spikeMd({ slug: "01-x", reqIds: "pending-extraction (Requirement Catalog join key: S01)" }) },
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /spike_requirement_backfilled/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("spike gating: a spike requirement_id that is not in the catalog fails", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s01-x"] }],
    requirements: [req("REQ-A-001", { coveredByIssues: ["ISS-1"] })],
    spikes: { "01-x.md": spikeMd({ slug: "01-x", reqIds: "REQ-GHOST-999" }) },
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /spike_requirement_resolves/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("spike gating: a must_verify_with_spike requirement gated by a spike passes", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"], spike_gates: ["gate:phase0:s01-x"] }],
    requirements: [req("REQ-A-001", { disposition: "must_verify_with_spike", coveredByIssues: ["ISS-1"] })],
    spikes: { "01-x.md": spikeMd({ slug: "01-x", reqIds: "REQ-A-001" }) },
  });
  try {
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("spike gating: a must_verify_with_spike requirement with no spike to gate it fails", () => {
  const f = fixture({
    issues: [{ id: "ISS-1", requirement_ids: ["REQ-A-001"] }],
    requirements: [req("REQ-A-001", { disposition: "must_verify_with_spike", coveredByIssues: ["ISS-1"] })],
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => /spike_requirement_gated/.test(e)), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});
