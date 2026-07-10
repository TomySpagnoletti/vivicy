#!/usr/bin/env node
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

export function readDeclaredSkills(targetRoot = resolveTargetRoot()): DeclaredSkills {
  const empty: DeclaredSkills = { required: [], recommended: [] };
  if (!targetRoot) return empty;

  const fromVivicy = declaredIn(readJsonOrNull(join(targetRoot, "vivicy.json")));
  const pkg = readJsonOrNull(join(targetRoot, "package.json"));
  const fromPkg = declaredIn(pkg && typeof pkg === "object" ? (pkg as { vivicy?: unknown }).vivicy : null);

  // vivicy.json declaring a field — even an empty array — is authoritative; package.json fills only fields vivicy.json omits.
  return {
    required: fromVivicy.required ?? fromPkg.required ?? [],
    recommended: fromVivicy.recommended ?? fromPkg.recommended ?? [],
  };
}

// null means undeclared (falls through to the other source); [] means declared-empty and authoritative — the two must stay distinguishable.
function declaredIn(config: unknown): { required: string[] | null; recommended: string[] | null } {
  if (!config || typeof config !== "object") return { required: null, recommended: null };
  const field = (value: unknown): string[] | null => (Array.isArray(value) ? toStringList(value).map(skillName) : null);
  return {
    required: field((config as { requiredSkills?: unknown }).requiredSkills),
    recommended: field((config as { recommendedSkills?: unknown }).recommendedSkills),
  };
}

// Declared entries may be a bare name or an `owner/repo@skill` id; `skills list` prints only names, so match on the part after "@".
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

// Substring match (not exact) so this stays robust to `skills` CLI output-format changes.
export function missingSkills(listOutput: unknown, required: string[] = []): string[] {
  const text = String(listOutput ?? "");
  return required.filter((name) => !text.includes(name));
}

export function checkSkills(runner: SkillsRunner = defaultRunner, declared = readDeclaredSkills()): SkillsCheck {
  const required = declared?.required ?? [];
  const recommended = declared?.recommended ?? [];
  const notes: string[] = [];

  if (required.length === 0 && recommended.length === 0) {
    return { ok: true, missingRequired: [], missingRecommended: [], notes, reason: undefined };
  }

  const result = runner();
  if (!result || result.ok !== true) {
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
