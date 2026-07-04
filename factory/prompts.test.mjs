// The agent prompts must be SELF-CONTAINED: they carry the per-action discipline
// themselves and do NOT depend on the (now lean) target containing development-
// method docs. The target no longer ships `docs/governance/**`, so any prompt that
// told an agent to read or route to a `docs/governance/...` doc would be a dangling
// reference. This test fails if any such reference reappears.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_PROMPTS_DIR } from "./target-root.mjs";

const PROMPTS = ["implementer.md", "reviewer.md", "extractor.md", "extraction-verifier.md", "map-review.md", "change-request.md", "spike-prover.md", "spike-verifier.md", "cr-applier.md"];

function readPrompt(name) {
  return readFileSync(join(FACTORY_PROMPTS_DIR, name), "utf8");
}

test("no prompt references a docs/governance/** method doc (target is lean)", () => {
  for (const name of PROMPTS) {
    const text = readPrompt(name);
    assert.ok(
      !/docs\/governance\//.test(text),
      `${name} still references docs/governance/** — the lean target does not contain it`,
    );
    // The specific stale numbers the implementer prompt used to cite.
    assert.ok(!/governance\/0[0-9]-/.test(text), `${name} cites a stale governance doc number`);
  }
});

test("implementer.md is self-contained: declares it carries the discipline, lists the gate-first steps", () => {
  const text = readPrompt("implementer.md");
  assert.match(text, /SELF-CONTAINED/, "implementer.md must declare it is self-contained");
  assert.match(text, /LEAN/, "implementer.md must note the target is lean");
  // The four-action implementer discipline still travels in the prompt itself.
  assert.match(text, /verification gate/i);
  assert.match(text, /TDD|test delta/i);
  assert.match(text, /smallest vertical slice/i);
  assert.match(text, /review sub-agents/i);
});

test("extractor.md is self-contained: carries the corpus schemas without a target method doc", () => {
  const text = readPrompt("extractor.md");
  assert.match(text, /SELF-CONTAINED/, "extractor.md must declare it is self-contained");
  // The artifact schemas it owns are present in the prompt itself.
  assert.match(text, /Requirement Catalog/);
  assert.match(text, /Traceability Matrix/);
  assert.match(text, /issue-index\.json/);
  assert.match(text, /architecture-map\.yml/);
  assert.match(text, /owner-provided graph/i, "extractor must refine an owner-provided architecture map in place, not discard it");
  assert.match(text, /Preserve every existing node's `layout_x`/i, "extractor must preserve manual node/edge placements verbatim");
});

test("extractor.md carries the spike evidence-gate and the normative-detection floor", () => {
  const text = readPrompt("extractor.md");
  assert.match(text, /### Spike file/, "extractor must carry the inlined spike file shape (not a target-repo template)");
  assert.match(text, /### Issue file/, "extractor must carry the inlined issue file shape");
  assert.match(text, /no `S` prefix/, "the spike shape pins one filename convention: <nn>-<slug>, no S prefix");
  assert.match(text, /must_verify_with_spike/, "extractor must mint spike obligations");
  assert.match(text, /gate:phase0:s/, "extractor must wire the spike gate id");
  assert.match(text, /INTEGRATE mode \(existing spikes are the authority\)/i, "extractor must integrate owner-provided spikes, not just mint");
  assert.match(text, /NEVER rewrite, renumber, recreate/i, "integrate mode must preserve provided spikes verbatim");
  assert.match(text, /Normative detection floor/i, "extractor must carry the normative floor");
});

test("extraction-verifier.md verifies spike evidence", () => {
  const text = readPrompt("extraction-verifier.md");
  assert.match(text, /Spike evidence/i, "verifier must carry the spike-evidence lens");
  assert.match(text, /spike_evidence_gap/, "verifier must offer the spike_evidence_gap problem kind");
});

test("reviewer.md is self-contained: carries the public-API review checklist", () => {
  const text = readPrompt("reviewer.md");
  assert.match(text, /Public-API review checklist/i);
  assert.match(text, /Garbage-input degradation/i);
});

test("extractor.md carries the architecture-map authoring craft (passes, layout storyboard, anti-patterns, conflict fix)", () => {
  const text = readPrompt("extractor.md");
  assert.match(text, /Pass 1 — Canonical decisions/i);
  assert.match(text, /Pass 2 — Nodes/i);
  assert.match(text, /Pass 3 — Edges/i);
  assert.match(text, /Pass 4 — Source-ref audit/i);
  assert.match(text, /operational storyboard/i, "the layout method narrative");
  assert.match(text, /Anti-patterns — never author these/i);
  assert.match(text, /Resolving a canonical contradiction/i, "the agent edits canonical + re-freeze, no change-request");
});

test("change-request.md carries the post-freeze Change-Control discipline", () => {
  const text = readPrompt("change-request.md");
  assert.match(text, /Change Request agent/i);
  assert.match(text, /guided intake/i);
  assert.match(text, /accepted_current_build/);
  assert.match(text, /owner_decision_evidence/);
  assert.match(text, /never silently edit/i, "the agent must not silently patch the frozen canonical");
  assert.match(text, /full CR frontmatter/, "change-request.md carries the CR frontmatter shape inline, not a target-repo template");
});

test("spike-prover.md carries the run-it-in-the-target-repo proving discipline", () => {
  const text = readPrompt("spike-prover.md");
  assert.match(text, /SELF-CONTAINED/, "spike-prover.md must declare it is self-contained");
  assert.match(text, /Spike Prover/i);
  // It proves substance by RUNNING experiments in the target repo, never by reasoning.
  assert.match(text, /IN THIS TARGET REPO/i);
  assert.match(text, /never fabricate|never claim a proof/i);
  // The six evidence fields it must record.
  for (const field of ["environment", "commands", "observed output", "decision", "documentation updates", "unresolved risks"]) {
    assert.match(text, new RegExp(field, "i"), `spike-prover must record the "${field}" evidence field`);
  }
  // The machine verdict contract.
  assert.match(text, /spike-<stem>-proof\.json/);
  assert.match(text, /"verdict":\s*"verified"/);
  // It stays in scope and only corrects canonical when reality forces it (rule 1).
  assert.match(text, /truth-model rule 1|pre-freeze correction/i);
  assert.match(text, /Forbidden/i, "must forbid touching other spikes / the corpus");
});

test("spike-verifier.md carries the independent counter-verification discipline", () => {
  const text = readPrompt("spike-verifier.md");
  assert.match(text, /SELF-CONTAINED/, "spike-verifier.md must declare it is self-contained");
  assert.match(text, /independent Spike Verifier/i);
  assert.match(text, /did \*\*NOT\*\* establish this proof|You did .*NOT.* establish/i);
  // It writes the agree verdict and edits nothing.
  assert.match(text, /spike-<stem>-verdict\.json/);
  assert.match(text, /"agree":\s*(true|boolean)/i);
  assert.match(text, /Report, never edit|edit no file|You edit nothing/i);
});

test("vivi.md pins the strict spike filename/gate_id grammar", () => {
  const text = readPrompt("vivi.md");
  // Vivi writes spikes the rest of the pipeline consumes; a filename that does not
  // match the gate_id slug is silently skipped by the proving stage (real bug found
  // in the torture run — Vivi wrote `S01-...md` with `gate:phase0:s01-...`).
  assert.match(text, /NO leading `S`\/`s`/i, "vivi.md must forbid the leading-S filename");
  assert.match(text, /gate:phase0:s<nn>-<slug>/, "vivi.md must show the gate_id grammar");
  assert.match(text, /filename stem \*\*verbatim\*\*|equal the filename without `\.md`/i, "vivi.md must require gate_id slug == filename stem");
});

test("map-review.md carries the independent per-lens review method", () => {
  const text = readPrompt("map-review.md");
  assert.match(text, /independent domain-expert reviewer/i);
  assert.match(text, /ONE lens/i);
  assert.match(text, /seven systemic passes/i);
  assert.match(text, /Source-of-truth audit/i);
  assert.match(text, /findings/i);
  assert.match(text, /never a human reviewing/i);
});
