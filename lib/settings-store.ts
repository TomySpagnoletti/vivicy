import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import path from "node:path"

import { replaceFileAtomically } from "@/lib/managed-block"
import { vivicyHome } from "@/lib/vivicy-home"
import {
  DEFAULT_SETTINGS,
  mergeSettingsLayers,
  normalizeSettings,
  settingsDelta,
  type AgentsSettings,
  type SettingsOverride,
  type SettingsScope,
  type SettingsState,
} from "@/lib/settings"

// Never move this fs I/O into ./settings: that module must stay node:fs-free for the client bundle.
const SETTINGS_FILE = "settings.json"

const PROJECT_SETTINGS_SEGMENTS = [".vivicy", SETTINGS_FILE] as const

export function machineSettingsPath(): string {
  return path.join(vivicyHome(), SETTINGS_FILE)
}

export function projectSettingsPath(targetRoot: string): string {
  return path.join(path.resolve(targetRoot), ...PROJECT_SETTINGS_SEGMENTS)
}

function readLayer(file: string | null): unknown {
  if (file === null) return null
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function scopeFor(targetRoot: string | null): SettingsScope {
  return targetRoot !== null && existsSync(machineSettingsPath()) ? "project" : "machine"
}

export function resolveSettings(targetRoot: string | null): AgentsSettings {
  return mergeSettingsLayers(readLayer(machineSettingsPath()), readLayer(targetRoot === null ? null : projectSettingsPath(targetRoot)))
}

function machineSettings(): AgentsSettings {
  return mergeSettingsLayers(readLayer(machineSettingsPath()))
}

// `draft` is the tier a save LANDS on and `baseline` the tier below it: editing the machine defaults must never start from — nor write back — what a project's own override resolves to.
export function readSettingsState(targetRoot: string | null): SettingsState {
  const scope = scopeFor(targetRoot)
  const settings = resolveSettings(targetRoot)
  const machine = machineSettings()
  return {
    settings,
    draft: scope === "project" ? settings : machine,
    baseline: scope === "project" ? machine : DEFAULT_SETTINGS,
    scope,
  }
}

function publish(file: string, document: AgentsSettings | SettingsOverride): void {
  mkdirSync(path.dirname(file), { recursive: true })
  replaceFileAtomically(file, Buffer.from(`${JSON.stringify(document, null, 2)}\n`))
}

export function saveSettings(targetRoot: string | null, input: unknown): SettingsState {
  const next = normalizeSettings(input)
  const projectRoot = scopeFor(targetRoot) === "project" ? targetRoot : null
  if (projectRoot === null) {
    publish(machineSettingsPath(), next)
  } else {
    const file = projectSettingsPath(projectRoot)
    const delta = settingsDelta(machineSettings(), next)
    if (delta === null) rmSync(file, { force: true })
    else publish(file, delta)
  }
  return readSettingsState(targetRoot)
}
