import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.ts";

const PROMPTS = ["implementer.md", "reviewer.md", "extractor.md", "extraction-verifier.md", "map-review.md", "change-request.md", "spike-prover.md", "spike-verifier.md", "cr-applier.md", "skill-scout.md"];

function readPrompt(name: string) {
  return readFileSync(join(FACTORY_PROMPTS_DIR, name), "utf8");
}

test("no prompt references a docs/governance/** method doc (target is lean)", () => {
  for (const name of PROMPTS) {
    const text = readPrompt(name);
    assert.ok(
      !/docs\/governance\//.test(text),
      `${name} still references docs/governance/** — the lean target does not contain it`,
    );
    assert.ok(!/governance\/0[0-9]-/.test(text), `${name} cites a stale governance doc number`);
  }
});

test("implementer.md is self-contained: declares it carries the discipline, lists the gate-first steps", () => {
  const text = readPrompt("implementer.md");
  assert.match(text, /SELF-CONTAINED/, "implementer.md must declare it is self-contained");
  assert.match(text, /LEAN/, "implementer.md must note the target is lean");
  assert.match(text, /verification gate/i);
  assert.match(text, /TDD|test delta/i);
  assert.match(text, /smallest vertical slice/i);
  assert.match(text, /review sub-agents/i);
});

test("extractor.md is self-contained: carries the corpus schemas without a target method doc", () => {
  const text = readPrompt("extractor.md");
  assert.match(text, /SELF-CONTAINED/, "extractor.md must declare it is self-contained");
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
  assert.match(text, /IN THIS TARGET REPO/i);
  assert.match(text, /never fabricate|never claim a proof/i);
  for (const field of ["environment", "commands", "observed output", "decision", "documentation updates", "unresolved risks"]) {
    assert.match(text, new RegExp(field, "i"), `spike-prover must record the "${field}" evidence field`);
  }
  assert.match(text, /spike-<stem>-proof\.json/);
  assert.match(text, /"verdict":\s*"verified"/);
  assert.match(text, /truth-model rule 1|pre-freeze correction/i);
  assert.match(text, /Forbidden/i, "must forbid touching other spikes / the corpus");
});

test("spike-verifier.md carries the independent counter-verification discipline", () => {
  const text = readPrompt("spike-verifier.md");
  assert.match(text, /SELF-CONTAINED/, "spike-verifier.md must declare it is self-contained");
  assert.match(text, /independent Spike Verifier/i);
  assert.match(text, /did \*\*NOT\*\* establish this proof|You did .*NOT.* establish/i);
  assert.match(text, /spike-<stem>-verdict\.json/);
  assert.match(text, /"agree":\s*(true|boolean)/i);
  assert.match(text, /Report, never edit|edit no file|You edit nothing/i);
});

test("vivi.md pins the strict spike filename/gate_id grammar", () => {
  const text = readPrompt("vivi.md");
  assert.match(text, /NO leading `S`\/`s`/i, "vivi.md must forbid the leading-S filename");
  assert.match(text, /gate:phase0:s<nn>-<slug>/, "vivi.md must show the gate_id grammar");
  assert.match(text, /filename stem \*\*verbatim\*\*|equal the filename without `\.md`/i, "vivi.md must require gate_id slug == filename stem");
});

test("the spec-kind discipline is pinned across vivi/implementer/reviewer prompts", () => {
  const vivi = readPrompt("vivi.md");
  assert.match(vivi, /spec_kind: project/, "vivi.md must document the project kind");
  assert.match(vivi, /spec_kind: feature/, "vivi.md must document the feature kind");
  assert.match(vivi, /grill the CHANGE, not the world/i, "vivi.md must scope the feature grill");
  assert.match(vivi, /do NOT redefine the stack/i, "vivi.md must forbid re-specifying an existing product's stack");

  const implementer = readPrompt("implementer.md");
  assert.match(implementer, /spec_kind/, "implementer.md must read the manifest's spec_kind");
  assert.match(implementer, /follow ITS structure, naming, and idioms/i, "implementer.md must bind feature work to existing conventions");

  const reviewer = readPrompt("reviewer.md");
  assert.match(reviewer, /spec_kind/, "reviewer.md must read the manifest's spec_kind");
  assert.match(reviewer, /rewrites or restyles pre-existing code beyond the issue's needs is a fail/i, "reviewer.md must fail legacy-rewriting diffs");
});

test("the zero-comment / no-time-marker hygiene is pinned across implementer/reviewer prompts and the target AGENTS.md template", () => {
  const implementer = readPrompt("implementer.md");
  assert.match(implementer, /CODE HYGIENE/, "implementer.md must carry the code-hygiene section");
  assert.match(implementer, /ZERO comments by default/i);
  assert.match(implementer, /not derivable from the code itself/i);
  assert.match(implementer, /ONE dense line/i);
  assert.match(implementer, /NEVER match the comment density/i, "a legacy codebase's comment density must never be imitated");
  assert.match(implementer, /do not restyle untouched code/i, "hygiene must not license out-of-scope rewrites");
  assert.match(implementer, /version markers/i);
  assert.match(implementer, /never when or in which batch/i, "implementer.md must ban time-fixed references");

  const reviewer = readPrompt("reviewer.md");
  assert.match(reviewer, /Code hygiene \(MUST enforce on the whole diff\)/i, "reviewer.md must carry the hygiene enforcement section");
  assert.match(reviewer, /non-invariant comment/i);
  assert.match(reviewer, /time-fixed reference/i);
  assert.match(reviewer, /do not restyle untouched code/i);

  const template = readFileSync(join(FACTORY_DIR, "templates", "AGENTS.md"), "utf8");
  assert.match(template, /Zero comments by default/i, "the scaffolded AGENTS.md must carry the standing comment rule");
  assert.match(template, /structural invariant/i);
  assert.match(template, /Never encode a moment in time/i, "the scaffolded AGENTS.md must ban time-fixed references");
  assert.match(template, /may amend this section/i, "the owner valve must stay");
});

test("vivi.md carries the governess charter (action protocol, no code, no CR decision)", () => {
  const text = readPrompt("vivi.md");
  assert.match(text, /```vivicy-action/, "vivi.md must document the vivicy-action fence");
  assert.match(text, /"actions": \[\{"tool":/, "vivi.md must show the envelope shape");
  for (const tool of [
    "status.read",
    "pipeline.start",
    "pipeline.resume",
    "pipeline.stop",
    "pipeline.extract",
    "pipeline.retry",
    "skills.install",
    "skills.remove",
    "map.move",
    "crs.list",
    "cycle.open",
    "cycle.cancel",
    "notifications.read",
  ]) {
    assert.match(text, new RegExp(tool.replace(".", "\\.")), `vivi.md must document the ${tool} tool`);
  }
  assert.match(text, /You never write code/i, "vivi.md must carry the no-code prohibition");
  assert.match(text, /no `cr\.decide` tool/i, "vivi.md must state the CR decision is never hers");
  assert.match(text, /never repeat a succeeded action/i, "vivi.md must forbid re-issuing succeeded actions");
});

test("vivi.md carries la Nonna's voice WITH the no-seasoning-in-files guard", () => {
  const text = readPrompt("vivi.md");
  assert.match(text, /la Nonna's kitchen/i, "vivi.md must define the Nonna voice section");
  assert.match(text, /la ricetta/, "vivi.md must map the spec to the recipe");
  assert.match(text, /mise en place/, "vivi.md must map extracted issues to the mise en place");
  assert.match(text, /Seasoning, never the dish/i, "vivi.md must bound the metaphor density");
  assert.match(text, /The files never get seasoned/i, "vivi.md must forbid the metaphor in written files");
  assert.match(text, /Sober when it burns/i, "vivi.md must require plain facts first on errors");
  assert.match(text, /Engineer first, Nonna second/i, "vivi.md must pin the engineer-first posture");
  assert.match(text, /not a toy/i, "vivi.md must state Vivicy is not a toy");
});

test("skill-scout.md carries the propose-only skill-scouting discipline", () => {
  const text = readPrompt("skill-scout.md");
  assert.match(text, /SELF-CONTAINED/, "skill-scout.md must declare it is self-contained");
  assert.match(text, /Skill Scout/i);
  assert.match(text, /npx -y skills find/);
  assert.match(text, /VERBATIM in `npx skills find` output/i, "the scout must never invent skill ids");
  assert.match(text, /Prefer OFFICIAL vendor skills/i);
  assert.match(text, /AT MOST 6/i);
  assert.match(text, /"skills": \[\]/, "zero selection must be a legitimate result");
  assert.match(text, /Do \*\*NOT\*\* install anything/i);
  assert.match(text, /"id": "owner\/repo@skill"/);
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
