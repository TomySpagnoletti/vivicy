// Independent per-lens architecture-map review (the method's Review Method).
//
// After the map generates and the fidelity verifier passes, the map is reviewed AS A
// SYSTEM by independent domain-expert sub-agents — one lens each, never a human reviewing
// the agents' output. Each lens reads the whole map + canonical corpus through a single
// perspective and writes a structured findings file; this module fans them out, then
// aggregates. Findings that reveal a real misalignment or gap flow back to the extractor
// (which may edit the map or, per Pass 1, canonical) exactly like a fidelity problem.
//
// The leg spawn (spawnLens) and the findings read (readFindings) are SEAMS supplied by the
// orchestrator (extract-issues), so the heavy agent-leg infra stays in one place and this
// module — the lens catalog, the fan-out, and the pure aggregation — is fully unit-testable.
import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

// The eight review lenses (method Review Method). Each gets the WHOLE map but one
// perspective; `focus` is injected into the shared map-review prompt.
export const MAP_REVIEW_LENSES = [
  { key: "product", focus: "Product and real-world workflow: the graph reflects how the product actually behaves end to end; a human can challenge the system from left to right without reading every doc." },
  { key: "architecture", focus: "Architecture and runtime: every always-on service, worker runtime, local wrapper, queue, materialization step, and provider dependency that matters to implementation is represented; no fabricated or missing runtime component." },
  { key: "security", focus: "Security and secrets: every security, credential, tenancy, authorization, network, and provider boundary is explicit; no edge implies a bypass the docs forbid; read-only inspection edges are labeled read-only." },
  { key: "data-ownership", focus: "Data and source-of-truth ownership: every durable state has exactly ONE owning node; the same state is never stored in several nodes; no duplicate authority." },
  { key: "protocol", focus: "Protocol and API boundaries: every worker/service communication path uses the one documented protocol; no second path or shadow protocol for the same relationship; edge identity (from+to+relation+protocol) is meaningful." },
  { key: "infrastructure", focus: "Infrastructure and provider implementation: provider-specific nodes sit behind a declared provider-neutral boundary when the docs require abstraction; provider names do not leak into product-level nodes." },
  { key: "observability", focus: "Observability and cost: audit, observability, cost, and security controls are represented and sit in a supporting band, not on the main production path." },
  { key: "dev-traceability", focus: "Development traceability and verification: every node/edge is justified by its cited source_refs without uncited assumptions; high-risk kinds carry line-precise refs; future capabilities are visually and semantically separate from current scope; no fallback or alternate path the accepted docs did not choose." },
];

// Where each lens writes its structured findings.
export function mapReviewReportRel(lensKey) {
  return `.vivicy/development/reports/map-review-${lensKey}.json`;
}

// The per-lens prompt context appended to the shared map-review prompt: the lens, where
// the corpus + map live, and where to write the findings. Pure.
export function mapReviewLensContext({ lens, manifestPath, baselineId }) {
  return (
    `\n\n---\n\n## Map review context for this run\n\n` +
    `- Frozen baseline manifest: \`${manifestPath}\` (baseline_id \`${baselineId}\`). Read it for the authoritative corpus files + line numbers.\n` +
    `- The map under review: \`.vivicy/architecture-map/architecture-map.yml\`.\n` +
    `- YOUR REVIEW LENS — **${lens.key}**: ${lens.focus}\n` +
    `- Write your STRUCTURED findings — and nothing else — to \`${mapReviewReportRel(lens.key)}\`, ` +
    `as JSON \`{ "findings": [{ "target": string, "source_ref": string, "detail": string, "correction": string, "real": boolean }] }\`. ` +
    `Do NOT edit the map or any corpus file; report findings for the extractor to fix.\n`
  );
}

// Aggregate per-lens findings into one flat list, tagging each with its lens. Pure.
export function aggregateFindings(perLens) {
  const findings = [];
  for (const { lens, result } of perLens) {
    const list = Array.isArray(result?.findings) ? result.findings : [];
    for (const f of list) findings.push({ lens, ...f });
  }
  return findings;
}

// A finding is ACTIONABLE unless the lens explicitly marked it not real (stylistic /
// already-fine). Pure — this is the integration rule: only real misalignments/gaps feed back.
export function actionableFindings(findings) {
  return findings.filter((f) => f.real !== false);
}

// Format actionable findings as a fix context for the extractor (mirrors the fidelity
// verdict feedback). Pure.
export function formatMapReviewFix(findings) {
  if (!findings.length) return "";
  return [
    "The architecture-map review (independent per-lens domain-expert sub-agents) found issues to correct.",
    "Fix the map (or, per Pass 1, the canonical doc the map cites) so each is resolved, then the map regenerates and is re-reviewed:",
    ...findings.map(
      (f) =>
        `- [${f.lens}] ${f.target ?? "*"}${f.source_ref ? ` (${f.source_ref})` : ""}: ${f.detail ?? ""}${f.correction ? ` — fix: ${f.correction}` : ""}`,
    ),
  ].join("\n");
}

// Run the per-lens review: clear stale reports, fan out one independent leg per lens
// (in parallel — the lenses are independent), then aggregate. A lens whose leg dies or
// writes nothing simply contributes no findings (never blocks the others).
export async function runMapReview({ repoRoot, manifestPath, baselineId, cfg, attempt, spawnLens, readFindings, lenses = MAP_REVIEW_LENSES }) {
  for (const lens of lenses) {
    const abs = resolve(repoRoot, mapReviewReportRel(lens.key));
    if (existsSync(abs)) rmSync(abs, { force: true });
  }
  const legs = await Promise.all(
    lenses.map((lens) => spawnLens({ repoRoot, manifestPath, baselineId, cfg, attempt, lens })),
  );
  const perLens = lenses.map((lens) => ({ lens: lens.key, result: readFindings({ repoRoot, lensKey: lens.key }) }));
  const findings = aggregateFindings(perLens);
  return { findings, actionable: actionableFindings(findings), legs };
}
