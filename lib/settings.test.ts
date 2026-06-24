import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  agentDefaultsFor,
  DEFAULT_SETTINGS,
  EFFORT_LEVELS,
  isDistinctAssignment,
  isValidEffort,
  normalizeSettings,
  resolveAssignment,
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

  it("normalizeSettings fills missing fields with the assigned CLI's defaults", () => {
    const normalized = normalizeSettings({
      // Assign the implementer to codex (allowed, R12) with an empty model.
      implementer: { provider: "codex", model: "", effort: "high" },
    })
    // The implementer now runs codex; an empty model falls back to codex's default.
    expect(normalized.implementer.provider).toBe("codex")
    expect(normalized.implementer.model).toBe("gpt-5.5-codex")
    // "high" is valid for codex, so it is kept.
    expect(normalized.implementer.effort).toBe("high")
    // The reviewer was omitted but defaults to codex, which now collides with the
    // implementer; the distinct-CLI invariant repairs it to claude with claude's
    // defaults.
    expect(normalized.reviewer.provider).toBe("claude")
    expect(normalized.reviewer.model).toBe("claude-opus-4-8")
    expect(normalized.reviewer.effort).toBe("xhigh")
    expect(isDistinctAssignment(normalized)).toBe(true)
  })
})

describe("role -> CLI assignment (R12)", () => {
  it("resolveAssignment keeps a valid distinct assignment", () => {
    expect(
      resolveAssignment({
        implementer: { provider: "codex", model: "x", effort: "high" },
        reviewer: { provider: "claude", model: "y", effort: "max" },
      })
    ).toEqual({ implementer: "codex", reviewer: "claude" })
  })

  it("resolveAssignment repairs same-CLI-for-both to distinct CLIs", () => {
    // Both claude -> reviewer repaired to codex.
    expect(
      resolveAssignment({
        implementer: { provider: "claude" },
        reviewer: { provider: "claude" },
      })
    ).toEqual({ implementer: "claude", reviewer: "codex" })
    // Both codex -> reviewer repaired to claude.
    expect(
      resolveAssignment({
        implementer: { provider: "codex" },
        reviewer: { provider: "codex" },
      })
    ).toEqual({ implementer: "codex", reviewer: "claude" })
  })

  it("resolveAssignment falls back to defaults for unknown CLIs", () => {
    expect(resolveAssignment({ implementer: { provider: "gemini" } })).toEqual({
      implementer: "claude",
      reviewer: "codex",
    })
    expect(resolveAssignment(null)).toEqual({ implementer: "claude", reviewer: "codex" })
  })

  it("normalizeSettings never lets one CLI hold both roles", () => {
    const swapped = normalizeSettings({
      implementer: { provider: "codex", model: "gpt-5.5-codex", effort: "minimal" },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
    })
    expect(swapped.implementer.provider).toBe("codex")
    expect(swapped.reviewer.provider).toBe("claude")
    expect(isDistinctAssignment(swapped)).toBe(true)

    const collided = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "high" },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
    })
    expect(isDistinctAssignment(collided)).toBe(true)
  })

  it("normalizeSettings clamps maxParallel to a sane integer (default 1)", () => {
    expect(normalizeSettings({}).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: 4 }).maxParallel).toBe(4)
    expect(normalizeSettings({ maxParallel: 0 }).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: -2 }).maxParallel).toBe(1)
    expect(normalizeSettings({ maxParallel: 999 }).maxParallel).toBe(8)
    expect(normalizeSettings({ maxParallel: 2.7 }).maxParallel).toBe(2)
  })

  it("agentDefaultsFor returns each CLI's latest model + default level", () => {
    expect(agentDefaultsFor("claude")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
    })
    expect(agentDefaultsFor("codex")).toEqual({
      provider: "codex",
      model: "gpt-5.5-codex",
      effort: "high",
    })
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
  it("maps the default assignment to the dev-loop env vars", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "high" },
      maxParallel: 1,
    })
    expect(env).toEqual({
      VIVICY_IMPLEMENTER_CLI: "claude",
      VIVICY_REVIEWER_CLI: "codex",
      VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
      VIVICY_CLAUDE_EFFORT: "xhigh",
      VIVICY_CODEX_MODEL: "gpt-5.5-codex",
      VIVICY_CODEX_EFFORT: "high",
      VIVICY_MAX_PARALLEL: "1",
    })
  })

  it("carries the concurrency knob, clamped to [1, 8]", () => {
    const base = {
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      reviewer: { provider: "codex", model: "gpt-5.5-codex", effort: "high" },
    } as const
    expect(settingsToEnv({ ...base, maxParallel: 3 }).VIVICY_MAX_PARALLEL).toBe("3")
    expect(settingsToEnv({ ...base, maxParallel: 0 }).VIVICY_MAX_PARALLEL).toBe("1")
    expect(settingsToEnv({ ...base, maxParallel: 99 }).VIVICY_MAX_PARALLEL).toBe("8")
  })

  it("carries a swapped assignment: each CLI's model/level follows the CLI", () => {
    // implementer=codex, reviewer=claude. The CLI-keyed env vars must hold each
    // CLI's own model/level regardless of which role it fills.
    const env = settingsToEnv({
      implementer: { provider: "codex", model: "gpt-5.5-codex", effort: "minimal" },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max" },
      maxParallel: 2,
    })
    expect(env.VIVICY_IMPLEMENTER_CLI).toBe("codex")
    expect(env.VIVICY_REVIEWER_CLI).toBe("claude")
    expect(env.VIVICY_CODEX_EFFORT).toBe("minimal")
    expect(env.VIVICY_CLAUDE_EFFORT).toBe("max")
  })
})
