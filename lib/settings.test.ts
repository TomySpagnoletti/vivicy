import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  agentDefaultsFor,
  DEFAULT_SETTINGS,
  effortsForModel,
  EFFORT_LEVELS,
  isAgentCompatible,
  isDistinctAssignment,
  isSettingsValid,
  isValidEffort,
  modelCapability,
  modelSupportsFast,
  MODEL_IDS,
  MODELS,
  normalizeSettings,
  resolveAssignment,
  settingsToEnv,
  withModel,
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
  it("pins the latest models with the documented default thinking levels and fast off", () => {
    expect(DEFAULT_SETTINGS.implementer).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
      fast: false,
    })
    expect(DEFAULT_SETTINGS.reviewer).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      fast: false,
    })
  })

  it("readSettings returns the defaults when no file exists", () => {
    expect(existsSync(getSettingsPath())).toBe(false)
    expect(readSettings()).toEqual(DEFAULT_SETTINGS)
  })

  it("each CLI's default model is the first in its curated list", () => {
    expect(MODEL_IDS.claude[0]).toBe("claude-opus-4-8")
    expect(MODEL_IDS.codex[0]).toBe("gpt-5.5")
    // Last ~4 versions per CLI.
    expect(MODEL_IDS.claude).toHaveLength(4)
    expect(MODEL_IDS.codex).toHaveLength(4)
  })
})

describe("per-model compatibility map", () => {
  it("declares the researched models with the right effort + fast support", () => {
    // Claude Opus line: full effort range; fast on 4.6/4.7/4.8 only.
    expect(modelCapability("claude", "claude-opus-4-8")).toEqual({
      efforts: EFFORT_LEVELS.claude,
      fast: true,
    })
    expect(modelSupportsFast("claude", "claude-opus-4-8")).toBe(true)
    expect(modelSupportsFast("claude", "claude-opus-4-7")).toBe(true)
    expect(modelSupportsFast("claude", "claude-opus-4-6")).toBe(true)
    // Older Opus: no fast.
    expect(modelSupportsFast("claude", "claude-opus-4-5")).toBe(false)

    // Codex: gpt-5.5 + gpt-5.4 support fast; mini does not; spark is speed-first
    // with NO reasoning levels and no fast.
    expect(modelSupportsFast("codex", "gpt-5.5")).toBe(true)
    expect(modelSupportsFast("codex", "gpt-5.4")).toBe(true)
    expect(modelSupportsFast("codex", "gpt-5.4-mini")).toBe(false)
    expect(modelSupportsFast("codex", "gpt-5.3-codex-spark")).toBe(false)
    expect(effortsForModel("codex", "gpt-5.3-codex-spark")).toEqual([])
  })

  it("every listed model declares a self-consistent capability", () => {
    for (const provider of ["claude", "codex"] as const) {
      for (const { id, capability } of MODELS[provider]) {
        // efforts is the model's own allowed set (subset of the CLI union).
        for (const level of capability.efforts) {
          expect(EFFORT_LEVELS[provider]).toContain(level)
        }
        // modelSupportsFast mirrors the capability flag for a listed model.
        expect(modelSupportsFast(provider, id)).toBe(capability.fast)
      }
    }
  })

  it("treats a custom (unlisted) model as fast-incapable but keeps a usable effort set", () => {
    expect(modelCapability("claude", "claude-experimental-x")).toBeNull()
    // Custom model: fast off (we never vouch for an unknown model's fast support).
    expect(modelSupportsFast("claude", "claude-experimental-x")).toBe(false)
    // But effort falls back to the CLI union so it is never stranded.
    expect(effortsForModel("claude", "claude-experimental-x")).toEqual(EFFORT_LEVELS.claude)
  })
})

describe("effort validation (per model)", () => {
  it("accepts only the levels the SELECTED model allows", () => {
    // Claude opus accepts the full claude set.
    for (const level of EFFORT_LEVELS.claude) {
      expect(isValidEffort("claude", "claude-opus-4-8", level)).toBe(true)
    }
    expect(isValidEffort("claude", "claude-opus-4-8", "minimal")).toBe(false) // codex-only
    expect(isValidEffort("claude", "claude-opus-4-8", "extreme")).toBe(false)
    expect(isValidEffort("claude", "claude-opus-4-8", 5)).toBe(false)

    // Codex frontier model accepts the codex set (incl. xhigh).
    for (const level of EFFORT_LEVELS.codex) {
      expect(isValidEffort("codex", "gpt-5.5", level)).toBe(true)
    }
    expect(isValidEffort("codex", "gpt-5.5", "max")).toBe(false) // claude-only

    // Spark has NO reasoning levels: nothing is valid.
    expect(isValidEffort("codex", "gpt-5.3-codex-spark", "high")).toBe(false)
    expect(isValidEffort("codex", "gpt-5.3-codex-spark", "")).toBe(false)
  })

  it("normalizeSettings rejects an incompatible model+effort and repairs to the model default", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "extreme" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "minimal" },
    })
    // Bad effort falls back to the model default; a valid one is kept.
    expect(normalized.implementer.effort).toBe(DEFAULT_SETTINGS.implementer.effort)
    expect(normalized.implementer.model).toBe("claude-opus-4-8")
    expect(normalized.reviewer.effort).toBe("minimal")
    expect(normalized.reviewer.model).toBe("gpt-5.5")
  })

  it("normalizeSettings empties the effort for a model with no reasoning control", () => {
    const normalized = normalizeSettings({
      // Reviewer = codex on spark with a stale effort.
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh" },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "high" },
    })
    expect(normalized.reviewer.model).toBe("gpt-5.3-codex-spark")
    expect(normalized.reviewer.effort).toBe("") // spark has no thinking level
    expect(isAgentCompatible(normalized.reviewer)).toBe(true)
  })

  it("preserves a custom model but keeps a valid effort for it", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "custom-claude", effort: "max" },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high" },
    })
    expect(normalized.implementer.model).toBe("custom-claude")
    expect(normalized.implementer.effort).toBe("max") // valid in the CLI union fallback
  })
})

describe("fast-mode validation", () => {
  it("normalizeSettings strips fast on a fast-INcapable model", () => {
    const normalized = normalizeSettings({
      // Try to force fast on Opus 4.5 (no fast) and on spark (no fast).
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", fast: true },
    })
    expect(normalized.implementer.fast).toBe(false)
    expect(normalized.reviewer.fast).toBe(false)
    expect(isAgentCompatible(normalized.implementer)).toBe(true)
    expect(isAgentCompatible(normalized.reviewer)).toBe(true)
  })

  it("normalizeSettings keeps fast on a fast-capable model", () => {
    const normalized = normalizeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: true },
    })
    expect(normalized.implementer.fast).toBe(true)
    expect(normalized.reviewer.fast).toBe(true)
  })

  it("withModel drops fast when switching to a fast-incapable model and repairs effort", () => {
    const fastOpus = { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true } as const
    const switched = withModel(fastOpus, "claude-opus-4-5")
    expect(switched.model).toBe("claude-opus-4-5")
    expect(switched.fast).toBe(false) // 4.5 has no fast
    expect(switched.effort).toBe("max") // still a valid claude level

    // Switching codex frontier -> spark drops both fast and effort.
    const fastCodex = { provider: "codex", model: "gpt-5.5", effort: "high", fast: true } as const
    const spark = withModel(fastCodex, "gpt-5.3-codex-spark")
    expect(spark.fast).toBe(false)
    expect(spark.effort).toBe("")
    expect(isAgentCompatible(spark)).toBe(true)
  })

  it("isAgentCompatible rejects an impossible fast/effort combo", () => {
    expect(
      isAgentCompatible({ provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true })
    ).toBe(false) // fast on a no-fast model
    expect(
      isAgentCompatible({ provider: "codex", model: "gpt-5.3-codex-spark", effort: "high", fast: false })
    ).toBe(false) // effort set on a no-reasoning model
    expect(
      isAgentCompatible({ provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true })
    ).toBe(true)
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
    expect(
      resolveAssignment({
        implementer: { provider: "claude" },
        reviewer: { provider: "claude" },
      })
    ).toEqual({ implementer: "claude", reviewer: "codex" })
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
      implementer: { provider: "codex", model: "gpt-5.5", effort: "minimal" },
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

  it("agentDefaultsFor returns each CLI's latest model + default level + fast off", () => {
    expect(agentDefaultsFor("claude")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      effort: "xhigh",
      fast: false,
    })
    expect(agentDefaultsFor("codex")).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      fast: false,
    })
  })

  it("normalized defaults are valid settings", () => {
    expect(isSettingsValid(DEFAULT_SETTINGS)).toBe(true)
    expect(isSettingsValid(normalizeSettings({}))).toBe(true)
  })
})

describe("persistence round-trip", () => {
  it("writeSettings normalizes, persists, and readSettings reads it back", () => {
    const written = writeSettings({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "low", fast: false },
    })
    expect(written.implementer.effort).toBe("max")
    expect(written.implementer.fast).toBe(true)
    expect(written.reviewer.effort).toBe("low")
    expect(existsSync(getSettingsPath())).toBe(true)
    expect(readSettings()).toEqual(written)
  })

  it("readSettings falls back to defaults on a corrupt file", () => {
    writeSettings(DEFAULT_SETTINGS)
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
  it("maps the default assignment to the dev-loop env vars (fast off)", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
      maxParallel: 1,
    })
    expect(env).toEqual({
      VIVICY_IMPLEMENTER_CLI: "claude",
      VIVICY_REVIEWER_CLI: "codex",
      VIVICY_CLAUDE_MODEL: "claude-opus-4-8",
      VIVICY_CLAUDE_EFFORT: "xhigh",
      VIVICY_CLAUDE_FAST: "0",
      VIVICY_CODEX_MODEL: "gpt-5.5",
      VIVICY_CODEX_EFFORT: "high",
      VIVICY_CODEX_FAST: "0",
      VIVICY_MAX_PARALLEL: "1",
    })
  })

  it("emits the fast flag '1' only when fast is on AND the model supports it", () => {
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: true },
      maxParallel: 1,
    })
    expect(env.VIVICY_CLAUDE_FAST).toBe("1")
    expect(env.VIVICY_CODEX_FAST).toBe("1")
  })

  it("never emits fast '1' for a model that cannot do fast, even if fast is true", () => {
    // Defence in depth: a forced-fast incapable model (should already be repaired
    // upstream, but settingsToEnv re-checks) emits "0".
    const env = settingsToEnv({
      implementer: { provider: "claude", model: "claude-opus-4-5", effort: "high", fast: true },
      reviewer: { provider: "codex", model: "gpt-5.3-codex-spark", effort: "", fast: true },
      maxParallel: 1,
    })
    expect(env.VIVICY_CLAUDE_FAST).toBe("0")
    expect(env.VIVICY_CODEX_FAST).toBe("0")
  })

  it("carries the concurrency knob, clamped to [1, 8]", () => {
    const base = {
      implementer: { provider: "claude", model: "claude-opus-4-8", effort: "xhigh", fast: false },
      reviewer: { provider: "codex", model: "gpt-5.5", effort: "high", fast: false },
    } as const
    expect(settingsToEnv({ ...base, maxParallel: 3 }).VIVICY_MAX_PARALLEL).toBe("3")
    expect(settingsToEnv({ ...base, maxParallel: 0 }).VIVICY_MAX_PARALLEL).toBe("1")
    expect(settingsToEnv({ ...base, maxParallel: 99 }).VIVICY_MAX_PARALLEL).toBe("8")
  })

  it("carries a swapped assignment: each CLI's model/level/fast follows the CLI", () => {
    const env = settingsToEnv({
      implementer: { provider: "codex", model: "gpt-5.5", effort: "minimal", fast: true },
      reviewer: { provider: "claude", model: "claude-opus-4-8", effort: "max", fast: false },
      maxParallel: 2,
    })
    expect(env.VIVICY_IMPLEMENTER_CLI).toBe("codex")
    expect(env.VIVICY_REVIEWER_CLI).toBe("claude")
    expect(env.VIVICY_CODEX_EFFORT).toBe("minimal")
    expect(env.VIVICY_CODEX_FAST).toBe("1") // codex (implementer) wants fast on gpt-5.5
    expect(env.VIVICY_CLAUDE_EFFORT).toBe("max")
    expect(env.VIVICY_CLAUDE_FAST).toBe("0")
  })
})
