import { chmodSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import { MANAGED_TEMP_PREFIX } from "../lib/managed-block.ts"

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

// The raw object, for the readers that own their own field (the skill declarations) rather than the two command fields normalized above. Missing and unparseable both read as null; only `updateProjectConfig` tells them apart, since only a writer has to.
export function readProjectConfigObject(targetRoot: string): Record<string, unknown> | null {
  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

// The ONE read-modify-write of vivicy.json — the gate/run commands and the skill pins both land through it, so the file has a single writer with a single set of guarantees. The write is atomic (a temp beside the target, exclusively created over a removed leftover, the target's mode carried across, then one rename): this file holds the verification gate command AND every skill pin, and a torn write would lose both at once. A file that exists but is not a JSON object is never clobbered — the caller decides whether that is a typed refusal or a silent no-op.
export function updateProjectConfig(targetRoot: string, mutate: (config: Record<string, unknown>) => void): "written" | "refused" {
  const configPath = resolve(targetRoot, PROJECT_CONFIG_FILENAME)
  const config = existsSync(configPath) ? readProjectConfigObject(targetRoot) : {}
  if (config === null) return "refused"
  mutate(config)
  const temp = resolve(targetRoot, `${MANAGED_TEMP_PREFIX}${process.pid}.${PROJECT_CONFIG_FILENAME}`)
  const mode = existsSync(configPath) ? statSync(configPath).mode : null
  try {
    rmSync(temp, { force: true })
    writeFileSync(temp, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" })
    if (mode !== null) chmodSync(temp, mode)
    renameSync(temp, configPath)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
  return "written"
}

// Writes one command field into vivicy.json while preserving every other field (the skill declarations etc.); creates the file if absent.
function setCommandField(targetRoot: string, field: CommandField, command: string): string {
  const normalized = normalizeCommand(command, field, PROJECT_CONFIG_FILENAME)
  if (normalized === null) {
    throw new ProjectConfigError(`refusing to set an empty ${field.noun} command in ${PROJECT_CONFIG_FILENAME}`, field.code)
  }
  const written = updateProjectConfig(targetRoot, (config) => {
    config[field.key] = normalized
  })
  if (written === "refused") {
    throw new ProjectConfigError(
      `${PROJECT_CONFIG_FILENAME}: cannot set "${field.key}" — the file is not a JSON object. Fix or delete it; the workflow re-establishes the command mechanically.`,
      "invalid_json"
    )
  }
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
