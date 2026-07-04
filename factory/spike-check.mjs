#!/usr/bin/env node
// spike:check — the Phase 0 evidence-gate well-formedness gate. It proves every
// spike artifact under .vivicy/development/spikes/ carries a valid Traceability
// block (gate-id grammar, status enum, requirement ids) and, once a spike is
// verified, the evidence field labels the Completion Rule requires. It is the
// spike analogue of
// semantic-extraction:check (source well-formedness) and is deterministic and
// read-only.
//
//   VIVICY_TARGET_ROOT=<root> node vivicy/factory/spike-check.mjs
//
// Scope boundary, kept deliberately narrow:
//   - This gate checks each spike file IN ISOLATION (shape, not meaning).
//   - It does NOT resolve issue spike_gates against spikes — that referential
//     check lives in traceability:check.
//   - It does NOT block on verification status — the dev-loop readiness gate owns
//     "an issue must not start against an unverified spike". `pending` is a valid,
//     freshly-minted state, so a corpus of pending spikes passes this gate.
//
// With no spikes/ directory or an empty one it exits 0 ("nothing to check yet"),
// mirroring the other extraction checks before extraction has run.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargetRoot } from "./target-root.mjs";

const repoRoot = resolveTargetRoot();

const SPIKES_DIR = ".vivicy/development/spikes";
const SPIKE_STATUSES = ["pending", "verified", "deferred", "blocked", "failed"];
// gate:phase0:s<slug>, where <slug> equals the spike filename stem (e.g.
// 03-codex-auth.md -> gate:phase0:s03-codex-auth). The leading "s" namespaces the
// gate; the slug is the join key back to the file.
const GATE_ID_PATTERN = /^gate:phase0:s([a-z0-9][a-z0-9-]*)$/;
// Files the scan skips: the shipped template and any directory readme.
const NON_SPIKE_FILES = new Set(["readme.md", "spike-template.md"]);
// The six evidence fields the Completion Rule requires a spike to capture.
const COMPLETION_FIELDS = [
  "environment",
  "commands",
  "observed output",
  "decision",
  "documentation updates",
  "unresolved risks",
];

export function runSpikeCheck(options = {}) {
  const root = options.repoRoot ?? repoRoot;
  const errors = [];
  const fail = (rule, scope, evidence, expected, requiredFix) => {
    errors.push(`Rule: ${rule}\n  Scope: ${scope}\n  Evidence: ${evidence}\n  Expected: ${expected}\n  Required fix: ${requiredFix}`);
  };

  const dirAbs = resolveInside(root, SPIKES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) {
    return placeholder("no spikes directory");
  }
  const files = readdirSync(dirAbs)
    .filter((f) => f.toLowerCase().endsWith(".md") && !NON_SPIKE_FILES.has(f.toLowerCase()))
    .sort();
  if (files.length === 0) return placeholder("no spikes");

  // gate ids are inherently unique: each must equal its (unique) filename slug.
  for (const file of files) {
    const label = `${SPIKES_DIR}/${file}`;
    const fileSlug = file.slice(0, -3).toLowerCase(); // strip ".md"
    const text = readFileSync(join(dirAbs, file), "utf8");

    const block = parseSpikeTraceability(text, label, fail);
    if (block) {
      if (!SPIKE_STATUSES.includes(block.status)) {
        fail(
          "spike_status_enum",
          label,
          `status="${block.status}"`,
          `status is one of ${SPIKE_STATUSES.join(" | ")}`,
          `set a valid status in ${label}`,
        );
      }

      const gateMatch = block.gate_id.match(GATE_ID_PATTERN);
      if (!gateMatch) {
        fail(
          "spike_gate_id_grammar",
          label,
          `gate_id="${block.gate_id}"`,
          "gate_id matches gate:phase0:s<slug>",
          `set gate_id to gate:phase0:s${fileSlug} in ${label}`,
        );
      } else if (gateMatch[1] !== fileSlug) {
        fail(
          "spike_gate_id_matches_file",
          label,
          `gate_id slug "${gateMatch[1]}" does not match filename slug "${fileSlug}"`,
          "the gate-id slug equals the spike filename stem",
          `rename ${label} or set gate_id to gate:phase0:s${fileSlug}`,
        );
      }
    }

    for (const section of ["Question", "Must Verify", "Evidence Required"]) {
      if (!sectionPresent(text, section)) {
        fail(
          "spike_section_required",
          label,
          `missing "## ${section}" section`,
          "a spike documents its Question, Must Verify, and Evidence Required",
          `add the "## ${section}" section to ${label}`,
        );
      }
    }

    // Completion Rule: a spike is complete only once verified, so the six evidence
    // fields are required only at `verified`. This proves the field LABELS are
    // present; whether the recorded evidence actually supports the decision is the
    // fidelity verifier's judgment, not something a deterministic check can read.
    if (block && block.status === "verified") {
      const evidence = extractSection(text, "Evidence Required").toLowerCase();
      const missing = COMPLETION_FIELDS.filter((field) => !evidence.includes(field));
      if (missing.length > 0) {
        fail(
          "spike_completion_fields",
          label,
          `a verified spike's Evidence Required is missing field(s): ${missing.join(", ")}`,
          `a verified spike records all of: ${COMPLETION_FIELDS.join(", ")}`,
          `add the missing field(s) to the Evidence Required section of ${label}`,
        );
      }
    }
  }

  // No two spikes may describe the SAME dependency. A stale or renamed duplicate — e.g.
  // `01-provider-auth.md` left beside `s01-provider-auth.md` — means the folder was not
  // kept clean. Compare each file's DESCRIPTIVE slug (the stem minus its leading
  // `s?<digits>-` id prefix) and fail on any collision so duplicates surface here instead
  // of silently accumulating.
  const byDescriptive = new Map();
  for (const file of files) {
    const key = file.slice(0, -3).toLowerCase().replace(/^s?\d+-?/, "");
    if (!key) continue; // a bare-number stem has no descriptive part to collide on
    const firstSeen = byDescriptive.get(key);
    if (firstSeen) {
      fail(
        "spike_duplicate",
        `${SPIKES_DIR}/${file}`,
        `describes the same dependency "${key}" as ${SPIKES_DIR}/${firstSeen}`,
        "one spike file per dependency — no stale or renamed duplicate left in the folder",
        `remove the stale duplicate; keep a single <nn>-<slug>.md for "${key}"`,
      );
    } else {
      byDescriptive.set(key, file);
    }
  }

  // E2 — inter-spike gating: validate the gated_by/blocks graph across the well-formed spikes.
  validateSpikeGatingGraph(readSpikes(root), fail);

  return done(errors, `${files.length} spike(s)`);
}

// Reader for the spike corpus, shared by traceability-check (referential
// resolution + requirement back-fill) and the dev-loop readiness gate. It indexes
// ONLY well-formed spikes — a spike whose gate id is not exactly
// `gate:phase0:s<filename-stem>` is skipped here, because runSpikeCheck (the
// authoritative validator) fails the corpus on it anyway. Indexing only the
// well-formed entries makes gate ids inherently unique (each equals its unique
// filename) and keeps a malformed spike from masquerading as a real gate.
// Returns an empty array when no spikes exist.
export function readSpikes(root = repoRoot) {
  const spikes = [];
  if (!root) return spikes;
  const dirAbs = resolve(root, SPIKES_DIR);
  if (!existsSync(dirAbs) || !statSync(dirAbs).isDirectory()) return spikes;
  for (const file of readdirSync(dirAbs)) {
    if (!file.toLowerCase().endsWith(".md") || NON_SPIKE_FILES.has(file.toLowerCase())) continue;
    const block = extractTraceabilityScalars(readFileSync(join(dirAbs, file), "utf8"));
    const fileSlug = file.slice(0, -3).toLowerCase();
    if (block.gate_id !== `gate:phase0:s${fileSlug}`) continue;
    spikes.push({
      file: `${SPIKES_DIR}/${file}`,
      gate_id: block.gate_id,
      status: SPIKE_STATUSES.includes(block.status) ? block.status : null,
      requirement_ids: block.requirement_ids ?? null,
      gated_by: parseGateList(block.gated_by),
      blocks: parseGateList(block.blocks),
      gated_by_external: block.gated_by_external || null,
    });
  }
  return spikes;
}

// gate_id -> status for every well-formed spike (a thin index over readSpikes).
export function readSpikeGateStatuses(root = repoRoot) {
  return new Map(readSpikes(root).map((spike) => [spike.gate_id, spike.status]));
}

// The gate_ids that are not only `verified` but whose ENTIRE transitive gated_by chain is
// also verified — the only spike gates safe to treat as satisfied. This makes the dev-loop
// readiness chain-aware on every turn, not only at the startup spike-check, so a spike
// hand-flipped to verified ahead of its chain never silently unblocks a dependent issue.
export function transitivelyVerifiedGates(root = repoRoot) {
  const spikes = readSpikes(root);
  const byGate = new Map(spikes.map((spike) => [spike.gate_id, spike]));
  const verified = new Set();
  for (const spike of spikes) {
    if (spike.status !== "verified") continue;
    if (transitiveGatedBy(spike.gate_id, byGate).every((g) => byGate.get(g)?.status === "verified")) {
      verified.add(spike.gate_id);
    }
  }
  return verified;
}

function parseGateList(value) {
  if (!value || value === "[]") return [];
  return value
    .replace(/^\[|\]$/g, "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
}

// E2 — inter-spike gating graph. A spike may declare `gated_by` (the spikes it depends on,
// which must verify first) and `blocks` (the inverse). The graph is validated for: referential
// integrity (entries resolve to real spikes), inverse consistency (A.blocks B <-> B.gated_by A),
// acyclicity (like issue depends_on), and the status chain — a `verified` spike requires every
// spike in its transitive gated_by chain to be verified. That last rule enforces the ordering,
// and the dev-loop's spike-status readiness then honours it for free.
function validateSpikeGatingGraph(spikes, fail) {
  const byGate = new Map(spikes.map((spike) => [spike.gate_id, spike]));
  for (const spike of spikes) {
    const label = spike.file;
    for (const g of spike.gated_by) {
      if (!byGate.has(g)) {
        fail("spike_gated_by_resolves", label, `gated_by "${g}" matches no spike`, "every gated_by entry is another spike's gate_id", `fix gated_by in ${label}`);
      }
    }
    for (const b of spike.blocks) {
      if (!byGate.has(b)) {
        fail("spike_blocks_resolves", label, `blocks "${b}" matches no spike`, "every blocks entry is another spike's gate_id", `fix blocks in ${label}`);
      } else if (!byGate.get(b).gated_by.includes(spike.gate_id)) {
        fail("spike_blocks_consistency", label, `${spike.gate_id} blocks ${b}, but ${b} does not list it in gated_by`, "a blocks edge is mirrored by the target's gated_by", `add gated_by: ${spike.gate_id} to ${b}, or remove blocks in ${label}`);
      }
    }
  }

  const nodes = spikes.map((spike) => spike.gate_id);
  const cycle = findGateCycle(nodes, (g) => (byGate.get(g)?.gated_by ?? []).filter((x) => byGate.has(x)));
  if (cycle) {
    fail("spike_gating_acyclic", SPIKES_DIR, `gated_by cycle: ${cycle.join(" -> ")}`, "the gated_by graph is acyclic (like issue depends_on)", "break the cycle in the spikes' gated_by lists");
  }

  for (const spike of spikes) {
    if (spike.status !== "verified") continue;
    const unmet = transitiveGatedBy(spike.gate_id, byGate).filter((g) => byGate.get(g)?.status !== "verified");
    if (unmet.length > 0) {
      fail("spike_verified_chain", spike.file, `${spike.gate_id} is verified but its gated_by chain is not verified: ${unmet.join(", ")}`, "a spike is verified only after every spike that gates it is verified", `verify ${unmet.join(", ")} first, or downgrade ${spike.gate_id}`);
    }
  }
}

// DFS three-colour cycle detection (the spike graph is small); returns a cycle path or null.
function findGateCycle(nodes, edgesOf) {
  const color = new Map(nodes.map((n) => [n, 0])); // 0 white, 1 gray (on path), 2 black
  const path = [];
  let cycle = null;
  const visit = (n) => {
    if (cycle) return;
    color.set(n, 1);
    path.push(n);
    for (const m of edgesOf(n) || []) {
      if (cycle) break;
      if (color.get(m) === 1) {
        cycle = [...path.slice(path.indexOf(m)), m];
        return;
      }
      if (color.get(m) === 0) visit(m);
    }
    path.pop();
    color.set(n, 2);
  };
  for (const n of nodes) {
    if (color.get(n) === 0) visit(n);
    if (cycle) return cycle;
  }
  return null;
}

function transitiveGatedBy(gate, byGate) {
  const seen = new Set();
  const stack = [...(byGate.get(gate)?.gated_by ?? [])];
  while (stack.length) {
    const g = stack.pop();
    if (seen.has(g) || !byGate.has(g)) continue;
    seen.add(g);
    stack.push(...(byGate.get(g).gated_by ?? []));
  }
  return [...seen];
}

// The spike Traceability block is YAML-shaped but parsed with fixed line rules
// (dependency-free, deterministic), mirroring semantic-extraction-check. Reads the
// three scalar keys; the caller decides whether missing keys are an error.
function extractTraceabilityScalars(text) {
  const lines = text.split(/\r?\n/);
  const headingIndex = lines.findIndex((line) => /^##\s+Traceability\s*$/.test(line));
  const data = {};
  if (headingIndex === -1) return data;
  for (let i = headingIndex + 1; i < lines.length; i += 1) {
    const raw = lines[i];
    if (/^#{1,2}\s/.test(raw)) break;
    if (!raw.trim() || /^\s*(`{3,}|~{3,})/.test(raw)) continue;
    const keyMatch = raw.match(/^([a-z_]+):\s*(.*)$/);
    if (!keyMatch) continue;
    const [, key, value] = keyMatch;
    if (
      ["requirement_ids", "gate_id", "status", "gated_by", "blocks", "gated_by_external"].includes(key) &&
      data[key] === undefined
    ) {
      data[key] = value.trim();
    }
  }
  return data;
}

function parseSpikeTraceability(text, label, fail) {
  if (!/^##\s+Traceability\s*$/m.test(text)) {
    fail(
      "spike_traceability_block",
      label,
      'missing "## Traceability" section',
      "every spike carries a Traceability block with requirement_ids, gate_id, status",
      `add a "## Traceability" block to ${label}`,
    );
    return null;
  }
  const data = extractTraceabilityScalars(text);
  let ok = true;
  for (const key of ["requirement_ids", "gate_id", "status"]) {
    if (!data[key]) {
      fail(
        "spike_traceability_field",
        label,
        `traceability ${key} is missing or empty`,
        "the Traceability block sets requirement_ids, gate_id, and status",
        `set ${key}: in the Traceability block of ${label}`,
      );
      ok = false;
    }
  }
  return ok ? data : null;
}

function sectionPresent(text, section) {
  return new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`, "m").test(text);
}

function extractSection(text, section) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${escapeRegExp(section)}\\s*$`).test(line));
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end).join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function placeholder(reason) {
  return { exitCode: 0, errors: [], placeholder: true, summary: `spike-check: nothing to check yet (${reason})` };
}

function done(errors, scope = "") {
  return {
    exitCode: errors.length > 0 ? 1 : 0,
    errors,
    placeholder: false,
    summary:
      errors.length > 0
        ? `spike-check: FAILED with ${errors.length} error(s)`
        : `spike-check: OK${scope ? ` (${scope})` : ""}`,
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
    console.error(
      "error: no target project configured. Set VIVICY_TARGET_ROOT to the absolute path of the project to check.",
    );
    process.exit(2);
  }
  const result = runSpikeCheck();
  for (const error of result.errors) console.error(`error:\n${error}`);
  console.log(result.summary);
  process.exit(result.exitCode);
}
