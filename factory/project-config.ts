import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECT_CONFIG_FILENAME = "vivicy.json";

// null in vivicy.json#gateCommand means "gate not yet established"; the pipeline fills a real command mechanically, never a human.
export const GATE_COMMAND_SENTINEL = null;

export type ProjectConfigErrorCode = "invalid_json" | "invalid_gate_command";

export interface ProjectConfig {
  gateCommand: string | null;
}

export class ProjectConfigError extends Error {
  code: ProjectConfigErrorCode;
  constructor(message: string, code: ProjectConfigErrorCode) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
  }
}

export function normalizeGateCommand(value: unknown, source = PROJECT_CONFIG_FILENAME): string | null {
  if (value === null || value === undefined) return GATE_COMMAND_SENTINEL;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectConfigError(
      `${source}: "gateCommand" must be null (the not-yet-established sentinel) or the non-empty command Vivicy runs as the verification gate (e.g. "npm test", "go test ./...", "pytest -q"). The pipeline sets this mechanically; it is never hand-edited.`,
      "invalid_gate_command",
    );
  }
  return value.trim();
}

export function isGateCommandEstablished(config: ProjectConfig | null): config is ProjectConfig & { gateCommand: string } {
  return config != null && typeof config.gateCommand === "string" && config.gateCommand.length > 0;
}

export function loadProjectConfig(targetRoot: string | null | undefined): ProjectConfig | null {
  if (!targetRoot) return null;

  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME);
  if (existsSync(configPath)) {
    return parseConfig(readFileSync(configPath, "utf8"), PROJECT_CONFIG_FILENAME);
  }

  const pkgPath = resolve(targetRoot, "package.json");
  if (existsSync(pkgPath)) {
    let pkg: unknown;
    try {
      pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    } catch {
      return null; // malformed package.json is swallowed (not our file); a malformed vivicy.json above still throws
    }
    if (pkg && typeof pkg === "object" && "vivicy" in pkg && pkg.vivicy && typeof pkg.vivicy === "object") {
      return normalizeConfig(pkg.vivicy, "package.json#vivicy");
    }
  }
  return null;
}

// Writes gateCommand into vivicy.json while preserving every other field (requiredSkills etc.); creates the file if absent.
export function setGateCommand(targetRoot: string, command: string): string {
  const normalized = normalizeGateCommand(command);
  if (normalized === null) {
    throw new ProjectConfigError(
      `refusing to set an empty verification gate command in ${PROJECT_CONFIG_FILENAME}`,
      "invalid_gate_command",
    );
  }
  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME);
  let config: Record<string, unknown> = {};
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>;
  }
  config.gateCommand = normalized;
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return normalized;
}

function parseConfig(text: string, source: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProjectConfigError(`${source}: invalid JSON — ${(error as Error)?.message ?? error}`, "invalid_json");
  }
  return normalizeConfig(raw, source);
}

function normalizeConfig(raw: unknown, source: string): ProjectConfig {
  if (!raw || typeof raw !== "object") {
    throw new ProjectConfigError(`${source}: must be a JSON object`, "invalid_json");
  }
  return { gateCommand: normalizeGateCommand((raw as { gateCommand?: unknown }).gateCommand, source) };
}

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
  if (isGateCommandEstablished(projectConfig)) return projectConfig.gateCommand;

  if (typeof explicitDefault === "string" && explicitDefault.trim().length > 0) {
    return explicitDefault.trim();
  }

  throw new ProjectConfigError(
    `Verification gate command not established: neither the issue's "gate_command" nor "${PROJECT_CONFIG_FILENAME}#gateCommand" supplies one — gateCommand is still the not-yet-established sentinel (null). Vivicy establishes it mechanically (from the frozen canonical during extraction, else the stack-setup issue's implementer); the gate refuses to run until it is a real command.`,
    "invalid_gate_command",
  );
}
