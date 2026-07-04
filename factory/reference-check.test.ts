import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runReferenceCheck } from "./reference-check.ts";

// `files` maps repo-relative path -> content. Returns the check result.
function run(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "vivicy-ref-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(join(abs, ".."), { recursive: true });
      writeFileSync(abs, content);
    }
    return runReferenceCheck({ repoRoot: root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("no entry docs -> nothing to check", () => {
  const result = run({ "src/index.js": "//" });
  assert.equal(result.exitCode, 0);
  assert.equal(result.placeholder, true);
});

test("resolving links pass", () => {
  const result = run({
    "README.md": "See [spec](.vivicy/canonical/01-arch.md) and [home](./AGENTS.md).",
    "AGENTS.md": "Read [the arch](.vivicy/canonical/01-arch.md).",
    ".vivicy/canonical/01-arch.md": "# Arch",
  });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("a broken local markdown link fails", () => {
  const result = run({
    "README.md": "See [spec](.vivicy/canonical/99-missing.md).",
    ".vivicy/canonical/01-arch.md": "# Arch",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_resolves/);
});

test("external links, anchors, and non-md targets are ignored", () => {
  const result = run({
    "README.md": "[web](https://example.com/x.md) [anchor](#section) [img](./logo.png) [code](src/index.js)",
  });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("a canonical doc with a broken cross-link fails", () => {
  const result = run({
    "README.md": "# Project",
    ".vivicy/canonical/01-arch.md": "See [tokenizer](02-tokenizer.md).",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_resolves/);
});

test("a link escaping the project root fails", () => {
  const result = run({
    "README.md": "[outside](../secrets.md)",
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_inside_repo/);
});

test("a broken link with a CommonMark title attribute is caught", () => {
  const result = run({ "README.md": 'See [spec](.vivicy/canonical/99-missing.md "Spec").' });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_resolves/);
});

test("a valid link with a title attribute passes", () => {
  const result = run({
    "README.md": '[spec](.vivicy/canonical/01-arch.md "Spec")',
    ".vivicy/canonical/01-arch.md": "# Arch",
  });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("a broken angle-bracket link is caught", () => {
  const result = run({ "README.md": "See [spec](<.vivicy/canonical/99-missing.md>)." });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_resolves/);
});

test("a link resolving to a directory (not a file) fails", () => {
  const result = run({
    "README.md": "[dir](.vivicy/canonical.md)",
    ".vivicy/canonical.md/keep.txt": "x", // makes .vivicy/canonical.md a directory
  });
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join("\n"), /reference_resolves/);
});

test("a link inside a fenced code block is not resolved", () => {
  const result = run({ "README.md": "```\n[example](./does-not-exist.md)\n```\n" });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});

test("a percent-encoded link resolves to its decoded path", () => {
  const result = run({
    "README.md": "[doc](my%20doc.md)",
    "my doc.md": "# Doc",
  });
  assert.equal(result.exitCode, 0, result.errors.join("\n"));
});
