import assert from "node:assert/strict"
import test from "node:test"
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  isGateCommandEstablished,
  isRunCommandEstablished,
  loadProjectConfig,
  normalizeGateCommand,
  normalizeRunCommand,
  PROJECT_CONFIG_FILENAME,
  ProjectConfigError,
  resolveGateCommand,
  resolveRunCommand,
  setGateCommand,
  setRunCommand,
} from "./project-config.ts"

function scratch() {
  return mkdtempSync(join(tmpdir(), "vivicy-projcfg-"))
}

test("normalizeGateCommand accepts a non-empty string and trims it", () => {
  assert.equal(normalizeGateCommand("  go test ./...  "), "go test ./...")
})

test("normalizeGateCommand treats null/undefined as the not-yet-established sentinel", () => {
  assert.equal(normalizeGateCommand(null), null)
  assert.equal(normalizeGateCommand(undefined), null)
})

test("normalizeGateCommand rejects a present-but-malformed value (empty / whitespace / non-string)", () => {
  for (const bad of ["", "   ", 42, {}, []]) {
    assert.throws(() => normalizeGateCommand(bad), ProjectConfigError)
  }
})

test("isGateCommandEstablished is true only for a real non-empty command", () => {
  assert.equal(isGateCommandEstablished({ gateCommand: "npm test", runCommand: null }), true)
  assert.equal(isGateCommandEstablished({ gateCommand: null, runCommand: null }), false)
  assert.equal(isGateCommandEstablished(null), false)
})

test("loadProjectConfig reads a NON-NODE gateCommand from vivicy.json (no npm/node assumption)", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }))
    const cfg = loadProjectConfig(dir)
    assert.deepEqual(cfg, { gateCommand: "go test ./...", runCommand: null })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadProjectConfig reads the null sentinel as a valid not-yet-established state (never throws)", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, runCommand: null }))
    const cfg = loadProjectConfig(dir)
    assert.deepEqual(cfg, { gateCommand: null, runCommand: null })
    assert.equal(isGateCommandEstablished(cfg), false)
    assert.equal(isRunCommandEstablished(cfg), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadProjectConfig honors several polyglot runners verbatim", () => {
  for (const command of ["cargo test", "pytest -q", "phpunit", "swift test", "npm test"]) {
    const dir = scratch()
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: command }))
      assert.equal(loadProjectConfig(dir)!.gateCommand, command)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("a vivicy.json whose JSON is valid but NOT an object is refused (the one caller of the object guard)", () => {
  for (const body of ['"a string"', "[1,2]", "42", "null"]) {
    const dir = scratch()
    try {
      writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), body)
      assert.throws(
        () => loadProjectConfig(dir),
        (error: unknown) =>
          error instanceof ProjectConfigError && error.code === "invalid_json" && /must be a JSON object/.test(error.message),
        `vivicy.json containing ${body} must be refused as a non-object`
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test("vivicy.json is the ONE declaration location: a `vivicy` field in package.json is not read", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", vivicy: { gateCommand: "rake test" } }))
    assert.equal(loadProjectConfig(dir), null)

    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }))
    assert.equal(loadProjectConfig(dir)!.gateCommand, "go test ./...")
    assert.equal(loadProjectConfig(dir)!.runCommand, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadProjectConfig returns null when no config is present at all", () => {
  const dir = scratch()
  try {
    assert.equal(loadProjectConfig(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("loadProjectConfig THROWS on a present-but-malformed vivicy.json (loud, not silent)", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), "{ not json")
    assert.throws(() => loadProjectConfig(dir), { code: "invalid_json" })

    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "" }))
    assert.throws(() => loadProjectConfig(dir), { code: "invalid_gate_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("setGateCommand fills gateCommand while preserving every other field, and refuses an empty command", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, skills: [{ id: "a/b@c" }] }))
    const written = setGateCommand(dir, "  go test ./...  ")
    assert.equal(written, "go test ./...")
    const after = JSON.parse(readFileSync(join(dir, PROJECT_CONFIG_FILENAME), "utf8"))
    assert.deepEqual(after, { gateCommand: "go test ./...", skills: [{ id: "a/b@c" }] })

    assert.throws(() => setGateCommand(dir, "   "), { code: "invalid_gate_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// vivicy.json holds the verification gate command AND every skill pin, so it has ONE writer and that writer publishes by rename: a torn write would lose both at once.
test("every vivicy.json write is atomic, keeps the file's mode, and refuses a file that is not a JSON object", () => {
  const dir = scratch()
  const config = join(dir, PROJECT_CONFIG_FILENAME)
  try {
    writeFileSync(config, `${JSON.stringify({ gateCommand: null, skills: [{ id: "a/b@c" }] }, null, 2)}\n`)
    chmodSync(config, 0o600)
    const before = statSync(config).ino
    setGateCommand(dir, "npm test")
    assert.equal(statSync(config).mode & 0o777, 0o600, "the owner's mode survives the rename that publishes the new bytes")
    assert.notEqual(statSync(config).ino, before, "the bytes are published by a rename, never written into the live file")
    assert.deepEqual(
      readdirSync(dir).filter((entry) => entry !== PROJECT_CONFIG_FILENAME),
      [],
      "no temp is left beside the target"
    )
    assert.ok(readFileSync(config, "utf8").endsWith("}\n"))

    writeFileSync(config, "{ not json at all\n")
    assert.throws(() => setRunCommand(dir, "npm run dev"), { name: "ProjectConfigError", code: "invalid_json" })
    assert.equal(readFileSync(config, "utf8"), "{ not json at all\n", "the owner's broken file is never clobbered")
    assert.deepEqual(readdirSync(dir), [PROJECT_CONFIG_FILENAME], "and the refused write leaves no residue")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("normalizeRunCommand mirrors the gate-command sentinel + malformed rules under its own error code", () => {
  assert.equal(normalizeRunCommand("  npm run dev  "), "npm run dev")
  assert.equal(normalizeRunCommand(null), null)
  assert.equal(normalizeRunCommand(undefined), null)
  for (const bad of ["", "   ", 42, {}, []]) {
    assert.throws(() => normalizeRunCommand(bad), { code: "invalid_run_command" })
  }
})

test("isRunCommandEstablished is true only for a real non-empty command", () => {
  assert.equal(isRunCommandEstablished({ gateCommand: null, runCommand: "npm run dev" }), true)
  assert.equal(isRunCommandEstablished({ gateCommand: "npm test", runCommand: null }), false)
  assert.equal(isRunCommandEstablished(null), false)
})

test("loadProjectConfig THROWS on a present-but-malformed runCommand (loud, its own code)", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, runCommand: "" }))
    assert.throws(() => loadProjectConfig(dir), { code: "invalid_run_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("setRunCommand fills runCommand while preserving gateCommand + other fields, and refuses an empty command", () => {
  const dir = scratch()
  try {
    writeFileSync(
      join(dir, PROJECT_CONFIG_FILENAME),
      JSON.stringify({ gateCommand: "npm test", runCommand: null, skills: [{ id: "a/b@c" }] })
    )
    const written = setRunCommand(dir, "  npm run dev  ")
    assert.equal(written, "npm run dev")
    const after = JSON.parse(readFileSync(join(dir, PROJECT_CONFIG_FILENAME), "utf8"))
    assert.deepEqual(after, { gateCommand: "npm test", runCommand: "npm run dev", skills: [{ id: "a/b@c" }] })

    assert.throws(() => setRunCommand(dir, "   "), { code: "invalid_run_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveRunCommand returns vivicy.json#runCommand, else explicitDefault, else throws its typed refusal", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, runCommand: "flask run" }))
    assert.equal(resolveRunCommand({ targetRoot: dir, explicitDefault: "npm run dev" }), "flask run")

    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null, runCommand: null }))
    assert.equal(resolveRunCommand({ targetRoot: dir, explicitDefault: "npm run dev" }), "npm run dev")
    assert.throws(() => resolveRunCommand({ targetRoot: dir }), { code: "invalid_run_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveGateCommand precedence: issue.gate_command > vivicy.json > explicitDefault", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: "go test ./..." }))

    assert.equal(
      resolveGateCommand({
        issue: { gate_command: "go test ./pkg/..." },
        targetRoot: dir,
        explicitDefault: "npm test",
      }),
      "go test ./pkg/..."
    )

    assert.equal(resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "npm test" }), "go test ./...")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveGateCommand skips the null sentinel: falls through to explicitDefault, else throws", () => {
  const dir = scratch()
  try {
    writeFileSync(join(dir, PROJECT_CONFIG_FILENAME), JSON.stringify({ gateCommand: null }))
    assert.equal(resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "node --test" }), "node --test")
    assert.throws(() => resolveGateCommand({ issue: {}, targetRoot: dir }), { code: "invalid_gate_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("resolveGateCommand uses the explicit caller default ONLY when nothing else exists (no Node fallback)", () => {
  const dir = scratch()
  try {
    assert.equal(resolveGateCommand({ issue: {}, targetRoot: dir, explicitDefault: "node --test" }), "node --test")
    assert.throws(() => resolveGateCommand({ issue: {}, targetRoot: dir }), { code: "invalid_gate_command" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
