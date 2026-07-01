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
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
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

// The next CR id is the highest existing CR-#### plus one (CR-0001 when none exist).
export function nextCrId(crs = readChangeRequests()) {
  const max = crs.reduce((acc, cr) => {
    const n = cr.fm?.id && CR_ID.test(String(cr.fm.id)) ? Number(String(cr.fm.id).slice(3)) : (cr.fileNumber ?? 0);
    return Math.max(acc, n);
  }, 0);
  return `CR-${String(max + 1).padStart(4, "0")}`;
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

function isBlank(value) {
  return value === null || value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
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
  const result = runChangeControlCheck();
  for (const error of result.errors) console.error(`error:\n${error}`);
  console.log(result.summary);
  process.exit(result.exitCode);
}
