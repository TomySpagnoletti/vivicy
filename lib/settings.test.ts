import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  isValidEffort,
  normalizeSettings,
  settingsToEnv,
} from "@/lib/settings"
import { getSettingsPath, readSettings, writeSettings } from "@/lib/settings-store"

let runtimeDir: string
let prevCwd: string

beforeEach(() => {
  // getSettingsPath() is relative to cwd; isolate the store per test.
  runtimeDir = mkdtempSync(path.join(tmpdir(), "vivicy-settings-"))
  prevCwd = process.cwd()
  process.chdir(runtimeDir)
})

afterEach(() => {
  process.chdir(prevCwd)
  rmSync(runtimeDir, { recursive: true, force: true })
})

describe("defaults", () => {
  it("pins the latest models with the documented default thinking levels", () => {
    expect(DEFAULT_SETTINGS.implementer).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
    })
    expect(DEFAULT_SETTINGS.reviewer).toEqual({
      provider: "codex",
      model: "gpt-5.5-codex",
      effort: "high",
    })
  })

  it("readSettings returns the defaults when no file exists", () => {
    expect(existsSync(getSettingsPath())).toBe(false)
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })
})

describe("effort validation", () => {
  it("accepts only each provider's allowed levels", () => {
    // Claude levels.
    for (const level of EFFORT_LEVELS.claude) {
      expect(isValidEffort("claude", level)).toBe(true)
    }
    expect(isValidEffort("claude", "minimal")).toBe(false) // codex-only level
    expect(isValidEffort("claude", "extreme")).toBe(false)
    expect(isValidEffort("claude", 5)).toBe(false)

    // Codex levels.
    for (const level of EFFORT_LEVELS.codex) {
      expect(isValidEffort("codex", level)).toBe(true)
    }
    expect(isValidEffort("codex", "xhigh")).toBe(false) // claude-only level
    expect(isValidEffort("codex", "max")).toBe(false)
  })

  it("normalizeSettings rejects an invalid effort and keeps the role default", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "custom-claude", effort: "extreme" },
      reviewer: { provider: "codex", model: "custom-codex", effort: "minimal" },
    })
    // Bad effort falls back to the default; a valid one is kept. The user-set
    // model is preserved (always-latest is a default, not a lock).
    expect(normalized.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    expect(normalized.implementer.model).toBe("custom-claude")
    expect(normalized.reviewer.effort).toBe("minimal")
    expect(normalized.reviewer.model).toBe("custom-codex")
  })

  it("normalizeSettings forces the provider per role and fills missing fields", () => {
    const normalized = normalizeSettings({
      // Attempt to switch the implementer to codex + drop the reviewer entirely.
      implementer: { provider: "codex", model: "", effort: "high" },
    })
    // Provider is fixed per role; an empty model falls back to the default.
    expect(normalized.implementer.provider).toBe("claude")
    expect(normalized.implementer.model).toBe(DEFAULT_SETTINGS.implementer.model)
    // "high" is valid for claude, so it is kept.
    expect(normalized.implementer.effort).toBe("high")
    // Missing reviewer block => full default.
    expect(normalized.reviewer).toEqual(DEFAULT_SETTINGS.reviewer)
  })
})

describe("persistence round-trip", () => {
  it("writeSettings normalizes, persists, and readSettings reads it back", () => {
    const written = writeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
      reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "low" },
    })
    expect(written.implementer.effort).toBe("max")
    expect(written.reviewer.effort).toBe("low")
    expect(existsSync(getSettingsPath())).toBe(true)
    expect(readSettings()).toEqual(written)
  })

  it("readSettings falls back to defaults on a corrupt file", () => {
    writeSettings(DEFAULT_SETTINGS)
    // Corrupt the store.
    const file = getSettingsPath()
    writeFileSync(file, "{ not json")
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("stores the file inside the gitignored .vivicy-runtime dir", () => {
    writeSettings(DEFAULT_SETTINGS)
    const file = getSettingsPath()
    expect(file.startsWith(process.cwd())).toBe(true)
    expect(file).toContain(`.vivicy-runtime${path.sep}settings.json`)
  })
})

describe("settingsToEnv", () => {
  it("maps settings to the dev-loop env vars", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "high" },
    })
    expect(env).toEqual({
      VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
      VIVICY_CLAUDE_EFFORT: "xhigh",
      VIVICY_CODEX_MODEL: "gpt-5.5-codex",
      VIVICY_CODEX_EFFORT: "high",
    })
  })
})
