import { existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";

export interface MapReviewLens {
  key: string;
  focus: string;
}

export interface MapReviewFinding {
  target?: string;
  source_ref?: string;
  detail?: string;
  correction?: string;
  real?: boolean;
}

export type TaggedFinding = MapReviewFinding & { lens: string };

export interface MapReviewResult {
  findings?: MapReviewFinding[];
}

export const MAP_REVIEW_LENSES: MapReviewLens[] = [
  { key: "product", focus: "Product and real-world workflow: the graph reflects how the product actually behaves end to end; a human can challenge the system from left to right without reading every doc." },
  { key: "architecture", focus: "Architecture and runtime: every always-on service, worker runtime, local wrapper, queue, materialization step, and provider dependency that matters to implementation is represented; no fabricated or missing runtime component." },
  { key: "security", focus: "Security and secrets: every security, credential, tenancy, authorization, network, and provider boundary is explicit; no edge implies a bypass the docs forbid; read-only inspection edges are labeled read-only." },
  { key: "data-ownership", focus: "Data and source-of-truth ownership: every durable state has exactly ONE owning node; the same state is never stored in several nodes; no duplicate authority." },
  { key: "protocol", focus: "Protocol and API boundaries: every worker/service communication path uses the one documented protocol; no second path or shadow protocol for the same relationship; edge identity (from+to+relation+protocol) is meaningful." },
  { key: "infrastructure", focus: "Infrastructure and provider implementation: provider-specific nodes sit behind a declared provider-neutral boundary when the docs require abstraction; provider names do not leak into product-level nodes." },
  { key: "observability", focus: "Observability and cost: audit, observability, cost, and security controls are represented and sit in a supporting band, not on the main production path." },
  { key: "dev-traceability", focus: "Development traceability and verification: every node/edge is justified by its cited source_refs without uncited assumptions; high-risk kinds carry line-precise refs; future capabilities are visually and semantically separate from current scope; no fallback or alternate path the accepted docs did not choose." },
];

export function mapReviewReportRel(lensKey: string): string {
  return `.vivicy/development/reports/map-review-${lensKey}.json`;
}

export function mapReviewLensContext({ lens, manifestPath, baselineId }: { lens: MapReviewLens; manifestPath: string; baselineId: string }): string {
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

export function aggregateFindings(perLens: { lens: string; result: MapReviewResult | null }[]): TaggedFinding[] {
  const findings: TaggedFinding[] = [];
  for (const { lens, result } of perLens) {
    const list = Array.isArray(result?.findings) ? result.findings : [];
    for (const f of list) findings.push({ lens, ...f });
  }
  return findings;
}

export function actionableFindings<T extends { real?: boolean }>(findings: T[]): T[] {
  return findings.filter((f) => f.real !== false);
}

export function formatMapReviewFix(findings: TaggedFinding[]): string {
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

export async function runMapReview({ repoRoot, manifestPath, baselineId, cfg, attempt, spawnLens, readFindings, lenses = MAP_REVIEW_LENSES }: {
  repoRoot: string;
  manifestPath: string;
  baselineId: string;
  cfg: unknown;
  attempt: number;
  spawnLens: (args: { repoRoot: string; manifestPath: string; baselineId: string; cfg: unknown; attempt: number; lens: MapReviewLens }) => Promise<unknown>;
  readFindings: (args: { repoRoot: string; lensKey: string }) => MapReviewResult | null;
  lenses?: MapReviewLens[];
}): Promise<{ findings: TaggedFinding[]; actionable: TaggedFinding[]; legs: unknown[] }> {
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
