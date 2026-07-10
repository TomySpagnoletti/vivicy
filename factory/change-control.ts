#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTargetRoot } from "./target-root.ts";

const repoRoot = resolveTargetRoot();

const CHANGE_REQUESTS_DIR = ".vivicy/change-requests";
const BASELINES_DIR = ".vivicy/baselines";
const CATALOG_PATH = ".vivicy/requirements/catalog.json";
const NON_CR_FILES = new Set(["cr-template.md", "readme.md"]);
const CR_FILENAME = /^CR-(\d{4})-[a-z0-9-]+\.md$/;
const CR_ID = /^CR-(\d{4})$/;

export const CR_STATUSES = [
  "idea",
  "under_review",
  "accepted_current_build",
  "docs_applied",
  "accepted_future",
  "rejected",
  "implemented",
  "superseded",
] as const;
export type CrStatus = (typeof CR_STATUSES)[number];
export const CR_CLASSIFICATIONS = [
  "pending",
  "clarification",
  "minor_product_change",
  "major_product_change",
  "architecture_change",
  "implementation_order_change",
  "future_option",
  "rejection_candidate",
] as const;
export type CrClassification = (typeof CR_CLASSIFICATIONS)[number];
const DECIDED_STATUSES = new Set(["accepted_current_build", "docs_applied", "accepted_future", "rejected", "implemented"]);
const PREVIOUS_REQUIRED = new Set(["accepted_current_build", "docs_applied", "implemented"]);
const RESULTING_REQUIRED = new Set(["docs_applied", "implemented"]);
const PREVIOUS_FIELDS = ["previous_baseline_id", "previous_baseline_version", "previous_baseline_manifest_path", "previous_document_set_hash", "previous_manifest_hash"];
const RESULTING_FIELDS = ["resulting_baseline_id", "resulting_baseline_version", "resulting_baseline_manifest_path", "resulting_document_set_hash", "resulting_manifest_hash"] as const;
const DECISION_FIELDS = ["owner_decision_by", "owner_decision_at", "owner_decision_evidence"];

export type CrFrontmatterValue = string | boolean | string[] | null;
export interface CrFrontmatter {
  [key: string]: CrFrontmatterValue | undefined;
}
export interface ChangeRequestRecord {
  file: string;
  fileNumber: number | null;
  fm: CrFrontmatter | null;
}

export function readChangeRequests(root: string | null = repoRoot): ChangeRequestRecord[] {
  const out: ChangeRequestRecord[] = [];
  if (!root) return out;
  const dirAbs = resolve(root, CHANGE_REQUESTS_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return out;
  for (const file of readdirSync(dirAbs).sort()) {
    if (!file.toLowerCase().endsWith(".md") || NON_CR_FILES.has(file.toLowerCase())) continue;
    const fm = parseFrontmatter(readFileSync(join(dirAbs, file), "utf8"));
    const m = file.match(CR_FILENAME);
    out.push({ file, fileNumber: m ? Number(m[1]) : null, fm });
  }
  return out;
}

export function readChangeRequest(root: string | null, id: string): ChangeRequestRecord | null {
  return readChangeRequests(root).find((cr) => String(cr.fm?.id ?? "") === id) ?? null;
}

export function nextCrId(crs: ChangeRequestRecord[] = readChangeRequests()): string {
  const max = crs.reduce((acc, cr) => {
    const n = cr.fm?.id && CR_ID.test(String(cr.fm.id)) ? Number(String(cr.fm.id).slice(3)) : (cr.fileNumber ?? 0);
    return Math.max(acc, n);
  }, 0);
  return `CR-${String(max + 1).padStart(4, "0")}`;
}

interface CreateChangeRequestOptions {
  repoRoot?: string | null;
  title?: string;
  classification?: CrClassification;
  source?: string;
  sourceEvidence?: string[];
  affectedVerificationGates?: string[];
  body?: string | null;
  now?: () => string;
}
export function createChangeRequest({ repoRoot, title, classification = "minor_product_change", source = "agent", sourceEvidence = [], affectedVerificationGates = [], body = null, now }: CreateChangeRequestOptions = {}): { id: string; path: string } {
  if (!repoRoot) throw new Error("createChangeRequest: repoRoot is required");
  if (!isNonEmptyString(title)) throw new Error("createChangeRequest: a non-empty title is required");
  if (!CR_CLASSIFICATIONS.includes(classification)) {
    throw new Error(`createChangeRequest: invalid classification "${classification}" (one of ${CR_CLASSIFICATIONS.join(", ")})`);
  }
  const dirAbs = resolveInside(repoRoot, CHANGE_REQUESTS_DIR);
  mkdirSync(dirAbs, { recursive: true });
  const id = nextCrId(readChangeRequests(repoRoot));
  const nowIso = typeof now === "function" ? now() : new Date().toISOString();
  const date = nowIso.slice(0, 10);
  const file = `${CHANGE_REQUESTS_DIR}/${id}-${slugify(title)}.md`;
  const content = renderNewChangeRequest({ id, title, classification, source, sourceEvidence, affectedVerificationGates, body, date });
  writeFileSync(resolve(repoRoot, file), content);

  const check = runChangeControlCheck({ repoRoot });
  if (check.exitCode !== 0) {
    throw new Error(`createChangeRequest: the written CR ${id} does not pass change-control:\n${check.errors.join("\n")}`);
  }
  return { id, path: file };
}

interface DecideChangeRequestOptions {
  repoRoot?: string | null;
  id?: string;
  decision?: string;
  decidedBy?: string;
  evidenceRef?: string;
  now?: () => string;
}
export function decideChangeRequest({ repoRoot, id, decision, decidedBy, evidenceRef, now }: DecideChangeRequestOptions = {}): { id: string; path: string; status: "accepted_current_build" | "rejected" } {
  if (!repoRoot) throw new Error("decideChangeRequest: repoRoot is required");
  if (decision !== "approved" && decision !== "rejected") {
    throw new Error(`decideChangeRequest: decision must be "approved" or "rejected", got "${decision}"`);
  }
  const crs = readChangeRequests(repoRoot);
  const cr = crs.find((c) => String(c.fm?.id ?? "") === id);
  if (!cr) throw new Error(`decideChangeRequest: no CR with id ${id} under ${CHANGE_REQUESTS_DIR}`);
  const status = String(cr.fm?.status ?? "");
  if (status !== "idea" && status !== "under_review") {
    throw new Error(`decideChangeRequest: CR ${id} is "${status}", only idea|under_review CRs can be decided`);
  }

  const nowIso = typeof now === "function" ? now() : new Date().toISOString();
  const patch: Record<string, unknown> & { status?: "accepted_current_build" | "rejected" } = {
    updated_at: nowIso.slice(0, 10),
    owner_decision: decision,
    owner_decision_by: decidedBy || "owner",
    owner_decision_at: nowIso.slice(0, 10),
    owner_decision_evidence: evidenceRef || `owner decision recorded ${nowIso}`,
  };
  if (decision === "rejected") {
    patch.status = "rejected";
  } else {
    const frozen = readFrozenBaselineIdentity(repoRoot);
    if (!frozen) {
      throw new Error(`decideChangeRequest: cannot approve ${id} — no frozen baseline manifest under ${BASELINES_DIR}/ to record as previous_baseline_*`);
    }
    patch.status = "accepted_current_build";
    Object.assign(patch, frozen);
  }

  const rel = `${CHANGE_REQUESTS_DIR}/${cr.file}`;
  const abs = resolve(repoRoot, rel);
  writeFileSync(abs, rewriteFrontmatter(readFileSync(abs, "utf8"), patch));
  const check = runChangeControlCheck({ repoRoot });
  if (check.exitCode !== 0) {
    throw new Error(`decideChangeRequest: the decided CR ${id} does not pass change-control:\n${check.errors.join("\n")}`);
  }
  return { id: id!, path: rel, status: patch.status! };
}

export interface ResultingBaselineIdentity {
  resulting_baseline_id: string;
  resulting_baseline_version: string;
  resulting_baseline_manifest_path: string;
  resulting_document_set_hash: string;
  resulting_manifest_hash: string;
}
interface StampChangeRequestAppliedOptions {
  repoRoot?: string | null;
  id?: string;
  resulting?: ResultingBaselineIdentity;
  now?: () => string;
}
export function stampChangeRequestApplied({ repoRoot, id, resulting, now }: StampChangeRequestAppliedOptions = {}): { id: string; path: string; status: "docs_applied" } {
  if (!repoRoot) throw new Error("stampChangeRequestApplied: repoRoot is required");
  const crs = readChangeRequests(repoRoot);
  const cr = crs.find((c) => String(c.fm?.id ?? "") === id);
  if (!cr) throw new Error(`stampChangeRequestApplied: no CR with id ${id} under ${CHANGE_REQUESTS_DIR}`);
  if (String(cr.fm?.status ?? "") !== "accepted_current_build") {
    throw new Error(`stampChangeRequestApplied: CR ${id} is "${cr.fm?.status}", only accepted_current_build can be marked docs_applied`);
  }
  const missing = RESULTING_FIELDS.filter((f) => isBlank(resulting?.[f]));
  if (missing.length > 0) {
    throw new Error(`stampChangeRequestApplied: resulting identity is missing ${missing.join(", ")}`);
  }
  const nowIso = typeof now === "function" ? now() : new Date().toISOString();
  const patch = { status: "docs_applied", updated_at: nowIso.slice(0, 10), ...resulting };
  const rel = `${CHANGE_REQUESTS_DIR}/${cr.file}`;
  const abs = resolve(repoRoot, rel);
  writeFileSync(abs, rewriteFrontmatter(readFileSync(abs, "utf8"), patch));
  const check = runChangeControlCheck({ repoRoot });
  if (check.exitCode !== 0) {
    throw new Error(`stampChangeRequestApplied: the stamped CR ${id} does not pass change-control:\n${check.errors.join("\n")}`);
  }
  return { id: id!, path: rel, status: "docs_applied" };
}

// Active baseline = status:frozen with no superseded marker; must match doc-baseline/extract-issues' definition.
export interface FrozenBaselineIdentity {
  previous_baseline_id: string;
  previous_baseline_version: unknown;
  previous_baseline_manifest_path: string;
  previous_document_set_hash: unknown;
  previous_manifest_hash: unknown;
}
type BaselineManifest = {
  status?: unknown;
  superseded?: unknown;
  baseline_id?: unknown;
  version?: unknown;
  document_set_hash?: unknown;
  manifest_hash?: unknown;
} | null;
export function readFrozenBaselineIdentity(root: string): FrozenBaselineIdentity | null {
  const dirAbs = resolve(root, BASELINES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return null;
  for (const file of readdirSync(dirAbs)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    let manifest: BaselineManifest;
    try {
      manifest = JSON.parse(readFileSync(join(dirAbs, file), "utf8")) as BaselineManifest;
    } catch {
      continue;
    }
    if (!manifest || manifest.status !== "frozen" || manifest.superseded || typeof manifest.baseline_id !== "string") continue;
    return {
      previous_baseline_id: manifest.baseline_id,
      previous_baseline_version: manifest.version,
      previous_baseline_manifest_path: `${BASELINES_DIR}/${file}`,
      previous_document_set_hash: manifest.document_set_hash,
      previous_manifest_hash: manifest.manifest_hash,
    };
  }
  return null;
}

export interface ChangeControlCheckResult {
  exitCode: number;
  errors: string[];
  placeholder: boolean;
  summary: string;
}
type FailFn = (rule: string, scope: string, evidence: string, expected: string, requiredFix: string) => void;

export function runChangeControlCheck(options: { repoRoot?: string | null } = {}): ChangeControlCheckResult {
  const root = (options.repoRoot ?? repoRoot) as string;
  const errors: string[] = [];
  const fail: FailFn = (rule, scope, evidence, expected, requiredFix) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };

  const dirAbs = resolveInside(root, CHANGE_REQUESTS_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return placeholder("no change-requests directory");
  const crs = readChangeRequests(root);
  if (crs.length === 0) return placeholder("no change requests");

  const numbers: number[] = [];
  const manifestHashes = readBaselineManifestHashes(root);

  for (const { file, fileNumber, fm } of crs) {
    const label = `${CHANGE_REQUESTS_DIR}/${file}`;
    if (!fm) {
      fail("cr_frontmatter", label, "no YAML frontmatter block", "every CR opens with a --- frontmatter block", `add the CR frontmatter block to ${label}`);
      continue;
    }

    const id = fm.id ? String(fm.id) : "";
    if (!CR_ID.test(id)) {
      fail("cr_id_format", label, `id="${id}"`, "id matches CR-#### (four digits)", `set id: CR-#### in ${label}`);
    } else {
      numbers.push(Number(id.slice(3)));
      if (fileNumber === null || `CR-${String(fileNumber).padStart(4, "0")}` !== id) {
        fail("cr_id_filename_match", label, `filename number ${fileNumber} vs id ${id}`, "the filename CR-####-slug.md number equals the frontmatter id", `rename ${label} or align its id`);
      }
    }

    const status = fm.status ? String(fm.status) : "";
    if (!(CR_STATUSES as readonly string[]).includes(status)) {
      fail("cr_status_enum", label, `status="${status}"`, `status is one of ${CR_STATUSES.join(" | ")}`, `set a valid status in ${label}`);
    }
    const classification = fm.classification ? String(fm.classification) : "";
    if (!(CR_CLASSIFICATIONS as readonly string[]).includes(classification)) {
      fail("cr_classification_enum", label, `classification="${classification}"`, `classification is one of ${CR_CLASSIFICATIONS.join(" | ")}`, `set a valid classification in ${label}`);
    }

    if (DECIDED_STATUSES.has(status)) {
      const missing = DECISION_FIELDS.filter((f) => isBlank(fm[f]));
      if (missing.length > 0) {
        fail("cr_decision_evidence", label, `decided status "${status}" but missing: ${missing.join(", ")}`, "a decided CR records owner_decision_by, owner_decision_at, and owner_decision_evidence", `populate the decision-evidence fields in ${label}`);
      }
    }

    if (PREVIOUS_REQUIRED.has(status)) {
      const missing = PREVIOUS_FIELDS.filter((f) => isBlank(fm[f]));
      if (missing.length > 0) {
        fail("cr_previous_baseline", label, `status "${status}" but missing previous_baseline field(s): ${missing.join(", ")}`, "accepted_current_build onward records the pre-change baseline identity", `record the previous_baseline_* fields in ${label}`);
      }
    }
    if (RESULTING_REQUIRED.has(status)) {
      const missing = RESULTING_FIELDS.filter((f) => isBlank(fm[f]));
      if (missing.length > 0) {
        fail("cr_resulting_baseline", label, `status "${status}" but missing resulting_* field(s): ${missing.join(", ")}`, "docs_applied onward records the resulting baseline identity", `record the resulting_* fields in ${label}`);
      } else if (!manifestHashes.has(String(fm.resulting_manifest_hash))) {
        fail("cr_resulting_manifest_exists", label, `resulting_manifest_hash "${fm.resulting_manifest_hash}" matches no manifest in ${BASELINES_DIR}/`, "the resulting baseline manifest exists and was generated by the freeze", `generate/verify the resulting baseline before marking ${label} docs_applied`);
      }
    }
  }

  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      fail("cr_sequential", CHANGE_REQUESTS_DIR, `CR numbers ${sorted.join(", ")} are not a gap-free 1..N sequence`, "CR ids are sequential CR-0001..CR-####N with no gaps or duplicates", "renumber the CRs so their ids form a contiguous sequence");
      break;
    }
  }

  validateSupersedesGraph(crs, fail);

  validateNoCrOnlyRequirements(root, fail);

  return done(errors, `${crs.length} change request(s)`);
}

function validateSupersedesGraph(crs: ChangeRequestRecord[], fail: FailFn): void {
  const byId = new Map<string, CrFrontmatter>();
  for (const cr of crs) if (cr.fm?.id) byId.set(String(cr.fm.id), cr.fm);
  for (const cr of crs) {
    const fm = cr.fm;
    if (!fm?.id) continue;
    const label = `${CHANGE_REQUESTS_DIR}/${cr.file}`;
    for (const target of toList(fm.supersedes)) {
      const other = byId.get(target);
      if (!other) {
        fail("cr_supersedes_target", label, `supersedes "${target}" which does not exist`, "every supersedes target is a real CR", `fix the supersedes list in ${label}`);
      } else if (String(other.superseded_by ?? "") !== String(fm.id)) {
        fail("cr_supersedes_consistency", label, `${fm.id} supersedes ${target}, but ${target}.superseded_by="${other.superseded_by ?? "null"}"`, "a supersedes edge is mirrored by the target's superseded_by", `set superseded_by: ${fm.id} in ${target}`);
      }
    }
  }
}

function validateNoCrOnlyRequirements(root: string, fail: FailFn): void {
  const catalogAbs = resolve(root, CATALOG_PATH);
  if (!existsSync(catalogAbs)) return;
  let catalog: { requirements?: Array<{ id?: unknown; sourceRefs?: unknown }> } | null;
  try {
    catalog = JSON.parse(readFileSync(catalogAbs, "utf8")) as typeof catalog;
  } catch {
    return;
  }
  const requirements = Array.isArray(catalog?.requirements) ? catalog.requirements : [];
  for (const req of requirements) {
    const refs = toList(req?.sourceRefs);
    if (refs.length === 0) continue;
    const allFromCr = refs.every((ref) => String(ref).startsWith(`${CHANGE_REQUESTS_DIR}/`));
    if (allFromCr) {
      fail("requirement_sourced_only_from_cr", `${CATALOG_PATH} ${req.id}`, `${req.id} sources only from change-requests/`, "an active requirement is sourced from the canonical baseline, never only from a CR", `cite ${req.id} to canonical lines (apply the CR to canonical and re-extract), or remove it`);
    }
  }
}

function readBaselineManifestHashes(root: string): Set<string> {
  const hashes = new Set<string>();
  const dirAbs = resolve(root, BASELINES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return hashes;
  for (const file of readdirSync(dirAbs)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(dirAbs, file), "utf8")) as { manifest_hash?: unknown };
      if (typeof manifest.manifest_hash === "string") hashes.add(manifest.manifest_hash);
    } catch {
      // the baseline tool owns manifest validity — not re-validated here
    }
  }
  return hashes;
}

function parseFrontmatter(text: string): CrFrontmatter | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm: CrFrontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!km) continue;
    fm[km[1]] = parseValue(km[2].trim());
  }
  return fm;
}

function parseValue(raw: string): CrFrontmatterValue {
  if (raw === "" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "[]") return [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return raw.replace(/^["']|["']$/g, "");
}

function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

const SLUG_MAX_LENGTH = 48;
function slugify(title: string): string {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length <= SLUG_MAX_LENGTH) return base || "change";
  const capped = base.slice(0, SLUG_MAX_LENGTH);
  const lastHyphen = capped.lastIndexOf("-");
  const cut = (lastHyphen > 0 ? capped.slice(0, lastHyphen) : capped).replace(/-+$/g, "");
  return cut || "change";
}

function renderNewChangeRequest({ id, title, classification, source, sourceEvidence, affectedVerificationGates = [], body, date }: { id: string; title: string; classification: CrClassification; source: string; sourceEvidence: string[]; affectedVerificationGates?: string[]; body: string | null; date: string }): string {
  const fm = [
    "---",
    `id: ${id}`,
    `title: ${title}`,
    "status: idea",
    `classification: ${classification}`,
    `created_at: ${date}`,
    `updated_at: ${date}`,
    `source: ${source}`,
    "owner_decision: pending",
    "owner_decision_by: null",
    "owner_decision_at: null",
    "owner_decision_evidence: null",
    "previous_baseline_id: null",
    "previous_baseline_version: null",
    "previous_baseline_manifest_path: null",
    "previous_document_set_hash: null",
    "previous_manifest_hash: null",
    "target_baseline_bump: null",
    "resulting_baseline_id: null",
    "resulting_baseline_version: null",
    "resulting_baseline_manifest_path: null",
    "resulting_document_set_hash: null",
    "resulting_manifest_hash: null",
    "affected_docs: []",
    "affected_issues: []",
    "affected_requirements: []",
    `affected_verification_gates: ${serializeFmValue(toList(affectedVerificationGates))}`,
    "issue_generation_required: false",
    "catalog_delta_required: false",
    "matrix_rows_pending: false",
    "supersedes: []",
    "superseded_by: null",
    "---",
  ].join("\n");
  if (isNonEmptyString(body)) return `${fm}\n\n${body.trim()}\n`;
  const evidence = toList(sourceEvidence);
  return [
    fm,
    "",
    `# ${id} - ${title}`,
    "",
    "## Idea",
    "",
    `${title}. Restated as a product change, decided by the owner.`,
    "",
    "## Why It Matters",
    "",
    `Raised via ${source}. The owner decides whether this changes the product intention.`,
    "",
    "## Development Agent Recommendation",
    "",
    `Recommended status \`idea\` pending the owner decision. Classification \`${classification}\`.`,
    "",
    "## Impact Assessment",
    "",
    "- Product behavior: recorded above.",
    "- Architecture / data model / protocols / security: `N/A - no impact found` unless the owner's decision touches them.",
    "",
    "## Decision",
    "",
    "Record the owner decision, date, and reason, and populate `owner_decision_by`, `owner_decision_at`, and `owner_decision_evidence`. A decided CR without this evidence is invalid.",
    "",
    "## Machine Evidence",
    "",
    evidence.length ? "```text" : "`N/A - no machine evidence captured`",
    ...(evidence.length ? [...evidence, "```"] : []),
    "",
    "## Audit Trail",
    "",
    "```text",
    `${date} - CR created (source: ${source}).`,
    "```",
    "",
  ].join("\n");
}

// Preserves the file's original CRLF/LF line ending — do not normalize to LF.
function rewriteFrontmatter(text: string, patch: Record<string, unknown>): string {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) throw new Error("rewriteFrontmatter: no --- frontmatter block");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const remaining = new Set(Object.keys(patch));
  const rewritten = m[1].split(/\r?\n/).map((line) => {
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (km && Object.prototype.hasOwnProperty.call(patch, km[1])) {
      remaining.delete(km[1]);
      return `${km[1]}: ${serializeFmValue(patch[km[1]])}`;
    }
    return line;
  });
  for (const key of remaining) rewritten.push(`${key}: ${serializeFmValue(patch[key])}`);
  const newBlock = `---\n${rewritten.join("\n")}\n---`.replace(/\n/g, eol);
  return text.slice(0, m.index) + newBlock + text.slice(m.index! + m[0].length);
}

function serializeFmValue(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function placeholder(reason: string): ChangeControlCheckResult {
  return { exitCode: 0, errors: [], placeholder: true, summary: `change-control: nothing to check yet (${reason})` };
}

function done(errors: string[], scope = ""): ChangeControlCheckResult {
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    errors,
    placeholder: false,
    summary:
      errors.length > 0
        ? `change-control: FAILED with ${errors.length} error(s)`
        : `change-control: OK${scope ? ` (${scope})` : ""}`,
  };
}

function resolveInside(root: string, rel: string): string {
  if (isAbsolute(rel)) throw new Error(`Path must be repository-relative: ${rel}`);
  const absolute = resolve(root, rel);
  const r = relative(root, absolute);
  if (!r || r.startsWith("..") || isAbsolute(r)) throw new Error(`Path must stay inside repository: ${rel}`);
  return absolute;
}

const cliEntry = process.argv[1] ? resolve(process.argv[1]) : null;
if (cliEntry === fileURLToPath(import.meta.url)) {
  if (!repoRoot) {
    console.error("error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check.");
    process.exit(2);
  }
  const [subcommand, ...rest] = process.argv.slice(2);
  if (subcommand === "decide") {
    runDecideCli(rest);
  } else {
    const result = runChangeControlCheck();
    for (const error of result.errors) console.error(`error:\n${error}`);
    console.log(result.summary);
    process.exit(result.exitCode);
  }
}

function runDecideCli(args: string[]): void {
  const opt = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const id = opt("cr");
  const decision = opt("decision");
  if (!id || !decision) {
    console.error("usage: change-control.ts decide --cr CR-#### --decision approved|rejected [--by <actor>] [--evidence <ref>]");
    process.exit(2);
  }
  try {
    const result = decideChangeRequest({ repoRoot, id, decision, decidedBy: opt("by"), evidenceRef: opt("evidence") });
    console.log(JSON.stringify({ ok: true, ...result }));
    process.exit(0);
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    process.exit(1);
  }
}
