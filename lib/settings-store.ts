import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { getRuntimeDir } from "@/lib/runtime-dir"
import { DEFAULT_SETTINGS, normalizeSettings, type AgentsSettings } from "@/lib/settings"

// Filesystem I/O split out from ./settings so that module stays node:fs-free for the client bundle.
const SETTINGS_FILE = "settings.json"

export function getSettingsPath(): string {
  return path.join(getRuntimeDir(), SETTINGS_FILE)
}

export function readSettings(): AgentsSettings {
  const file = getSettingsPath()
  if (!existsSync(file)) return DEFAULT_SETTINGS
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return DEFAULT_SETTINGS
  }
}

export function writeSettings(input: unknown): AgentsSettings {
  const normalized = normalizeSettings(input)
  mkdirSync(getRuntimeDir(), { recursive: true })
  writeFileSync(getSettingsPath(), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}
