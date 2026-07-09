#!/usr/bin/env node
// Vivicy PROJECT-SKILLS stage (S-K): deterministically install at most 6 agent skills
// from the skills.sh registry into the TARGET repo. Two modes:
//   - AUTO (default): one "skill-scout" agent leg (the implementer CLI) reads the frozen
//     canonical docs, searches the registry, and proposes 0-6 skill ids; the orchestrator
//     enforces everything else.
//   - EXPLICIT (--ids): the given ids/URLs are the candidates; no leg is spawned. This is
//     the Vivi "install this skill URL" path.
//
// The AGENT only ever PROPOSES. Every enforcement decision is deterministic and lives
// here: the 6-skill project cap (official vendors kept first), the skills.sh security
// audits (a skill is safe iff zero "fail" and at most one "warn"; anything else installs
// only under VIVICY_ALLOW_UNSAFE_SKILLS=1 and is flagged security_waived), and the
// `npx skills add` install itself. Every rejection lands in the report with a machine
// reason — never silent.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runClaudeLeg, runCodexLeg } from "./agent-spawn.ts";
import type { AgentIssue, LegConfig, LegDeps } from "./agent-spawn.ts";
import { notify } from "./notify.ts";
import { agentCliArgs, CLI_DEFAULTS, composePrompt, DEFAULT_CONFIG, resolveAgentLegs } from "./dev-loop.ts";
import type { Leg, LegResult } from "./dev-loop.ts";
import { findFrozenManifest } from "./extract-issues.ts";
import { FACTORY_PROMPTS_DIR, resolveTargetRoot } from "./target-root.ts";
import { pruneGitkeeps } from "../lib/skeleton.ts";

export const SKILLS_REPORT_REL = ".vivicy/development/reports/skills-report.json";
// Transient scout->orchestrator handoff (same lifecycle as the extraction fidelity
// verdict): cleared before the leg runs and after each read, never a durable report.
const SCOUT_RESULT_REL = ".vivicy/development/reports/skill-scout-result.json";
export const MAX_PROJECT_SKILLS = 6;
const SKILL_ID_RE = /^[\w.-]+\/[\w.-]+@[\w.-]+$/;
const SCOUT_ISSUE_ID = "SKILLS";

// GitHub owners whose skills are FIRST-PARTY for the technology they cover. Used only
// for priority (official-first when the auto selection exceeds the cap) and for the
// official/community label — never as a security gate (the audits are the gate).
export const OFFICIAL_VENDOR_OWNERS: ReadonlySet<string> = new Set([
  "vercel-labs", "vercel", "supabase", "anthropics", "shadcn", "shadcn-ui", "openai", "stripe",
  "cloudflare", "expo", "prisma", "tailwindlabs", "remotion-dev", "microsoft", "google", "googleapis",
  "aws", "awslabs", "azure", "getsentry", "firebase", "mongodb", "redis", "docker", "github",
  "huggingface", "langchain-ai", "pydantic", "astral-sh", "denoland", "oven-sh", "sveltejs", "vuejs",
  "nuxt", "angular", "facebook", "vitejs", "playwright", "nodejs", "golang", "rust-lang", "python",
  "dotnet", "apple", "flutter", "kubernetes", "hashicorp", "elastic", "grafana", "rails", "laravel",
  "django", "spring-projects", "nestjs", "tanstack", "apollographql", "netlify", "twilio", "clerk",
]);

export type SkillRejectReason = "red_audit" | "too_many_warnings" | "unaudited" | "cap_exceeded" | "invalid_id" | "install_failed" | "not_installed" | "remove_failed";
export type SkillsPhase = "selecting" | "auditing" | "installing" | "removing" | "green" | "failed" | "skipped";

interface SkillRef {
  id: string;
  owner: string;
  source: string;
  skill: string;
}

interface SkillCandidate extends SkillRef {
  name: string;
  reason: string;
  official: boolean;
}

export interface SkillAuditRecord {
  provider: string;
  status: string;
}

// The audit endpoint's answer for one skill: `found:false` covers both an unreachable
// endpoint and a 404 — the UNVERIFIED gate treats them identically.
export interface SkillAuditFetch {
  found: boolean;
  audits: SkillAuditRecord[];
}

export interface InstalledSkillEntry {
  id: string;
  source: string;
  skill: string;
  name: string;
  official: boolean;
  security_waived: boolean;
  audits: SkillAuditRecord[];
  reason: string;
}

export interface RejectedSkillEntry {
  id: string;
  reason: SkillRejectReason;
  detail?: string;
}

export interface RemovedSkillEntry {
  id: string;
  detail?: string;
}

export interface SkillsReport {
  phase: SkillsPhase;
  baseline_id: string | null;
  mode: "auto" | "explicit" | "remove";
  installed: InstalledSkillEntry[];
  rejected: RejectedSkillEntry[];
  /** Skills a REMOVE run uninstalled this run (absent on install runs). */
  removed?: RemovedSkillEntry[];
  summary: string;
  updated_at: string;
}

interface SpawnScoutArgs {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  resultRel: string;
  attempt: number;
  feedback: string | null;
}

// The impure edges a caller may inject (all default to the real tooling) — the same
// deps pattern extract-issues uses so tests run with no network and no real npx.
export interface InstallSkillsOptions {
  repoRoot?: string;
  ids?: string[];
  cfg?: Record<string, unknown>;
  promptsDir?: string;
  env?: NodeJS.ProcessEnv;
  spawnScout?: (args: SpawnScoutArgs) => Promise<LegResult | void>;
  fetchAudit?: (args: { source: string; skill: string }) => Promise<SkillAuditFetch>;
  runInstall?: (args: { repoRoot: string; source: string; skill: string }) => { code: number; output?: string };
  emitReport?: (report: SkillsReport, repoRoot: string) => void;
  findBaseline?: (repoRoot: string) => { manifestPath: string; baselineId: string } | null;
  now?: () => Date;
}

/** A configuration/sequencing error the CLI maps to exit 2 (vs 1 for a failed stage). */
export class SkillsConfigError extends Error {}

/** Parse a strict `owner/repo@skill` id into its parts, or null when malformed. */
export function parseSkillId(id: string): SkillRef | null {
  if (!SKILL_ID_RE.test(id)) return null;
  const at = id.lastIndexOf("@");
  const source = id.slice(0, at);
  return { id, owner: source.slice(0, source.indexOf("/")), source, skill: id.slice(at + 1) };
}

/** Normalize a user-supplied skill reference — `owner/repo@skill` or a full `https://skills.sh/owner/repo/skill` URL — into a parsed ref, or null. */
export function normalizeSkillId(raw: string): SkillRef | null {
  const trimmed = raw.trim();
  const url = /^https?:\/\/skills\.sh\/([\w.-]+)\/([\w.-]+)\/([\w.-]+)\/?$/.exec(trimmed);
  if (url) return parseSkillId(`${url[1]}/${url[2]}@${url[3]}`);
  return parseSkillId(trimmed);
}

/** The deterministic safety verdict for one skill's audits: "safe", or the machine rejection reason. */
export function auditVerdict(audit: SkillAuditFetch): "safe" | "red_audit" | "too_many_warnings" | "unaudited" {
  if (!audit.found) return "unaudited";
  const fails = audit.audits.filter((a) => a.status === "fail").length;
  if (fails > 0) return "red_audit";
  const warns = audit.audits.filter((a) => a.status === "warn").length;
  if (warns > 1) return "too_many_warnings";
  return "safe";
}

/**
 * Drive select -> audit -> install -> record for the project-skills stage. Returns the
 * final report (also mirrored to .vivicy/development/reports/skills-report.json at every
 * phase transition). Green with zero installed skills is a legitimate outcome; every
 * rejection carries a machine reason. Throws {@link SkillsConfigError} when no target is
 * configured or when AUTO mode finds no active frozen baseline.
 */
export async function installSkills(options: InstallSkillsOptions = {}): Promise<SkillsReport> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new SkillsConfigError("No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project, or pass options.repoRoot.");
  }
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const emitReport = options.emitReport ?? defaultEmitReport;
  const fetchAudit = options.fetchAudit ?? defaultFetchAudit;
  const runInstall = options.runInstall ?? defaultRunInstall;
  const findBaseline = options.findBaseline ?? findFrozenManifest;
  const explicitIds = (options.ids ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  const mode: "auto" | "explicit" = explicitIds.length > 0 ? "explicit" : "auto";
  const allowUnsafe = env.VIVICY_ALLOW_UNSAFE_SKILLS === "1";

  const baseline = findBaseline(repoRoot);
  if (mode === "auto" && !baseline) {
    throw new SkillsConfigError("install-skills: AUTO mode requires an active frozen baseline (.vivicy/baselines/*.json with status \"frozen\" and not superseded). Freeze the canonical docs (extraction does this) before the skills stage, or pass --ids for an explicit install.");
  }

  const priorReport = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_REL)) as Partial<SkillsReport> | null;
  const report: SkillsReport = {
    phase: "selecting",
    baseline_id: baseline?.baselineId ?? null,
    mode,
    installed: [],
    rejected: [],
    summary: "",
    updated_at: "",
  };
  const emit = (): void => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
  };

  // Idempotent re-run guard: a green (or already-skipped) report for the SAME baseline
  // means the stage is settled — a changed (re-frozen) baseline re-runs, an explicit
  // --ids always runs, and a failed report stays retryable.
  if (mode === "auto" && (priorReport?.phase === "green" || priorReport?.phase === "skipped") && priorReport.baseline_id === report.baseline_id) {
    report.phase = "skipped";
    report.installed = Array.isArray(priorReport.installed) ? priorReport.installed : [];
    report.summary = `skills stage already green for baseline ${report.baseline_id}; nothing to do. A new frozen baseline re-runs the stage; use --ids to add a specific skill.`;
    emit();
    return report;
  }

  report.summary = mode === "auto"
    ? "scouting project skills from the frozen canonical docs"
    : `validating ${explicitIds.length} explicitly requested skill id(s)`;
  emit();

  let candidates: SkillCandidate[];
  if (mode === "explicit") {
    candidates = [];
    const seen = new Set<string>();
    for (const raw of explicitIds) {
      const ref = normalizeSkillId(raw);
      if (!ref) {
        report.rejected.push({ id: raw, reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" });
        continue;
      }
      if (seen.has(ref.id)) continue;
      seen.add(ref.id);
      candidates.push({ ...ref, name: ref.skill, reason: "explicitly requested", official: OFFICIAL_VENDOR_OWNERS.has(ref.owner) });
    }
  } else {
    const spawnScout = options.spawnScout ?? makeDefaultSpawnScout(options);
    const selection = await runScoutSelection({ repoRoot, spawnScout, manifestPath: baseline!.manifestPath, baselineId: baseline!.baselineId });
    if (!selection.ok) {
      report.phase = "failed";
      report.summary = `skill scout produced no valid result after a bounded re-prompt: ${selection.problems.join("; ")}`;
      emit();
      return report;
    }
    candidates = selection.candidates;
  }

  // Deterministic cap: the project's installed set never exceeds 6 TOTAL, counting what
  // vivicy.json / the prior report already record. Already-installed candidates are
  // dropped silently (re-requesting an installed skill is a no-op, not a rejection).
  const alreadyInstalled = installedSkillIds(repoRoot, priorReport);
  candidates = candidates.filter((c) => !alreadyInstalled.has(c.id));
  const slots = Math.max(0, MAX_PROJECT_SKILLS - alreadyInstalled.size);
  if (mode === "auto") {
    // Stable official-first: official vendors keep their slots when the selection
    // overflows; relative order within each group is preserved.
    candidates = [...candidates.filter((c) => c.official), ...candidates.filter((c) => !c.official)];
  }
  const accepted = candidates.slice(0, slots);
  for (const c of candidates.slice(slots)) {
    report.rejected.push({ id: c.id, reason: "cap_exceeded", detail: `project already has ${alreadyInstalled.size} skill(s); the installed set may never exceed ${MAX_PROJECT_SKILLS} total` });
  }

  report.phase = "auditing";
  report.summary = `auditing ${accepted.length} candidate skill(s) against skills.sh security audits`;
  emit();
  const toInstall: Array<SkillCandidate & { security_waived: boolean; audits: SkillAuditRecord[]; waiveReason?: SkillRejectReason }> = [];
  for (const c of accepted) {
    const audit = await fetchAudit({ source: c.source, skill: c.skill });
    const verdict = auditVerdict(audit);
    if (verdict === "safe") {
      toInstall.push({ ...c, security_waived: false, audits: audit.audits });
    } else if (allowUnsafe) {
      toInstall.push({ ...c, security_waived: true, audits: audit.audits, waiveReason: verdict });
    } else {
      report.rejected.push({ id: c.id, reason: verdict, detail: auditDetail(audit, verdict) });
    }
  }

  report.phase = "installing";
  report.summary = `installing ${toInstall.length} skill(s) at the repository level via the skills CLI`;
  emit();
  for (const c of toInstall) {
    const r = runInstall({ repoRoot, source: c.source, skill: c.skill });
    if ((r.code ?? 1) !== 0) {
      report.rejected.push({ id: c.id, reason: "install_failed", detail: tail(r.output) });
      continue;
    }
    report.installed.push({
      id: c.id,
      source: c.source,
      skill: c.skill,
      name: c.name,
      official: c.official,
      security_waived: c.security_waived,
      audits: c.audits.map((a) => ({ provider: a.provider, status: a.status })),
      reason: c.security_waived ? c.waiveReason ?? c.reason : c.reason,
    });
  }

  if (report.installed.length > 0) {
    const mergedIds = mergeRequiredSkills(repoRoot, report.installed.map((e) => e.id));
    updateAgentsMd(repoRoot, skillBlockEntries(mergedIds, priorReport, report.installed));
  }

  report.phase = "green";
  const total = alreadyInstalled.size + report.installed.length;
  report.summary =
    `skills stage green: ${report.installed.length} installed, ${report.rejected.length} rejected; project total ${total}/${MAX_PROJECT_SKILLS}` +
    (report.installed.length === 0 && report.rejected.length === 0 ? " (zero skills is a legitimate outcome)" : "");
  emit();
  return report;
}

// ---------------------------------------------------------------------------
// Remove (W6, v0.7.0) — uninstall project skills deterministically
// ---------------------------------------------------------------------------

/** The impure edges of a remove run (all default to the real tooling). */
export interface RemoveSkillsOptions {
  repoRoot?: string;
  ids?: string[];
  env?: NodeJS.ProcessEnv;
  runRemove?: (args: { repoRoot: string; source: string; skill: string }) => { code: number; output?: string };
  emitReport?: (report: SkillsReport, repoRoot: string) => void;
  now?: () => Date;
}

/**
 * REMOVE explicitly named skills from the target project. Fully deterministic — no
 * agent leg, ever. For each id: refuse an unknown/not-installed id with a machine
 * reason; otherwise uninstall it (the skills CLI first, a direct `.agents/skills/`
 * removal as fallback), drop it from `vivicy.json` requiredSkills, and rebuild the
 * AGENTS.md managed block from the remaining set. Removal frees slots under the
 * {@link MAX_PROJECT_SKILLS} cap. Every outcome lands in the report (mode "remove"),
 * never silent.
 */
export async function removeSkills(options: RemoveSkillsOptions = {}): Promise<SkillsReport> {
  const repoRoot = options.repoRoot;
  if (!repoRoot) {
    throw new SkillsConfigError("No target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project, or pass options.repoRoot.");
  }
  const ids = (options.ids ?? []).map((s) => s.trim()).filter((s) => s.length > 0);
  if (ids.length === 0) {
    throw new SkillsConfigError("remove requires at least one skill id (owner/repo@skill or a skills.sh URL)");
  }
  const now = options.now ?? (() => new Date());
  const emitReport = options.emitReport ?? defaultEmitReport;
  const runRemove = options.runRemove ?? defaultRunRemove;

  const priorReport = readJsonOrNull(resolve(repoRoot, SKILLS_REPORT_REL)) as Partial<SkillsReport> | null;
  const installedIds = installedSkillIds(repoRoot, priorReport);

  const report: SkillsReport = {
    phase: "removing",
    baseline_id: typeof priorReport?.baseline_id === "string" ? priorReport.baseline_id : null,
    mode: "remove",
    // The report documents the project's whole surviving installed set at the end;
    // during the run it starts from the prior installed entries.
    installed: Array.isArray(priorReport?.installed) ? [...priorReport.installed] : [],
    rejected: [],
    removed: [],
    summary: `removing ${ids.length} skill(s)`,
    updated_at: "",
  };
  const emit = (): void => {
    report.updated_at = now().toISOString();
    emitReport(report, repoRoot);
  };
  emit();

  const toDrop = new Set<string>();
  for (const raw of ids) {
    const ref = normalizeSkillId(raw);
    if (!ref) {
      report.rejected.push({ id: raw, reason: "invalid_id", detail: "expected owner/repo@skill or https://skills.sh/owner/repo/skill" });
      continue;
    }
    if (toDrop.has(ref.id)) continue;
    if (!installedIds.has(ref.id)) {
      report.rejected.push({ id: ref.id, reason: "not_installed", detail: "this skill is not part of the project's installed set (vivicy.json requiredSkills / skills report)" });
      continue;
    }
    const r = runRemove({ repoRoot, source: ref.source, skill: ref.skill });
    if ((r.code ?? 1) !== 0) {
      report.rejected.push({ id: ref.id, reason: "remove_failed", detail: tail(r.output) });
      continue;
    }
    toDrop.add(ref.id);
    report.removed!.push({ id: ref.id });
  }

  if (toDrop.size > 0) {
    const remaining = dropRequiredSkills(repoRoot, toDrop);
    report.installed = report.installed.filter((e) => !toDrop.has(e.id));
    updateAgentsMd(repoRoot, skillBlockEntries(remaining, priorReport, []));
  }

  report.phase = "green";
  const total = installedSkillIds(repoRoot, report).size;
  report.summary = `skills remove green: ${report.removed!.length} removed, ${report.rejected.length} refused; project total ${total}/${MAX_PROJECT_SKILLS}`;
  emit();
  return report;
}

/**
 * Default uninstall seam: try the skills CLI's own `remove` first (it owns the
 * per-agent symlinks it created); when the CLI refuses or lacks the verb, fall back
 * to removing the skill directory under `.agents/skills/` plus any now-dangling
 * per-agent symlinks — the same layout `npx skills add` produces.
 */
function defaultRunRemove({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }): { code: number; output?: string } {
  const viaCli = spawnSync("npx", ["-y", "skills", "remove", skill, "-y"], { cwd: repoRoot, encoding: "utf8", env: process.env });
  if ((viaCli.status ?? 1) === 0) {
    return { code: 0, output: `${viaCli.stdout ?? ""}\n${viaCli.stderr ?? ""}`.trim() };
  }
  // Fallback: direct removal of the installed layout.
  const skillDir = resolve(repoRoot, ".agents", "skills", skill);
  if (!existsSync(skillDir)) {
    return { code: 1, output: `skills CLI could not remove "${skill}" (${source}) and ${skillDir} does not exist` };
  }
  try {
    rmSync(skillDir, { recursive: true, force: true });
    pruneDanglingSkillLinks(repoRoot);
    return { code: 0, output: `removed ${skillDir} directly (skills CLI remove unavailable)` };
  } catch (error) {
    return { code: 1, output: `failed to remove ${skillDir}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Remove now-dangling symlinks in the per-agent skill dirs (.claude/skills, .codex/skills). */
function pruneDanglingSkillLinks(repoRoot: string): void {
  for (const rel of [".claude/skills", ".codex/skills"]) {
    const dir = resolve(repoRoot, rel);
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = resolve(dir, entry);
      try {
        const stat = lstatSync(abs);
        if (stat.isSymbolicLink() && !existsSync(abs)) rmSync(abs, { force: true });
      } catch {
        // Best-effort pruning; a leftover link is cosmetic, never state.
      }
    }
  }
}

/** Drop ids from vivicy.json requiredSkills (preserving every other field); returns the remaining list. */
function dropRequiredSkills(repoRoot: string, drop: Set<string>): string[] {
  const abs = resolve(repoRoot, "vivicy.json");
  if (!existsSync(abs)) return [];
  const parsed = readJsonOrNull(abs);
  if (parsed === null || typeof parsed !== "object") return [];
  const config = parsed as Record<string, unknown>;
  const remaining = toStringList(config.requiredSkills).filter((id) => !drop.has(id));
  config.requiredSkills = remaining;
  writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`);
  return remaining;
}

// ---------------------------------------------------------------------------
// Scout leg (AUTO mode)
// ---------------------------------------------------------------------------

async function runScoutSelection({ repoRoot, spawnScout, manifestPath, baselineId }: { repoRoot: string; spawnScout: (args: SpawnScoutArgs) => Promise<LegResult | void>; manifestPath: string; baselineId: string }): Promise<{ ok: true; candidates: SkillCandidate[] } | { ok: false; problems: string[] }> {
  let feedback: string | null = null;
  let problems: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    clearScoutResult(repoRoot);
    await spawnScout({ repoRoot, manifestPath, baselineId, resultRel: SCOUT_RESULT_REL, attempt, feedback });
    const raw = readJsonOrNull(resolve(repoRoot, SCOUT_RESULT_REL));
    clearScoutResult(repoRoot);
    const validated = validateScoutResult(raw);
    if (validated.ok) return validated;
    problems = validated.problems;
    feedback = problems.join("; ");
  }
  return { ok: false, problems };
}

// Strict validation of the scout's result file: `{ "skills": [{ id, name, reason }] }`
// with 0-6 entries and every id in `owner/repo@skill` form. Duplicates are deduped;
// anything else is invalid and triggers the single bounded re-prompt.
function validateScoutResult(raw: unknown): { ok: true; candidates: SkillCandidate[] } | { ok: false; problems: string[] } {
  if (raw === null || typeof raw !== "object") {
    return { ok: false, problems: [`no valid JSON result file was written (expected { "skills": [...] } at ${SCOUT_RESULT_REL})`] };
  }
  const skills = (raw as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) {
    return { ok: false, problems: ['the result JSON has no "skills" array'] };
  }
  if (skills.length > MAX_PROJECT_SKILLS) {
    return { ok: false, problems: [`${skills.length} skills proposed; the maximum is ${MAX_PROJECT_SKILLS} (fewer is better)`] };
  }
  const problems: string[] = [];
  const candidates: SkillCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of skills) {
    const id = entry && typeof entry === "object" ? (entry as { id?: unknown }).id : undefined;
    const ref = typeof id === "string" ? parseSkillId(id.trim()) : null;
    if (!ref) {
      problems.push(`invalid skill id ${JSON.stringify(id)} (must be owner/repo@skill, exactly as seen in \`npx skills find\` output)`);
      continue;
    }
    if (seen.has(ref.id)) continue;
    seen.add(ref.id);
    const name = String((entry as { name?: unknown }).name ?? ref.skill).trim() || ref.skill;
    const reason = String((entry as { reason?: unknown }).reason ?? "").trim();
    candidates.push({ ...ref, name, reason, official: OFFICIAL_VENDOR_OWNERS.has(ref.owner) });
  }
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, candidates };
}

function clearScoutResult(repoRoot: string): void {
  rmSync(resolve(repoRoot, SCOUT_RESULT_REL), { force: true });
}

// Build the real SCOUT seam: the IMPLEMENTER-role CLI re-roled to "skill-scout", run in
// the target repo via the shared leg infra — the same binding extract-issues uses for
// its extractor leg, so flags/transcripts/timeouts never diverge.
function makeDefaultSpawnScout(options: InstallSkillsOptions): (args: SpawnScoutArgs) => Promise<LegResult | void> {
  const promptsDir = options.promptsDir ?? FACTORY_PROMPTS_DIR;
  const cfg: Record<string, unknown> = { ...DEFAULT_CONFIG, ...(options.cfg ?? {}) };
  const legs = resolveAgentLegs(process.env);
  const implementer: Leg = legs?.implementer ?? { actor: "claude", role: "implementer", provider: "claude", model: CLI_DEFAULTS.claude.model, effort: CLI_DEFAULTS.claude.effort, fast: false };
  const leg: Leg = { ...implementer, role: "skill-scout" };
  return async ({ repoRoot, manifestPath, baselineId, resultRel, attempt, feedback }) => {
    const legCfg = { ...cfg, promptsDir, execRoot: repoRoot };
    const issue: AgentIssue = { id: SCOUT_ISSUE_ID, graph_refs: ["node:skills"], path: SKILLS_REPORT_REL };
    const context = scoutContext({ manifestPath, baselineId, resultRel, attempt, feedback });
    const deps = legDepsForTarget(legCfg, issue, repoRoot, context);
    return leg.provider === "codex" ? runCodexLeg(leg, issue, legCfg as LegConfig, deps) : runClaudeLeg(leg, issue, legCfg as LegConfig, deps);
  };
}

function scoutContext({ manifestPath, baselineId, resultRel, attempt, feedback }: { manifestPath: string; baselineId: string; resultRel: string; attempt: number; feedback: string | null }): string {
  return (
    `\n\n---\n\n## Skill scouting context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). The canonical corpus it pins under \`.vivicy/canonical/**\` is your ONLY source of truth about the project.\n` +
    `- Write your JSON result — and nothing else — to \`${resultRel}\`.\n` +
    `- Select AT MOST ${MAX_PROJECT_SKILLS} skills; fewer is better, zero is valid.\n` +
    `- Attempt: ${attempt}.\n` +
    (feedback
      ? `\n### What was INVALID last time\n\nYour previous result was rejected by the orchestrator's strict validation. Fix exactly this and rewrite the result file:\n\n\`\`\`text\n${feedback}\n\`\`\`\n`
      : "")
  );
}

// Bind the shared leg runner to the TARGET repo, injecting the run context onto the
// role prompt — exactly as extract-issues' legDepsForTarget.
function legDepsForTarget(legCfg: Record<string, unknown>, issue: AgentIssue, repoRoot: string, context: string): LegDeps {
  const abs = (rel: string) => resolve(repoRoot, rel);
  return {
    composePrompt: (template: string, iss: AgentIssue) => composePrompt(template, iss) + context,
    agentCliArgs,
    abs,
    execRoot: repoRoot,
    transcriptDirAbs: abs(`${legCfg.transcriptsDir as string}/${issue.id}`),
    cwdFilter: null,
  };
}

// ---------------------------------------------------------------------------
// Default seams (the real tooling)
// ---------------------------------------------------------------------------

// GET the PUBLIC skills.sh audit endpoint for one skill. Unreachable / non-200 / bad
// JSON all collapse to found:false — the UNVERIFIED gate, never a crash.
async function defaultFetchAudit({ source, skill }: { source: string; skill: string }): Promise<SkillAuditFetch> {
  try {
    const res = await fetch(`https://skills.sh/api/v1/skills/audit/${source}/${skill}`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { found: false, audits: [] };
    const body = (await res.json()) as { audits?: unknown };
    const audits = Array.isArray(body?.audits)
      ? body.audits
          .filter((a): a is Record<string, unknown> => Boolean(a) && typeof a === "object")
          .map((a) => ({ provider: String(a.provider ?? "unknown"), status: String(a.status ?? "") }))
      : [];
    return { found: true, audits };
  } catch {
    return { found: false, audits: [] };
  }
}

// Project-level install via the Vercel skills CLI: lands under .agents/skills/ in the
// target repo with per-agent symlinks, so one install serves both agents.
function defaultRunInstall({ repoRoot, source, skill }: { repoRoot: string; source: string; skill: string }): { code: number; output?: string } {
  const r = spawnSync("npx", ["-y", "skills", "add", source, "--skill", skill, "-y"], { cwd: repoRoot, encoding: "utf8", env: process.env });
  return { code: r.status ?? 1, output: `${r.stdout ?? ""}\n${r.stderr ?? ""}`.trim() };
}

const NOTIFY_BY_PHASE: Record<string, { level: "info" | "success" | "warning" | "error"; stage: string; message: string }> = {
  selecting: { level: "info", stage: "SK", message: "selecting project skills from the frozen canonical" },
  removing: { level: "info", stage: "SK", message: "removing project skills" },
  green: { level: "success", stage: "SK", message: "project skills stage green" },
  failed: { level: "error", stage: "SK", message: "project skills stage failed" },
};

function defaultEmitReport(report: SkillsReport, repoRoot: string): void {
  const abs = resolve(repoRoot, SKILLS_REPORT_REL);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `${JSON.stringify(report, null, 2)}\n`);
  pruneGitkeeps(repoRoot);
  const mapped = NOTIFY_BY_PHASE[report.phase];
  if (mapped) notify({ ...mapped, event: `skills_${report.phase}` });
}

// ---------------------------------------------------------------------------
// Target-repo artifacts: vivicy.json requiredSkills + the AGENTS.md managed block
// ---------------------------------------------------------------------------

const SKILLS_BLOCK_BEGIN = "<!-- vivicy:skills:begin -->";
const SKILLS_BLOCK_END = "<!-- vivicy:skills:end -->";

export interface SkillBlockEntry {
  id: string;
  name: string;
  official: boolean;
  reason: string;
}

/** Render the managed AGENTS.md skills block. Pure and deterministic: same entries -> byte-identical block. */
export function buildSkillsBlock(entries: SkillBlockEntry[]): string {
  const bullets = entries.length > 0
    ? entries.map((e) => `- **${e.name}** (\`${e.id}\`, ${e.official ? "official" : "community"})${e.reason ? ` — ${e.reason}` : ""}`)
    : ["_No project skills are currently installed._"];
  return [
    SKILLS_BLOCK_BEGIN,
    "## Project skills",
    "",
    "Vivicy installed these agent skills at the repository level, under `.agents/skills/` (with per-agent symlinks). Both the IMPLEMENTER and the REVIEWER MUST consult and apply the relevant skill whenever their work touches its domain — a skill listed here is part of this project's development contract, not optional reading.",
    "",
    ...bullets,
    SKILLS_BLOCK_END,
  ].join("\n");
}

/** Replace the managed skills block in `content` (or append/create). Pure; idempotent for identical inputs. */
export function applySkillsBlock(content: string | null, entries: SkillBlockEntry[]): string {
  const block = buildSkillsBlock(entries);
  if (content === null) return `# Agent instructions\n\n${block}\n`;
  const begin = content.indexOf(SKILLS_BLOCK_BEGIN);
  const end = content.indexOf(SKILLS_BLOCK_END);
  if (begin !== -1 && end !== -1 && end >= begin) {
    return content.slice(0, begin) + block + content.slice(end + SKILLS_BLOCK_END.length);
  }
  return `${content.replace(/\s*$/, "")}\n\n${block}\n`;
}

function updateAgentsMd(repoRoot: string, entries: SkillBlockEntry[]): void {
  const abs = resolve(repoRoot, "AGENTS.md");
  const content = existsSync(abs) ? readFileSync(abs, "utf8") : null;
  writeFileSync(abs, applySkillsBlock(content, entries));
}

// Merge the installed ids into vivicy.json's requiredSkills (the canonical, polyglot
// home dev-preflight reads first). Preserves gateCommand and every unknown field
// (parse -> mutate one key -> re-stringify keeps key order); 2-space pretty-print with
// a trailing newline like lib/scaffold.ts. A present-but-unparseable vivicy.json is
// left untouched (never clobber the owner's file); the report still records the
// installs and the prior-report union keeps the cap honest on the next run.
function mergeRequiredSkills(repoRoot: string, newIds: string[]): string[] {
  const abs = resolve(repoRoot, "vivicy.json");
  let config: Record<string, unknown> = {};
  if (existsSync(abs)) {
    const parsed = readJsonOrNull(abs);
    if (parsed === null || typeof parsed !== "object") return dedupe(newIds);
    config = parsed as Record<string, unknown>;
  }
  const existing = toStringList(config.requiredSkills);
  const merged = dedupe([...existing, ...newIds]);
  config.requiredSkills = merged;
  writeFileSync(abs, `${JSON.stringify(config, null, 2)}\n`);
  return merged;
}

// The AGENTS.md block documents the project's WHOLE installed set, not just this run:
// metadata comes from this run's entries first, then the prior report, then a derived
// fallback for ids that predate any report.
function skillBlockEntries(mergedIds: string[], priorReport: Partial<SkillsReport> | null, installedNow: InstalledSkillEntry[]): SkillBlockEntry[] {
  const meta = new Map<string, SkillBlockEntry>();
  const priorInstalled = priorReport && Array.isArray(priorReport.installed) ? priorReport.installed : [];
  for (const e of priorInstalled) {
    if (e && typeof e.id === "string") meta.set(e.id, { id: e.id, name: e.name ?? e.skill ?? e.id, official: e.official === true, reason: e.reason ?? "" });
  }
  for (const e of installedNow) meta.set(e.id, { id: e.id, name: e.name, official: e.official, reason: e.reason });
  const entries: SkillBlockEntry[] = [];
  for (const id of mergedIds) {
    const known = meta.get(id);
    if (known) {
      entries.push(known);
      continue;
    }
    const ref = parseSkillId(id);
    if (ref) entries.push({ id, name: ref.skill, official: OFFICIAL_VENDOR_OWNERS.has(ref.owner), reason: "" });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// The ids already occupying project slots: vivicy.json requiredSkills UNION the prior
// report's installed entries (defence in depth if vivicy.json could not be written).
function installedSkillIds(repoRoot: string, priorReport: Partial<SkillsReport> | null): Set<string> {
  const ids = new Set<string>();
  const config = readJsonOrNull(resolve(repoRoot, "vivicy.json"));
  if (config && typeof config === "object") {
    for (const id of toStringList((config as { requiredSkills?: unknown }).requiredSkills)) ids.add(id);
  }
  const priorInstalled = priorReport && Array.isArray(priorReport.installed) ? priorReport.installed : [];
  for (const e of priorInstalled) {
    if (e && typeof e.id === "string") ids.add(e.id);
  }
  return ids;
}

function auditDetail(audit: SkillAuditFetch, verdict: string): string {
  if (verdict === "unaudited") return "no security audit is available for this skill (endpoint unreachable or skill not audited); set VIVICY_ALLOW_UNSAFE_SKILLS=1 to install anyway (flagged security_waived)";
  const counts = audit.audits.map((a) => `${a.provider}:${a.status}`).join(", ");
  return `audits [${counts}]; the rule is: zero "fail" and at most one "warn"; set VIVICY_ALLOW_UNSAFE_SKILLS=1 to install anyway (flagged security_waived)`;
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
  return value.map((v) => String(v).trim()).filter((v) => v.length > 0);
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function tail(output: string | undefined, max = 800): string {
  const text = (output ?? "").trim();
  return text.length > max ? text.slice(-max) : text;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  let ids: string[] = [];
  let removeIds: string[] = [];
  let json = false;
  let usageError: string | null = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--ids") {
      const value = argv[i + 1];
      if (!value) {
        usageError = "--ids requires a comma-separated list of skill ids/URLs";
        break;
      }
      ids = value.split(",");
      i += 1;
    } else if (arg.startsWith("--ids=")) {
      ids = arg.slice("--ids=".length).split(",");
    } else if (arg === "--remove") {
      const value = argv[i + 1];
      if (!value) {
        usageError = "--remove requires a comma-separated list of skill ids/URLs";
        break;
      }
      removeIds = value.split(",");
      i += 1;
    } else if (arg.startsWith("--remove=")) {
      removeIds = arg.slice("--remove=".length).split(",");
    } else {
      usageError = `unknown argument: ${arg}`;
      break;
    }
  }
  if (!usageError && ids.length > 0 && removeIds.length > 0) {
    usageError = "--ids and --remove are mutually exclusive (one run installs OR removes)";
  }
  if (usageError) {
    console.error(`error: ${usageError}\nusage: node factory/install-skills.ts [--ids <id1,id2,...>] [--remove <id1,id2,...>] [--json]`);
    process.exit(2);
  }
  const repoRoot = resolveTargetRoot();
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the target project.");
    process.exit(2);
  }
  const run = removeIds.length > 0 ? removeSkills({ repoRoot, ids: removeIds }) : installSkills({ repoRoot, ids });
  run
    .then((report) => {
      if (json) console.log(JSON.stringify(report, null, 2));
      else console.log(report.summary);
      process.exit(report.phase === "failed" ? 1 : 0);
    })
    .catch((error) => {
      console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(error instanceof SkillsConfigError ? 2 : 1);
    });
}
