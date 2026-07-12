import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { docPrepStageNeeded, latestCompleteBatch, prepareDocs, routeByLocation } from "./prepare-docs.ts";
import type { PrepareDocsOptions } from "./prepare-docs.ts";

function repo(): string {
  return mkdtempSync(join(tmpdir(), "vivicy-prep-"));
}

function writeBatch(root: string, id: string, files: Record<string, string>, language: string, opts: { manifest?: boolean } = {}): void {
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
    writeFileSync(join(batchDir, "manifest.json"), JSON.stringify({ batchId: id, createdAt: new Date().toISOString(), language, files: manifestFiles }, null, 2));
  }
}

function readReport(root: string): { phase: string; placed: Array<{ target: string; route: string }>; rejected: Array<{ source: string; reason: string }>; batch_id: string | null } {
  return JSON.parse(readFileSync(join(root, ".vivicy/development/reports/doc-prep-report.json"), "utf8"));
}

const NEVER_SPAWN: PrepareDocsOptions["spawnLeg"] = async () => {
  throw new Error("leg must not spawn in this scenario");
};

const ENGLISH = "The product lets a user manage a catalog of items with search and pagination across the whole dataset.";
const FRENCH = "Le produit permet à un utilisateur de gérer un catalogue d'articles avec recherche et pagination sur tout le jeu de données.";

test("docPrepStageNeeded: no batch -> false; no report -> true; settled-same-batch -> false; stale batch -> true", () => {
  assert.equal(docPrepStageNeeded(null, null), false);
  assert.equal(docPrepStageNeeded({ batchId: "b1" }, null), true);
  assert.equal(docPrepStageNeeded({ batchId: "b1" }, { phase: "green", batch_id: "b1" }), false);
  assert.equal(docPrepStageNeeded({ batchId: "b2" }, { phase: "green", batch_id: "b1" }), true);
  assert.equal(docPrepStageNeeded({ batchId: "b1" }, { phase: "failed", batch_id: "b1" }), true);
});

test("routeByLocation maps canonical-shaped upload paths to their target, rejects wrong extension and loose files", () => {
  assert.deepEqual(routeByLocation("canonical/spec.md"), { targetRel: "canonical/spec.md" });
  assert.deepEqual(routeByLocation("Naight/canonical/architecture.md"), { targetRel: "canonical/architecture.md" });
  assert.deepEqual(routeByLocation("architecture-map/architecture-map.yml"), { targetRel: "architecture-map/architecture-map.yml" });
  assert.deepEqual(routeByLocation("development/spikes/spike-1.md"), { targetRel: "development/spikes/spike-1.md" });
  assert.deepEqual(routeByLocation("requirements/catalog.json"), { targetRel: "requirements/catalog.json" });
  assert.equal(routeByLocation("cahier-des-charges.txt"), null);
  assert.equal(routeByLocation("canonical/scan.pdf"), null);
});

test("latestCompleteBatch picks the lexicographically-largest batch that carries a manifest, skipping interrupted ones", () => {
  const root = repo();
  try {
    writeBatch(root, "2026-01-01", { "canonical/a.md": ENGLISH }, "eng");
    writeBatch(root, "2026-02-02", { "b.txt": "loose" }, "eng", { manifest: false });
    const latest = latestCompleteBatch(root);
    assert.equal(latest?.batchId, "2026-01-01");
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
    assert.equal(report.batch_id, null);
    assert.equal(readReport(root).phase, "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("empty batch -> skipped", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-03-03", {}, "eng");
    const report = await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    assert.equal(report.phase, "skipped");
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

test("leg failure: no output after the bounded re-prompt -> phase failed, sources recorded as leg_no_output", async () => {
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

test("report shape carries phase, batch_id, language, placed, rejected, summary, updated_at", async () => {
  const root = repo();
  try {
    writeBatch(root, "2026-11-11", { "canonical/a.md": ENGLISH }, "eng");
    await prepareDocs({ repoRoot: root, spawnLeg: NEVER_SPAWN });
    const report = readReport(root) as Record<string, unknown>;
    for (const key of ["phase", "batch_id", "language", "placed", "rejected", "summary", "updated_at"]) {
      assert.ok(key in report, `report missing ${key}`);
    }
    assert.equal((report as { language: string }).language, "eng");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
