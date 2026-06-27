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

const PROMPTS = ["implementer.md", "reviewer.md", "extractor.md", "extraction-verifier.md"];

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
});

test("reviewer.md is self-contained: carries the public-API review checklist", () => {
  const text = readPrompt("reviewer.md");
  assert.match(text, /Public-API review checklist/i);
  assert.match(text, /Garbage-input degradation/i);
});
