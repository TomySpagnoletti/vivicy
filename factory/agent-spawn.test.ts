import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LEG_ROLE_PATTERN, LegPromptError, legRoles, readPrompt } from "./agent-spawn.ts";
import { FACTORY_DIR, FACTORY_PROMPTS_DIR } from "./target-root.ts";

function scratchPrompts(): string {
  return mkdtempSync(join(tmpdir(), "vivicy-prompts-"));
}

function refusal(run: () => unknown): LegPromptError {
  let outcome: unknown;
  try {
    outcome = run();
  } catch (error) {
    assert.ok(error instanceof LegPromptError, `expected a LegPromptError, got ${String(error)}`);
    return error;
  }
  assert.fail(`expected a typed refusal, got ${JSON.stringify(outcome)}`);
}

test("readPrompt returns the role's prompt verbatim when the file backs it", () => {
  const dir = scratchPrompts();
  try {
    writeFileSync(join(dir, "readiness-checker.md"), "# Readiness Checker\n\nbody\n");
    assert.equal(readPrompt({ promptsDir: dir }, "readiness-checker"), "# Readiness Checker\n\nbody\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPrompt refuses a leg role with no prompt file, naming the role, the expected path, and the directory-derived valid roles", () => {
  const dir = scratchPrompts();
  try {
    writeFileSync(join(dir, "implementer.md"), "impl\n");
    writeFileSync(join(dir, "reviewer.md"), "rev\n");
    const error = refusal(() => readPrompt({ promptsDir: dir }, "readiness-checker"));
    assert.equal(error.code, "unknown_leg_role");
    assert.equal(error.name, "LegPromptError");
    assert.equal(error.role, "readiness-checker");
    assert.equal(error.promptPath, resolve(dir, "readiness-checker.md"));
    assert.match(error.message, /leg role "readiness-checker" has no prompt file/, "the refusal names the role that has no prompt");
    assert.ok(error.message.includes(resolve(dir, "readiness-checker.md")), "the refusal names the exact path it expected");
    assert.match(error.message, /Valid roles \(one per prompt file under .*\): implementer, reviewer\./, "the refusal lists the roles derived from the prompt directory, never a hand-list");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPrompt refuses a blank prompt file rather than running a leg on no instructions", () => {
  const dir = scratchPrompts();
  try {
    writeFileSync(join(dir, "reviewer.md"), "   \n\t\n");
    const error = refusal(() => readPrompt({ promptsDir: dir }, "reviewer"));
    assert.equal(error.code, "empty_leg_prompt");
    assert.equal(error.role, "reviewer");
    assert.equal(error.promptPath, resolve(dir, "reviewer.md"));
    assert.match(error.message, /empty prompt file/, "the refusal says the file is empty, not that the role is unknown");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPrompt refuses a malformed leg role before it can resolve outside the prompt directory", () => {
  const root = mkdtempSync(join(tmpdir(), "vivicy-prompts-root-"));
  try {
    const dir = join(root, "prompts");
    mkdirSync(dir);
    writeFileSync(join(dir, "reviewer.md"), "rev\n");
    writeFileSync(join(root, "outside.md"), "escaped\n");
    for (const role of ["", "  ", "../outside", "nested/reviewer", "Reviewer", "spike_prover", "reviewer.md", "-reviewer", "reviewer-"]) {
      const error = refusal(() => readPrompt({ promptsDir: dir }, role));
      assert.equal(error.code, "invalid_leg_role", `role ${JSON.stringify(role)} must be refused as malformed`);
      assert.equal(error.promptPath, null, `role ${JSON.stringify(role)} must be refused with no resolved prompt path to speak of`);
      assert.ok(!error.message.includes(join(root, "outside.md")), `role ${JSON.stringify(role)} must never name a path outside the prompt directory`);
    }
    const nonString = refusal(() => readPrompt({ promptsDir: dir }, null as unknown as string));
    assert.equal(nonString.code, "invalid_leg_role");
    assert.match(nonString.message, /"null" is not a valid leg role/, "a non-string role degrades to the same typed refusal, never a raw TypeError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readPrompt refuses a leg config with no prompts directory instead of throwing a raw path error", () => {
  for (const promptsDir of [undefined, "", "   "]) {
    const error = refusal(() => readPrompt({ promptsDir }, "implementer"));
    assert.equal(error.code, "prompts_dir_unset");
    assert.equal(error.role, "implementer");
    assert.equal(error.promptPath, null);
    assert.match(error.message, /carries no promptsDir/, "the refusal names the missing config field");
  }
});

test("readPrompt distinguishes an unreadable prompt from an absent one instead of blaming the role", () => {
  const dir = scratchPrompts();
  try {
    mkdirSync(join(dir, "reviewer.md"));
    const error = refusal(() => readPrompt({ promptsDir: dir }, "reviewer"));
    assert.equal(error.code, "prompt_unreadable", "a directory sitting where the prompt belongs is a read failure, not an unknown role");
    assert.equal(error.promptPath, resolve(dir, "reviewer.md"));
    assert.equal((error.cause as { code?: string } | undefined)?.code, "EISDIR", "the underlying errno rides along as the cause");
    assert.doesNotMatch(error.message, /has no prompt file/, "a present-but-unreadable prompt must never be reported as a missing role");
    assert.deepEqual(legRoles(dir), [], "a directory named <role>.md is never advertised as a valid role");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("legRoles derives the valid role set from the prompt directory alone (*.md stems, non-prompt files ignored)", () => {
  const dir = scratchPrompts();
  try {
    writeFileSync(join(dir, "zebra-groomer.md"), "z\n");
    writeFileSync(join(dir, "quokka-herder.md"), "q\n");
    writeFileSync(join(dir, "aardvark-tamer.md"), "a\n");
    writeFileSync(join(dir, "notes.txt"), "not a prompt\n");
    writeFileSync(join(dir, "README"), "not a prompt\n");
    assert.deepEqual(legRoles(dir), ["aardvark-tamer", "quokka-herder", "zebra-groomer"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every role the factory's own prompt directory declares loads a non-empty prompt through the spawn seam", () => {
  const roles = legRoles(FACTORY_PROMPTS_DIR);
  assert.ok(roles.length > 0, "the factory prompt directory must declare at least one leg role");
  for (const role of roles) {
    assert.match(role, LEG_ROLE_PATTERN, `prompt file ${role}.md is not named after a valid leg role`);
    assert.ok(readPrompt({ promptsDir: FACTORY_PROMPTS_DIR }, role).trim().length > 0, `role ${role} must load a non-empty prompt`);
  }
});

const LEG_ROLE_LITERAL = new RegExp(`(?:\\brole:\\s*|\\bleg\\()"(${LEG_ROLE_PATTERN.source.replace(/^\^|\$$/g, "")})"`, "g");

test("the role set the factory stamps on legs and the prompt-file set are the same set (bidirectional, no hand-list on either side)", () => {
  const stamped = new Set<string>();
  const sources = readdirSync(FACTORY_DIR).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"));
  assert.ok(sources.length > 0, "the factory source scan must find modules to read");
  for (const name of sources) {
    for (const match of readFileSync(join(FACTORY_DIR, name), "utf8").matchAll(LEG_ROLE_LITERAL)) stamped.add(match[1]);
  }
  assert.deepEqual(
    [...stamped].sort(),
    legRoles(FACTORY_PROMPTS_DIR),
    "a leg role with no factory/prompts/<role>.md refuses at the spawn seam the first time that leg runs, and a prompt file no role stamps is dead weight — if a leg legitimately derives its role indirectly (not a literal `role: \"…\"` / `leg(\"…\")`), that role is invisible to this scan and only the seam's typed refusal covers it",
  );
});
