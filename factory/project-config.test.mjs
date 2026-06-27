// Unit tests for the POLYGLOT project-config seam (vivicy.json gate command).
//
// These prove the gate command is read from the TARGET PROJECT with no hidden
// Node assumption: a Go/Rust/Python-style command in vivicy.json is honored, the
// per-issue override wins, an explicit caller default is the lowest priority, and
// a present-but-malformed config (or a total absence with no default) fails loudly.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectConfig,
  PROJECT_CONFIG_FILENAME,
  ProjectConfigError,
  resolveGateCommand,
  validateGateCommand,
} from "./project-config.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vivicy-projcfg-"));
}

test("validateGateCommand accepts a non-empty string and trims it", () => {
  assert.equal(validateGateCommand("  go test ./...  "), "go test ./...");
});

test("validateGateCommand rejects empty / non-string", () => {
  for (const bad of ["", "   ", null, undefined, 42, {}, []]) {
    assert.throws(() => validateGateCommand(bad), ProjectConfigError);
  }
});

test("loadProjectConfig reads a NON-NODE gateCommand from vivicy.json (no npm/node assumption)", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }));
    const cfg = loadProjectConfig(dir);
    assert.deepEqual(cfg, { gateCommand: "go test ./..." });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectConfig honors several polyglot runners verbatim", () => {
  for (const command of ["cargo test", "pytest -q", "phpunit", "swift test", "npm test"]) {
    const dir = scratch();
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: command }));
      assert.equal(loadProjectConfig(dir).gateCommand, command);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("loadProjectConfig falls back to a `vivicy` field in package.json", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", vivicy: { gateCommand: "rake test" } }));
    assert.deepEqual(loadProjectConfig(dir), { gateCommand: "rake test" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("vivicy.json WINS over a package.json vivicy field when both exist", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ vivicy: { gateCommand: "npm test" } }));
    assert.equal(loadProjectConfig(dir).gateCommand, "go test ./...");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectConfig returns null when no config is present at all", () => {
  const dir = scratch();
  try {
    assert.equal(loadProjectConfig(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectConfig THROWS on a present-but-malformed vivicy.json (loud, not silent)", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), "{ not json");
    assert.throws(() => loadProjectConfig(dir), { code: "invalid_json" });

    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "" }));
    assert.throws(() => loadProjectConfig(dir), { code: "invalid_gate_command" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGateCommand precedence: issue.gate_command > vivicy.json > explicitDefault", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }));

    // 1. Per-issue override wins over everything.
    assert.equal(
      resolveGateCommand({
        issue: { gate_command: "go test ./pkg/..." },
        targetRoot: dir,
        explicitDefault: "npm test",
      }),
      "go test ./pkg/...",
    );

    // 2. With no per-issue override, vivicy.json wins over the explicit default.
    assert.equal(
      resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "npm test" }),
      "go test ./...",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGateCommand uses the explicit caller default ONLY when nothing else exists (no Node fallback)", () => {
  const dir = scratch(); // no vivicy.json, no package.json
  try {
    assert.equal(
      resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "node --test" }),
      "node --test",
    );
    // And with truly nothing configured, it fails loudly rather than assuming npm.
    assert.throws(
      () => resolveGateCommand({ issue: {}, targetRoot: dir }),
      { code: "invalid_gate_command" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
