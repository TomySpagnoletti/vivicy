import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BaselineManifest } from "./doc-baseline.ts";

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "doc-baseline.ts");

function makeTargetRoot() {
  const root = mkdtempSync(resolve(tmpdir(), "doc-baseline-test-"));
  mkdirSync(resolve(root, ".vivicy", "canonical"), { recursive: true });
  mkdirSync(resolve(root, ".vivicy", "baselines"), { recursive: true });
  return root;
}

function writeDoc(root: string, rel: string, body: string): void {
  const abs = resolve(root, ".vivicy", "canonical", rel);
  writeFileSync(abs, body);
}

function writePackage(root: string, name: string): void {
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ name, version: "0.0.0" }, null, 2)}\n`);
}

interface CliResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number;
}

function runCli(root: string, args: string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, VIVICY_TARGET_ROOT: root },
      stdio: "pipe",
    });
    return { ok: true, stdout, stderr: "", status: 0 };
  } catch (error) {
    const err = error as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number | null };
    return {
      ok: false,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
      status: err.status ?? 1,
    };
  }
}

function readBaseline(root: string, baselineId: string): BaselineManifest {
  return JSON.parse(readFileSync(resolve(root, ".vivicy", "baselines", `${baselineId}.json`), "utf8")) as BaselineManifest;
}

const BASELINE_ID = "baseline-v1.0.0-draft";

test("generate hashes the doc set and produces a self-consistent manifest", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writeDoc(root, "02-b.md", "# Doc Two\n\nbody beta\n");

    const gen = runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]);
    assert.equal(gen.status, 0, gen.stderr);

    const manifest = readBaseline(root, BASELINE_ID);
    assert.equal(manifest.baseline_id, BASELINE_ID);
    assert.equal(manifest.status, "draft");
    assert.equal(manifest.files.length, 2, "both canonical docs were hashed into the manifest");
    assert.match(manifest.document_set_hash, /^[0-9a-f]{64}$/, "document_set_hash is a sha256 hex digest");
    assert.match(manifest.manifest_hash, /^[0-9a-f]{64}$/, "manifest_hash is a sha256 hex digest");
    for (const file of manifest.files) {
      assert.match(file.sha256, /^[0-9a-f]{64}$/);
      assert.equal(typeof file.bytes, "number");
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("the document set hash is reproducible for the same content and changes when content changes", () => {
  const rootA = makeTargetRoot();
  const rootB = makeTargetRoot();
  const rootC = makeTargetRoot();
  try {
    for (const root of [rootA, rootB]) {
      writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
      writeDoc(root, "02-b.md", "# Doc Two\n\nbody beta\n");
    }
    writeDoc(rootC, "01-a.md", "# Doc One\n\nbody ALPHA-CHANGED\n");
    writeDoc(rootC, "02-b.md", "# Doc Two\n\nbody beta\n");

    for (const root of [rootA, rootB, rootC]) {
      const gen = runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]);
      assert.equal(gen.status, 0, gen.stderr);
    }

    const hashA = readBaseline(rootA, BASELINE_ID).document_set_hash;
    const hashB = readBaseline(rootB, BASELINE_ID).document_set_hash;
    const hashC = readBaseline(rootC, BASELINE_ID).document_set_hash;

    assert.equal(hashA, hashB, "identical doc sets in different roots hash identically (deterministic)");
    assert.notEqual(hashA, hashC, "a single changed byte changes the document_set_hash");
  } finally {
    rmSync(rootA, { force: true, recursive: true });
    rmSync(rootB, { force: true, recursive: true });
    rmSync(rootC, { force: true, recursive: true });
  }
});

test("verify accepts a manifest that matches the doc tree it was generated from", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writeDoc(root, "02-b.md", "# Doc Two\n\nbody beta\n");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    const verify = runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`]);
    assert.equal(verify.status, 0, verify.stderr);
    assert.match(verify.stdout, /Verified/);
    assert.match(verify.stdout, new RegExp(`baseline_id=${BASELINE_ID}`));
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("verify fails when a tracked doc is tampered after the manifest was frozen", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writeDoc(root, "02-b.md", "# Doc Two\n\nbody beta\n");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    writeDoc(root, "01-a.md", "# Doc One\n\nbody TAMPERED\n");

    const verify = runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`]);
    assert.equal(verify.status, 1, "tampered tree must fail verification");
    assert.match(verify.stderr, /Baseline verification failed/);
    assert.match(verify.stderr, /changed: .vivicy\/canonical\/01-a\.md/);
    assert.match(verify.stderr, /document_set_hash mismatch/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("verify detects a newly added tracked doc that the manifest does not list", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    writeDoc(root, "03-c.md", "# Doc Three\n\nbody gamma\n");

    const verify = runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`]);
    assert.equal(verify.status, 1, "an unlisted new doc must fail verification");
    assert.match(verify.stderr, /new included file: .vivicy\/canonical\/03-c\.md/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("verify reports a manifest_hash mismatch when the manifest body is edited", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    const manifestPath = resolve(root, ".vivicy", "baselines", `${BASELINE_ID}.json`);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.product = "Tampered Product Name";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const verify = runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`]);
    assert.equal(verify.status, 1, "an edited manifest body must fail verification");
    assert.match(verify.stderr, /Manifest hash mismatch/);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("product is derived from the target package.json name, title-cased (never a hardcoded brand)", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writePackage(root, "formula");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    const manifest = readBaseline(root, BASELINE_ID);
    assert.equal(manifest.product, "Formula", "package name 'formula' title-cases to 'Formula'");
    assert.notEqual(manifest.product, "Example Brand", "the product is never a hardcoded brand");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("generate --bump validates the version delta matches the declared bump class (E4)", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody\n");
    writePackage(root, "formula");
    assert.equal(
      runCli(root, ["generate", "--version", "1.1.0", "--status", "draft", "--bump", "minor", "--previous-version", "1.0.0"]).status,
      0,
    );
    const wrong = runCli(root, ["generate", "--version", "1.2.0", "--status", "draft", "--bump", "minor", "--previous-version", "1.0.0"]);
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /does not match a minor bump from 1\.0\.0 \(expected 1\.1\.0\)/);
    assert.equal(
      runCli(root, ["generate", "--version", "2.0.0", "--status", "draft", "--bump", "major", "--previous-version", "1.4.2"]).status,
      0,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("verify --require-min-version rejects a frozen 0.x as an extraction source (E4)", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody\n");
    writePackage(root, "formula");
    assert.equal(runCli(root, ["generate", "--version", "0.2.0", "--status", "draft"]).status, 0);
    const tooLow = runCli(root, [
      "verify",
      "--manifest",
      ".vivicy/baselines/baseline-v0.2.0-draft.json",
      "--require-min-version",
      "1.0.0",
    ]);
    assert.equal(tooLow.status, 1, "a 0.x baseline cannot drive extraction");
    assert.match(tooLow.stderr, /below the required minimum 1\.0\.0/);
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);
    assert.equal(
      runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`, "--require-min-version", "1.0.0"]).status,
      0,
    );
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("product title-cases multi-word and scoped package names", () => {
  const cases = [
    ["my-cool-lib", "My Cool Lib"],
    ["@acme/formula-engine", "Formula Engine"],
    ["pocket_ledger", "Pocket Ledger"],
  ];
  for (const [name, expected] of cases) {
    const root = makeTargetRoot();
    try {
      writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
      writePackage(root, name);
      assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);
      assert.equal(readBaseline(root, BASELINE_ID).product, expected, `${name} => ${expected}`);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  }
});

test("product falls back to a neutral name when the target has no package.json (never a hardcoded brand)", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);

    const manifest = readBaseline(root, BASELINE_ID);
    assert.equal(manifest.product, "Project", "neutral fallback when the project does not name itself");
    assert.notEqual(manifest.product, "Example Brand");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("product falls back to neutral when package.json has no usable name", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writeFileSync(resolve(root, "package.json"), `${JSON.stringify({ version: "0.0.0" }, null, 2)}\n`);
    assert.equal(runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]).status, 0);
    assert.equal(readBaseline(root, BASELINE_ID).product, "Project");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("--product overrides the derived name", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc One\n\nbody alpha\n");
    writePackage(root, "formula");
    assert.equal(
      runCli(root, ["generate", "--version", "1.0.0", "--status", "draft", "--product", "Custom Brand"]).status,
      0,
    );
    assert.equal(readBaseline(root, BASELINE_ID).product, "Custom Brand", "explicit --product wins over package name");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("generate stamps the mechanically detected spec_kind and it rides the manifest hash", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc\n");
    const gen = runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]);
    assert.equal(gen.status, 0, gen.stderr);
    const project = readBaseline(root, BASELINE_ID);
    assert.equal(project.spec_kind, "project");

    mkdirSync(resolve(root, "src"), { recursive: true });
    writeFileSync(resolve(root, "src", "main.go"), "package main\n");
    const gen2 = runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]);
    assert.equal(gen2.status, 0, gen2.stderr);
    const feature = readBaseline(root, BASELINE_ID);
    assert.equal(feature.spec_kind, "feature");
    assert.notEqual(feature.manifest_hash, project.manifest_hash);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a freshly generated manifest verifies with spec_kind present (shape stays legacy-tolerant)", () => {
  const root = makeTargetRoot();
  try {
    writeDoc(root, "01-a.md", "# Doc\n");
    const gen = runCli(root, ["generate", "--version", "1.0.0", "--status", "draft"]);
    assert.equal(gen.status, 0, gen.stderr);
    // spec_kind is optional in assertManifestShape by design — extending it to require the field would break old frozen manifests that predate it.
    const manifest = readBaseline(root, BASELINE_ID);
    assert.ok(manifest.spec_kind === "project" || manifest.spec_kind === "feature");
    const verify = runCli(root, ["verify", "--manifest", `.vivicy/baselines/${BASELINE_ID}.json`]);
    assert.equal(verify.status, 0, verify.stderr);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
