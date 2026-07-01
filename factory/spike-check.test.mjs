import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSpikeGateStatuses, readSpikes, runSpikeCheck, transitivelyVerifiedGates } from "./spike-check.mjs";

// A well-formed spike whose gate-id slug matches its filename stem. `extra`
// overrides individual sections so each test can break exactly one rule.
function spike({ slug = "01-example", status = "pending", gate, sections } = {}) {
  const s = {
    traceability:
      "```text\n" +
      "requirement_ids: pending-extraction (Requirement Catalog join key: S01)\n" +
      `gate_id: ${gate ?? `gate:phase0:s${slug}`}\n` +
      `status: ${status}\n` +
      "```",
    question: "Does the provider behave as assumed?",
    mustVerify: "- [Live test required: ...] the assumption",
    evidence:
      "```text\n" +
      "environment: date, runtime, versions\n" +
      "commands or API calls: exact calls\n" +
      "observed output: relevant results\n" +
      "decision: the locked decision\n" +
      "documentation updates: docs to change\n" +
      "unresolved risks: remaining uncertainty\n" +
      "```",
    ...sections,
  };
  return [
    "# S01 - Example",
    "",
    "Document status: Phase 0 spike.",
    "",
    "## Traceability",
    "",
    s.traceability,
    "",
    ...(s.question === null ? [] : ["## Question", "", s.question, ""]),
    ...(s.mustVerify === null ? [] : ["## Must Verify", "", s.mustVerify, ""]),
    ...(s.evidence === null ? [] : ["## Evidence Required", "", s.evidence, ""]),
  ].join("\n");
}

// `spikes` maps filename -> content; pass `null` for no spikes/ dir at all.
function run(spikes) {
  const root = mkdtempSync(join(tmpdir(), "vivicy-spike-"));
  try {
    if (spikes) {
      const dir = join(root, ".vivicy/development/spikes");
      mkdirSync(dir, { recursive: true });
      for (const [name, content] of Object.entries(spikes)) writeFileSync(join(dir, name), content);
    }
    return runSpikeCheck({ repoRoot: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("no spikes directory -> nothing to check (exit 0, placeholder)", () => {
  const result = run(null);
  assert.equal(result.exitCode, 0);
  assert.equal(result.placeholder, true);
});

test("empty spikes directory -> nothing to check", () => {
  const result = run({});
  assert.equal(result.exitCode, 0);
  assert.equal(result.placeholder, true);
});

test("a well-formed pending spike passes", () => {
  const result = run({ "01-example.md": spike() });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("a verified spike with full evidence passes", () => {
  const result = run({ "01-example.md": spike({ status: "verified" }) });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("the README and the template are not treated as spikes", () => {
  const result = run({
    "README.md": "# Phase 0 Spikes\n",
    "SPIKE-TEMPLATE.md": "# S<NN>\n",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.placeholder, true);
});

test("an out-of-enum status fails", () => {
  const result = run({ "01-example.md": spike({ status: "done" }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_status_enum/);
});

test("a malformed gate id fails the grammar rule", () => {
  const result = run({ "01-example.md": spike({ gate: "phase0-01" }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_gate_id_grammar/);
});

test("a gate-id slug that disagrees with the filename fails", () => {
  const result = run({ "01-example.md": spike({ gate: "gate:phase0:s99-other" }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_gate_id_matches_file/);
});

test("a missing section fails", () => {
  const result = run({ "01-example.md": spike({ sections: { question: null } }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_section_required/);
});

test("a VERIFIED spike missing a completion field fails", () => {
  const evidence =
    "```text\n" +
    "environment: x\n" +
    "commands or API calls: x\n" +
    "observed output: x\n" +
    "documentation updates: x\n" + // "decision" and "unresolved risks" removed
    "```";
  const result = run({ "01-example.md": spike({ status: "verified", sections: { evidence } }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_completion_fields/);
});

test("a PENDING spike with incomplete evidence passes (completion enforced only at verified)", () => {
  const evidence = "```text\nenvironment: only this one field\n```";
  const result = run({ "01-example.md": spike({ status: "pending", sections: { evidence } }) });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("readSpikes indexes only well-formed spikes (skips a gate-id/filename mismatch)", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-spike-"));
  try {
    const dir = join(root, ".vivicy/development/spikes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-good.md"), spike({ slug: "01-good", status: "verified" }));
    writeFileSync(join(dir, "02-bad.md"), spike({ slug: "02-bad", gate: "gate:phase0:s99-wrong" }));
    assert.deepEqual(
      readSpikes(root).map((s) => s.gate_id),
      ["gate:phase0:s01-good"],
    );
    const statuses = readSpikeGateStatuses(root);
    assert.equal(statuses.get("gate:phase0:s01-good"), "verified");
    assert.equal(statuses.has("gate:phase0:s99-wrong"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing Traceability block fails", () => {
  const content = ["# S01", "", "## Question", "q", "", "## Must Verify", "- x", "", "## Evidence Required", "x"].join("\n");
  const result = run({ "01-example.md": content });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_traceability_block/);
});

test("a missing Traceability field (no status) fails", () => {
  const traceability =
    "```text\n" +
    "requirement_ids: pending-extraction (Requirement Catalog join key: S01)\n" +
    "gate_id: gate:phase0:s01-example\n" +
    "```";
  const result = run({ "01-example.md": spike({ sections: { traceability } }) });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /spike_traceability_field/);
});

// E2 — inter-spike gating.
function trace({ slug, status = "pending", gated_by, blocks, external } = {}) {
  return [
    "```text",
    "requirement_ids: pending-extraction (Requirement Catalog join key: S01)",
    `gate_id: gate:phase0:s${slug}`,
    `status: ${status}`,
    ...(gated_by ? [`gated_by: ${gated_by}`] : []),
    ...(blocks ? [`blocks: ${blocks}`] : []),
    ...(external ? [`gated_by_external: ${external}`] : []),
    "```",
  ].join("\n");
}
const spk = (slug, opts = {}) => spike({ slug, sections: { traceability: trace({ slug, ...opts }) } });

test("E2: gated_by referencing an unknown spike fails", () => {
  const result = run({ "01-a.md": spk("01-a", { gated_by: "gate:phase0:s99-missing" }) });
  assert.match(result.errors.join("\n"), /spike_gated_by_resolves/);
});

test("E2: a valid gated_by chain passes (s02-b gates s01-a; both well-formed)", () => {
  const result = run({
    "01-a.md": spk("01-a", { gated_by: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b"),
  });
  assert.deepEqual(result.errors, []);
  assert.equal(result.exitCode, 0);
});

test("E2: blocks without the mirrored gated_by fails (consistency)", () => {
  const result = run({
    "01-a.md": spk("01-a", { blocks: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b"),
  });
  assert.match(result.errors.join("\n"), /spike_blocks_consistency/);
});

test("E2: blocks mirrored by the target's gated_by passes", () => {
  const result = run({
    "01-a.md": spk("01-a", { blocks: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b", { gated_by: "gate:phase0:s01-a" }),
  });
  assert.deepEqual(result.errors, []);
});

test("E2: a gated_by cycle fails", () => {
  const result = run({
    "01-a.md": spk("01-a", { gated_by: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b", { gated_by: "gate:phase0:s01-a" }),
  });
  assert.match(result.errors.join("\n"), /spike_gating_acyclic/);
});

test("E2: a verified spike whose gated_by chain is NOT verified fails the status chain", () => {
  const result = run({
    "01-a.md": spk("01-a", { status: "verified", gated_by: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b", { status: "pending" }),
  });
  assert.match(result.errors.join("\n"), /spike_verified_chain/);
});

test("E2: a verified spike with its whole gated_by chain verified passes", () => {
  const result = run({
    "01-a.md": spk("01-a", { status: "verified", gated_by: "gate:phase0:s02-b" }),
    "02-b.md": spk("02-b", { status: "verified" }),
  });
  assert.deepEqual(result.errors, []);
});

test("E2: transitivelyVerifiedGates counts a verified spike only when its whole chain is verified", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-spike-"));
  try {
    const dir = join(root, ".vivicy/development/spikes");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "01-a.md"), spk("01-a", { status: "verified", gated_by: "gate:phase0:s02-b" }));
    writeFileSync(join(dir, "02-b.md"), spk("02-b", { status: "verified" }));
    writeFileSync(join(dir, "03-c.md"), spk("03-c", { status: "verified", gated_by: "gate:phase0:s04-d" }));
    writeFileSync(join(dir, "04-d.md"), spk("04-d", { status: "pending" }));
    const gates = transitivelyVerifiedGates(root);
    assert.ok(gates.has("gate:phase0:s01-a"), "a is verified and its chain (b) is verified");
    assert.ok(gates.has("gate:phase0:s02-b"));
    assert.ok(!gates.has("gate:phase0:s03-c"), "c is verified but its gated_by d is pending -> not counted");
    assert.ok(!gates.has("gate:phase0:s04-d"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
