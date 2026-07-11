import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isGateCommandEstablished,
  loadProjectConfig,
  normalizeGateCommand,
  PROJECT_CONFIG_FILENAME,
  ProjectConfigError,
  resolveGateCommand,
  setGateCommand,
} from "./project-config.ts";

function scratch() {
  return mkdtempSync(join(tmpdir(), "vivicy-projcfg-"));
}

test("normalizeGateCommand accepts a non-empty string and trims it", () => {
  assert.equal(normalizeGateCommand("  go test ./...  "), "go test ./...");
});

test("normalizeGateCommand treats null/undefined as the not-yet-established sentinel", () => {
  assert.equal(normalizeGateCommand(null), null);
  assert.equal(normalizeGateCommand(undefined), null);
});

test("normalizeGateCommand rejects a present-but-malformed value (empty / whitespace / non-string)", () => {
  for (const bad of ["", "   ", 42, {}, []]) {
    assert.throws(() => normalizeGateCommand(bad), ProjectConfigError);
  }
});

test("isGateCommandEstablished is true only for a real non-empty command", () => {
  assert.equal(isGateCommandEstablished({ gateCommand: "npm test" }), true);
  assert.equal(isGateCommandEstablished({ gateCommand: null }), false);
  assert.equal(isGateCommandEstablished(null), false);
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

test("loadProjectConfig reads the null sentinel as a valid not-yet-established state (never throws)", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null }));
    const cfg = loadProjectConfig(dir);
    assert.deepEqual(cfg, { gateCommand: null });
    assert.equal(isGateCommandEstablished(cfg), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadProjectConfig honors several polyglot runners verbatim", () => {
  for (const command of ["cargo test", "pytest -q", "phpunit", "swift test", "npm test"]) {
    const dir = scratch();
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: command }));
      assert.equal(loadProjectConfig(dir)!.gateCommand, command);
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
    assert.equal(loadProjectConfig(dir)!.gateCommand, "go test ./...");
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

test("setGateCommand fills gateCommand while preserving every other field, and refuses an empty command", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, requiredSkills: ["a/b@c"] }));
    const written = setGateCommand(dir, "  go test ./...  ");
    assert.equal(written, "go test ./...");
    const after = JSON.parse(readFileSync(join(dir, PROJECT_CONFIG_FILENAME), "utf8"));
    assert.deepEqual(after, { gateCommand: "go test ./...", requiredSkills: ["a/b@c"] });

    assert.throws(() => setGateCommand(dir, "   "), { code: "invalid_gate_command" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGateCommand precedence: issue.gate_command > vivicy.json > explicitDefault", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }));

    assert.equal(
      resolveGateCommand({
        issue: { gate_command: "go test ./pkg/..." },
        targetRoot: dir,
        explicitDefault: "npm test",
      }),
      "go test ./pkg/...",
    );

    assert.equal(
      resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "npm test" }),
      "go test ./...",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGateCommand skips the null sentinel: falls through to explicitDefault, else throws", () => {
  const dir = scratch();
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null }));
    assert.equal(
      resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "node --test" }),
      "node --test",
    );
    assert.throws(
      () => resolveGateCommand({ issue: {}, targetRoot: dir }),
      { code: "invalid_gate_command" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveGateCommand uses the explicit caller default ONLY when nothing else exists (no Node fallback)", () => {
  const dir = scratch();
  try {
    assert.equal(
      resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "node --test" }),
      "node --test",
    );
    assert.throws(
      () => resolveGateCommand({ issue: {}, targetRoot: dir }),
      { code: "invalid_gate_command" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
