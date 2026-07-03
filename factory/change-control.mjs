#!/usr/bin/env node
// change-control:check — the post-freeze Change-Request registry gate (A2).
//
// After a baseline is frozen, no idea touches active scope directly: it passes through a
// Product Change Request under .vivicy/change-requests/. This deterministic gate proves the
// CR registry is well-formed — sequential IDs that match their filenames, valid status +
// classification enums, owner-decision evidence on every decided CR, the baseline-identity
// fields required from `accepted_current_build`/`docs_applied` onward (with a resulting
// manifest that actually exists), a consistent supersedes graph, and no active requirement
// sourced only from a CR file. It is read-only and runs alongside the other extraction gates.
//
//   VIVICY_TARGET_ROOT=<root> node vivicy/factory/change-control.mjs
//
// With no change-requests/ directory or no CR files it exits 0 ("nothing to check yet").
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveTargetRoot } from "./target-root.mjs";

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
];
export const CR_CLASSIFICATIONS = [
  "pending",
  "clarification",
  "minor_product_change",
  "major_product_change",
  "architecture_change",
  "implementation_order_change",
  "future_option",
  "rejection_candidate",
];
// A decided CR must carry owner-decision evidence (no agent self-assertion).
const DECIDED_STATUSES = new Set(["accepted_current_build", "docs_applied", "accepted_future", "rejected", "implemented"]);
// previous_baseline_* is required from accepted_current_build onward; resulting_* from docs_applied onward.
const PREVIOUS_REQUIRED = new Set(["accepted_current_build", "docs_applied", "implemented"]);
const RESULTING_REQUIRED = new Set(["docs_applied", "implemented"]);
const PREVIOUS_FIELDS = ["previous_baseline_id", "previous_baseline_version", "previous_baseline_manifest_path", "previous_document_set_hash", "previous_manifest_hash"];
const RESULTING_FIELDS = ["resulting_baseline_id", "resulting_baseline_version", "resulting_baseline_manifest_path", "resulting_document_set_hash", "resulting_manifest_hash"];
const DECISION_FIELDS = ["owner_decision_by", "owner_decision_at", "owner_decision_evidence"];

// Read + parse every real CR (skips the template + readme). Returns [{ file, number, fm }].
export function readChangeRequests(root = repoRoot) {
  const out = [];
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

// One CR by its frontmatter id (e.g. "CR-0003"), or null when none matches. The single
// lookup both cr-apply and the control plane use so the id→file resolution lives here.
export function readChangeRequest(root, id) {
  return readChangeRequests(root).find((cr) => String(cr.fm?.id ?? "") === id) ?? null;
}

// The next CR id is the highest existing CR-#### plus one (CR-0001 when none exist).
export function nextCrId(crs = readChangeRequests()) {
  const max = crs.reduce((acc, cr) => {
    const n = cr.fm?.id && CR_ID.test(String(cr.fm.id)) ? Number(String(cr.fm.id).slice(3)) : (cr.fileNumber ?? 0);
    return Math.max(acc, n);
  }, 0);
  return `CR-${String(max + 1).padStart(4, "0")}`;
}

// The single writer of a new Change Request (G7 emission). Every CR source — the spike
// prover, a readiness/dev leg, Vivi mid-run — routes through here so the frontmatter
// shape stays consistent with CR-TEMPLATE.md and the written file passes
// runChangeControlCheck. Computes the next sequential id, renders the full frontmatter
// (status: idea, owner_decision: pending, the null baseline-identity scaffold the checker
// needs to stay silent for an idea) + the template's narrative sections, writes the file,
// and returns its refs. `now` is a seam (tests pin it); `sourceEvidence` is the machine
// evidence (report paths, transcript refs) captured verbatim so the CR never rests on an
// agent's unverified assertion. Throws if the rendered CR would not pass the checker.
export function createChangeRequest({ repoRoot, title, classification = "minor_product_change", source = "agent", sourceEvidence = [], body = null, now } = {}) {
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
  const content = renderNewChangeRequest({ id, title, classification, source, sourceEvidence, body, date });
  writeFileSync(resolve(repoRoot, file), content);

  // Validation of record: the written file must pass the deterministic gate, or the
  // writer is buggy — fail loudly here rather than leave a malformed CR on disk.
  const check = runChangeControlCheck({ repoRoot });
  if (check.exitCode !== 0) {
    throw new Error(`createChangeRequest: the written CR ${id} does not pass change-control:\n${check.errors.join("\n")}`);
  }
  return { id, path: file };
}

// Record the owner decision on a CR (G7 decision — P2's single human touchpoint). Pure
// deterministic frontmatter rewrite, no agent: an `approved` CR becomes
// accepted_current_build with previous_baseline_* filled from the CURRENT frozen baseline
// manifest (the immutable pre-change identity the registry chains); a `rejected` CR
// becomes rejected. Both stamp owner_decision/owner_decision_by/at/evidence. The decided
// file must pass runChangeControlCheck. `now` is a seam (tests pin it).
export function decideChangeRequest({ repoRoot, id, decision, decidedBy, evidenceRef, now } = {}) {
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
  const patch = {
    updated_at: nowIso.slice(0, 10),
    owner_decision: decision,
    owner_decision_by: decidedBy || "owner",
    owner_decision_at: nowIso.slice(0, 10),
    owner_decision_evidence: evidenceRef || `owner decision recorded ${nowIso}`,
  };
  if (decision === "rejected") {
    patch.status = "rejected";
  } else {
    // accepted_current_build requires the pre-change baseline identity: the CURRENT frozen
    // manifest. A CR cannot be approved into the build with no baseline to change against.
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
  return { id, path: rel, status: patch.status };
}

// Stamp an APPROVED CR (status accepted_current_build) as docs_applied after the canonical
// edit has been re-frozen (G7 application chain, step c). Deterministic frontmatter
// rewrite: status → docs_applied, resulting_baseline_* filled from the NEW frozen manifest
// identity, updated_at bumped. `resulting` is { resulting_baseline_id, resulting_baseline_version,
// resulting_baseline_manifest_path, resulting_document_set_hash, resulting_manifest_hash }
// — the resulting_manifest_hash must exist in a baselines/ manifest (the checker verifies
// it). The stamped file must pass runChangeControlCheck. `now` is a seam (tests pin it).
export function stampChangeRequestApplied({ repoRoot, id, resulting, now } = {}) {
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
  return { id, path: rel, status: "docs_applied" };
}

// The single active frozen baseline's previous_* identity fields, or null when none is
// frozen. The active manifest is status:frozen with no `superseded` marker (the same
// definition doc-baseline and extract-issues use). Mirrors those fields into the
// previous_baseline_* names the checker's PREVIOUS_FIELDS require.
export function readFrozenBaselineIdentity(root) {
  const dirAbs = resolve(root, BASELINES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return null;
  for (const file of readdirSync(dirAbs)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(dirAbs, file), "utf8"));
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

export function runChangeControlCheck(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const errors = [];
  const fail = (rule, scope, evidence, expected, requiredFix) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };

  const dirAbs = resolveInside(root, CHANGE_REQUESTS_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return placeholder("no change-requests directory");
  const crs = readChangeRequests(root);
  if (crs.length === 0) return placeholder("no change requests");

  const numbers = [];
  const manifestHashes = readBaselineManifestHashes(root);

  for (const { file, fileNumber, fm } of crs) {
    const label = `${CHANGE_REQUESTS_DIR}/${file}`;
    if (!fm) {
      fail("cr_frontmatter", label, "no YAML frontmatter block", "every CR opens with a --- frontmatter block", `add the frontmatter from CR-TEMPLATE.md to ${label}`);
      continue;
    }

    // ID format + filename match.
    const id = fm.id ? String(fm.id) : "";
    if (!CR_ID.test(id)) {
      fail("cr_id_format", label, `id="${id}"`, "id matches CR-#### (four digits)", `set id: CR-#### in ${label}`);
    } else {
      numbers.push(Number(id.slice(3)));
      if (fileNumber === null || `CR-${String(fileNumber).padStart(4, "0")}` !== id) {
        fail("cr_id_filename_match", label, `filename number ${fileNumber} vs id ${id}`, "the filename CR-####-slug.md number equals the frontmatter id", `rename ${label} or align its id`);
      }
    }

    // Status + classification enums.
    const status = fm.status ? String(fm.status) : "";
    if (!CR_STATUSES.includes(status)) {
      fail("cr_status_enum", label, `status="${status}"`, `status is one of ${CR_STATUSES.join(" | ")}`, `set a valid status in ${label}`);
    }
    const classification = fm.classification ? String(fm.classification) : "";
    if (!CR_CLASSIFICATIONS.includes(classification)) {
      fail("cr_classification_enum", label, `classification="${classification}"`, `classification is one of ${CR_CLASSIFICATIONS.join(" | ")}`, `set a valid classification in ${label}`);
    }

    // Decided status requires owner-decision evidence.
    if (DECIDED_STATUSES.has(status)) {
      const missing = DECISION_FIELDS.filter((f) => isBlank(fm[f]));
      if (missing.length > 0) {
        fail("cr_decision_evidence", label, `decided status "${status}" but missing: ${missing.join(", ")}`, "a decided CR records owner_decision_by, owner_decision_at, and owner_decision_evidence", `populate the decision-evidence fields in ${label}`);
      }
    }

    // Baseline-identity fields required from accepted_current_build / docs_applied onward.
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

  // Sequential, gap-free, unique CR numbering (CR-0001..N).
  const sorted = [...numbers].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i += 1) {
    if (sorted[i] !== i + 1) {
      fail("cr_sequential", CHANGE_REQUESTS_DIR, `CR numbers ${sorted.join(", ")} are not a gap-free 1..N sequence`, "CR ids are sequential CR-0001..CR-####N with no gaps or duplicates", "renumber the CRs so their ids form a contiguous sequence");
      break;
    }
  }

  // Consistent supersedes / superseded_by graph.
  validateSupersedesGraph(crs, fail);

  // No active requirement sourced ONLY from a CR file.
  validateNoCrOnlyRequirements(root, fail);

  return done(errors, `${crs.length} change request(s)`);
}

function validateSupersedesGraph(crs, fail) {
  const byId = new Map();
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

function validateNoCrOnlyRequirements(root, fail) {
  const catalogAbs = resolve(root, CATALOG_PATH);
  if (!existsSync(catalogAbs)) return;
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(catalogAbs, "utf8"));
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

function readBaselineManifestHashes(root) {
  const hashes = new Set();
  const dirAbs = resolve(root, BASELINES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return hashes;
  for (const file of readdirSync(dirAbs)) {
    if (!file.toLowerCase().endsWith(".json")) continue;
    try {
      const manifest = JSON.parse(readFileSync(join(dirAbs, file), "utf8"));
      if (typeof manifest.manifest_hash === "string") hashes.add(manifest.manifest_hash);
    } catch {
      // ignore unparseable manifests; the baseline tool owns their validity
    }
  }
  return hashes;
}

// Minimal frontmatter reader (dependency-free, deterministic): the `--- ... ---` block's
// `key: value` lines, with `null`/empty -> null, `[a, b]` -> array, booleans parsed.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!km) continue;
    fm[km[1]] = parseValue(km[2].trim());
  }
  return fm;
}

function parseValue(raw) {
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

function toList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

// A filename-safe slug from a CR title: lowercase, non-alphanumerics to single hyphens,
// trimmed and capped so the CR-####-slug.md filename stays readable and matches the
// CR_FILENAME grammar ([a-z0-9-]+).
function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "change";
}

// Render a fresh CR file: the FULL CR-TEMPLATE frontmatter (valid enums + the null
// baseline-identity scaffold an `idea` needs to pass the checker) followed by the
// template's narrative sections. A caller may pass a `body` (already-formatted markdown
// after the frontmatter) for a richer narrative; otherwise the template sections are
// emitted with the machine evidence folded into the Audit Trail so the CR never rests on
// an unverified assertion.
function renderNewChangeRequest({ id, title, classification, source, sourceEvidence, body, date }) {
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
    "affected_verification_gates: []",
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

// Deterministically rewrite the frontmatter `key: value` lines of a CR file: keys present
// in `patch` are replaced in place (preserving their original position); keys not yet in
// the block are appended just before the closing `---`. Everything outside the frontmatter
// block is byte-preserved, and the file's dominant line ending is kept (no CRLF->LF).
function rewriteFrontmatter(text, patch) {
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
  return text.slice(0, m.index) + newBlock + text.slice(m.index + m[0].length);
}

function serializeFmValue(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  return String(value);
}

function isBlank(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function placeholder(reason) {
  return { exitCode: 0, errors: [], placeholder: true, summary: `change-control: nothing to check yet (${reason})` };
}

function done(errors, scope = "") {
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

function resolveInside(root, rel) {
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
  // Default (no subcommand): run the registry check, exactly as before. The `decide`
  // subcommand records an owner decision on a CR without disturbing that default — the
  // control plane (lib/control.ts) and the CLI (G14) both drive decisions through it.
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

// `change-control.mjs decide --cr CR-#### --decision approved|rejected [--by <actor>]
// [--evidence <ref>]` — records an owner decision and prints the resulting status as JSON
// for a non-human caller. Exit 0 on success, 1 on any decision error (unknown/undecidable
// CR, no frozen baseline to approve against), 2 on a usage error.
function runDecideCli(args) {
  const opt = (name) => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const id = opt("cr");
  const decision = opt("decision");
  if (!id || !decision) {
    console.error("usage: change-control.mjs decide --cr CR-#### --decision approved|rejected [--by <actor>] [--evidence <ref>]");
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
