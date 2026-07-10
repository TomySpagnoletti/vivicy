import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export const PROJECT_CONFIG_FILENAME = "vivicy.json";

export type ProjectConfigErrorCode = "invalid_json" | "invalid_gate_command";

export interface ProjectConfig {
  gateCommand: string;
}

export class ProjectConfigError extends Error {
  code: ProjectConfigErrorCode;
  constructor(message: string, code: ProjectConfigErrorCode) {
    super(message);
    this.name = "ProjectConfigError";
    this.code = code;
  }
}

export function validateGateCommand(value: unknown, source = PROJECT_CONFIG_FILENAME): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectConfigError(
      `${source}: "gateCommand" must be a non-empty string (the command Vivicy runs as the verification gate, e.g. "npm test", "go test ./...", "pytest -q")`,
      "invalid_gate_command",
    );
  }
  return value.trim();
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
  return { gateCommand: validateGateCommand((raw as { gateCommand?: unknown }).gateCommand, source) };
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
  if (projectConfig) return projectConfig.gateCommand;

  if (typeof explicitDefault === "string" && explicitDefault.trim().length > 0) {
    return explicitDefault.trim();
  }

  throw new ProjectConfigError(
    `No gate command configured. Add a "${PROJECT_CONFIG_FILENAME}" at the project root with a "gateCommand" (e.g. {"gateCommand": "go test ./..."}), or set it per issue via "gate_command".`,
    "invalid_gate_command",
  );
}
