#!/usr/bin/env node
// Start-of-work preflight: surface which development skills the TARGET project
// declares, and whether they are installed and available to both agents via the
// Vercel `skills` CLI. `skills` symlinks a skill across every agent on the
// machine from one source, so a single install serves both agents.
//
// Vivicy is project-agnostic: it has NO built-in stack assumptions. The set of
// development skills is owned by the target project, not by Vivicy. A project
// declares the skills its agents should use; a project that declares none (e.g.
// a pure-JS library) preflights cleanly with nothing to check.
//
// Where skills are declared (read from the target root; per field, a declared
// vivicy.json array — even empty — wins over the package.json fallback):
//   - vivicy.json   { "requiredSkills": [...], "recommendedSkills": [...] } — the
//     canonical, language-neutral home (install-skills.ts maintains requiredSkills;
//     entries are `owner/repo@skill` ids, matched against `skills list` output by
//     their skill-name part).
//   - package.json  "vivicy": { "requiredSkills": [...], "recommendedSkills": [...] }
//     — Node-only fallback.
//
// Absent skills are reported as informational NOTES, never a hard failure — the
// only thing that blocks the loop is an explicitly REQUIRED skill that is
// missing. With no declared required skills (the default), preflight is always
// ok, so an arbitrary project is never gated on any particular tech stack.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveTargetRoot } from "./target-root.ts";

interface DeclaredSkills {
  required: string[];
  recommended: string[];
}

type SkillsRunnerResult = { ok: false } | { ok: true; output: string };
type SkillsRunner = () => SkillsRunnerResult;

interface SkillsCheck {
  ok: boolean;
  missingRequired: string[];
  missingRecommended: string[];
  notes: string[];
  reason: string | undefined;
}

// Read the target project's declared skills. Returns { required, recommended }
// arrays of skill NAMES (the part `skills list` prints — a declared `owner/repo@skill`
// id contributes its skill-name part). vivicy.json is the canonical, polyglot home;
// package.json#vivicy is the Node-only fallback, per field.
export function readDeclaredSkills(targetRoot = resolveTargetRoot()): DeclaredSkills {
  const empty: DeclaredSkills = { required: [], recommended: [] };
  if (!targetRoot) return empty;

  const fromVivicy = declaredIn(readJsonOrNull(join(targetRoot, "vivicy.json")));
  const pkg = readJsonOrNull(join(targetRoot, "package.json"));
  const fromPkg = declaredIn(pkg && typeof pkg === "object" ? (pkg as { vivicy?: unknown }).vivicy : null);

  // A field vivicy.json DECLARES (even as an empty array — the owner emptied it) is
  // authoritative; package.json only fills fields vivicy.json does not declare.
  return {
    required: fromVivicy.required ?? fromPkg.required ?? [],
    recommended: fromVivicy.recommended ?? fromPkg.recommended ?? [],
  };
}

// Each field is `null` when the config does not declare it as an array (absent config,
// absent field, or a non-array value), so the caller can distinguish "undeclared" from
// an authoritative empty list.
function declaredIn(config: unknown): { required: string[] | null; recommended: string[] | null } {
  if (!config || typeof config !== "object") return { required: null, recommended: null };
  const field = (value: unknown): string[] | null => (Array.isArray(value) ? toStringList(value).map(skillName) : null);
  return {
    required: field((config as { requiredSkills?: unknown }).requiredSkills),
    recommended: field((config as { recommendedSkills?: unknown }).recommendedSkills),
  };
}

// A declared entry may be a bare skill name or an `owner/repo@skill` registry id; the
// installed check greps `skills list` output, which prints skill names, so an id
// matches by its part after the "@".
function skillName(entry: string): string {
  const at = entry.lastIndexOf("@");
  return at > 0 ? entry.slice(at + 1) : entry;
}

function readJsonOrNull(abs: string): unknown {
  if (!existsSync(abs)) return null;
  try {
    return JSON.parse(readFileSync(abs, "utf8"));
  } catch {
    return null;
  }
}

function toStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
}

// Pure + unit-tested: which of the given skills are absent from `skills list`
// output. Substring match keeps it robust across `skills` CLI output-format
// changes. An empty `required` list yields no missing skills.
export function missingSkills(listOutput: unknown, required: string[] = []): string[] {
  const text = String(listOutput ?? "");
  return required.filter((name) => !text.includes(name));
}

// Decide preflight outcome from the declared skills and the `skills list` output.
//
// Pure for testability: pass `declared` and a `runner`. Returns
//   { ok, missingRequired, missingRecommended, notes, reason }
// where `ok` is false ONLY when a declared REQUIRED skill is missing (or the CLI
// is unavailable while required skills were declared). With no declared required
// skills, ok is always true and absent skills become informational notes.
export function checkSkills(runner: SkillsRunner = defaultRunner, declared = readDeclaredSkills()): SkillsCheck {
  const required = declared?.required ?? [];
  const recommended = declared?.recommended ?? [];
  const notes: string[] = [];

  // A project that declares no skills has nothing to check: clean preflight.
  if (required.length === 0 && recommended.length === 0) {
    return { ok: true, missingRequired: [], missingRecommended: [], notes, reason: undefined };
  }

  const result = runner();
  if (!result || result.ok !== true) {
    // The CLI is unavailable. Required skills can't be confirmed → block only if
    // any are required; otherwise it's just an informational note.
    if (required.length > 0) {
      return {
        ok: false,
        missingRequired: [...required],
        missingRecommended: [...recommended],
        notes,
        reason:
          "skills CLI not available and this project declares required skills — install the Vercel `skills` CLI on this machine",
      };
    }
    notes.push(
      "skills CLI not available; could not confirm recommended skills (informational only): " +
        recommended.join(", "),
    );
    return { ok: true, missingRequired: [], missingRecommended: [...recommended], notes, reason: undefined };
  }

  const missingRequired = missingSkills(result.output, required);
  const missingRecommended = missingSkills(result.output, recommended);

  if (missingRecommended.length > 0) {
    notes.push(`recommended skills not installed (informational only): ${missingRecommended.join(", ")}`);
  }

  return {
    ok: missingRequired.length === 0,
    missingRequired,
    missingRecommended,
    notes,
    reason: missingRequired.length === 0 ? undefined : "required skills not found in `skills list`",
  };
}

function defaultRunner(): SkillsRunnerResult {
  const result = spawnSync("npx", ["--no-install", "skills", "list"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return { ok: false };
  return { ok: true, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const declared = readDeclaredSkills();
  const { ok, missingRequired, notes } = checkSkills(defaultRunner, declared);

  for (const note of notes) {
    process.stdout.write(`dev-preflight: note: ${note}\n`);
  }

  if (ok) {
    if (declared.required.length === 0 && declared.recommended.length === 0) {
      process.stdout.write("dev-preflight: no development skills declared by the target project; nothing to check.\n");
    } else {
      process.stdout.write("dev-preflight: all required development skills are installed.\n");
    }
  } else {
    process.stderr.write(
      `dev-preflight: required development skills are missing.\n  missing: ${missingRequired.join(", ")}\n`,
    );
    process.stderr.write(
      "Install the missing skills with the Vercel `skills` CLI (`npx skills add <skill>`), or remove them from this project's vivicy.json \"requiredSkills\" (or package.json \"vivicy.requiredSkills\").\n",
    );
    process.exit(1);
  }
}
