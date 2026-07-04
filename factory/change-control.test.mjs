import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

import {
  CR_STATUSES,
  createChangeRequest,
  decideChangeRequest,
  nextCrId,
  readChangeRequest,
  readChangeRequests,
  runChangeControlCheck,
} from "./change-control.mjs";

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

// --- G7: the CR writer + owner-decision recorder -------------------------------------

function emptyRepo() {
  const root = mkdtempSync(resolve(tmpdir(), "cc-write-"));
  return { root, cleanup: () => rmSync(root, { force: true, recursive: true }) };
}

// A frozen baseline manifest under .vivicy/baselines/ — the pre-change identity an approved
// CR chains from (decideChangeRequest reads its baseline_id/version/hashes into previous_*).
function writeFrozenManifest(root, { version = "1.0.0" } = {}) {
  const id = `baseline-v${version}`;
  const abs = resolve(root, `.vivicy/baselines/${id}.json`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify({
    schema_version: 1, baseline_id: id, version, status: "frozen",
    document_set_hash: `doc-${version}`, manifest_hash: `manifest-${version}`,
    files: [{ path: ".vivicy/canonical/01-x.md", bytes: 1, sha256: "z" }],
  }, null, 2));
  return { id, version, manifestHash: `manifest-${version}` };
}

test("createChangeRequest writes an idea CR that passes the checker, returning its refs", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const { id, path } = createChangeRequest({ repoRoot: root, title: "Add a bulk export", now: () => "2026-07-02T00:00:00.000Z" });
    assert.equal(id, "CR-0001");
    assert.match(path, /^\.vivicy\/change-requests\/CR-0001-add-a-bulk-export\.md$/);
    // The written file passes the real gate (valid enums, sequential id, decision scaffold).
    assert.equal(runChangeControlCheck({ repoRoot: root }).exitCode, 0);
    const cr = readChangeRequest(root, "CR-0001");
    assert.equal(cr.fm.status, "idea");
    assert.equal(cr.fm.source, "agent");
    assert.equal(cr.fm.owner_decision, "pending");
    assert.equal(cr.fm.classification, "minor_product_change");
  } finally {
    cleanup();
  }
});

test("createChangeRequest numbers ids sequentially and stays gap-free", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const a = createChangeRequest({ repoRoot: root, title: "First" });
    const b = createChangeRequest({ repoRoot: root, title: "Second", classification: "major_product_change" });
    const c = createChangeRequest({ repoRoot: root, title: "Third", source: "owner" });
    assert.deepEqual([a.id, b.id, c.id], ["CR-0001", "CR-0002", "CR-0003"]);
    // Three sequential CRs still pass change-control together.
    assert.equal(runChangeControlCheck({ repoRoot: root }).exitCode, 0);
    assert.equal(nextCrId(readChangeRequests(root)), "CR-0004");
  } finally {
    cleanup();
  }
});

test("createChangeRequest folds a caller-supplied narrative body and captures machine evidence", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const { id } = createChangeRequest({
      repoRoot: root, title: "Spike disproven", classification: "major_product_change", source: "agent",
      sourceEvidence: [".vivicy/development/reports/spike-01-proof.json"],
    });
    const text = readFileSync(resolve(root, `.vivicy/change-requests/${id}-spike-disproven.md`), "utf8");
    assert.match(text, /spike-01-proof\.json/, "the machine evidence is cited in the body");
    assert.equal(runChangeControlCheck({ repoRoot: root }).exitCode, 0);
  } finally {
    cleanup();
  }
});

test("createChangeRequest rejects an invalid classification", () => {
  const { root, cleanup } = emptyRepo();
  try {
    assert.throws(() => createChangeRequest({ repoRoot: root, title: "x", classification: "nonsense" }), /invalid classification/);
  } finally {
    cleanup();
  }
});

test("decideChangeRequest approved fills previous_* from the frozen manifest and passes the checker", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const frozen = writeFrozenManifest(root, { version: "1.2.0" });
    const { id } = createChangeRequest({ repoRoot: root, title: "Approve me" });
    const result = decideChangeRequest({ repoRoot: root, id, decision: "approved", decidedBy: "owner:ui", evidenceRef: "approved in the UI", now: () => "2026-07-02T00:00:00.000Z" });

    assert.equal(result.status, "accepted_current_build");
    const cr = readChangeRequest(root, id);
    assert.equal(cr.fm.status, "accepted_current_build");
    // previous_baseline_* is filled from the frozen manifest (the pre-change identity).
    assert.equal(cr.fm.previous_baseline_id, frozen.id);
    assert.equal(cr.fm.previous_baseline_version, "1.2.0");
    assert.equal(cr.fm.previous_manifest_hash, frozen.manifestHash);
    assert.equal(cr.fm.owner_decision, "approved");
    assert.equal(cr.fm.owner_decision_by, "owner:ui");
    assert.equal(cr.fm.owner_decision_evidence, "approved in the UI");
    // The decided CR passes the real gate (accepted_current_build needs previous_* + evidence).
    assert.equal(runChangeControlCheck({ repoRoot: root }).exitCode, 0);
  } finally {
    cleanup();
  }
});

test("decideChangeRequest approved refuses when no frozen baseline exists to chain from", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const { id } = createChangeRequest({ repoRoot: root, title: "No baseline yet" });
    assert.throws(() => decideChangeRequest({ repoRoot: root, id, decision: "approved", decidedBy: "owner:ui" }), /no frozen baseline/);
    // The CR is untouched (still idea) after the refused approval.
    assert.equal(readChangeRequest(root, id).fm.status, "idea");
  } finally {
    cleanup();
  }
});

test("decideChangeRequest rejected records the decision and passes the checker", () => {
  const { root, cleanup } = emptyRepo();
  try {
    const { id } = createChangeRequest({ repoRoot: root, title: "Reject me" });
    const result = decideChangeRequest({ repoRoot: root, id, decision: "rejected", decidedBy: "owner:ui", evidenceRef: "declined", now: () => "2026-07-02T00:00:00.000Z" });
    assert.equal(result.status, "rejected");
    const cr = readChangeRequest(root, id);
    assert.equal(cr.fm.status, "rejected");
    assert.equal(cr.fm.owner_decision, "rejected");
    // A rejected CR needs decision evidence (no previous_* required) — it passes the gate.
    assert.equal(runChangeControlCheck({ repoRoot: root }).exitCode, 0);
  } finally {
    cleanup();
  }
});

test("decideChangeRequest refuses to decide an already-decided CR (no double-decide)", () => {
  const { root, cleanup } = emptyRepo();
  try {
    writeFrozenManifest(root);
    const { id } = createChangeRequest({ repoRoot: root, title: "Once only" });
    decideChangeRequest({ repoRoot: root, id, decision: "approved", decidedBy: "owner:ui" });
    // A second decision on the now-accepted CR is refused (only idea|under_review decidable).
    assert.throws(() => decideChangeRequest({ repoRoot: root, id, decision: "rejected", decidedBy: "owner:ui" }), /only idea\|under_review/);
  } finally {
    cleanup();
  }
});

test("decideChangeRequest rejects an unknown CR id and a bad decision value", () => {
  const { root, cleanup } = emptyRepo();
  try {
    assert.throws(() => decideChangeRequest({ repoRoot: root, id: "CR-9999", decision: "approved", decidedBy: "x" }), /no CR with id CR-9999/);
    createChangeRequest({ repoRoot: root, title: "x" });
    assert.throws(() => decideChangeRequest({ repoRoot: root, id: "CR-0001", decision: "maybe", decidedBy: "x" }), /must be "approved" or "rejected"/);
  } finally {
    cleanup();
  }
});
