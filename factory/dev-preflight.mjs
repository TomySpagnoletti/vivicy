#!/usr/bin/env node
// Start-of-work preflight: verify the required development skills are installed
// and available to BOTH agents (Claude Code + Codex) via the Vercel `skills`
// CLI. `skills` symlinks a skill across every agent on the machine from one
// source, so a single install serves both agents; this check fails fast if any
// required skill is missing before the autonomous loop starts.
import { spawnSync } from "node:child_process";

export const REQUIRED_SKILLS = [
  "react-best-practices",
  "taste-skill",
  "nestjs-best-practices",
  "supabase",
  "supabase-postgres-best-practices",
];

// Pure + unit-tested: which required skills are absent from `skills list` output.
// Substring match keeps it robust across `skills` CLI output-format changes.
export function missingSkills(listOutput, required = REQUIRED_SKILLS) {
  const text = String(listOutput ?? "");
  return required.filter((name) => !text.includes(name));
}

export function checkSkills(runner = defaultRunner) {
  const result = runner();
  if (!result || result.ok !== true) {
    return {
      ok: false,
      missing: REQUIRED_SKILLS,
      reason: "skills CLI not available — install the Vercel `skills` CLI and the required skills on this machine",
    };
  }
  const missing = missingSkills(result.output);
  return { ok: missing.length === 0, missing, reason: missing.length === 0 ? undefined : "required skills not found in `skills list`" };
}

function defaultRunner() {
  const result = spawnSync("npx", ["--no-install", "skills", "list"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return { ok: false };
  return { ok: true, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { ok, missing, reason } = checkSkills();
  if (ok) {
    process.stdout.write("dev-preflight: all required development skills are installed.\n");
  } else {
    process.stderr.write(`dev-preflight: ${reason}\n  missing: ${missing.join(", ")}\n`);
    process.stderr.write(
      "Install on the dedicated machine (Vercel `npx skills`): e.g. `npx skills add vercel-labs/react-best-practices`, `npx skills add leonxlnx/taste-skill`, `npx skills add https://github.com/kadajett/agent-nestjs-skills --skill nestjs-best-practices`, and the official Supabase skills from skills.sh/supabase. See AGENTS.md > Development Skills.\n",
    );
    process.exit(1);
  }
}
