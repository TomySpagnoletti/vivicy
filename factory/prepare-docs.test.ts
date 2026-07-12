import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { completeBatches, docPrepStageNeeded, prepareDocs, routeByLocation, unconsumedActiveCycleBatches } from "./prepare-docs.ts";
import type { DocPrepReport, PrepareDocsOptions } from "./prepare-docs.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "vivicy-prep-"));
}

type Cycle = { binding: "active"; id: string } | { binding: "seed" };

function writeBatch(
  root: string,
  id: string,
  files: Record<string, string>,
  language: string,
  opts: { manifest?: boolean; cycle?: Cycle } = {},
): void {
  const batchDir = join(root, ".vivicy/uploads", id);
  const manifestFiles: Array<{ path: string; size: number; sha256: string }> = [];
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(batchDir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    manifestFiles.push({ path: rel, size: content.length, sha256: "x" });
  }
  mkdirSync(batchDir, { recursive: true });
  if (opts.manifest !== false) {
    writeFileSync(
      join(batchDir, "manifest.json"),
      JSON.stringify({ batchId: id, createdAt: new Date().toISOString(), language, cycle: opts.cycle ?? { binding: "active", id: "project" }, files: manifestFiles }, null, 2),
    );
  }
}

function writeFrozenBaseline(root: string, baselineId = "baseline-v1.0.0"): void {
  const dir = join(root, ".vivicy/baselines");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${baselineId}.json`), JSON.stringify({ status: "frozen", baseline_id: baselineId }, null, 2));
}

function openCycle(root: string, id: string): void {
  const abs = join(root, ".vivicy/development/reports/spec-cycle.json");
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, JSON.stringify({ status: "drafting", kind: "feature", id, opened_at: new Date().toISOString(), opened_by: "test" }, null, 2));
}

function readReport(root: string): DocPrepReport {
  return JSON.parse(readFileSync(join(root, ".vivicy/development/reports/doc-prep-report.json"), "utf8"));
}

const NEVER_SPAWN: PrepareDocsOptions["spawnLeg"] = async () => {
  throw new Error("leg must not spawn in this scenario");
};

const ENGLISH = "The product lets a user manage a catalog of items with search and pagination across the whole dataset.";
const FRENCH = "Le produit permet à un utilisateur de gérer un catalogue d'articles avec recherche et pagination sur tout le jeu de données.";

test("routeByLocation maps canonical-shaped upload paths to their target, rejects wrong extension and loose files", () => {
  assert.deepEqual(routeByLocation("canonical/spec.md"), { targetRel: "canonical/spec.md" });
  assert.deepEqual(routeByLocation("Naight/canonical/architecture.md"), { targetRel: "canonical/architecture.md" });
  assert.deepEqual(routeByLocation("architecture-map/architecture-map.yml"), { targetRel: "architecture-map/architecture-map.yml" });
  assert.deepEqual(routeByLocation("development/spikes/spike-1.md"), { targetRel: "development/spikes/spike-1.md" });
  assert.deepEqual(routeByLocation("requirements/catalog.json"), { targetRel: "requirements/catalog.json" });
  assert.equal(routeByLocation("cahier-des-charges.txt"), null);
  assert.equal(routeByLocation("canonical/scan.pdf"), null);
});

test("completeBatches returns only manifest-carrying batches, id-sorted, skipping interrupted ones", () => {
  const root = repo();
  try {
    writeBatch(root, "2026-02-02", { "b.txt": "loose" }, "eng", { manifest: false });
    writeBatch(root, "2026-01-01", { "canonical/a.md": ENGLISH }, "eng");
    writeBatch(root, "2026-03-03", { "canonical/c.md": ENGLISH }, "eng");
    assert.deepEqual(completeBatches(root).map((b) => b.batchId), ["2026-01-01", "2026-03-03"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("docPrepStageNeeded: an unconsumed active-cycle batch -> true; consumed -> false", () => {
  const root = repo();
  try {
    writeBatch(root, "b1", { "canonical/a.md": ENGLISH }, "eng");
    assert.equal(docPrepStageNeeded(root, null), true);
    assert.equal(docPrepStageNeeded(root, { cycle_id: "project", batches_consumed: ["b1"] } as DocPrepReport), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a seed batch is ignored while the canonical is frozen and becomes unconsumed-active when its cycle opens", () => {
  const root = repo();
  try {
    writeFrozenBaseline(root);
    writeBatch(root, "s1", { "canonical/a.md": ENGLISH }, "eng", { cycle: { binding: "seed" } });
    assert.equal(docPrepStageNeeded(root, null), false);
    assert.deepEqual(unconsumedActiveCycleBatches(root, null).map((b) => b.batchId), []);
    openCycle(root, "cycle-x");
    assert.equal(docPrepStageNeeded(root, null), true);
    assert.deepEqual(unconsumedActiveCycleBatches(root, null).map((b) => b.batchId), ["s1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a batch bound to a non-current cycle is never consumed by another cycle's prep", () => {
  const root = repo();
  try {
    writeFrozenBaseline(root);
    openCycle(root, "cycle-2");
    writeBatch(root, "b-old", { "canonical/a.md": ENGLISH }, "eng", { cycle: { binding: "active", id: "cycle-1" } });
    writeBatch(root, "b-new", { "canonical/b.md": ENGLISH }, "eng", { cycle: { binding: "active", id: "cycle-2" } });
    assert.deepEqual(unconsumedActiveCycleBatches(root, null).map((b) => b.batchId), ["b-new"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prep consumes ALL unconsumed active-cycle batches in one run, ordered by id, keying each placement by batch", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-01-01", { "canonical/a.md": `# A\n\n${ENGLISH}` }, "eng");
    writeBatch(root, "2026-02-02", { "canonical/b.md": `# B\n\n${ENGLISH}` }, "eng");
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "green");
    assert.deepEqual(report.batches_consumed, ["2026-01-01", "2026-02-02"]);
    assert.deepEqual(report.batches_pending, []);
    assert.deepEqual(report.placed.map((p) => p.target).sort(), ["canonical/a.md", "canonical/b.md"]);
    assert.equal(report.placed.find((p) => p.target === "canonical/a.md")?.batch, "2026-01-01");
    assert.equal(report.placed.find((p) => p.target === "canonical/b.md")?.batch, "2026-02-02");
    assert.ok(existsSync(join(root, ".vivicy/canonical/a.md")));
    assert.ok(existsSync(join(root, ".vivicy/canonical/b.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash-safe consumption: a failed batch is NOT marked consumed; a re-run retries only it", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-01-01", { "canonical/a.md": `# A\n\n${ENGLISH}` }, "eng");
    writeBatch(root, "2026-02-02", { "notes.txt": FRENCH }, "eng");
    const failed = await prepareDocs({ repoRoot: root, spawnLeg: async () => {} });
    assert.equal(failed.phase, "failed");
    assert.deepEqual(failed.batches_consumed, ["2026-01-01"]);
    assert.deepEqual(unconsumedActiveCycleBatches(root, failed).map((b) => b.batchId), ["2026-02-02"]);
    const green = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ outputDir }) => {
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "notes.md"), "# Notes\n\nExploded canonical.");
      },
    });
    assert.equal(green.phase, "green");
    assert.deepEqual(green.batches_consumed, ["2026-01-01", "2026-02-02"]);
    assert.ok(green.placed.some((p) => p.target === "canonical/a.md" && p.batch === "2026-01-01"));
    assert.ok(green.placed.some((p) => p.target === "canonical/notes.md" && p.batch === "2026-02-02"));
    assert.equal(green.rejected.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-cycle language: the first batch of the project fixes the cycle language; a later divergent batch is translated toward it", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-01-01", { "canonical/produit.md": FRENCH }, "fra");
    writeBatch(root, "2026-02-02", { "canonical/product.md": ENGLISH }, "eng");
    let legLang = "";
    let legInputCount = -1;
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ inputDir, outputDir, language }) => {
        const { readdirSync } = await import("node:fs");
        legLang = language;
        legInputCount = readdirSync(inputDir).length;
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "product.md"), `# Produit\n\n${FRENCH}`);
      },
    });
    assert.equal(report.phase, "green");
    assert.equal(report.language, "fra");
    assert.equal(legLang, "fra");
    assert.equal(legInputCount, 1);
    assert.ok(report.placed.some((p) => p.target === "canonical/produit.md" && p.route === "canonical"));
    assert.ok(report.placed.some((p) => p.route === "explode" && p.translated === true));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("per-cycle language: an already-established canonical language governs a later divergent batch's translation", async () => {
  const root = repo();
  try {
    mkdirSync(join(root, ".vivicy/canonical"), { recursive: true });
    writeFileSync(join(root, ".vivicy/canonical/spec.md"), `# Produit\n\n${FRENCH}`);
    writeBatch(root, "2026-03-03", { "canonical/product.md": ENGLISH }, "eng");
    let legLang = "";
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ outputDir, language }) => {
        legLang = language;
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "product.md"), `# Produit\n\n${FRENCH}`);
      },
    });
    assert.equal(report.language, "fra");
    assert.equal(legLang, "fra");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undetermined batch language is resolved by the language leg before the dominant-language law governs placement", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-05-05", { "canonical/spec.md": FRENCH }, "und");
    let seenBatchDir = "";
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: NEVER_SPAWN,
      resolveLanguage: async ({ batchDir }) => {
        seenBatchDir = batchDir;
        return { resolved: true, language: "fra" };
      },
    });
    assert.equal(report.language, "fra");
    assert.equal(report.phase, "green");
    assert.match(seenBatchDir, /2026-05-05$/);
    assert.deepEqual(report.placed.map((p) => p.target), ["canonical/spec.md"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an undetermined batch the leg cannot resolve stays 'und' and preparation still runs", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-06-06", { "canonical/spec.md": FRENCH }, "und");
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: NEVER_SPAWN,
      resolveLanguage: async () => ({ resolved: false, language: "und" }),
    });
    assert.equal(report.language, "und");
    assert.equal(report.phase, "green");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no batch -> skipped (the pipeline proceeds on owner-authored canonical)", async () => {
  const root = repo();
  try {
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "skipped");
    assert.deepEqual(report.batches_consumed, []);
    assert.deepEqual(report.batches_pending, []);
    assert.equal(readReport(root).phase, "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the canonical is frozen -> skipped, and the imported batch is named as a next-cycle seed", async () => {
  const root = repo();
  try {
    writeFrozenBaseline(root);
    writeBatch(root, "2026-03-03", { "canonical/a.md": ENGLISH }, "eng", { cycle: { binding: "seed" } });
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "skipped");
    assert.equal(report.cycle_id, null);
    assert.match(report.summary, /seed the next cycle/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a zero-file batch is consumed green (a legitimate empty outcome), never left perpetually stale", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-03-03", {}, "eng");
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "green");
    assert.deepEqual(report.batches_consumed, ["2026-03-03"]);
    assert.equal(docPrepStageNeeded(root, report), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("already-settled batch -> skipped without spawning the leg", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-04-04", { "canonical/a.md": ENGLISH }, "eng");
    const first = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(first.phase, "green");
    const second = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(second.phase, "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("happy path: a clean dominant-language canonical doc is placed untouched; a messy doc goes to the leg and is placed from its scratch output", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-05-05", { "canonical/spec.md": `# Spec\n\n${ENGLISH}`, "cahier.txt": FRENCH }, "eng");
    let legSaw: { language: string; inputCount: number } | null = null;
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ inputDir, outputDir, language }) => {
        const { readdirSync } = await import("node:fs");
        legSaw = { language, inputCount: readdirSync(inputDir).length };
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "produit.md"), "# Produit\n\nExploded canonical.");
      },
    });
    assert.equal(report.phase, "green");
    assert.equal(legSaw!.language, "eng");
    assert.equal(legSaw!.inputCount, 1);
    const clean = report.placed.find((p) => p.target === "canonical/spec.md");
    assert.equal(clean?.route, "canonical");
    assert.ok(existsSync(join(root, ".vivicy/canonical/spec.md")));
    const exploded = report.placed.find((p) => p.target === "canonical/produit.md");
    assert.equal(exploded?.route, "explode");
    assert.ok(existsSync(join(root, ".vivicy/canonical/produit.md")));
    assert.equal(existsSync(join(root, ".vivicy/development/reports/doc-prep-scratch")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("language law: a canonical-located doc in a non-dominant language is NOT placed directly — it is sent to the leg to translate", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-06-06", { "canonical/spec.md": FRENCH }, "eng");
    let translateInput = "";
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ inputDir, outputDir }) => {
        const { readdirSync } = await import("node:fs");
        translateInput = readFileSync(join(inputDir, readdirSync(inputDir)[0]), "utf8");
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "spec.md"), `# Spec\n\n${ENGLISH}`);
      },
    });
    assert.equal(report.phase, "green");
    assert.equal(report.placed.filter((p) => p.route === "canonical").length, 0);
    assert.match(translateInput, /vivicy:doc-prep translate/);
    assert.match(translateInput, /canonical\/spec\.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("path-(a) light check rejects an empty canonical doc and non-JSON requirements", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-07-07", { "canonical/empty.md": "   ", "requirements/bad.json": "not json", "canonical/ok.md": ENGLISH }, "eng");
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "green");
    const reasons = report.rejected.map((r) => `${r.source}:${r.reason}`);
    assert.ok(reasons.includes("canonical/empty.md:invalid_canonical"));
    assert.ok(reasons.includes("requirements/bad.json:invalid_canonical"));
    assert.ok(report.placed.some((p) => p.target === "canonical/ok.md"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("placement validation: leg output outside a canonical target is rejected, a valid one is placed", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-08-08", { "notes.txt": FRENCH }, "eng");
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async ({ outputDir }) => {
        mkdirSync(join(outputDir, "canonical"), { recursive: true });
        writeFileSync(join(outputDir, "canonical", "good.md"), "# Good");
        writeFileSync(join(outputDir, "escape.md"), "# Not a canonical target");
        writeFileSync(join(outputDir, "canonical", "image.png"), "binary");
      },
    });
    assert.equal(report.phase, "green");
    assert.ok(report.placed.some((p) => p.target === "canonical/good.md"));
    const rejReasons = report.rejected.map((r) => r.reason);
    assert.ok(rejReasons.includes("outside_target"));
    assert.equal(existsSync(join(root, ".vivicy/canonical/good.md")), true);
    assert.equal(existsSync(join(root, ".vivicy/escape.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("leg failure: no output after the bounded re-prompt -> phase failed, sources recorded as leg_no_output, batch left unconsumed", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-09-09", { "notes.txt": FRENCH }, "eng");
    let attempts = 0;
    const report = await prepareDocs({
      repoRoot: root,
      spawnLeg: async () => {
        attempts += 1;
      },
    });
    assert.equal(report.phase, "failed");
    assert.equal(attempts, 2);
    assert.ok(report.rejected.some((r) => r.reason === "leg_no_output"));
    assert.deepEqual(report.batches_consumed, []);
    assert.equal(existsSync(join(root, ".vivicy/development/reports/doc-prep-scratch")), false, "the failure path must clear the leg scratch dir (no leftover for extraction's git add -A)");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("nested platform-safe paths: a deep canonical upload path places at the mirrored nested target", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-10-10", { "Import/canonical/domain/orders.md": ENGLISH }, "eng");
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "green");
    assert.ok(report.placed.some((p) => p.target === "canonical/domain/orders.md"));
    assert.ok(existsSync(join(root, ".vivicy/canonical/domain/orders.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report shape carries phase, cycle_id, cycle_kind, batches_consumed, batches_pending, language, placed, rejected, summary, updated_at", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-11-11", { "canonical/a.md": ENGLISH }, "eng");
    await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    const report = readReport(root) as unknown as Record<string, unknown>;
    for (const key of ["phase", "cycle_id", "cycle_kind", "batches_consumed", "batches_pending", "language", "placed", "rejected", "summary", "updated_at"]) {
      assert.ok(key in report, `report missing ${key}`);
    }
    assert.equal((report as { language: string }).language, "eng");
    assert.equal((report as { cycle_id: string }).cycle_id, "project");
    assert.equal((report as { cycle_kind: string }).cycle_kind, "project");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
