import assert from "node:assert/strict";
import test from "node:test";

import {
  actionableFindings,
  aggregateFindings,
  formatMapReviewFix,
  MAP_REVIEW_LENSES,
  mapReviewLensContext,
  mapReviewReportRel,
  runMapReview,
} from "./map-review.ts";
import type { MapReviewLens, MapReviewResult } from "./map-review.ts";

test("MAP_REVIEW_LENSES are the eight method lenses with unique keys and a focus each", () => {
  assert.equal(MAP_REVIEW_LENSES.length, 8);
  const keys = MAP_REVIEW_LENSES.map((l) => l.key);
  assert.equal(new Set(keys).size, 8, "lens keys are unique");
  for (const l of MAP_REVIEW_LENSES) assert.ok(l.focus.length > 0, `${l.key} carries a focus`);
});

test("mapReviewReportRel is per-lens under development/reports", () => {
  assert.equal(mapReviewReportRel("security"), ".vivicy/development/reports/map-review-security.json");
});

test("mapReviewLensContext names the lens, the map under review, and the per-lens output path", () => {
  const ctx = mapReviewLensContext({
    lens: { key: "protocol", focus: "Protocol and API boundaries." },
    manifestPath: ".vivicy/baselines/b.json",
    baselineId: "b",
  });
  assert.match(ctx, /protocol/);
  assert.match(ctx, /Protocol and API boundaries/);
  assert.match(ctx, /architecture-map\.yml/);
  assert.match(ctx, /map-review-protocol\.json/);
  assert.match(ctx, /baseline_id `b`/);
});

test("aggregateFindings flattens per-lens findings and tags each with its lens; tolerates null", () => {
  const out = aggregateFindings([
    { lens: "security", result: { findings: [{ target: "node:a", detail: "x" }] } },
    { lens: "data-ownership", result: { findings: [{ target: "node:b", detail: "y", real: false }] } },
    { lens: "product", result: null },
  ]);
  assert.deepEqual(out.map((f) => f.lens), ["security", "data-ownership"]);
  assert.equal(out[0].target, "node:a");
});

test("actionableFindings keeps everything except real:false (default-real)", () => {
  const out = actionableFindings([{ real: true }, { real: false }, {}]);
  assert.equal(out.length, 2);
});

test("formatMapReviewFix lists each finding (lens, target, detail, correction); empty -> ''", () => {
  assert.equal(formatMapReviewFix([]), "");
  const s = formatMapReviewFix([{ lens: "security", target: "node:a", detail: "two owners", correction: "merge" }]);
  assert.match(s, /\[security\] node:a/);
  assert.match(s, /two owners/);
  assert.match(s, /fix: merge/);
});

test("runMapReview fans out one leg per lens, aggregates findings, and marks actionable", async () => {
  const spawned: string[] = [];
  const spawnLens = async ({ lens }: { lens: MapReviewLens }) => {
    spawned.push(lens.key);
    return { transcriptRel: `t-${lens.key}` };
  };
  const findingsByLens: Record<string, MapReviewResult> = { security: { findings: [{ target: "node:a", detail: "x", real: true }] } };
  const readFindings = ({ lensKey }: { lensKey: string }) => findingsByLens[lensKey] ?? { findings: [] };
  const lenses = [
    { key: "security", focus: "f" },
    { key: "product", focus: "f" },
  ];
  const out = await runMapReview({
    repoRoot: "/nonexistent-temp-root",
    manifestPath: "m",
    baselineId: "b",
    cfg: {},
    attempt: 1,
    spawnLens,
    readFindings,
    lenses,
  });
  assert.deepEqual(spawned, ["security", "product"], "one leg per lens");
  assert.equal(out.findings.length, 1);
  assert.equal(out.actionable.length, 1);
  assert.equal(out.legs.length, 2);
});
