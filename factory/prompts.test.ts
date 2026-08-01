import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.ts"
import { PROOFS_DIR, PROOF_RECIPE_FILE } from "../lib/proofs.ts"

const PROMPTS = [
  "implementer.md",
  "reviewer.md",
  "extractor.md",
  "extraction-verifier.md",
  "map-review.md",
  "spike-prover.md",
  "spike-verifier.md",
  "cr-applier.md",
  "skill-scout.md",
  "doc-prep.md",
  "detect-language.md",
]

const ALL_LEG_PROMPTS = [
  "doc-prep.md",
  "detect-language.md",
  "extractor.md",
  "extraction-verifier.md",
  "vivi.md",
  "implementer.md",
  "reviewer.md",
  "merge-resolver.md",
  "readiness-checker.md",
  "cr-applier.md",
  "map-review.md",
  "skill-scout.md",
  "spike-prover.md",
  "spike-verifier.md",
  "acceptance.md",
  "retro.md",
]

function readPrompt(name: string) {
  return readFileSync(join(FACTORY_PROMPTS_DIR, name), "utf8")
}

test("no prompt references a docs/governance/** method doc (target is lean)", () => {
  for (const name of PROMPTS) {
    const text = readPrompt(name)
    assert.ok(!/docs\/governance\//.test(text), `${name} still references docs/governance/** — the lean target does not contain it`)
    assert.ok(!/governance\/0[0-9]-/.test(text), `${name} cites a stale governance doc number`)
  }
})

test("doc-prep.md is self-contained and carries the language law, scratch-only writes, and the prepare-don't-judge boundary", () => {
  const text = readPrompt("doc-prep.md")
  assert.match(text, /SELF-CONTAINED/, "doc-prep.md must declare it is self-contained")
  assert.match(text, /LEAN/, "doc-prep.md must note the target is lean")
  assert.match(text, /dominant language/i, "doc-prep.md must state the manifest-language law")
  assert.match(text, /TRANSLATE/, "doc-prep.md must instruct translation into the dominant language")
  assert.match(text, /output directory/i, "doc-prep.md must confine writes to the leg's scratch output directory")
  assert.match(text, /NOT.*modify.*uploads|uploads.*immutable|never.*uploads/i, "doc-prep.md must forbid touching uploads")
  assert.match(text, /drift|coherence|contradiction/i, "doc-prep.md must state it does not judge corpus coherence")
})

test("detect-language.md is self-contained and asks for an ISO 639-3 per-file + dominant JSON verdict written to one file", () => {
  const text = readPrompt("detect-language.md")
  assert.match(text, /SELF-CONTAINED/, "detect-language.md must declare it is self-contained")
  assert.match(text, /ISO 639-3/, "detect-language.md must name the ISO 639-3 code system")
  assert.match(text, /dominant/i, "detect-language.md must ask for the dominant language")
  assert.match(text, /perFile/, "detect-language.md must specify the per-file verdict shape")
  assert.match(text, /SINGLE JSON file|single JSON file/, "detect-language.md must confine the write to one JSON file")
  assert.match(text, /never.*uploads|uploads/i, "detect-language.md must keep uploads untouched")
})

test("implementer.md is self-contained: declares it carries the discipline, lists the gate-first steps", () => {
  const text = readPrompt("implementer.md")
  assert.match(text, /SELF-CONTAINED/, "implementer.md must declare it is self-contained")
  assert.match(text, /LEAN/, "implementer.md must note the target is lean")
  assert.match(text, /verification gate/i)
  assert.match(text, /TDD|test delta/i)
  assert.match(text, /smallest vertical slice/i)
  assert.match(text, /review sub-agents/i)
})

test("the gate-command lifecycle is pinned across the implementer/reviewer/extractor prompts", () => {
  const implementer = readPrompt("implementer.md")
  const reviewer = readPrompt("reviewer.md")
  assert.match(implementer, /\{\{gate_command_directive\}\}/, "implementer.md must carry the gate-command directive injection point")
  assert.match(reviewer, /\{\{gate_command_directive\}\}/, "reviewer.md must carry the gate-command directive injection point")
  assert.match(
    implementer,
    /UNLESS the directive below tells you to establish it/i,
    "implementer.md must defer the vivicy.json rule to the injected directive"
  )
  assert.match(reviewer, /never change `vivicy\.json` or the gate command yourself/i)

  const extractor = readPrompt("extractor.md")
  assert.match(extractor, /extraction-gate-command\.json/, "extractor.md must record a canonical-stated gate command as structured output")
  assert.match(extractor, /sentinel `null`/, "extractor.md must name the null sentinel")
  assert.match(
    extractor,
    /if the canonical does not state a gate command, do NOT write this file/i,
    "extractor must never guess the gate command"
  )
})

test("the run-command lifecycle is pinned across the implementer/reviewer/extractor prompts (mirrors the gate-command chain)", () => {
  const implementer = readPrompt("implementer.md")
  const reviewer = readPrompt("reviewer.md")
  assert.match(implementer, /\{\{run_command_directive\}\}/, "implementer.md must carry the run-command directive injection point")
  assert.match(reviewer, /\{\{run_command_directive\}\}/, "reviewer.md must carry the run-command directive injection point")
  assert.match(
    implementer,
    /`vivicy\.json` also carries `runCommand`/,
    "implementer.md must name runCommand and defer its edit to the injected directive"
  )
  assert.match(reviewer, /reverting the run command strands the owner/i, "reviewer.md must forbid reverting an established run command")

  const extractor = readPrompt("extractor.md")
  assert.match(extractor, /extraction-run-command\.json/, "extractor.md must record a canonical-stated run command as structured output")
  assert.match(extractor, /## Run command \(only if the canonical STATES it\)/, "extractor.md must carry the run-command recording section")
  assert.match(
    extractor,
    /if the canonical does not state a run command, do NOT write this file/i,
    "extractor must never guess the run command"
  )
  assert.match(extractor, /never point it at the test runner/i, "the run command is not the verification gate")
})

test("extractor.md is self-contained: carries the corpus schemas without a target method doc", () => {
  const text = readPrompt("extractor.md")
  assert.match(text, /SELF-CONTAINED/, "extractor.md must declare it is self-contained")
  assert.match(text, /Requirement Catalog/)
  assert.match(text, /Traceability Matrix/)
  assert.match(text, /issue-index\.json/)
  assert.match(text, /architecture-map\.yml/)
  assert.match(text, /owner-provided graph/i, "extractor must refine an owner-provided architecture map in place, not discard it")
  assert.match(text, /Preserve every existing node's `layout_x`/i, "extractor must preserve manual node/edge placements verbatim")
})

test("extractor.md carries the spike evidence-gate and the normative-detection floor", () => {
  const text = readPrompt("extractor.md")
  assert.match(text, /### Spike file/, "extractor must carry the inlined spike file shape (not a target-repo template)")
  assert.match(text, /### Issue file/, "extractor must carry the inlined issue file shape")
  assert.match(text, /no `S` prefix/, "the spike shape pins one filename convention: <nn>-<slug>, no S prefix")
  assert.match(text, /must_verify_with_spike/, "extractor must mint spike obligations")
  assert.match(text, /gate:phase0:s/, "extractor must wire the spike gate id")
  assert.match(
    text,
    /INTEGRATE mode \(existing spikes are the authority\)/i,
    "extractor must integrate owner-provided spikes, not just mint"
  )
  assert.match(text, /NEVER rewrite, renumber, recreate/i, "integrate mode must preserve provided spikes verbatim")
  assert.match(text, /Normative detection floor/i, "extractor must carry the normative floor")
})

test("extraction-verifier.md verifies spike evidence", () => {
  const text = readPrompt("extraction-verifier.md")
  assert.match(text, /Spike evidence/i, "verifier must carry the spike-evidence lens")
  assert.match(text, /spike_evidence_gap/, "verifier must offer the spike_evidence_gap problem kind")
})

test("reviewer.md is self-contained: carries the public-API review checklist", () => {
  const text = readPrompt("reviewer.md")
  assert.match(text, /Public-API review checklist/i)
  assert.match(text, /Garbage-input degradation/i)
})

test("extractor.md carries the architecture-map authoring craft (passes, layout storyboard, anti-patterns, conflict fix)", () => {
  const text = readPrompt("extractor.md")
  assert.match(text, /Pass 1 — Canonical decisions/i)
  assert.match(text, /Pass 2 — Nodes/i)
  assert.match(text, /Pass 3 — Edges/i)
  assert.match(text, /Pass 4 — Source-ref audit/i)
  assert.match(text, /operational storyboard/i, "the layout method narrative")
  assert.match(text, /Anti-patterns — never author these/i)
  assert.match(text, /Resolving a canonical contradiction/i, "the agent edits canonical + re-freeze, no change-request")
})

test("spike-prover.md carries the run-it-in-the-target-repo proving discipline", () => {
  const text = readPrompt("spike-prover.md")
  assert.match(text, /SELF-CONTAINED/, "spike-prover.md must declare it is self-contained")
  assert.match(text, /Spike Prover/i)
  assert.match(text, /IN THIS TARGET REPO/i)
  assert.match(text, /never fabricate|never claim a proof/i)
  for (const field of ["environment", "commands", "observed output", "decision", "documentation updates", "unresolved risks"]) {
    assert.match(text, new RegExp(field, "i"), `spike-prover must record the "${field}" evidence field`)
  }
  assert.match(text, /spike-<stem>-proof\.json/)
  assert.match(text, /"verdict":\s*"verified"/)
  assert.match(text, /truth-model rule 1|pre-freeze correction/i)
  assert.match(text, /Forbidden/i, "must forbid touching other spikes / the corpus")
})

test("spike-verifier.md carries the independent counter-verification discipline", () => {
  const text = readPrompt("spike-verifier.md")
  assert.match(text, /SELF-CONTAINED/, "spike-verifier.md must declare it is self-contained")
  assert.match(text, /independent Spike Verifier/i)
  assert.match(text, /did \*\*NOT\*\* establish this proof|You did .*NOT.* establish/i)
  assert.match(text, /spike-<stem>-verdict\.json/)
  assert.match(text, /"agree":\s*(true|boolean)/i)
  assert.match(text, /Report, never edit|edit no file|You edit nothing/i)
})

test("vivi.md pins the strict spike filename/gate_id grammar", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /NO leading `S`\/`s`/i, "vivi.md must forbid the leading-S filename")
  assert.match(text, /gate:phase0:s<nn>-<slug>/, "vivi.md must show the gate_id grammar")
  assert.match(
    text,
    /filename stem \*\*verbatim\*\*|equal the filename without `\.md`/i,
    "vivi.md must require gate_id slug == filename stem"
  )
})

test("the spec-kind discipline is pinned across vivi/implementer/reviewer prompts", () => {
  const vivi = readPrompt("vivi.md")
  assert.match(vivi, /spec_kind: project/, "vivi.md must document the project kind")
  assert.match(vivi, /spec_kind: feature/, "vivi.md must document the feature kind")
  assert.match(vivi, /grill the CHANGE, not the world/i, "vivi.md must scope the feature grill")
  assert.match(vivi, /do NOT redefine the stack/i, "vivi.md must forbid re-specifying an existing product's stack")

  const implementer = readPrompt("implementer.md")
  assert.match(implementer, /spec_kind/, "implementer.md must read the manifest's spec_kind")
  assert.match(implementer, /follow ITS structure, naming, and idioms/i, "implementer.md must bind feature work to existing conventions")

  const reviewer = readPrompt("reviewer.md")
  assert.match(reviewer, /spec_kind/, "reviewer.md must read the manifest's spec_kind")
  assert.match(
    reviewer,
    /rewrites or restyles pre-existing code beyond the issue's needs is a fail/i,
    "reviewer.md must fail diffs that rewrite pre-existing code"
  )
})

test("the zero-comment / no-time-marker hygiene is pinned across implementer/reviewer prompts and the target AGENTS.md template", () => {
  const implementer = readPrompt("implementer.md")
  assert.match(implementer, /CODE HYGIENE/, "implementer.md must carry the code-hygiene section")
  assert.match(implementer, /ZERO comments by default/i)
  assert.match(implementer, /not derivable from the code itself/i)
  assert.match(implementer, /ONE dense line/i)
  assert.match(implementer, /NEVER match the comment density/i, "an existing codebase's comment density must never be imitated")
  assert.match(implementer, /do not restyle untouched code/i, "hygiene must not license out-of-scope rewrites")
  assert.match(implementer, /version markers/i)
  assert.match(implementer, /never when or in which batch/i, "implementer.md must ban time-fixed references")

  const reviewer = readPrompt("reviewer.md")
  assert.match(reviewer, /Code hygiene \(MUST enforce on the whole diff\)/i, "reviewer.md must carry the hygiene enforcement section")
  assert.match(reviewer, /non-invariant comment/i)
  assert.match(reviewer, /time-fixed reference/i)
  assert.match(reviewer, /do not restyle untouched code/i)

  const template = readFileSync(join(FACTORY_DIR, "templates", "AGENTS.md"), "utf8")
  assert.match(template, /Zero comments by default/i, "the scaffolded AGENTS.md must carry the standing comment rule")
  assert.match(template, /structural invariant/i)
  assert.match(template, /Never encode a moment in time/i, "the scaffolded AGENTS.md must ban time-fixed references")
  assert.match(template, /may amend this section/i, "the owner valve must stay")
})

test("vivi.md carries the governess charter (action protocol, no code, no CR decision)", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /```vivicy-action/, "vivi.md must document the vivicy-action fence")
  assert.match(text, /"actions": \[\{"tool":/, "vivi.md must show the envelope shape")
  for (const tool of [
    "status.read",
    "workflow.start",
    "workflow.resume",
    "workflow.stop",
    "workflow.extract",
    "workflow.retry",
    "skills.install",
    "skills.remove",
    "map.move",
    "crs.list",
    "cycle.open",
    "cycle.cancel",
    "notifications.read",
  ]) {
    assert.match(text, new RegExp(tool.replace(".", "\\.")), `vivi.md must document the ${tool} tool`)
  }
  assert.match(text, /You never write code/i, "vivi.md must carry the no-code prohibition")
  assert.match(text, /no `cr\.decide` tool/i, "vivi.md must state the CR decision is never hers")
  assert.match(text, /never repeat a succeeded action/i, "vivi.md must forbid re-issuing succeeded actions")
})

test("vivi.md serves a question batch as validated cards, and pins every bound the parser enforces", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /```vivicy-questions/, "vivi.md must document the vivicy-questions fence")
  assert.match(text, /"recommended": true/, "vivi.md must show the recommended flag")
  assert.match(text, /"allowOther": true/, "vivi.md must show the always-on free answer")
  assert.match(text, /1 to 6 cards/i, "vivi.md must pin the stack cap the parser enforces")
  assert.match(text, /2 or 3 options/i, "vivi.md must pin the option count the parser enforces")
  assert.match(text, /exactly one marked/i, "vivi.md must pin the single-recommendation law")
  assert.match(text, /200 characters at most/i, "vivi.md must pin the question length bound")
  assert.match(text, /80 characters at most/i, "vivi.md must pin the option label bound")
  assert.match(text, /NEVER a card/i, "vivi.md must keep open questions out of the cards")
  assert.match(text, /dropped WHOLE/i, "vivi.md must state that a malformed block loses the whole batch")
  assert.match(text, /never re-ask a card that already carries its line/i, "vivi.md must forbid re-asking an answered card")
})

test("vivi.md carries the red-gate playbook: report paths, the four cause classes, and the propose-one-action discipline", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /When it burns/i, "vivi.md must carry the red-gate playbook section")
  assert.match(text, /-blocked\.json/, "the playbook must send Vivi to the per-issue block report")
  assert.match(text, /extraction-status\.json/, "the playbook must send Vivi to the extraction block report")
  assert.match(text, /-gate\.json/, "the playbook must send Vivi to the gate evidence")
  assert.match(text, /development\/transcripts\//, "the playbook must send Vivi to the leg transcript")
  for (const cls of ["transient", "environment", "spec contradiction", "quota"]) {
    assert.match(text, new RegExp(`\\*\\*${cls}\\*\\*`), `the playbook must classify the ${cls} cause (bold class cell)`)
  }
  assert.match(text, /workflow\.retry/, "the transient class must propose the retry action")
  assert.match(text, /Change Request/, "the spec-contradiction class must propose drafting a CR")
  assert.match(text, /quota-state\.json/, "the quota class must cite the quota-state report")
  assert.match(text, /You PROPOSE; the owner clicks/, "the playbook must keep P2: propose, owner decides")
})

test("vivi.md carries la Nonna's voice WITH the no-seasoning-in-files guard", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /la Nonna's kitchen/i, "vivi.md must define the Nonna voice section")
  assert.match(text, /la ricetta/, "vivi.md must map the spec to the recipe")
  assert.match(text, /mise en place/, "vivi.md must map extracted issues to the mise en place")
  assert.match(text, /Seasoning, never the dish/i, "vivi.md must bound the metaphor density")
  assert.match(text, /The files never get seasoned/i, "vivi.md must forbid the metaphor in written files")
  assert.match(text, /Sober when it burns/i, "vivi.md must require plain facts first on errors")
  assert.match(text, /Engineer first, Nonna second/i, "vivi.md must pin the engineer-first posture")
  assert.match(text, /not a toy/i, "vivi.md must state Vivicy is not a toy")
})

test("skill-scout.md carries the propose-only keep/drop/add scouting discipline", () => {
  const text = readPrompt("skill-scout.md")
  assert.match(text, /SELF-CONTAINED/, "skill-scout.md must declare it is self-contained")
  assert.match(text, /Skill Scout/i)
  assert.match(text, /npx -y skills find/)
  assert.match(text, /VERBATIM in `npx skills find` output/i, "the scout must never invent skill ids")
  assert.match(text, /Prefer OFFICIAL vendor skills/i)
  assert.match(text, /set of agent skills this project SHOULD have/i, "the contract is the whole set, not additions alone")
  assert.match(text, /Each one your context lists gets a `keep` or a `drop`/i, "every installed skill owes a verdict")
  assert.match(text, /your order IS the priority the orchestrator obeys/i, "the ranking is the scout's, and nothing reorders it")
  assert.match(text, /RESERVE the orchestrator falls back on/i, "the tail past the budget backfills a refused candidate")
  assert.match(text, /AT MOST 6 skills is the project TOTAL/i, "the cap is a project total, never a per-run budget")
  assert.match(text, /bounds your context names/i, "and the per-run bound comes from the context, so the two can never contradict")
  assert.match(text, /"add": \[\], "installed": \[\]/, "zero selection must be a legitimate result")
  assert.match(text, /Do \*\*NOT\*\* install or remove anything/i)
  assert.match(text, /"id": "owner\/repo@skill"/)
})

test("map-review.md carries the independent per-lens review method", () => {
  const text = readPrompt("map-review.md")
  assert.match(text, /independent domain-expert reviewer/i)
  assert.match(text, /ONE lens/i)
  assert.match(text, /seven systemic passes/i)
  assert.match(text, /Source-of-truth audit/i)
  assert.match(text, /findings/i)
  assert.match(text, /never a human reviewing/i)
})

test("every leg prompt carries the data-not-instructions injection boundary", () => {
  const onDisk = readdirSync(FACTORY_PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
  assert.deepEqual(
    onDisk,
    [...ALL_LEG_PROMPTS].sort(),
    "a prompt file was added or removed without updating the injection-boundary pin list — every leg reading owner/repo content must carry the boundary"
  )
  for (const name of ALL_LEG_PROMPTS) {
    const text = readPrompt(name)
    assert.match(text, /data, not instructions/i, `${name} must name the data-not-instructions boundary`)
    assert.match(text, /never an instruction you obey/i, `${name} must forbid obeying a directive embedded in the content it reads`)
  }
})

test("acceptance.md carries the whole-product acceptance method (fresh-context, propose-only, structured verdict, recorded seam)", () => {
  const text = readPrompt("acceptance.md")
  assert.match(text, /SELF-CONTAINED/, "acceptance.md must declare it is self-contained")
  assert.match(text, /Whole-Product Acceptance/i, "acceptance.md must define the whole-product acceptance role")
  assert.match(text, /end-to-end acceptance scenario/i, "acceptance.md must check the spec's end-to-end scenarios")
  assert.match(text, /[Cc]ross-issue seam/i, "acceptance.md must check cross-issue seams the per-issue gates miss")
  assert.match(text, /satisfied only on paper|on paper/i, "acceptance.md must catch a spec area satisfied only on paper")
  assert.match(text, /RUN it|run it in the target|runnable/i, "acceptance.md must run executable scenarios")
  assert.match(text, /read_only|read-verify/i, "acceptance.md must read-verify the non-executable scenarios")
  assert.match(text, /run.?story/i, "acceptance.md must record the run-story seam (what it cannot execute yet)")
  assert.match(text, /acceptance-verdict\.json/, "acceptance.md must write its structured verdict to acceptance-verdict.json")
  assert.match(
    text,
    /You edit no product file and you decide nothing|propose/i,
    "acceptance.md must be propose-only (P5): the leg proposes, the orchestrator routes"
  )
})

test("vivi.md pins the document-intake law: read the whole corpus first, prove it with the synthesis, grill only the gaps", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /## When documents land — read first, then grill only the gaps/, "vivi.md must carry the document-intake section")
  assert.match(text, /Handing you documents IS a request/i, "the section must state the import itself is the request")
  assert.match(text, /END TO END/, "the section must require reading every file end to end")
  assert.match(text, /a partially read source is a falsely read source/i, "the section must carry the exhaustive-observation law")
  assert.match(text, /never modify anything under `\.vivicy\/uploads\/`/i, "the section must keep the uploads immutable")
  assert.match(text, /synthesis that PROVES the reading/i, "the section must require the synthesis as the proof of reading")
  assert.match(text, /Never ask what the documents already answer/i, "the section must forbid re-asking what the corpus answers")
  assert.match(text, /what are you building\?" after a cahier des charges/i, "the section must name the observed failure it forbids")
  assert.match(text, /Never defer the reading/i, "the section must forbid deferring the reading")
  assert.match(text, /there's nothing for you to check right now/i, "the section must forbid the observed deferral phrasing verbatim")
  assert.match(
    text,
    /it is not your reading, and it never excuses you from reading now/i,
    "the section must deny the doc-prep stage as an excuse"
  )
})

test("vivi.md's quality bar requires the spec to state its end-to-end acceptance scenario(s)", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /## The quality bar for every canonical doc/, "vivi.md must keep the quality-bar section")
  assert.match(text, /end-to-end acceptance scenario/i, "vivi.md's quality bar must require stated end-to-end acceptance scenarios")
  assert.match(
    text,
    /what a user DOES with the finished thing|what a user DOES/i,
    "the item must frame the scenario as a user walkthrough with observable outcome"
  )
  assert.match(
    text,
    /whole-product obligation the acceptance pass checks/i,
    "the item must tie the scenario to the whole-product acceptance pass"
  )
})

test("vivi.md's quality bar requires the spec to state how the product runs and ships (run command + deploy story)", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /State how it runs and ships/i, "vivi.md's quality bar must require the run-and-ship area")
  assert.match(text, /run command/i, "the item must require the command that starts the product")
  assert.match(text, /deploy target/i, "the item must require the deploy target (or an explicit none)")
  assert.match(text, /rollback/i, "the item must require the rollback expectation for a named deploy target")
  assert.match(text, /vivicy\.json#runCommand/, "the item must tie the run command to vivicy.json#runCommand")
  assert.match(
    text,
    /never invent a run command or a deploy target/i,
    "the item must forbid inventing run/deploy details the owner did not state"
  )
})

test("vivi.md's quality bar grills the quality ambition (what GOOD looks like) and translates non-technical bars into checkable statements", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /State the quality ambition — what GOOD looks like/i, "vivi.md's quality bar must carry the ambition item")
  assert.match(text, /gap between "it runs" and "it's good"/i, "the item must name the mediocre gap the ambition closes")
  assert.match(
    text,
    /reference products or experiences the owner points at/i,
    "the item must grill the reference products/experiences the owner points at"
  )
  assert.match(text, /moments that must feel effortless or instant/i, "the item must grill the moments that must feel effortless")
  assert.match(text, /would make the owner reject the plate at tasting/i, "the item must grill what would make the owner reject the result")
  assert.match(text, /my mother could use it/, "the item must translate a non-technical ambition example")
  assert.match(text, /into concrete, checkable statements/i, "the translation duty must produce concrete checkable statements")
  assert.match(
    text,
    /the reviewer and the acceptance pass judge the assembled build against/i,
    "the ambition must become an obligation the reviewer + acceptance pass judge against"
  )
})

test("reviewer.md and acceptance.md judge the build against the spec's stated ambition, not just its functional letter", () => {
  const reviewer = readPrompt("reviewer.md")
  assert.match(
    reviewer,
    /Judge against the spec's ambition, not only its letter/i,
    "reviewer.md must carry the judge-against-ambition line"
  )
  assert.match(reviewer, /ships below the stated bar is a fidelity miss/i, "reviewer.md must make a below-ambition result a fidelity miss")
  assert.match(
    reviewer,
    /returned `not_faithful`/,
    "the reviewer ambition miss must route through its existing not_faithful verdict, no new machinery"
  )

  const acceptance = readPrompt("acceptance.md")
  assert.match(acceptance, /Ambition, not only the functional letter/i, "acceptance.md must carry the judge-against-ambition check")
  assert.match(
    acceptance,
    /ships below its own stated bar is a whole-product gap/i,
    "acceptance.md must make a below-ambition build a whole-product gap"
  )
  assert.match(
    acceptance,
    /never an ambition the canonical did not state/i,
    "acceptance.md must bound the check to the spec's stated bar, not the leg's taste"
  )
})

test("vivi.md points at the post-cycle retro report, routes each owner-decided proposal through its existing surface, and settles only what the skills stage actually ran", () => {
  const text = readPrompt("vivi.md")
  assert.match(text, /retro-report\.json/, "vivi.md must point at the retro report")
  assert.match(text, /recurring failure classes/i, "vivi.md must name what the retro records")
  assert.match(text, /settings dialog/i, "vivi.md must route a settings proposal to the settings dialog")
  assert.match(text, /Change Request you draft/i, "vivi.md must route a method-block/canonical proposal through the CR flow (§3)")
  assert.match(
    text,
    /never applying a proposal yourself|owner-decided data until they click/i,
    "vivi.md must keep the owner-decided landings owner-decided, never self-applied"
  )
  assert.match(
    text,
    /carrying a recorded `skill_install` outcome/,
    "vivi.md must key 'already settled' to the RECORDED outcome, never to the landing"
  )
  assert.match(
    text,
    /Every proposal WITHOUT that outcome[^.]*is still owner-decided/,
    "vivi.md must keep every proposal the stage did not run owner-decided"
  )
  assert.match(
    text,
    /never to re-run what the stage already decided/i,
    "vivi.md must stop Vivi re-running skills.install over a proposal the skills stage already decided"
  )
})

test("retro.md carries the post-cycle retro method (fresh-context, recurring-class floor, mapped propose-only amendments, structured verdict, recorded cross-cycle seam)", () => {
  const text = readPrompt("retro.md")
  assert.match(text, /SELF-CONTAINED/, "retro.md must declare it is self-contained")
  assert.match(text, /Post-Cycle Retro/i, "retro.md must define the post-cycle retro role")
  assert.match(text, /runs AFTER|cycle has closed|acceptance pass went green/i, "retro.md must run at the close, after acceptance green")
  assert.match(text, /at least TWICE|at least two occurrences|RECURRING/i, "retro.md must define a recurring class as ≥2 occurrences")
  assert.match(text, /one-off failure is NOT recurring|A one-off failure is/i, "retro.md must exclude one-off failures")
  for (const landing of ["method_block", "skill", "settings", "canonical_clarification"]) {
    assert.match(text, new RegExp(landing), `retro.md must map a proposal to the ${landing} landing place`)
  }
  assert.match(
    text,
    /Change Request flow/i,
    "retro.md must route a method-block/canonical amendment through the existing CR flow (§3 adjudication)"
  )
  assert.match(text, /retro-verdict\.json/, "retro.md must write its structured verdict to retro-verdict.json")
  assert.match(text, /recorded seam/i, "retro.md must record the cross-cycle-arc seam (this cycle only)")
  assert.match(
    text,
    /You edit no file and you decide nothing|propose only|never self-apply/i,
    "retro.md must be propose-only (P5): the leg applies nothing itself"
  )
  assert.match(text, /`skill_id`/, "retro.md must order the structured skill_id field")
  assert.match(text, /owner\/repo@skill/, "retro.md must pin the id grammar the boundary parses")
  assert.match(
    text,
    /INSTALL ORDER/,
    "retro.md must state that skill_id is acted on autonomously, never a suggestion the owner has to carry"
  )
  assert.match(
    text,
    /security audit, cap and name-collision gates every install passes/,
    "retro.md must name the gates a proposed install still passes"
  )
  assert.match(
    text,
    /refused at the boundary and the proposal degrades to a text suggestion/,
    "retro.md must state what an unparseable id degrades to"
  )
  assert.match(
    text,
    /removal.*carries NO `skill_id`|nothing removes a skill automatically/i,
    "retro.md must keep removals text-only (no keep/drop lifecycle exists to act on)"
  )
  assert.match(
    text,
    /an id sitting on any other landing is ignored and that proposal stays owner-decided/,
    "retro.md must state the parser's own rule: a skill_id binds only on a skill proposal"
  )
})

const PINNED_KERNELS: Array<{ kernel: string; anchor: RegExp; prompts: string[] }> = [
  {
    kernel: "anti-token-economy asymmetry (exhaustive observation, minimal addition)",
    anchor: /[Tt]oken economy never trumps evidence/,
    prompts: [
      "implementer.md",
      "reviewer.md",
      "extractor.md",
      "extraction-verifier.md",
      "map-review.md",
      "acceptance.md",
      "readiness-checker.md",
      "spike-verifier.md",
      "doc-prep.md",
      "skill-scout.md",
      "cr-applier.md",
      "vivi.md",
    ],
  },
  {
    kernel: "negative claims only over enumerated, visited territory",
    anchor: /proves presence, never absence/,
    prompts: [
      "reviewer.md",
      "extraction-verifier.md",
      "map-review.md",
      "acceptance.md",
      "retro.md",
      "readiness-checker.md",
      "spike-verifier.md",
    ],
  },
  {
    kernel: "map-first orientation for legs working in the tree",
    anchor: /[Mm]ap first/,
    prompts: ["implementer.md", "reviewer.md", "extractor.md"],
  },
  {
    kernel: "structured sweep (enumerate, visit every partition, drill on signal)",
    anchor: /coverage is structural, never query-dependent/,
    prompts: ["extraction-verifier.md", "map-review.md", "acceptance.md", "retro.md"],
  },
  {
    kernel: "vicious-defect taxonomy injection slot (the single-source class list)",
    anchor: /\{\{vicious_defect_classes\}\}/,
    prompts: ["implementer.md", "reviewer.md", "extractor.md", "extraction-verifier.md"],
  },
  {
    kernel: "vicious-defect torture-criteria injection slot (the single-source proof shapes)",
    anchor: /\{\{vicious_torture_criteria\}\}/,
    prompts: ["extractor.md", "extraction-verifier.md"],
  },
  {
    kernel: "proof-class taxonomy injection slot (the single-source proportionality list)",
    anchor: /\{\{proof_classes\}\}/,
    prompts: ["extractor.md", "extraction-verifier.md"],
  },
  {
    kernel: "declared-proofs directive slot (produced by the implementer, judged by the reviewer)",
    anchor: /\{\{proofs_directive\}\}/,
    prompts: ["implementer.md", "reviewer.md"],
  },
  {
    kernel:
      "absent-project-skills directive slot (the two legs the skills block instructs are the two that must be told when a bundle is not there)",
    anchor: /\{\{skills_directive\}\}/,
    prompts: ["implementer.md", "reviewer.md"],
  },
]

test("every pinned kernel sits exactly where adjudicated — present in each receiving prompt, absent everywhere else", () => {
  for (const { kernel, anchor, prompts } of PINNED_KERNELS) {
    for (const name of ALL_LEG_PROMPTS) {
      const text = readPrompt(name)
      if (prompts.includes(name)) {
        assert.match(text, anchor, `${name} must carry the ${kernel} kernel`)
      } else {
        assert.doesNotMatch(
          text,
          anchor,
          `${name} must NOT carry the ${kernel} kernel — a kernel pasted where it drives nothing is over-instruction (and vivi.md reaches the leg only through lib/vivi.ts's raw persona embed — its factory binding, legDepsForVerbatimPrompt, discards the role template and never substitutes — so a slot there would reach the leg as a literal placeholder)`
        )
      }
    }
  }
})

const CLASS_VICE_TOKENS: Array<[string, RegExp]> = [
  ["Concurrency", /read-modify-write|check-then-act/],
  ["Time", /non-monotonic/],
  ["Async and ordering", /floating promises/],
  ["State and persistence", /half-applied migrations/],
  ["Data boundaries", /NFC vs NFD/],
  ["Resources", /ignored backpressure/],
  ["Network", /half-closed/],
  ["Security", /zip-slip/],
  ["Environment", /missed watcher events/],
  ["Human and UX", /two tabs one session/],
]

test("the vicious-defect class list is single-sourced in the factory — no prompt file restates any of the ten classes", () => {
  for (const name of ALL_LEG_PROMPTS) {
    const text = readPrompt(name)
    for (const [label, token] of CLASS_VICE_TOKENS) {
      assert.doesNotMatch(
        text,
        token,
        `${name} restates the ${label} class — the ten classes are injected from ONE factory-side source (composePrompt's \`vicious_defect_classes\`), never pasted per prompt`
      )
    }
  }
  assert.equal(
    CLASS_VICE_TOKENS.length,
    10,
    "one probe per class: a class with no probe is a class that can be pasted into a prompt unnoticed"
  )
})

test("the torture-criteria proof shapes are single-sourced too — neither extraction prompt restates them", () => {
  for (const name of ALL_LEG_PROMPTS) {
    const text = readPrompt(name)
    for (const shape of [/kill it mid-write/, /deliver the action twice/, /N writers/, /prove nothing leaked/]) {
      assert.doesNotMatch(
        text,
        shape,
        `${name} restates a torture-criterion shape — they are injected from ONE factory-side source (composePrompt's \`vicious_torture_criteria\`); two copies already drifted once`
      )
    }
  }
})

test("vivi.md's quality bar grills the reliability expectations a product's nature invites (the intake the owner never states)", () => {
  const text = readPrompt("vivi.md")
  assert.match(
    text,
    /State the reliability expectations the product's nature invites/,
    "vivi.md's quality bar must carry the reliability-intake item"
  )
  assert.match(
    text,
    /multi-user, handles money, crosses a network, runs background or scheduled work, or rewrites files the user cares about/,
    "the item triggers on the product's nature, not on every product"
  )
  assert.match(text, /the owner rarely thinks to state them/, "the item exists because these obligations are the unstated ones")
  assert.match(text, /double-clicks or works in two tabs/, "the double-fire question")
  assert.match(text, /a call is retried or arrives twice/, "the replay question")
  assert.match(text, /the process dies mid-save/, "the crash-mid-write question")
  assert.match(text, /a credential or a lock expires mid-operation/, "the expiry-mid-operation question")
  assert.match(text, /the clock or the timezone moves/, "the time question")
  assert.match(text, /never a generic questionnaire/, "the grill stays scoped to the product's nature")
  assert.match(
    text,
    /as an ordinary canonical obligation — quantified \(the window, the retry budget, the retention\), with its detection and recovery/,
    "each answer lands as a quantified obligation with detection + recovery, no new artifact"
  )
  assert.match(
    text,
    /the factory prevents and tortures what the spec states, and guesses nothing/,
    "the item ties the intake to the prevent + torture halves downstream"
  )
})

test("the vicious-defect taxonomy pairs with a gate-provable torture criterion: the extractor mints it, the verifier flags the missing pairing", () => {
  const extractor = readPrompt("extractor.md")
  assert.match(
    extractor,
    /A class the spec's own behaviour touches becomes a gate-provable obligation/,
    "extractor.md must turn a touched class into an obligation"
  )
  assert.match(
    extractor,
    /that class's TORTURE criterion in its `## Verification`, expressed in THIS product's stack — \{\{vicious_torture_criteria\}\}/,
    "the criterion is stated in the issue's Verification, in the product's own stack, with the proof shapes injected from the single source"
  )
  assert.match(
    extractor,
    /never a torture criterion for a vice the product cannot have/,
    "the criterion is bounded by what the canonical's obligations reach"
  )
  assert.match(
    extractor,
    /never a new catalog requirement: it is a verification criterion on an obligation the canonical already states, so source fidelity is untouched/,
    "the criterion can never be misread as an invented requirement"
  )
  assert.match(extractor, /a criterion that is not a real gate-provable test is not an obligation/, "prose is not a criterion")
  assert.match(
    extractor,
    /the torture criterion of every vicious defect class the Scope touches \(see "The vicious defect classes"\)/,
    "the Issue file shape's Verification section points at the single-source class list"
  )

  const verifier = readPrompt("extraction-verifier.md")
  assert.match(
    verifier,
    /Vice pairing \(a class-touching issue owes its torture criterion\)/,
    "extraction-verifier.md must carry the pairing check"
  )
  assert.match(
    verifier,
    /must state that class's torture criterion — \{\{vicious_torture_criteria\}\} — as a real gate-provable test/,
    "the pairing check reads the proof shapes from the single source, not a second copy"
  )
  assert.match(verifier, /the vice ships unproven and nothing downstream will ask again/, "the pairing gap names what it costs")
  assert.match(
    verifier,
    /Flag it with kind `vice_pairing_gap`, naming the issue, the class, and the criterion it owes/,
    "the pairing check itself offers the problem kind (open-string precedent), not only the slug list"
  )
  assert.match(verifier, /`granularity_violation`, `vice_pairing_gap`, /, "vice_pairing_gap joins the verdict's problem-kind slug list")
  assert.match(
    verifier,
    /flag ONLY where an obligation the canonical states would visibly break if the vice occurred/,
    "the pairing gap is severity-bounded: it forces a re-author loop, so it cannot fire on a class word that merely could apply"
  )
  assert.match(
    verifier,
    /every function takes input and every screen has a button/,
    "the bound names the two near-universal classes that would otherwise swallow the corpus"
  )
  assert.match(
    verifier,
    /never flag a criterion a named test already covers under other wording/,
    "the pairing check is bounded on the other side too"
  )
})

test("the vicious-defect taxonomy is consumed as a DUTY by each anchor it reaches — the implementer prevents by design, the reviewer hunts class by class", () => {
  const implementer = readPrompt("implementer.md")
  assert.match(implementer, /Prevent, never merely test afterwards/, "implementer.md must own the prevent-by-design half")
  assert.match(
    implementer,
    /one writer, or a lock\/transaction taken before the read/,
    "shared mutable state gets one writer or an explicit lock"
  )
  assert.match(implementer, /an atomic write \(temp \+ rename\), never truncate-then-write/, "a rewritten file gets an atomic write")
  assert.match(
    implementer,
    /idempotent by construction, keyed so the second delivery is a no-op/,
    "a replayable action is idempotent by construction"
  )
  assert.match(implementer, /an injected clock and monotonic durations, never `now\(\)` read inline/, "time comes from an injected clock")
  assert.match(implementer, /idempotent retries with backoff, or none/, "external calls retry idempotently or not at all")
  assert.match(implementer, /closed on every path including the failure one/, "anything opened is closed on the failure path too")
  assert.match(implementer, /validated and normalized once, at the boundary/, "boundary input is normalized once")
  assert.match(
    implementer,
    /guarded where the state lives, never on the button alone/,
    "a twice-fireable user action is guarded at the state, not the button"
  )
  assert.match(implementer, /a class it touches and you left to chance is a defect you shipped/, "the prevent duty carries its bar")

  const reviewer = readPrompt("reviewer.md")
  assert.match(reviewer, /Hunt this list once per review, class by class/, "reviewer.md must own the named hunt")
  assert.match(reviewer, /state HOW you ruled the vice out/, "the hunt is a per-class declaration of the verification, not a feeling")
  assert.match(
    reviewer,
    /"Not applicable" is a legitimate verdict PER CLASS and only per class/,
    "not-applicable is per class, never wholesale"
  )
  assert.match(
    reviewer,
    /exactly the negative claim this prompt forbids/,
    "the hunt binds to the negative-claims law the prompt already carries"
  )
  assert.match(reviewer, /hunting grounds, not a checklist to tick/, "the ten classes never bound the review")
})

test("the proof contract spans the corpus: the extractor declares proportionally, the verifier flags both excesses, the legs produce and judge, acceptance consumes", () => {
  const extractor = readPrompt("extractor.md")
  assert.match(
    extractor,
    /^- \*\*`## Proofs`\*\* — a `text` code block declaring the a-posteriori proofs this issue owes/m,
    "the issue file shape carries the Proofs section"
  )
  assert.match(extractor, /- id: <slug unique within this issue>/, "the declaration grammar is inline, one entry per proof")
  assert.match(
    extractor,
    /the orchestrator DERIVES the proof's directory from it, so you never author a path/,
    "no authored path: the slug is the only input"
  )
  assert.match(
    extractor,
    /cites the canonical line\(s\) that proof anchors, so the chain reads requirement → code → test → proof/,
    "each proof carries its /goal link"
  )
  assert.match(
    extractor,
    /Declare each issue's proofs in its `## Proofs` block, proportionally/,
    "the extractor owns the proportional declaration"
  )
  assert.match(
    extractor,
    /a pure-logic obligation owes its gate evidence and nothing more/,
    "no ritual artifact where the gate is the witness"
  )
  assert.match(extractor, /the proof comes AFTER the gate, never instead of it/, "a proof never softens the verification bar")

  const verifier = readPrompt("extraction-verifier.md")
  assert.match(verifier, /Proof pairing, BOTH directions/, "the verifier judges declaration AND ritual")
  assert.match(verifier, /kind `proof_declaration_gap`/, "the missing-where-demanded kind (open-string precedent)")
  assert.match(verifier, /kind `proof_ritual`/, "the ritual-where-pointless kind")
  assert.match(verifier, /`proof_declaration_gap`, `proof_ritual`\)/, "both kinds join the verdict's slug list")
  assert.match(
    verifier,
    /judge the obligation's NATURE exactly as the canonical states it, never a wish for more evidence/,
    "the pairing check is bounded, like the vice pairing"
  )

  const implementer = readPrompt("implementer.md")
  assert.match(
    implementer,
    /\{\{proofs_directive\}\}/,
    "the implementer receives the per-issue proofs duty by injection, zero mass when none are owed"
  )
  const reviewer = readPrompt("reviewer.md")
  assert.match(reviewer, /\{\{proofs_directive\}\}/, "the reviewer receives the same block and owns the judging half")

  const acceptance = readPrompt("acceptance.md")
  assert.match(
    acceptance,
    /declared proofs under `\.vivicy\/development\/proofs\/<issue-id>\/`/,
    "the whole-product pass reads the per-issue proofs as evidence"
  )
  assert.match(
    acceptance,
    /their mere presence is the orchestrator's mechanical gate, never your verdict/,
    "P5 split: the machine checks presence, fresh eyes judge content"
  )
})

test("the proof HOME and the recipe filename the code owns are pinned wherever prose names them (a path copy is free to drift otherwise)", () => {
  const template = readFileSync(join(FACTORY_DIR, "templates", "AGENTS.md"), "utf8")
  for (const [label, text] of [
    ["acceptance.md", readPrompt("acceptance.md")],
    ["the governed-repo AGENTS.md template", template],
  ] as Array<[string, string]>) {
    assert.ok(
      text.includes(`${PROOFS_DIR}/`),
      `${label} names the proofs home as prose — it must match lib/proofs.ts's PROOFS_DIR (${PROOFS_DIR})`
    )
    assert.ok(
      text.includes(PROOF_RECIPE_FILE),
      `${label} names the recipe file as prose — it must match lib/proofs.ts's PROOF_RECIPE_FILE (${PROOF_RECIPE_FILE})`
    )
  }
})

test("the proof classes are single-sourced in the factory — no prompt file names one of the class ids", () => {
  for (const name of ALL_LEG_PROMPTS) {
    const text = readPrompt(name)
    for (const id of ["ui_flow", "http_transcript", "run_log", "gate_evidence"]) {
      assert.doesNotMatch(
        text,
        new RegExp(id),
        `${name} names the ${id} proof class — the classes are injected from ONE factory-side source (composePrompt's \`proof_classes\`), never pasted per prompt`
      )
    }
  }
})

test("the extractor leaves the architecture map faithful on exit (map-current-last)", () => {
  const text = readPrompt("extractor.md")
  assert.match(text, /faithful to the frozen canonical on exit/, "extractor.md must carry the map-current-last exit duty")
})

test("map-review.md carries the map quality bar (enumerated completeness, fidelity vs canonical AND code, freshness, density)", () => {
  const text = readPrompt("map-review.md")
  assert.match(text, /The map's own quality bar/, "map-review.md must carry the quality-bar section")
  assert.match(text, /Completeness is claimable only over ENUMERATED territory/, "completeness claims are bounded to enumerated territory")
  assert.match(
    text,
    /against the canonical AND, when the repo already carries product code, against that code reality/,
    "fidelity is judged against canonical AND code"
  )
  assert.match(text, /freshness \(the current frozen corpus, never a stale prior\)/, "the bar includes freshness")
  assert.match(text, /density \(complete enough to build from, neither thin marketing nor a schema dump\)/, "the bar includes density")
})

test("extraction-verifier.md flags embedded directives that bent the extraction", () => {
  const text = readPrompt("extraction-verifier.md")
  assert.match(text, /Embedded directives were NOT obeyed/i, "verifier must carry the not-obeyed check")
  assert.match(text, /prompt-injection/i, "the not-obeyed check must name the prompt-injection threat")
  assert.match(text, /embedded_directive_obeyed/, "verifier must offer the embedded_directive_obeyed problem kind")
})

test("the atomic-verified-increments law is pinned across the extractor, extraction-verifier, reviewer, and vivi prompts", () => {
  const extractor = readPrompt("extractor.md")
  assert.match(
    extractor,
    /Granularity law — the smallest end-to-end-provable slice/i,
    "extractor.md must carry the granularity law in Discipline"
  )
  assert.match(extractor, /one obligation cluster/i, "the granularity law must bound the slice to one obligation cluster")
  assert.match(
    extractor,
    /DECOMPOSED into an ordered chain/i,
    "a divisible spec area must be decomposed into ordered slices with explicit dependencies"
  )
  assert.match(extractor, /pushes the drift into the seams/i, "the granularity law must state the over-fragmentation floor")

  const verifier = readPrompt("extraction-verifier.md")
  assert.match(
    verifier,
    /Issue granularity \(each issue is one atomic slice\)/i,
    "extraction-verifier.md must carry the granularity finding"
  )
  assert.match(verifier, /granularity_violation/, "the verifier must offer the granularity_violation problem kind (open-string precedent)")
  assert.match(
    verifier,
    /over-fragmentation only moves the drift into the seams/i,
    "the granularity finding must respect the atomicity floor"
  )

  const reviewer = readPrompt("reviewer.md")
  assert.match(reviewer, /Proportionality is a review signal/i, "reviewer.md must carry the proportionality signal")
  assert.match(reviewer, /no LOC threshold/i, "the proportionality signal must reject a mechanical LOC threshold")
  assert.match(reviewer, /decomposed into smaller independently-gateable slices/i, "an oversized diff must signal a missing decomposition")

  const vivi = readPrompt("vivi.md")
  assert.match(vivi, /Slice a big ask; never one omnibus/i, "vivi.md must carry the slice-the-big-ask discipline")
  assert.match(
    vivi,
    /an ordered set of small cycles\/CRs/i,
    "a big mid-flight ask must become ordered sliced cycles/CRs, never one omnibus"
  )
})
