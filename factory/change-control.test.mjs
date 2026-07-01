import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import { CR_STATUSES, nextCrId, readChangeRequests, runChangeControlCheck } from "./change-control.mjs";

function serialize(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.join(", ")}]`;
  return String(v);
}

function crBody(fm) {
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${serialize(v)}`);
  return `---\n${lines.join("\n")}\n---\n\n# ${fm.id ?? "CR"}\n`;
}

const validCr = (over = {}) => ({
  id: "CR-0001",
  title: "x",
  status: "idea",
  classification: "pending",
  created_at: "2026-06-30",
  updated_at: "2026-06-30",
  source: "owner",
  owner_decision: "pending",
  owner_decision_by: null,
  owner_decision_at: null,
  owner_decision_evidence: null,
  previous_baseline_id: null,
  previous_baseline_version: null,
  previous_baseline_manifest_path: null,
  previous_document_set_hash: null,
  previous_manifest_hash: null,
  target_baseline_bump: null,
  resulting_baseline_id: null,
  resulting_baseline_version: null,
  resulting_baseline_manifest_path: null,
  resulting_document_set_hash: null,
  resulting_manifest_hash: null,
  supersedes: [],
  superseded_by: null,
  ...over,
});

const decided = {
  owner_decision_by: "owner",
  owner_decision_at: "2026-06-30",
  owner_decision_evidence: "approved in message ref #42",
};
const previousBaseline = {
  previous_baseline_id: "baseline-v1.0.0",
  previous_baseline_version: "1.0.0",
  previous_baseline_manifest_path: ".vivicy/baselines/baseline-v1.0.0.json",
  previous_document_set_hash: "d1",
  previous_manifest_hash: "m1",
};

function fixture({ crs = {}, catalog, manifests } = {}) {
  const root = mkdtempSync(resolve(tmpdir(), "cc-check-"));
  const write = (rel, content) => {
    const abs = resolve(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [name, fm] of Object.entries(crs)) write(`.vivicy/change-requests/${name}`, crBody(fm));
  if (catalog) write(".vivicy/requirements/catalog.json", JSON.stringify(catalog, null, 2));
  for (const [name, m] of Object.entries(manifests ?? {})) write(`.vivicy/baselines/${name}`, JSON.stringify(m, null, 2));
  return { root, run: () => runChangeControlCheck({ repoRoot: root }), cleanup: () => rmSync(root, { force: true, recursive: true }) };
}

const has = (r, rule) => r.errors.some((e) => e.includes(rule));

test("placeholder: nothing to check with no change-requests directory", () => {
  const f = fixture({});
  try {
    const r = f.run();
    assert.equal(r.exitCode, 0);
    assert.equal(r.placeholder, true);
  } finally {
    f.cleanup();
  }
});

test("a valid idea CR passes", () => {
  const f = fixture({ crs: { "CR-0001-add-foo.md": validCr() } });
  try {
    const r = f.run();
    assert.deepEqual(r.errors, []);
    assert.equal(r.exitCode, 0);
  } finally {
    f.cleanup();
  }
});

test("fails on a bad status / classification enum", () => {
  const f = fixture({ crs: { "CR-0001-x.md": validCr({ status: "bogus", classification: "weird" }) } });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, "cr_status_enum") && has(r, "cr_classification_enum"));
  } finally {
    f.cleanup();
  }
});

test("fails when the filename number does not match the frontmatter id", () => {
  const f = fixture({ crs: { "CR-0002-x.md": validCr({ id: "CR-0001" }) } });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, "cr_id_filename_match"), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("a decided status without owner-decision evidence fails", () => {
  const f = fixture({ crs: { "CR-0001-x.md": validCr({ status: "rejected" }) } });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, "cr_decision_evidence"), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("accepted_current_build requires previous_baseline_* (and decision evidence)", () => {
  const f = fixture({ crs: { "CR-0001-x.md": validCr({ status: "accepted_current_build", ...decided }) } });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, "cr_previous_baseline"), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("a fully-populated accepted_current_build CR passes", () => {
  const f = fixture({ crs: { "CR-0001-x.md": validCr({ status: "accepted_current_build", classification: "minor_product_change", ...decided, ...previousBaseline }) } });
  try {
    const r = f.run();
    assert.deepEqual(r.errors, []);
  } finally {
    f.cleanup();
  }
});

test("docs_applied needs resulting_* fields and a resulting manifest that exists", () => {
  const base = validCr({ status: "docs_applied", classification: "minor_product_change", ...decided, ...previousBaseline });
  // Missing resulting_* fields.
  const f1 = fixture({ crs: { "CR-0001-x.md": base } });
  try {
    assert.ok(has(f1.run(), "cr_resulting_baseline"));
  } finally {
    f1.cleanup();
  }
  // resulting_* present but the manifest hash matches nothing in baselines/.
  const withResulting = {
    ...base,
    resulting_baseline_id: "baseline-v1.1.0",
    resulting_baseline_version: "1.1.0",
    resulting_baseline_manifest_path: ".vivicy/baselines/baseline-v1.1.0.json",
    resulting_document_set_hash: "d2",
    resulting_manifest_hash: "m2",
  };
  const f2 = fixture({ crs: { "CR-0001-x.md": withResulting } });
  try {
    assert.ok(has(f2.run(), "cr_resulting_manifest_exists"));
  } finally {
    f2.cleanup();
  }
  // With a matching manifest on disk, it passes.
  const f3 = fixture({ crs: { "CR-0001-x.md": withResulting }, manifests: { "baseline-v1.1.0.json": { manifest_hash: "m2" } } });
  try {
    assert.deepEqual(f3.run().errors, []);
  } finally {
    f3.cleanup();
  }
});

test("an inconsistent supersedes/superseded_by graph fails", () => {
  const f = fixture({
    crs: {
      "CR-0001-a.md": validCr({ id: "CR-0001", supersedes: ["CR-0002"] }),
      "CR-0002-b.md": validCr({ id: "CR-0002", superseded_by: null }),
    },
  });
  try {
    const r = f.run();
    assert.equal(r.exitCode, 1);
    assert.ok(has(r, "cr_supersedes_consistency"), r.errors.join("\n"));
  } finally {
    f.cleanup();
  }
});

test("non-sequential CR numbering fails", () => {
  const f = fixture({
    crs: {
      "CR-0001-a.md": validCr({ id: "CR-0001" }),
      "CR-0003-c.md": validCr({ id: "CR-0003" }),
    },
  });
  try {
    assert.ok(has(f.run(), "cr_sequential"));
  } finally {
    f.cleanup();
  }
});

test("an active requirement sourced only from a CR file fails", () => {
  const f = fixture({
    crs: { "CR-0001-x.md": validCr() },
    catalog: { requirements: [{ id: "REQ-A-001", sourceRefs: [".vivicy/change-requests/CR-0001-x.md:10"] }] },
  });
  try {
    assert.ok(has(f.run(), "requirement_sourced_only_from_cr"));
  } finally {
    f.cleanup();
  }
});

test("nextCrId returns highest + 1 (CR-0001 when none)", () => {
  const f = fixture({ crs: { "CR-0001-a.md": validCr({ id: "CR-0001" }), "CR-0002-b.md": validCr({ id: "CR-0002" }) } });
  try {
    assert.equal(nextCrId(readChangeRequests(f.root)), "CR-0003");
  } finally {
    f.cleanup();
  }
  assert.equal(nextCrId([]), "CR-0001");
});

test("CR_STATUSES exposes the eight statuses", () => {
  assert.equal(CR_STATUSES.length, 8);
});
