/**
 * Server-only filesystem store for Vivicy agent settings, persisted as JSON in
 * the gitignored Vivicy runtime dir (the same `.vivicy-runtime/` the control
 * plane uses for its lock/log).
 *
 * The schema, defaults, allowed levels, and validation live in the client-safe
 * {@link file://./settings} module; this file only adds the filesystem I/O so
 * `node:fs` never reaches the client bundle.
 *
 * Never load-bearing for correctness — a missing/corrupt file falls back to the
 * defaults so a run never blocks on it.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { DEFAULT_SETTINGS, normalizeSettings, type AgentsSettings } from "@/lib/settings"

const RUNTIME_DIR_NAME = ".vivicy-runtime"
const SETTINGS_FILE = "settings.json"

/** Absolute path to the gitignored Vivicy runtime dir (same as the control plane). */
export function getRuntimeDir(): string {
  return path.join(process.cwd(), RUNTIME_DIR_NAME)
}

/** Absolute path to the settings JSON store. */
export function getSettingsPath(): string {
  return path.join(getRuntimeDir(), SETTINGS_FILE)
}

/**
 * Read settings from disk, returning the defaults when the file is absent or
 * unreadable. Any partially-valid file is normalized so callers always get a
 * complete, valid document.
 */
export function readSettings(): AgentsSettings {
  const file = getSettingsPath()
  if (!existsSync(file)) return DEFAULT_SETTINGS
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, "utf8")))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/**
 * Normalize and persist settings, creating the runtime dir on demand. Returns
 * the normalized document actually written (so the caller echoes the validated
 * values, never the raw request).
 */
export function writeSettings(input: unknown): AgentsSettings {
  const normalized = normalizeSettings(input)
  mkdirSync(getRuntimeDir(), { recursive: true })
  writeFileSync(getSettingsPath(), `${JSON.stringify(normalized, null, 2)}\n`)
  return normalized
}
