// C1' — per-baseline source-excerpt-drift comparison.
//
// semantic-extraction-check persists each requirement's `source_excerpt_sha256` (the hash of
// the exact canonical lines it cites) into source-map.json. When a Change Request regenerates
// the baseline, this compares the NEW baseline's per-requirement excerpt hashes against the
// PRIOR baseline's and reports exactly which requirements a doc edit invalidated — the input
// the Change-Control re-drive needs to know what to re-extract, amend, or drop. Pure helpers
// + one file-reading entry; no agent judgment.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Build a Map<requirementId, source_excerpt_sha256> from a parsed source-map.json.
export function excerptMap(sourceMap) {
  const list = Array.isArray(sourceMap?.requirement_excerpts) ? sourceMap.requirement_excerpts : [];
  const map = new Map();
  for (const entry of list) {
    if (entry && typeof entry.id === "string") map.set(entry.id, entry.source_excerpt_sha256 ?? null);
  }
  return map;
}

// Compare two source-maps' excerpt hashes. Pure.
//   unchanged: id in both with an identical hash
//   changed:   id in both with a different hash (a doc edit invalidated its cited lines)
//   added:     id only in the new baseline
//   removed:   id only in the prior baseline
export function compareExcerpts(priorSourceMap, newSourceMap) {
  const prior = excerptMap(priorSourceMap);
  const next = excerptMap(newSourceMap);
  const unchanged = [];
  const changed = [];
  const added = [];
  const removed = [];
  for (const [id, hash] of next) {
    if (!prior.has(id)) added.push(id);
    else if (prior.get(id) !== hash) changed.push(id);
    else unchanged.push(id);
  }
  for (const id of prior.keys()) {
    if (!next.has(id)) removed.push(id);
  }
  return { unchanged: unchanged.sort(), changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

// Format the drift as the Change-Control re-drive disposition: a changed excerpt is
// `amended`, an added one is `new`, a removed one is `removed` (the agent decides split/merged
// on top of this mechanical signal). Pure.
export function formatExcerptDrift(drift) {
  const lines = [];
  if (drift.changed.length) lines.push(`amended (excerpt changed): ${drift.changed.join(", ")}`);
  if (drift.added.length) lines.push(`new: ${drift.added.join(", ")}`);
  if (drift.removed.length) lines.push(`removed: ${drift.removed.join(", ")}`);
  if (!lines.length) lines.push("no requirement excerpts changed between the two baselines");
  lines.push(`unchanged: ${drift.unchanged.length}`);
  return lines.join("\n");
}

// Impure entry: read the prior + new source-maps and compare. Returns { drift, report }.
// A missing source-map yields a null drift with an explanatory report (never throws).
export function runExcerptDrift({ priorSourceMapPath, newSourceMapPath, repoRoot = "." }) {
  const read = (rel) => {
    const abs = resolve(repoRoot, rel);
    if (!existsSync(abs)) return null;
    try {
      return JSON.parse(readFileSync(abs, "utf8"));
    } catch {
      return null;
    }
  };
  const prior = read(priorSourceMapPath);
  const next = read(newSourceMapPath);
  if (!prior || !next) {
    return { drift: null, report: `excerpt-drift: missing source-map (prior=${Boolean(prior)}, new=${Boolean(next)})` };
  }
  const drift = compareExcerpts(prior, next);
  return { drift, report: formatExcerptDrift(drift) };
}
