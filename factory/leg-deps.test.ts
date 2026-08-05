import assert from "node:assert/strict"
import test from "node:test"
import { resolve } from "node:path"

import { legDepsForTarget, legDepsForVerbatimPrompt } from "./leg-deps.ts"
import type { AgentIssue, LegDeps } from "./agent-spawn.ts"

const ROOT = resolve("/vivicy-leg-deps/target-repo")
const ISSUE: AgentIssue = {
  id: "ISSUE-0001",
  transcript_dir: "ISSUES/ISSUE-0001",
  issue_path: "issues/ISSUE-0001.md",
  graph_refs: ["node:alpha", "node:beta"],
}

test("legDepsForTarget composes the role prompt and appends the run context AFTER it", () => {
  const deps = legDepsForTarget(ROOT, "\n\n---\n\n## Context for this run\n")
  const prompt = deps.composePrompt("Fix {{issue_id}} at {{issue_path}} touching {{graph_refs}}.", ISSUE)

  assert.equal(prompt, "Fix ISSUE-0001 at issues/ISSUE-0001.md touching node:alpha, node:beta.\n\n---\n\n## Context for this run\n")
  assert.ok(
    prompt.indexOf("Fix ISSUE-0001") < prompt.indexOf("## Context for this run"),
    "the role prompt leads and the run context follows — a swap would put the run's instructions before the role that must obey them"
  )
})

test("legDepsForTarget carries the REAL composePrompt, so a leg gets no unfilled slot and no per-stage wiring", () => {
  const deps = legDepsForTarget(ROOT, "")
  const prompt = deps.composePrompt("{{issue_id}}\n{{vicious_defect_classes}}\n{{vicious_torture_criteria}}\n{{proof_classes}}", ISSUE)

  assert.doesNotMatch(
    prompt,
    /\{\{/,
    "every slot composePrompt owns is filled — a stub composer would leak the literal placeholder to the leg"
  )
  assert.match(prompt, /The vicious defect classes/, "the taxonomy dev-loop single-sources reaches every stage bound through this seam")
  assert.equal(
    deps.composePrompt("Role prompt.", ISSUE),
    "Role prompt.",
    "an empty context appends NOTHING — no separator invented on the stage's behalf"
  )
})

test("the run context is appended AFTER composition, so slot-shaped text a stage splices in stays literal", () => {
  const deps = legDepsForTarget(ROOT, "\n\nThe change request says: replace {{issue_id}} in the template.")
  const prompt = deps.composePrompt("Role prompt for {{issue_id}}.", ISSUE)

  assert.equal(prompt, "Role prompt for ISSUE-0001.\n\nThe change request says: replace {{issue_id}} in the template.")
  assert.match(
    prompt,
    /replace \{\{issue_id\}\} in the template/,
    "composing the CONCATENATION instead would substitute inside agent-written context (CR bodies, prior-attempt feedback) — that text is quoted evidence, never a template"
  )
})

test("legDepsForTarget roots the leg at the target repo: abs() resolves against it, execRoot is it, and cwdFilter stays null", () => {
  const deps = legDepsForTarget(ROOT, "")

  assert.equal(
    deps.abs(".vivicy/development/reports/extraction-status.json"),
    resolve(ROOT, ".vivicy/development/reports/extraction-status.json")
  )
  assert.equal(deps.abs("/already/absolute"), "/already/absolute", "an absolute rel wins, exactly as node:path resolve defines it")
  assert.equal(deps.execRoot, ROOT)
  assert.equal(
    deps.cwdFilter,
    null,
    "null asserts no two legs bound here are ever in flight in the same tree; dev-loop's own legDeps sets a real filter because its legs run N-way in sibling worktrees"
  )
})

test("legDepsForTarget hands the leg dev-loop's real agentCliArgs, per provider", () => {
  const deps = legDepsForTarget(ROOT, "")
  const leg = { actor: "claude", role: "implementer", model: "opus-4.8", effort: "xhigh" }

  assert.deepEqual(deps.agentCliArgs("claude", leg), ["--model", "opus-4.8", "--effort", "xhigh"])
  assert.deepEqual(deps.agentCliArgs("codex", leg), ["-m", "opus-4.8", "-c", 'model_reasoning_effort="xhigh"'])
})

test("legDepsForVerbatimPrompt sends the pre-composed prompt untouched, ignoring both the role template and the issue", () => {
  const promptText =
    "\n\nVivi persona + transcript + .vivicy state, already assembled by lib/vivi.ts. Slots like {{issue_id}} are literal here.\n\n"
  const deps = legDepsForVerbatimPrompt(ROOT, promptText)

  assert.equal(
    deps.composePrompt("# vivi\n\nWhatever the role file says {{issue_id}}.", ISSUE),
    promptText,
    "no double-composition and no tidying: what lib/vivi.ts wrote, to the byte, is what the leg runs"
  )
  assert.equal(deps.composePrompt("", { id: "vivi", transcript_dir: null }), promptText)
})

test("both bindings share ONE rooting — only the prompt differs", () => {
  const composed = legDepsForTarget(ROOT, "ctx")
  const verbatim = legDepsForVerbatimPrompt(ROOT, "text")
  const fields = Object.keys(composed).sort()
  const read = (deps: LegDeps, key: string): unknown => {
    const value = (deps as unknown as Record<string, unknown>)[key]
    return typeof value === "function" ? (value as (rel: string) => unknown)("a/b.json") : value
  }

  assert.deepEqual(
    Object.keys(verbatim).sort(),
    fields,
    "a field set on one builder and not the other is the fork this seam exists to prevent"
  )
  for (const key of fields) {
    if (key === "composePrompt") continue
    assert.deepEqual(
      read(verbatim, key),
      read(composed, key),
      `${key} forked between the two bindings — every field but composePrompt comes from the one literal`
    )
  }
  assert.equal(verbatim.agentCliArgs, composed.agentCliArgs, "the same imported function, not two wrappers")
})
