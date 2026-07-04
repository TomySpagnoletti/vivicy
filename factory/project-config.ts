// Vivicy project-level configuration (`vivicy.json`) — the POLYGLOT gate seam.
//
// Vivicy develops ANY project in ANY language. The one thing that is inherently
// project-specific is HOW to run the project's tests: the verification gate the
// dev-loop re-runs as its authoritative verdict. That command MUST come from the
// target project, never from a hardcoded Node default baked into the factory —
// otherwise a Go / Rust / PHP / Swift / Python project (which has no
// `package.json` and no `node --test`) would fail every gate and block every
// issue.
//
// The authoritative gate command therefore lives in a tiny `vivicy.json` at the
// TARGET ROOT:
//
//   { "gateCommand": "go test ./..." }      // Go
//   { "gateCommand": "cargo test" }         // Rust
//   { "gateCommand": "pytest -q" }          // Python
//   { "gateCommand": "phpunit" }            // PHP
//   { "gateCommand": "swift test" }         // Swift
//   { "gateCommand": "npm test" }           // Node
//
// Resolution order for a given issue (most specific wins):
//   1. issue.gate_command   — a per-issue override read in dev-loop.ts.
//   2. vivicy.json gateCommand — the project-level authoritative gate (this file).
//
// There is NO hidden Node fallback. If neither the issue nor `vivicy.json`
// supplies a gate command, the loop fails loudly with a clear message rather than
// silently assuming `npm test`.
//
// The config file name is also accepted as a `vivicy` field inside `package.json`
// for Node projects that prefer not to add a second manifest — but `vivicy.json`
// is the canonical, language-neutral home and takes precedence when both exist.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The canonical project-config filename at the target root. */
export const PROJECT_CONFIG_FILENAME = "vivicy.json";

/** Typed reasons a project config is rejected. */
export type ProjectConfigErrorCode = "invalid_json" | "invalid_gate_command";

/** The normalized project config resolved from `vivicy.json` (or `package.json#vivicy`). */
export interface ProjectConfig {
  gateCommand: string;
}

/** Typed reasons a project config is rejected. */
export class ProjectConfigError extends Error {
  code: ProjectConfigErrorCode;
  constructor(message: string, code: ProjectConfigErrorCode) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code; // "invalid_json" | "invalid_gate_command"
  }
}

/**
 * Validate a raw `gateCommand` value into a non-empty trimmed string, or throw
 * {@link ProjectConfigError}. The gate command is shell-executed, so the only
 * hard requirement is that it is a non-empty string; everything else is the
 * project's choice of runner.
 */
export function validateGateCommand(value: unknown, source = PROJECT_CONFIG_FILENAME): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectConfigError(
      `${source}: "gateCommand" must be a non-empty string (the command Vivicy runs as the verification gate, e.g. "npm test", "go test ./...", "pytest -q")`,
      "invalid_gate_command",
    );
  }
  return value.trim();
}

/**
 * Read and parse the target project's `vivicy.json` (or the `vivicy` field of its
 * `package.json` as a fallback). Returns a normalized config object
 * `{ gateCommand }`, or `null` when no project config is present at all (so the
 * caller can decide whether the absence is fatal — it is for the gate path).
 *
 * Pure read + validate; writes nothing. Throws {@link ProjectConfigError} only on
 * a present-but-malformed config (bad JSON, or a present-but-invalid
 * `gateCommand`) — a clear, loud failure is better than a silent wrong gate.
 */
export function loadProjectConfig(targetRoot: string | null | undefined): ProjectConfig | null {
  if (!targetRoot) return null;

  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME);
  if (existsSync(configPath)) {
    return parseConfig(readFileSync(configPath, "utf8"), PROJECT_CONFIG_FILENAME);
  }

  // Fallback: a `vivicy` field inside package.json (Node projects that prefer one
  // manifest). vivicy.json wins when both exist (handled above by early return).
  const pkgPath = resolve(targetRoot, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return null; // a malformed package.json is not OUR config to validate here
    }
    if (pkg && typeof pkg === "object" && "vivicy" in pkg && pkg.vivicy && typeof pkg.vivicy === "object") {
      return normalizeConfig(pkg.vivicy, "package.json#vivicy");
    }
  }
  return null;
}

/** Parse a `vivicy.json` text body into a normalized config, or throw. */
function parseConfig(text: string, source: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`${source}: invalid JSON — ${(error as Error)?.message ?? error}`, "invalid_json");
  }
  return normalizeConfig(raw, source);
}

/** Validate a parsed config object into `{ gateCommand }`, or throw. */
function normalizeConfig(raw: unknown, source: string): ProjectConfig {
  if (!raw || typeof raw !== "object") {
    throw new ProjectConfigError(`${source}: must be a JSON object`, "invalid_json");
  }
  return { gateCommand: validateGateCommand((raw as { gateCommand?: unknown }).gateCommand, source) };
}

/**
 * Resolve the AUTHORITATIVE gate command for an issue, most-specific first:
 *   1. issue.gate_command (per-issue override), if a non-empty string.
 *   2. the project-level `vivicy.json` gateCommand at `targetRoot`.
 *   3. an explicit `defaultGateCommand` the caller passed in (tests / the Node
 *      rehearsal fixture set this directly so they do not need a vivicy.json on
 *      disk) — this is NOT a hidden Node default; it only applies when a caller
 *      deliberately provides it.
 * Throws {@link ProjectConfigError} when none of the three yields a command, so a
 * misconfigured project blocks loudly instead of running a wrong gate.
 */
export function resolveGateCommand(
  {
    issue,
    targetRoot,
    explicitDefault,
  }: { issue?: { gate_command?: unknown }; targetRoot?: string | null; explicitDefault?: unknown } = {},
): string {
  const fromIssue = issue?.gate_command;
  if (typeof fromIssue === "string" && fromIssue.trim().length > 0) return fromIssue.trim();

  const projectConfig = loadProjectConfig(targetRoot);
  if (projectConfig) return projectConfig.gateCommand;

  if (typeof explicitDefault === "string" && explicitDefault.trim().length > 0) {
    return explicitDefault.trim();
  }

  throw new ProjectConfigError(
    `No gate command configured. Add a "${PROJECT_CONFIG_FILENAME}" at the project root with a "gateCommand" (e.g. {"gateCommand": "go test ./..."}), or set it per issue via "gate_command".`,
    "invalid_gate_command",
  );
}
