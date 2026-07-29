import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export const PROJECT_CONFIG_FILENAME = "vivicy.json"

// null in vivicy.json#gateCommand / #runCommand means "not yet established"; the workflow fills a real command mechanically, never a human.
export const GATE_COMMAND_SENTINEL = null
export const RUN_COMMAND_SENTINEL = null

export type ProjectConfigErrorCode = "invalid_json" | "invalid_gate_command" | "invalid_run_command"

export interface ProjectConfig {
  gateCommand: string | null
  runCommand: string | null
}

export class ProjectConfigError extends Error {
  code: ProjectConfigErrorCode
  constructor(message: string, code: ProjectConfigErrorCode) {
    super(message)
    this.name = "ProjectConfigError"
    this.code = code
  }
}

interface CommandField {
  key: "gateCommand" | "runCommand"
  code: "invalid_gate_command" | "invalid_run_command"
  noun: string
  describe: string
}

const GATE_FIELD: CommandField = {
  key: "gateCommand",
  code: "invalid_gate_command",
  noun: "verification gate",
  describe: `the non-empty command Vivicy runs as the verification gate (e.g. "npm test", "go test ./...", "pytest -q")`,
}

const RUN_FIELD: CommandField = {
  key: "runCommand",
  code: "invalid_run_command",
  noun: "run",
  describe: `the non-empty command that starts the built product for the owner to use (e.g. "npm run dev", "go run ./...", "flask run")`,
}

function normalizeCommand(value: unknown, field: CommandField, source: string): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProjectConfigError(
      `${source}: "${field.key}" must be null (the not-yet-established sentinel) or ${field.describe}. The workflow sets this mechanically; it is never hand-edited.`,
      field.code
    )
  }
  return value.trim()
}

export function normalizeGateCommand(value: unknown, source = PROJECT_CONFIG_FILENAME): string | null {
  return normalizeCommand(value, GATE_FIELD, source)
}

export function normalizeRunCommand(value: unknown, source = PROJECT_CONFIG_FILENAME): string | null {
  return normalizeCommand(value, RUN_FIELD, source)
}

export function isGateCommandEstablished(config: ProjectConfig | null): config is ProjectConfig & { gateCommand: string } {
  return config != null && typeof config.gateCommand === "string" && config.gateCommand.length > 0
}

export function isRunCommandEstablished(config: ProjectConfig | null): config is ProjectConfig & { runCommand: string } {
  return config != null && typeof config.runCommand === "string" && config.runCommand.length > 0
}

export function loadProjectConfig(targetRoot: string | null | undefined): ProjectConfig | null {
  if (!targetRoot) return null

  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  return parseConfig(readFileSync(configPath, "utf8"), PROJECT_CONFIG_FILENAME)
}

// Writes one command field into vivicy.json while preserving every other field (requiredSkills etc.); creates the file if absent.
function setCommandField(targetRoot: string, field: CommandField, command: string): string {
  const normalized = normalizeCommand(command, field, PROJECT_CONFIG_FILENAME)
  if (normalized === null) {
    throw new ProjectConfigError(`refusing to set an empty ${field.noun} command in ${PROJECT_CONFIG_FILENAME}`, field.code)
  }
  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME)
  let config: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed as Record<string, unknown>
  }
  config[field.key] = normalized
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return normalized
}

export function setGateCommand(targetRoot: string, command: string): string {
  return setCommandField(targetRoot, GATE_FIELD, command)
}

export function setRunCommand(targetRoot: string, command: string): string {
  return setCommandField(targetRoot, RUN_FIELD, command)
}

function parseConfig(text: string, source: string): ProjectConfig {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new ProjectConfigError(`${source}: invalid JSON — ${(error as Error)?.message ?? error}`, "invalid_json")
  }
  return normalizeConfig(raw, source)
}

function normalizeConfig(raw: unknown, source: string): ProjectConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProjectConfigError(`${source}: must be a JSON object`, "invalid_json")
  }
  const fields = raw as { gateCommand?: unknown; runCommand?: unknown }
  return {
    gateCommand: normalizeGateCommand(fields.gateCommand, source),
    runCommand: normalizeRunCommand(fields.runCommand, source),
  }
}

export function resolveGateCommand({
  issue,
  targetRoot,
  explicitDefault,
}: { issue?: { gate_command?: unknown }; targetRoot?: string | null; explicitDefault?: unknown } = {}): string {
  const fromIssue = issue?.gate_command
  if (typeof fromIssue === "string" && fromIssue.trim().length > 0) return fromIssue.trim()

  const projectConfig = loadProjectConfig(targetRoot)
  if (isGateCommandEstablished(projectConfig)) return projectConfig.gateCommand

  if (typeof explicitDefault === "string" && explicitDefault.trim().length > 0) {
    return explicitDefault.trim()
  }

  throw new ProjectConfigError(
    `Verification gate command not established: neither the issue's "gate_command" nor "${PROJECT_CONFIG_FILENAME}#gateCommand" supplies one — gateCommand is still the not-yet-established sentinel (null). Vivicy establishes it mechanically (from the frozen canonical during extraction, else the stack-setup issue's implementer); the gate refuses to run until it is a real command.`,
    "invalid_gate_command"
  )
}

export function resolveRunCommand({ targetRoot, explicitDefault }: { targetRoot?: string | null; explicitDefault?: unknown } = {}): string {
  const projectConfig = loadProjectConfig(targetRoot)
  if (isRunCommandEstablished(projectConfig)) return projectConfig.runCommand

  if (typeof explicitDefault === "string" && explicitDefault.trim().length > 0) {
    return explicitDefault.trim()
  }

  throw new ProjectConfigError(
    `Run command not established: "${PROJECT_CONFIG_FILENAME}#runCommand" is still the not-yet-established sentinel (null). Vivicy establishes it mechanically (from the frozen canonical's run-and-ship area during extraction, else the stack-setup issue's implementer); the built product cannot be served until it is a real command.`,
    "invalid_run_command"
  )
}
